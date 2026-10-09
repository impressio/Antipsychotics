#!/usr/bin/env python3
"""Build the 2D structure drawings assets/images/structures/<drug>.svg from the SMILES in assets/data/properties.json.

Layouts are computed with RDKit (CoordGen 2D depiction, the standard orientation used in
chemistry references); within a chemical group (properties.json chemGroups) the drawings are
aligned on the group's core substructure, so related drugs look alike; atoms are colored like the rest of the app (N blue, O red, Cl green,
F teal), the background is transparent and atom labels are drawn as paths, so the SVGs look
the same in every browser without fonts.

Usage: tools/.venv/bin/python tools/build_structures.py
Setup (once, shared with build_brain.py): python3 -m venv tools/.venv && tools/.venv/bin/python -m pip install numpy scipy rdkit
"""
import json
import re
from pathlib import Path

from rdkit import Chem
from rdkit.Chem import rdDepictor
from rdkit.Geometry import Point2D
from rdkit.Chem.Draw import rdMolDraw2D

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'images' / 'structures'
W, H = 200, 150

# Atom colors (RGB 0-1), matching the app palette
def rgb(hexcol):
    h = hexcol.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

PALETTE = {6: '#2b2f36', 7: '#1c7ed6', 8: '#e03131', 9: '#0ca678', 16: '#f59f00', 17: '#2f9e44',
           35: '#e8590c', 53: '#9c36b5', 15: '#f76707', 1: '#495057'}


def drug_groups():
    """[(core SMARTS list, {key: smiles})] by chemical group (properties.json chemGroups), then ungrouped drugs."""
    props = json.loads((ROOT / 'assets' / 'data' / 'properties.json').read_text(encoding='utf-8'))
    drugs = {k: d for k, d in props['drugs'].items() if d.get('smiles')}
    out = [(g.get('cores') or [], {k: d['smiles'] for k, d in drugs.items() if d.get('chemGroup') == g['key']}) for g in props.get('chemGroups', [])]
    known = {g['key'] for g in props.get('chemGroups', [])}
    out.append(([], {k: d['smiles'] for k, d in drugs.items() if d.get('chemGroup') not in known}))
    return out


def depict(smiles, ref=None, cores=()):
    """2D coordinates. With a reference molecule, the first core pattern found in both molecules is pinned to
    the reference's coordinates (explicit atom map), so the shared skeleton has the same orientation."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f'invalid SMILES: {smiles}')
    rdDepictor.SetPreferCoordGen(True)
    if ref is not None:
        pos = ref.GetConformer().GetPositions()
        for patt in cores:
            a, b = ref.GetSubstructMatch(patt), mol.GetSubstructMatch(patt)
            if a and b:
                rdDepictor.Compute2DCoords(mol, coordMap={j: Point2D(pos[i][0], pos[i][1]) for i, j in zip(a, b)})
                return mol
    rdDepictor.Compute2DCoords(mol)
    return mol


def draw(mol):
    d = rdMolDraw2D.MolDraw2DSVG(W, H)
    o = d.drawOptions()
    o.clearBackground = False                  # transparent: the card's tinted panel shows through
    o.bondLineWidth = 1.6
    o.padding = 0.08
    o.fixedBondLength = 22                     # same scale for every drug (shrinks only if it would not fit)
    o.multipleBondOffset = 0.18
    o.additionalAtomLabelPadding = 0.08
    o.minFontSize = 10
    o.maxFontSize = 13
    o.updateAtomPalette({z: rgb(c) for z, c in PALETTE.items()})
    rdMolDraw2D.PrepareAndDrawMolecule(d, mol)
    d.FinishDrawing()
    svg = d.GetDrawingText()
    svg = re.sub(r'<\?xml[^>]*>\s*', '', svg)                         # inline-friendly
    svg = re.sub(r"<!-- END OF HEADER -->\s*", '', svg)
    svg = svg.replace("width='200px' height='150px'", f"width='{W}' height='{H}'")
    return minify(svg)


def minify(svg):
    """Smaller SVG with the same drawing: drop RDKit's per-element class attributes and namespaces,
    move the shared stroke style to one rule, round coordinates to 0.1 and collapse whitespace."""
    svg = re.sub(r" class='[^']*'", '', svg)
    svg = re.sub(r"\s*xmlns:(rdkit|xlink)='[^']*'", '', svg)
    svg = re.sub(r"\s*(baseProfile|xml:space)='[^']*'", '', svg)
    svg = re.sub(r'-?\d+\.\d{2,}', lambda m: f'{float(m.group()):.1f}'.rstrip('0').rstrip('.'), svg)
    # bond paths share all style properties except stroke color (and dashes for wedges)
    svg = svg.replace(";stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1", "")
    svg = re.sub(r'\s+', ' ', svg).replace('> <', '><').strip()
    return svg + '\n'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    for cores, smiles in drug_groups():
        # the first drug of a group is the template: the others share the orientation of the common core
        patts = [Chem.MolFromSmarts(c) for c in cores]
        ref = None
        for key, smi in smiles.items():
            mol = depict(smi, ref, patts)
            if ref is None and patts:
                ref = mol
            svg = draw(mol)
            (OUT / f'{key}.svg').write_text(svg, encoding='utf-8')
            print(f'{key}.svg', len(svg.encode()) // 1024 + 1, 'kB')
            n += 1
    print(n, 'structures written to', OUT.relative_to(ROOT))


if __name__ == '__main__':
    main()
