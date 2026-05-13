### generated with love by Claude AI
#!/usr/bin/env bash
set -euo pipefail

######################################################################################
# Diff merged lcov files between schema pairs for all libraries.
# Usage: ./scripts/diff-coverage.sh [coverage/merged]
#
# Expects merged lcov files like: coverage/merged/angular_random.info
# Produces:
#   coverage/diff/<library>_<schemaA>_vs_<schemaB>/          <- HTML reports
#   coverage/diff/diff-summary.csv                           <- CSV summary
######################################################################################

MERGED_DIR="${1:-coverage/merged}"
DIFF_DIR="$(dirname "$MERGED_DIR")/diff"
mkdir -p "$DIFF_DIR"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CSV="$DIFF_DIR/diff-summary.csv"
echo "library,schema_a,schema_b,lines_only_in_a,lines_only_in_b,lines_in_both,fns_only_in_a,fns_only_in_b,branches_only_in_a,branches_only_in_b" > "$CSV"

SCHEMA_PAIRS=(
  "random syntest"
  "random typescript"
  "syntest typescript"
)

# Get all libraries from merged files
libraries=()
for f in "$MERGED_DIR"/*_random.info "$MERGED_DIR"/*_syntest.info "$MERGED_DIR"/*_typescript.info; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f" .info)"
  lib="${base%_*}"
  # Deduplicate
  if [[ ! " ${libraries[*]} " =~ " ${lib} " ]]; then
    libraries+=("$lib")
  fi
done

if [[ ${#libraries[@]} -eq 0 ]]; then
  echo "No merged .info files found in $MERGED_DIR" >&2
  exit 1
fi

echo "Found ${#libraries[@]} libraries: ${libraries[*]}"
echo ""

for library in "${libraries[@]}"; do
  for pair in "${SCHEMA_PAIRS[@]}"; do
    schema_a="${pair%% *}"
    schema_b="${pair##* }"

    file_a="$MERGED_DIR/${library}_${schema_a}.info"
    file_b="$MERGED_DIR/${library}_${schema_b}.info"

    if [[ ! -f "$file_a" ]]; then
      echo "Skipping $library $schema_a vs $schema_b: missing $file_a"
      continue
    fi
    if [[ ! -f "$file_b" ]]; then
      echo "Skipping $library $schema_a vs $schema_b: missing $file_b"
      continue
    fi

    label="${library}_${schema_a}_vs_${schema_b}"
    out_dir="$DIFF_DIR/$label"
    mkdir -p "$out_dir"

    echo "=== $label ==="

    # --- Compute lines only in A (covered by A, not B) ---
    # Use lcov subtraction: A - B = lines hit in A but with 0 count in B
    # lcov doesn't have native subtraction, so we use a Python helper inline
    python3 - "$file_a" "$file_b" "$out_dir" "$schema_a" "$schema_b" <<'PYEOF'
import sys
import re
from collections import defaultdict

file_a, file_b, out_dir, schema_a, schema_b = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]

def parse_lcov(path):
    """Parse lcov into {filename: {line: count}}"""
    data = defaultdict(lambda: defaultdict(int))
    fn_data = defaultdict(lambda: defaultdict(int))   # {file: {fn_name: count}}
    br_data = defaultdict(lambda: defaultdict(int))   # {file: {(line,block,branch): count}}
    current = None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith('SF:'):
                current = line[3:]
            elif line.startswith('DA:') and current:
                parts = line[3:].split(',')
                lineno, count = int(parts[0]), int(parts[1])
                data[current][lineno] = count
            elif line.startswith('FNDA:') and current:
                parts = line[5:].split(',', 1)
                count, name = int(parts[0]), parts[1]
                fn_data[current][name] = count
            elif line.startswith('BRDA:') and current:
                parts = line[5:].split(',')
                key = (int(parts[0]), int(parts[1]), int(parts[2]))
                count = 0 if parts[3] == '-' else int(parts[3])
                br_data[current][key] = count
    return data, fn_data, br_data

data_a, fn_a, br_a = parse_lcov(file_a)
data_b, fn_b, br_b = parse_lcov(file_b)

all_files = set(data_a.keys()) | set(data_b.keys())

lines_only_a = 0   # hit by A, not B
lines_only_b = 0   # hit by B, not A
lines_both   = 0   # hit by both
fns_only_a   = 0
fns_only_b   = 0
brs_only_a   = 0
brs_only_b   = 0

# Per-file diff for HTML generation
diff_lines = []  # (file, lineno, status) status: only_a / only_b / both / neither

for fname in sorted(all_files):
    a_lines = data_a.get(fname, {})
    b_lines = data_b.get(fname, {})
    all_lines = set(a_lines.keys()) | set(b_lines.keys())
    for lineno in sorted(all_lines):
        a_hit = a_lines.get(lineno, 0) > 0
        b_hit = b_lines.get(lineno, 0) > 0
        if a_hit and b_hit:
            lines_both += 1
        elif a_hit:
            lines_only_a += 1
            diff_lines.append((fname, lineno, 'only_a'))
        elif b_hit:
            lines_only_b += 1
            diff_lines.append((fname, lineno, 'only_b'))

    # Functions
    a_fns = fn_a.get(fname, {})
    b_fns = fn_b.get(fname, {})
    for fn in set(a_fns) | set(b_fns):
        a_hit = a_fns.get(fn, 0) > 0
        b_hit = b_fns.get(fn, 0) > 0
        if a_hit and not b_hit:
            fns_only_a += 1
        elif b_hit and not a_hit:
            fns_only_b += 1

    # Branches
    a_brs = br_a.get(fname, {})
    b_brs = br_b.get(fname, {})
    for br in set(a_brs) | set(b_brs):
        a_hit = a_brs.get(br, 0) > 0
        b_hit = b_brs.get(br, 0) > 0
        if a_hit and not b_hit:
            brs_only_a += 1
        elif b_hit and not a_hit:
            brs_only_b += 1

# Write CSV row
with open(f"{out_dir}/../diff-summary.csv", 'a') as f:
    lib = file_a.split('/')[-1].rsplit('_', 1)[0]
    f.write(f"{lib},{schema_a},{schema_b},{lines_only_a},{lines_only_b},{lines_both},{fns_only_a},{fns_only_b},{brs_only_a},{brs_only_b}\n")

print(f"  lines only in {schema_a}: {lines_only_a}")
print(f"  lines only in {schema_b}: {lines_only_b}")
print(f"  lines in both:            {lines_both}")
print(f"  fns only in {schema_a}:   {fns_only_a}")
print(f"  fns only in {schema_b}:   {fns_only_b}")
print(f"  branches only in {schema_a}: {brs_only_a}")
print(f"  branches only in {schema_b}: {brs_only_b}")

# Write HTML diff report
html_path = f"{out_dir}/index.html"
with open(html_path, 'w') as f:
    f.write(f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Coverage diff: {schema_a} vs {schema_b}</title>
<style>
  body {{ font-family: monospace; font-size: 13px; margin: 20px; background: #1e1e1e; color: #ccc; }}
  h1 {{ color: #fff; font-size: 16px; }}
  .summary {{ background: #2a2a2a; padding: 12px; border-radius: 6px; margin-bottom: 20px; }}
  .summary span {{ margin-right: 24px; }}
  .only_a {{ color: #6fcf97; }}
  .only_b {{ color: #56b4e9; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th {{ background: #333; color: #fff; padding: 6px 12px; text-align: left; position: sticky; top: 0; }}
  td {{ padding: 4px 12px; border-bottom: 1px solid #2a2a2a; }}
  tr:hover td {{ background: #2a2a2a; }}
  .tag-only_a {{ background: #1a3a2a; border-left: 3px solid #6fcf97; }}
  .tag-only_b {{ background: #1a2a3a; border-left: 3px solid #56b4e9; }}
  .filename {{ color: #aaa; font-size: 11px; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; }}
  .badge-a {{ background: #6fcf97; color: #000; }}
  .badge-b {{ background: #56b4e9; color: #000; }}
</style>
</head>
<body>
<h1>Coverage diff: <span class="only_a">{schema_a}</span> vs <span class="only_b">{schema_b}</span></h1>
<div class="summary">
  <span class="only_a">&#9632; only in {schema_a}: {lines_only_a} lines, {fns_only_a} fns, {brs_only_a} branches</span>
  <span class="only_b">&#9632; only in {schema_b}: {lines_only_b} lines, {fns_only_b} fns, {brs_only_b} branches</span>
  <span>both: {lines_both} lines</span>
</div>
<table>
<thead><tr><th>Schema</th><th>File</th><th>Line</th></tr></thead>
<tbody>
""")
    for fname, lineno, status in diff_lines:
        badge = f'<span class="badge badge-a">{schema_a}</span>' if status == 'only_a' else f'<span class="badge badge-b">{schema_b}</span>'
        f.write(f'<tr class="tag-{status}"><td>{badge}</td><td class="filename" title="{fname}">{fname}</td><td>{lineno}</td></tr>\n')
    f.write("</tbody></table></body></html>\n")

print(f"  HTML diff -> {html_path}")
PYEOF

    echo ""
  done
done

echo "============================="
echo "CSV summary: $CSV"
echo "HTML diffs:  $DIFF_DIR/<library>_<schemaA>_vs_<schemaB>/index.html"