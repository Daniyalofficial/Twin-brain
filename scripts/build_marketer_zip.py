#!/usr/bin/env python3
"""Build the loadable MarketerTwin extension ZIP.

Usage:  python3 scripts/build_marketer_zip.py [out_path]
Default out: MarketerTwin-v1.0.zip at the repo root (manifest.json sits at
the ZIP root, so "Load unpacked" works straight from the extracted folder).
"""
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'marketer'
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'MarketerTwin-v1.0.zip'

SKIP_DIRS = {'icons-src', '__pycache__', 'node_modules', '.git'}
SKIP_SUFFIXES = ('.pyc', '.DS_Store')

count = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted(SRC.rglob('*')):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(SRC).parts
        if any(part in SKIP_DIRS for part in rel_parts):
            continue
        if path.name.endswith(SKIP_SUFFIXES):
            continue
        z.write(path, path.relative_to(SRC).as_posix())
        count += 1

size = OUT.stat().st_size
print(f'{OUT} — {count} files, {size / 1024:.0f} KB')
