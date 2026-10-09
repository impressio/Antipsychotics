"""Build the D2 receptor model files in assets/models/ from the RCSB Protein Data Bank.

Template: PDB 6CM4 (human D2 receptor + risperidone, X-ray, inactive state; Wang et al. 2018).
Superposed onto it (Kabsch fit on transmembrane Cα atoms):
  - haloperidol from PDB 6LUQ (D2 + haloperidol, X-ray; Fan et al. 2020)
  - dopamine and the active receptor conformation from PDB 8U02 (D2 + dopamine + Gαo, cryo-EM; 2024)

Writes
  assets/models/6CM4.pdb.gz   receptor (T4 lysozyme fusion, waters and additives removed) + risperidone
  assets/models/d2-poses.json haloperidol and dopamine poses, and active-state coordinates of the
                              receptor atoms that move on activation (for the TM6 morph in js/structure.js)

Run:  tools/.venv/bin/python tools/build_receptor.py
The downloaded entries are cached in tools/.pdb-cache/.
"""
import gzip
import json
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'models'
CACHE = Path(__file__).resolve().parent / '.pdb-cache'

# Transmembrane helices of the D2 receptor (residue ranges, approximately after GPCRdb);
# TM1-TM4 form the rigid core used for the inactive/active superposition
TM = {1: (35, 60), 2: (68, 96), 3: (104, 138), 4: (149, 172), 5: (186, 216), 6: (366, 398), 7: (405, 430)}
CORE = [1, 2, 3, 4]
MOVE_MIN = 1.2   # Å: atoms that move less than this between states are not stored for the morph


def fetch(pdb_id):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f'{pdb_id}.pdb'
    if not path.exists():
        url = f'https://files.rcsb.org/download/{pdb_id}.pdb'
        print('downloading', url)
        path.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    return path.read_text().splitlines()


def atoms(lines, chain):
    out = []
    for ln in lines:
        if ln.startswith(('ATOM  ', 'HETATM')) and ln[21] == chain:
            out.append({
                'line': ln, 'het': ln.startswith('HETATM'), 'name': ln[12:16].strip(), 'resn': ln[17:20].strip(),
                'resi': int(ln[22:26]), 'xyz': np.array([float(ln[30:38]), float(ln[38:46]), float(ln[46:54])]),
                'elem': (ln[76:78].strip() or ln[12:16].strip()[0]).capitalize(), 'alt': ln[16],
            })
    return [a for a in out if a['alt'] in ' A']


def renumber(template, mobile, half=6, min_match=11):
    """Give mobile residues the template numbering: entries with a T4 lysozyme fusion inside ICL3
    (e.g. 6LUQ) number TM6-TM7 differently. Each residue takes the offset at which a ±6-residue
    window matches the template sequence (≥ 11 of 13 identical); unmatched residues are dropped."""
    tseq = {a['resi']: a['resn'] for a in template if a['name'] == 'CA' and not a['het']}
    mres = sorted({a['resi'] for a in mobile if a['name'] == 'CA' and not a['het']})
    mseq = {a['resi']: a['resn'] for a in mobile if a['name'] == 'CA' and not a['het']}
    offsets = {t - m for t in tseq for m in mres}
    new = {}
    for r in mres:
        best, score = None, 0
        for o in offsets:
            s = sum(1 for d in range(-half, half + 1) if r + d in mseq and tseq.get(r + d + o) == mseq[r + d])
            if s > score:
                best, score = o, s
        if score >= min_match:
            new[r] = r + best
    out = []
    for a in mobile:
        if a['het']:
            out.append(a)
        elif a['resi'] in new:
            out.append({**a, 'resi': new[a['resi']]})
    return out


def in_helices(resi, helices):
    return any(TM[h][0] <= resi <= TM[h][1] for h in helices)


def kabsch(mobile, target):
    """Rotation R and translation t with R @ mobile + t ≈ target (rows are points)."""
    mc, tc = mobile.mean(0), target.mean(0)
    h = (mobile - mc).T @ (target - tc)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    r = vt.T @ np.diag([1, 1, d]) @ u.T
    return r, tc - r @ mc


def fit(template, mobile, helices):
    ref = {a['resi']: a['xyz'] for a in template if a['name'] == 'CA' and not a['het'] and in_helices(a['resi'], helices)}
    mob = {a['resi']: a['xyz'] for a in mobile if a['name'] == 'CA' and not a['het'] and a['resi'] in ref}
    keys = sorted(mob)
    p, q = np.array([mob[k] for k in keys]), np.array([ref[k] for k in keys])
    r, t = kabsch(p, q)
    rmsd = float(np.sqrt((((p @ r.T + t) - q) ** 2).sum(1).mean()))
    return r, t, len(keys), rmsd


def pose(mobile, resn, r, t):
    return [[a['elem'], *np.round(r @ a['xyz'] + t, 3).tolist()] for a in mobile if a['het'] and a['resn'] == resn and a['elem'] != 'H']


def membrane_frame(tpl):
    """Rotation and origin placing the receptor in a membrane frame: z along the membrane normal
    (extracellular −z, intracellular +z, as in the app's viewer), origin at the bundle axis in the
    middle of the transmembrane segments. Helix directions alternate (TM1 runs out → in)."""
    ca = {a['resi']: a['xyz'] for a in tpl if a['name'] == 'CA' and not a['het']}
    n = np.zeros(3)
    for h, (lo, hi) in TM.items():
        v = ca[hi] - ca[lo]
        n += v / np.linalg.norm(v) * (1 if h % 2 else -1)
    z = n / np.linalg.norm(n)
    x = np.cross(z, [0, 0, 1.0]) if abs(z[2]) < 0.9 else np.cross(z, [0, 1.0, 0])
    x /= np.linalg.norm(x)
    rot = np.array([x, np.cross(z, x), z])
    pts = np.array([ca[r] for r in ca if any(lo <= r <= hi for lo, hi in TM.values())])
    proj = pts @ rot.T
    origin = np.array([proj[:, 0].mean(), proj[:, 1].mean(), (np.percentile(proj[:, 2], 5) + np.percentile(proj[:, 2], 95)) / 2])
    return rot, origin


def pdb_line(a, xyz):
    ln = a['line']
    return ln[:30] + ''.join(f'{v:8.3f}' for v in xyz) + ln[54:]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tpl_lines = fetch('6CM4')
    tpl = [a for a in atoms(tpl_lines, 'A') if (not a['het'] and a['resi'] < 1000) or a['resn'] == '8NU']

    allhelices = list(TM)
    halo = renumber(tpl, atoms(fetch('6LUQ'), 'A'))
    r_h, t_h, n_h, rmsd_h = fit(tpl, halo, allhelices)
    act = renumber(tpl, atoms(fetch('8U02'), 'R'))
    r_a, t_a, n_a, rmsd_a = fit(tpl, act, CORE)

    # Everything is written in the membrane frame: x' = M (x − 0) − o
    rot, origin = membrane_frame(tpl)
    to_mem = lambda xyz: rot @ xyz - origin
    r_h, t_h = rot @ r_h, rot @ t_h - origin
    r_a, t_a = rot @ r_a, rot @ t_a - origin
    for a in tpl:
        a['xyz'] = to_mem(a['xyz'])

    # Receptor file: D2 residues only (T4 lysozyme fusion 1002-1161 removed) + risperidone
    pdb = [pdb_line(a, a['xyz']) for a in tpl] + ['END']
    (OUT / '6CM4.pdb.gz').write_bytes(gzip.compress(('\n'.join(pdb) + '\n').encode(), mtime=0))

    # Active-state coordinates for receptor atoms present in both structures with the same residue type
    tpl_idx = {(a['resi'], a['name']): a for a in tpl if not a['het']}
    moved = []
    for a in act:
        if a['het'] or a['elem'] == 'H':
            continue
        b = tpl_idx.get((a['resi'], a['name']))
        if not b or b['resn'] != a['resn']:
            continue
        xyz = r_a @ a['xyz'] + t_a
        if np.linalg.norm(xyz - b['xyz']) >= MOVE_MIN:
            moved.append([a['resi'], a['name'], *np.round(xyz, 2).tolist()])
    tm6_ca = [m for m in moved if m[1] == 'CA' and TM[6][0] <= m[0] <= TM[6][1]]

    data = {
        'source': {
            'template': '6CM4 (D2 + risperidone, X-ray 2.87 Å)',
            'haloperidol': f'6LUQ (X-ray 3.1 Å), {n_h} TM Cα, RMSD {rmsd_h:.2f} Å',
            'dopamine': f'8U02 (cryo-EM 3.28 Å, active state with Gαo), {n_a} TM1-4 Cα, RMSD {rmsd_a:.2f} Å',
        },
        'tm': TM,
        'haloperidol': pose(halo, 'GMJ', r_h, t_h),
        'dopamine': pose(act, 'LDP', r_a, t_a),
        'active': moved,
    }
    (OUT / 'd2-poses.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
    print(f'6CM4 receptor: {sum(not a["het"] for a in tpl)} atoms; risperidone {sum(a["het"] for a in tpl)} atoms')
    print(f'haloperidol: {len(data["haloperidol"])} atoms ({data["source"]["haloperidol"]})')
    print(f'dopamine: {len(data["dopamine"])} atoms ({data["source"]["dopamine"]})')
    print(f'active-state atoms stored: {len(moved)} (TM6 Cα: {len(tm6_ca)}, max shift '
          f'{max((np.linalg.norm(np.array(m[2:]) - tpl_idx[(m[0], m[1])]["xyz"]) for m in moved), default=0):.1f} Å)')


if __name__ == '__main__':
    main()
