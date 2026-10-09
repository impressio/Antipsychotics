#!/usr/bin/env python3
"""Build the brain model files in assets/models/ (brain-mesh.bin.gz + brain-mesh.json: 3D meshes;
brain-2d.json + brain-2d-*.png: 2D views) for the regional-distribution viewer.

Sources (TemplateFlow, https://www.templateflow.org):
  * Cortex: FreeSurfer fsaverage6 (den-41k) pial surfaces and sulcal depth, left and right.
  * Deep structures: FreeSurfer aseg segmentation of the ICBM 152 2009c nonlinear asymmetric
    template (MNI152NLin2009cAsym, 2 mm), converted to smoothed surfaces (surface nets +
    Taubin smoothing) and mapped into fsaverage space by matching the cortical bounding boxes.
  * Hypothalamus, olfactory bulbs, pituitary gland and spinal cord are not in aseg; they are added as smooth
    ellipsoids / a tapered cylinder at standard MNI positions.

Usage: tools/.venv/bin/python tools/build_brain.py [SRC_DIR]
The five TemplateFlow source files (~2.5 MB) are downloaded into SRC_DIR on first use
(default: tools/.templateflow-cache, ignored by git) and reused afterward.
Requires numpy and scipy. Setup (once, shared with build_structures.py): python3 -m venv tools/.venv && tools/.venv/bin/python -m pip install numpy scipy rdkit
"""
import base64, gzip, json, sys, urllib.request, zlib
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from scipy import ndimage, sparse

TOOLS = Path(__file__).resolve().parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else TOOLS / '.templateflow-cache'
OUT = TOOLS.parent / 'assets' / 'models'

TEMPLATEFLOW = 'https://templateflow.s3.amazonaws.com'
SOURCES = [
    'tpl-fsaverage/tpl-fsaverage_hemi-L_den-41k_pial.surf.gii',
    'tpl-fsaverage/tpl-fsaverage_hemi-R_den-41k_pial.surf.gii',
    'tpl-fsaverage/tpl-fsaverage_hemi-L_den-41k_sulc.shape.gii',
    'tpl-fsaverage/tpl-fsaverage_hemi-R_den-41k_sulc.shape.gii',
    'tpl-MNI152NLin2009cAsym/tpl-MNI152NLin2009cAsym_res-02_seg-aseg_dseg.nii.gz',
]


def fetch_sources():
    """Download any missing TemplateFlow source files into SRC (atomic: .part then rename)."""
    SRC.mkdir(parents=True, exist_ok=True)
    for key in SOURCES:
        dest = SRC / Path(key).name
        if dest.exists() and dest.stat().st_size > 0:
            continue
        url = f'{TEMPLATEFLOW}/{key}'
        print('downloading', url)
        part = dest.with_suffix(dest.suffix + '.part')
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(part, 'wb') as f:
                while chunk := r.read(1 << 16):
                    f.write(chunk)
        except Exception as err:
            part.unlink(missing_ok=True)
            sys.exit(f'Could not download {url}: {err}')
        part.rename(dest)


# ---------------------------------------------------------------- readers
def gifti_arrays(path):
    root = ET.parse(path).getroot()
    out = []
    for da in root.iter('DataArray'):
        def attr(name):
            value = da.get(name)
            if value is None:
                raise ValueError(f'{path}: DataArray without {name}')
            return value
        data = da.find('Data')
        if data is None or data.text is None:
            raise ValueError(f'{path}: DataArray without Data')
        raw = zlib.decompress(base64.b64decode(data.text))
        dt = {'NIFTI_TYPE_FLOAT32': '<f4', 'NIFTI_TYPE_INT32': '<i4'}[attr('DataType')]
        shape = [int(attr(f'Dim{i}')) for i in range(int(attr('Dimensionality')))]
        out.append(np.frombuffer(raw, dt).reshape(shape))
    return out


def nifti(path):
    b = gzip.open(path).read()
    h = b[:348]
    dim = [int(x) for x in np.frombuffer(h[40:56], '<i2')]
    dt = {2: 'u1', 4: '<i2', 8: '<i4', 16: '<f4'}[int(np.frombuffer(h[70:72], '<i2')[0])]
    off = int(np.frombuffer(h[108:112], '<f4')[0])
    srow = np.frombuffer(h[280:328], '<f4').reshape(3, 4).astype(float)
    n = dim[1] * dim[2] * dim[3]
    vol = np.frombuffer(b[off:], dt)[:n].reshape(dim[3], dim[2], dim[1]).transpose(2, 1, 0)
    return vol, srow


# ---------------------------------------------------------------- meshing
def surface_nets(f, iso=0.5):
    """Dual surface extraction on a scalar grid; returns vertices (grid units) and triangles."""
    nx, ny, nz = f.shape
    c = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
    edges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    vals = np.stack([f[dx:nx - 1 + dx, dy:ny - 1 + dy, dz:nz - 1 + dz] for dx, dy, dz in c], -1)
    inside = vals > iso
    active = inside.any(-1) & ~inside.all(-1)
    idx = np.argwhere(active)
    cell_id = -np.ones(active.shape, int)
    cell_id[tuple(idx.T)] = np.arange(len(idx))
    v = vals[active]
    acc = np.zeros((len(idx), 3)); cnt = np.zeros(len(idx))
    for a, b in edges:
        va, vb = v[:, a], v[:, b]
        m = (va > iso) != (vb > iso)
        t = np.where(m, (iso - va) / np.where(m, vb - va, 1), 0)
        p = c[a] + t[:, None] * (c[b] - c[a])
        acc[m] += p[m]; cnt[m] += 1
    verts = idx + acc / cnt[:, None]
    faces = []
    # For every grid edge with a sign change, join the four cells sharing it into a quad
    for ax in range(3):
        o0, o1 = [(1, 2), (2, 0), (0, 1)][ax]  # right-handed (ax, o0, o1)
        lo = [slice(None)] * 3; hi = [slice(None)] * 3
        lo[ax] = slice(0, f.shape[ax] - 1); hi[ax] = slice(1, f.shape[ax])
        a = f[tuple(lo)] > iso; b = f[tuple(hi)] > iso
        pts = np.argwhere(a != b)
        keep = (pts[:, o0] >= 1) & (pts[:, o0] <= f.shape[o0] - 2) & (pts[:, o1] >= 1) & (pts[:, o1] <= f.shape[o1] - 2)
        pts = pts[keep]
        inner_first = a[tuple(pts.T)]
        e0 = np.zeros(3, int); e0[o0] = 1
        e1 = np.zeros(3, int); e1[o1] = 1
        cid = lambda q: cell_id[tuple(q.T)]
        q = np.stack([cid(pts - e0 - e1), cid(pts - e1), cid(pts), cid(pts - e0)], -1)
        ok = (q >= 0).all(1)
        q, inner_first = q[ok], inner_first[ok]
        q[~inner_first] = q[~inner_first][:, ::-1]
        faces.append(np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]]))
    return verts, np.concatenate(faces)


def taubin(v, f, iters=20, lam=0.5, mu=-0.53):
    n = len(v)
    i = np.concatenate([f[:, 0], f[:, 1], f[:, 2], f[:, 1], f[:, 2], f[:, 0]])
    j = np.concatenate([f[:, 1], f[:, 2], f[:, 0], f[:, 0], f[:, 1], f[:, 2]])
    A = sparse.coo_matrix((np.ones(len(i)), (i, j)), shape=(n, n)).tocsr()
    A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel(); deg[deg == 0] = 1
    W = sparse.diags(1 / deg) @ A
    for _ in range(iters):
        v = v + lam * (W @ v - v)
        v = v + mu * (W @ v - v)
    return v


def compact(v, f):
    used = np.unique(f)
    remap = -np.ones(len(v), int); remap[used] = np.arange(len(used))
    return v[used], remap[f]


def ellipsoid(center, radii, n=24, taper=None):
    th = np.linspace(0, np.pi, n // 2 + 1); ph = np.linspace(0, 2 * np.pi, n, endpoint=False)
    T, P = np.meshgrid(th, ph, indexing='ij')
    x, y, z = np.sin(T) * np.cos(P), np.sin(T) * np.sin(P), np.cos(T)
    v = np.stack([x.ravel() * radii[0], y.ravel() * radii[1], z.ravel() * radii[2]], -1) + center
    rows, cols = T.shape
    f = []
    for r in range(rows - 1):
        for k in range(cols):
            a, b = r * cols + k, r * cols + (k + 1) % cols
            c_, d = a + cols, b + cols
            f += [[a, c_, b], [b, c_, d]]
    v, f = np.array(v), np.array(f)
    return v, f


def tube(p0, p1, r0, r1, n=24, rings=12):
    t = np.linspace(0, 1, rings)
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    v = []
    for s in t:
        c = p0 + (p1 - p0) * s; r = r0 + (r1 - r0) * s
        v += [[c[0] + r * np.cos(a), c[1] + r * 0.85 * np.sin(a), c[2]] for a in ang]
    f = []
    for i in range(rings - 1):
        for k in range(n):
            a, b = i * n + k, i * n + (k + 1) % n
            f += [[a, b, a + n], [b, b + n, a + n]]
    v = np.array(v)
    # caps
    v = np.vstack([v, p0, p1]); cb, ct = len(v) - 2, len(v) - 1
    f += [[cb, (k + 1) % n, k] for k in range(n)]
    f += [[ct, (rings - 1) * n + k, (rings - 1) * n + (k + 1) % n] for k in range(n)]
    return v, np.array(f)[:, ::-1]



# ---------------------------------------------------------------- 2D views (software render)
REGION_IDS = {'ctx': 1, 'cb': 2, 'bs': 3, 'sc': 4, 'tha': 5, 'str': 6, 'hip': 7, 'amy': 8, 'hyp': 9, 'ob': 10, 'pit': 11}


def vertex_normals(v, f):
    n = np.zeros_like(v)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)


def rasterize(P, depth, f, attrs, zbuf, out, write):
    """Z-buffered triangle rasteriser. P: (n,2) pixel coords, depth: (n,), attrs: (n,k) per-vertex
    values interpolated barycentrically; write(mask_rows, mask_cols, values) stores accepted pixels."""
    H, W = zbuf.shape
    for tri in f:
        p = P[tri]
        x0, y0 = np.floor(p.min(0)).astype(int); x1, y1 = np.ceil(p.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W - 1), min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = p
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        w0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
        w1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        d = w0 * depth[tri[0]] + w1 * depth[tri[1]] + w2 * depth[tri[2]]
        rr, cc = np.nonzero(inside)
        rr_g, cc_g = rr + y0, cc + x0
        dz = d[rr, cc]
        ok = dz < zbuf[rr_g, cc_g]
        if not ok.any():
            continue
        rr_g, cc_g, rr, cc, dz = rr_g[ok], cc_g[ok], rr[ok], cc[ok], dz[ok]
        zbuf[rr_g, cc_g] = dz
        a = attrs[tri]
        vals = (w0[rr, cc, None] * a[0] + w1[rr, cc, None] * a[1] + w2[rr, cc, None] * a[2])
        write(rr_g, cc_g, vals)


def png_rgba(arr):
    import struct
    h, w, _ = arr.shape
    raw = b''.join(b'\x00' + arr[y].tobytes() for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


FRONT = 20  # region id offset for structures in the translucent half (drawn semi-translucent)


def render_view(meshes, side, res=0.3, behind=False):
    """Lateral view from the left (side=-1) or right (side=1) with that hemisphere translucent,
    matching the default 3D view. Returns an RGBA image: R region id (+FRONT for structures in the
    translucent half), G shading (200 = 1.0), B translucent-hemisphere alpha, A coverage.
    behind=True renders what lies behind the translucent half (its structures and cortex omitted),
    used to composite those structures semi-translucently."""
    glass_hemi = 'L' if side < 0 else 'R'
    to_view = np.array([side, 0.0, 0.0])
    light = np.array([0.75 * side, 0.35, 0.45]); light /= np.linalg.norm(light)
    half = (light + to_view); half /= np.linalg.norm(half)
    uv = lambda v: np.stack([(-v[:, 1] if side < 0 else v[:, 1]), -v[:, 2]], -1)
    allp = np.vstack([uv(m['v']) for m in meshes])
    lo = allp.min(0) - 4; hi = allp.max(0) + 4
    W, H = int(np.ceil((hi[0] - lo[0]) / res)), int(np.ceil((hi[1] - lo[1]) / res))
    img = np.zeros((H, W, 4), np.uint8)
    zbuf = np.full((H, W), np.inf)
    gbuf = np.full((H, W), np.inf)
    for m in meshes:
        v = m['v']; f = m['f']
        P = (uv(v) - lo) / res
        depth = -side * v[:, 0]
        n = vertex_normals(v, f)
        sulc = np.clip((m['sulc'] + 1.5) / 3.0, 0, 1) if 'sulc' in m else np.zeros(len(v))
        # Cerebellar folia as in the 3D shader: concentric shells around a point above the peduncles
        if m['region'] == 'cb':
            c = np.array([(v[:, 0].min() + v[:, 0].max()) / 2, (v[:, 1].min() + v[:, 1].max()) / 2 + 10, v[:, 2].max() + 6])
            g = v - c; dist = np.linalg.norm(g, axis=1); g = g / np.maximum(dist[:, None], 1e-9)
            ph = dist * 2.3 + 0.8 * np.sin(v[:, 0] * 0.21)
        else:
            g = np.zeros_like(v); ph = np.zeros(len(v))
        attrs = np.column_stack([n, sulc, ph, g])
        rid = REGION_IDS[m['region']]
        is_ctx = m['region'] == 'ctx'
        front = m['hemi'] == glass_hemi and not is_ctx
        if behind and m['hemi'] == glass_hemi:
            continue
        if is_ctx and m['hemi'] == glass_hemi:
            def write_glass(r, c, vals):
                nn = vals[:, :3] / np.maximum(np.linalg.norm(vals[:, :3], axis=1, keepdims=True), 1e-9)
                fres = 1 - np.abs(nn @ to_view)
                a = 0.13 + 0.75 * fres ** 2 + 0.25 * vals[:, 3] ** 1.5
                img[r, c, 2] = np.clip(a * 255, 0, 255).astype(np.uint8)
            rasterize(P, depth, f, attrs, gbuf, img, write_glass)
            continue
        def write_tissue(r, c, vals, rid=rid, is_ctx=is_ctx, front=front):
            nn = vals[:, :3] + 0.2 * np.cos(vals[:, 4:5]) * vals[:, 5:8]
            nn = nn / np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
            diff = np.maximum(0, nn @ light); spec = np.maximum(0, nn @ half) ** 24
            sh = 0.34 + 0.78 * diff + 0.12 * spec
            if rid == REGION_IDS['cb']:
                t = np.clip((np.sin(vals[:, 4]) + 0.6) / 1.5, 0, 1)
                sh = sh * (0.9 + 0.1 * t * t * (3 - 2 * t))
            if is_ctx:
                sh = sh * (1.12 - 0.55 * vals[:, 3] ** 1.2)
            img[r, c, 0] = rid + (FRONT if front else 0)
            img[r, c, 1] = np.clip(sh * 200, 0, 255).astype(np.uint8)
        rasterize(P, depth, f, attrs, zbuf, img, write_tissue)
    img[..., 3] = np.where((img[..., 0] > 0) | (img[..., 2] > 0), 255, 0)
    # Label anchors: centroid of each region's visible pixels (cortex: its top)
    anchors = {}
    for key, rid in REGION_IDS.items():
        ys, xs = np.nonzero((img[..., 0] == rid) | (img[..., 0] == rid + FRONT))
        if key == 'ctx':
            ys, xs = np.nonzero(img[..., 2] > 0)
            if len(ys):
                top = ys.min(); anchors[key] = [int(xs[ys < top + 3].mean()), int(top)]
            continue
        if len(ys):
            # median point of the region, snapped to a visible pixel
            cx, cy = np.median(xs), np.median(ys)
            k = np.argmin((xs - cx) ** 2 + (ys - cy) ** 2)
            anchors[key] = [int(xs[k]), int(ys[k])]
    return img, anchors, lo

# ---------------------------------------------------------------- build
def main():
    fetch_sources()
    meshes = []

    # Cortex (fsaverage6 pial) with sulcal depth
    ctx_pts = []
    for hemi in 'LR':
        v, f = gifti_arrays(SRC / f'tpl-fsaverage_hemi-{hemi}_den-41k_pial.surf.gii')
        sulc = gifti_arrays(SRC / f'tpl-fsaverage_hemi-{hemi}_den-41k_sulc.shape.gii')[0].ravel()
        ctx_pts.append(v)
        meshes.append(dict(name=f'ctx-{hemi}', region='ctx', hemi=hemi, v=v.astype(float), f=f, sulc=sulc))
    ctx_pts = np.vstack(ctx_pts)

    # aseg -> fsaverage: per-axis linear fit of the cerebral-cortex bounding boxes
    vol, srow = nifti(SRC / 'tpl-MNI152NLin2009cAsym_res-02_seg-aseg_dseg.nii.gz')
    def vox2mni(p):
        return p @ srow[:, :3].T + srow[:, 3]
    ctx_vox = np.argwhere(np.isin(vol, [3, 42]))
    mni = vox2mni(ctx_vox.astype(float))
    lo_m, hi_m = np.percentile(mni, 0.2, 0), np.percentile(mni, 99.8, 0)
    lo_f, hi_f = np.percentile(ctx_pts, 0.2, 0), np.percentile(ctx_pts, 99.8, 0)
    scale = (hi_f - lo_f) / (hi_m - lo_m)
    shift = lo_f - lo_m * scale
    to_fs = lambda p: p * scale + shift
    print('MNI -> fsaverage scale', scale.round(3), 'shift', shift.round(2))

    # Deep structures from aseg (left/right labels)
    STRUCT = [
        ('tha', 'Thalamus', {'L': [10], 'R': [49]}, 0.8),
        ('str', 'Striatum', {'L': [11, 12, 26], 'R': [50, 51, 58]}, 0.8),
        ('hip', 'Hippocampus', {'L': [17], 'R': [53]}, 0.7),
        ('amy', 'Amygdala', {'L': [18], 'R': [54]}, 0.7),
        ('cb', 'Cerebellum', {'L': [7, 8], 'R': [46, 47]}, 0.9),
        ('bs', 'Brainstem', {'M': [16]}, 0.9),
    ]
    for key, label, sides, sigma in STRUCT:
        for hemi, labels in sides.items():
            m = np.isin(vol, labels).astype(float)
            m = np.pad(m, 3)
            fine = ndimage.zoom(ndimage.gaussian_filter(m, sigma), 2, order=1)
            v, f = surface_nets(fine, 0.42 if key in ('amy', 'hip') else 0.5)
            v, f = compact(v, f)
            v = taubin(v, f, 12)
            vox = v / 2 - 3  # back to original voxel indices
            v = to_fs(vox2mni(vox))
            meshes.append(dict(name=f'{key}-{hemi}', region=key, hemi=hemi, v=v, f=f))
            print(key, hemi, len(v), 'verts', len(f), 'faces')

    # Synthetic small structures in MNI space
    for hemi, sx in (('L', -1), ('R', 1)):
        v, f = ellipsoid(np.array([sx * 4.5, -4.0, -11.0]), (4.0, 6.5, 4.5), 20)
        meshes.append(dict(name=f'hyp-{hemi}', region='hyp', hemi=hemi, v=to_fs(v), f=f))
        v, f = ellipsoid(np.array([sx * 9.0, 34.0, -24.0]), (3.0, 11.0, 2.6), 20)
        meshes.append(dict(name=f'ob-{hemi}', region='ob', hemi=hemi, v=to_fs(v), f=f))
    bs = np.argwhere(np.isin(vol, [16])); bs_mni = vox2mni(bs.astype(float))
    low = bs_mni[bs_mni[:, 2] < bs_mni[:, 2].min() + 4].mean(0)
    v, f = tube(low + [0, 0, 2], low + [0, 3, -38], 6.5, 5.0)
    meshes.append(dict(name='sc-M', region='sc', hemi='M', v=to_fs(v), f=f))
    # Pituitary gland in the sella turcica, at the end of the tuberoinfundibular pathway (about 12 x 9 x 6 mm)
    v, f = ellipsoid(np.array([0.0, 2.0, -35.0]), (6.0, 4.5, 3.5), 20)
    meshes.append(dict(name='pit-M', region='pit', hemi='M', v=to_fs(v), f=f))

    # Pack the meshes compactly (brain-mesh.bin.gz + brain-mesh.json):
    #   positions int16 (0.01 mm) delta-coded per axis, indices uint32 zigzag-delta-coded, sulcal
    #   depth uint8 delta-coded; each array is split into byte planes (all low bytes, then the next
    #   byte, ...) and the whole blob is gzip-compressed. Decoded in js/brain3d.js.
    OUT.mkdir(parents=True, exist_ok=True)
    blob = bytearray(); manifest = []
    def planes(arr):
        off = len(blob)
        by = arr.view(np.uint8).reshape(-1, arr.itemsize)
        for k in range(arr.itemsize):
            blob.extend(by[:, k].tobytes())
        return off
    center = (ctx_pts.min(0) + ctx_pts.max(0)) / 2
    for m in meshes:
        v = np.round((m['v'] - center) * 100).astype(np.int32)
        dv = np.diff(v, axis=0, prepend=np.zeros((1, 3), np.int32)).astype('<i2')     # wraps like int16
        f = m['f'].astype(np.int64).ravel()
        df = np.diff(f, prepend=0)
        zz = ((df << 1) ^ (df >> 63)).astype('<u4')
        e = dict(name=m['name'], region=m['region'], hemi=m['hemi'], nv=len(v), nf=len(m['f']),
                 pos=planes(dv), idx=planes(zz))
        if 'sulc' in m:
            sq = np.round(np.clip((m['sulc'] + 1.5) / 3.0, 0, 1) * 255).astype(np.int16)  # -1.5..1.5 mm -> 0..255
            e['sulc'] = planes(np.diff(sq, prepend=0).astype('i1'))
        manifest.append(e)
    (OUT / 'brain-mesh.bin.gz').write_bytes(gzip.compress(bytes(blob), 9, mtime=0))
    (OUT / 'brain-mesh.json').write_text(json.dumps({
        'units': 'positions int16 in 0.01 mm, centered on the cortex bounding box; fsaverage (RAS) axes',
        'encoding': 'gzip; per array: delta coding (positions per axis, int16 wrap; indices zigzag uint32; '
                    'sulc uint8 wrap), stored as byte planes starting at the given offset',
        'sources': 'TemplateFlow: fsaverage (den-41k pial, sulc); MNI152NLin2009cAsym res-02 aseg; see NOTICE',
        # MNI152 (mm) -> model coordinates (mm, as the decoded positions): model = mni * scale + shift,
        # so overlays defined in MNI space (e.g. pathway coordinates) can be placed on the meshes
        'mniToModel': {'scale': [round(float(x), 5) for x in scale], 'shift': [round(float(x), 3) for x in shift - center]},
        'meshes': manifest}, indent=1) + '\n')
    print('wrote brain-mesh.bin.gz', (OUT / 'brain-mesh.bin.gz').stat().st_size // 1024, 'kB')

    # 2D views rendered from the same meshes (used by the 2D map; colored on a canvas, no WebGL needed).
    # PNG channels: R region id (+FRONT in the translucent half), G shading (200 = 1.0),
    # B translucent-hemisphere alpha, A coverage; "-behind" omits the translucent half.
    q = [dict(m, v=np.round((m['v'] - center) * 100) / 100) for m in meshes]
    views = {}
    for key, side in (('L', -1), ('R', 1)):
        img, anchors, lo = render_view(q, side)
        under, _, _ = render_view(q, side, behind=True)
        (OUT / f'brain-2d-{key}.png').write_bytes(png_rgba(img))
        (OUT / f'brain-2d-{key}-behind.png').write_bytes(png_rgba(under))
        # origin: projection of model coordinates to pixels, px = ((side < 0 ? -y : y) - origin[0]) / res,
        # py = (-z - origin[1]) / res (orthographic lateral view)
        views[key] = dict(w=img.shape[1], h=img.shape[0], anchors=anchors, origin=[round(float(lo[0]), 3), round(float(lo[1]), 3)],
                          png=f'brain-2d-{key}.png', behind=f'brain-2d-{key}-behind.png')
        print('2D view', key, img.shape[1], 'x', img.shape[0])
    (OUT / 'brain-2d.json').write_text(json.dumps(dict(res=0.3, regions=REGION_IDS, front=FRONT, views=views), indent=1) + '\n')

if __name__ == '__main__':
    main()
