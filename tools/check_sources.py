#!/usr/bin/env python3
"""Check the values and references in assets/data/properties.json against public databases.

Read-only: it reports differences and never edits the data file.

  1. PubMed: every reference with a pmid still resolves, and its year and title match.
  2. FDA labels (openFDA): every reference with a setid is still current; newer revisions are reported.
  3. Receptor affinities: the Ki values of each drug (path in sourceChecks.kiPath) are compared with
     the IUPHAR/BPS Guide to Pharmacology bulk download and with ChEMBL; differences larger than
     sourceChecks.foldTolerance are reported.
  4. Sources: every path in "sources" exists, every cited reference exists, and the statuses are counted.

The settings (target ids per subunit, species, tolerance) live in the "sourceChecks" section of the
data file, so the script can be reused in other projects with the same file layout.
Downloads are cached in tools/.sources-cache/ (Guide to Pharmacology file for 7 days).

Usage: python3 tools/check_sources.py [--skip-pubmed] [--skip-labels] [--skip-ki] [--out report.md]
Needs only the Python standard library.
"""
import argparse
import csv
import io
import json
import statistics
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'assets' / 'data' / 'properties.json'
CACHE = ROOT / 'tools' / '.sources-cache'
EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/'
OPENFDA = 'https://api.fda.gov/drug/label.json'
CHEMBL = 'https://www.ebi.ac.uk/chembl/api/data/'
GTOPDB_CSV = 'https://www.guidetopharmacology.org/DATA/interactions.csv'


def fetch(url, retries=3, timeout=90):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as err:  # network errors are retried, then reported
            last = err
            time.sleep(1.5 * (attempt + 1))
    raise last


def fetch_json(url):
    return json.loads(fetch(url))


def get_path(obj, path):
    for key in path.split('.'):
        obj = obj[int(key)] if isinstance(obj, list) else obj[key]
    return obj


def check_sources(data, report):
    report.append('## Sources\n')
    missing_paths, missing_refs = [], []
    for path, src in data.get('sources', {}).items():
        try:
            get_path(data, path)
        except (KeyError, IndexError, ValueError, TypeError):
            missing_paths.append(path)
        missing_refs += [f'{path}: {r}' for r in src['refs'] if r not in data.get('references', {})]
    counts = Counter(s['status'] for s in data.get('sources', {}).values())
    report.append(f"{len(data.get('sources', {}))} values with sources: " + ', '.join(f'{k} {v}' for k, v in counts.most_common()) + '\n')
    for p in missing_paths:
        report.append(f'- path not found in the data: `{p}`')
    for r in missing_refs:
        report.append(f'- unknown reference: {r}')
    differs = [p for p, s in data.get('sources', {}).items() if s['status'] == 'differs']
    for p in differs:
        report.append(f"- differs: `{p}` = {get_path(data, p)} (source: {data['sources'][p]['reported']})")
    report.append('')


def check_pubmed(data, report):
    report.append('## PubMed references\n')
    refs = {k: r for k, r in data.get('references', {}).items() if r.get('pmid')}
    ids = [r['pmid'] for r in refs.values()]
    found = {}
    for i in range(0, len(ids), 100):
        j = fetch_json(EUTILS + 'esummary.fcgi?db=pubmed&retmode=json&id=' + ','.join(ids[i:i + 100]))
        found.update({k: v for k, v in j.get('result', {}).items() if k != 'uids'})
        time.sleep(0.4)
    problems = 0
    for key, r in refs.items():
        rec = found.get(r['pmid'])
        if not rec or 'error' in rec:
            report.append(f"- {key}: PMID {r['pmid']} not found")
            problems += 1
            continue
        title = rec.get('title', '').rstrip('.').lower()
        if not title.startswith(r['title'].lower()[:40]) or abs(int(rec.get('pubdate', '0')[:4] or 0) - r['year']) > 1:
            report.append(f"- {key}: PubMed has \"{rec.get('title', '')[:80]}\" ({rec.get('pubdate', '')[:4]})")
            problems += 1
    report.append(f'{len(refs)} references checked, {problems} problems\n')


def check_labels(data, report):
    report.append('## FDA labels\n')
    labels = {k: r for k, r in data.get('references', {}).items() if r.get('setid')}
    newer = 0
    for key, r in labels.items():
        try:
            j = fetch_json(OPENFDA + '?limit=1&search=' + urllib.parse.quote(f'set_id:"{r["setid"]}"'))
            eff = j['results'][0].get('effective_time', '')
        except Exception as err:
            report.append(f'- {key}: label not found ({err})')
            continue
        current = f'{eff[:4]}-{eff[4:6]}-{eff[6:8]}'
        if current > r.get('revised', ''):
            report.append(f"- {key}: newer revision {current} (recorded {r.get('revised', '-')}); check the values that cite it")
            newer += 1
        time.sleep(0.3)
    report.append(f'{len(labels)} labels checked, {newer} with a newer revision\n')


def gtopdb_rows():
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / 'gtopdb_interactions.csv'
    if not f.exists() or time.time() - f.stat().st_mtime > 7 * 86400:
        f.write_bytes(fetch(GTOPDB_CSV, timeout=300))
    lines = f.read_text(encoding='utf-8').splitlines()
    version = lines[0].strip('"# ')
    return version, list(csv.DictReader(io.StringIO('\n'.join(lines[1:]))))


def chembl_molecule(name):
    j = fetch_json(CHEMBL + 'molecule.json?pref_name__iexact=' + urllib.parse.quote(name.upper()))
    return j['molecules'][0]['molecule_chembl_id'] if j['molecules'] else None


def check_ki(data, report):
    cfg = data['sourceChecks']
    tol = cfg.get('foldTolerance', 2)
    version, rows = gtopdb_rows()
    report.append(f'## Receptor affinities (Ki)\n\nGuide to Pharmacology: {version}; ChEMBL: live API; tolerance {tol}-fold\n')
    report.append('| Drug | Subunit | App (nM) | Guide to Pharmacology (nM) | ChEMBL median (nM, n) | Flag |')
    report.append('| --- | --- | --- | --- | --- | --- |')
    for key, drug in data['drugs'].items():
        try:
            ki = get_path(drug, cfg['kiPath'])
        except (KeyError, TypeError):
            continue
        cid = chembl_molecule(drug['name'])
        for sub, app in ki.items():
            gt = [float(r['Original Affinity Median nm']) for r in rows
                  if r['Ligand'].lower() == drug['name'].lower() and r['Target'] == cfg['gtopdbTargets'].get(sub)
                  and r['Target Species'] == cfg.get('species', 'Human') and r['Original Affinity Units'] == 'Ki'
                  and r['Original Affinity Median nm']]
            ch = []
            if cid and sub in cfg['chemblTargets']:
                j = fetch_json(CHEMBL + f"activity.json?molecule_chembl_id={cid}&target_chembl_id={cfg['chemblTargets'][sub]}&standard_type=Ki&limit=200")
                ch = [float(a['standard_value']) for a in j['activities'] if a['standard_value'] and a['standard_units'] == 'nM' and a['standard_relation'] in ('=', None)]
                time.sleep(0.2)
            if not gt and not ch:
                continue
            ref = statistics.median(gt or ch)
            flag = ''
            if app == 'nd':
                flag = 'app: not determined'
            elif app is None:
                flag = 'app: not bound'
            elif max(app, ref) / min(app, ref) > tol:
                flag = f'{max(app, ref) / min(app, ref):.1f}-fold'
            report.append(f"| {drug['name']} | {sub} | {'not bound' if app is None else app} | "
                          f"{', '.join(f'{v:.3g}' for v in gt) or '-'} | {f'{statistics.median(ch):.3g} ({len(ch)})' if ch else '-'} | {flag} |")
    report.append('')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--skip-pubmed', action='store_true')
    ap.add_argument('--skip-labels', action='store_true')
    ap.add_argument('--skip-ki', action='store_true')
    ap.add_argument('--out', help='write the report to this Markdown file')
    a = ap.parse_args()
    data = json.loads(DATA.read_text(encoding='utf-8'))
    report = [f'# Source check: {DATA.relative_to(ROOT)}\n', time.strftime('Run %Y-%m-%d %H:%M\n')]
    check_sources(data, report)
    if not a.skip_pubmed:
        check_pubmed(data, report)
    if not a.skip_labels:
        check_labels(data, report)
    if not a.skip_ki and 'sourceChecks' in data:
        check_ki(data, report)
    text = '\n'.join(report)
    if a.out:
        Path(a.out).write_text(text, encoding='utf-8')
    print(text)


if __name__ == '__main__':
    main()
