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
    python3 - "$file_a" "$file_b" "$out_dir" "$schema_a" "$schema_b" "$REPO_ROOT" <<'PYEOF'
import sys
import html as htmllib
from collections import defaultdict
from pathlib import Path

file_a, file_b, out_dir, schema_a, schema_b, repo_root = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
)

def parse_lcov(path):
    """Parse lcov into {filename: {line: count}}"""
    data = defaultdict(lambda: defaultdict(int))
    fn_data = defaultdict(lambda: defaultdict(int))
    br_data = defaultdict(lambda: defaultdict(int))
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

def read_source_lines(fname):
    """Try to read source lines from the file path as-is, or rebased under repo_root."""
    candidates = [
        Path(fname),
        Path(repo_root) / Path(fname).relative_to('/') if Path(fname).is_absolute() else Path(repo_root) / fname,
    ]
    # Also try stripping everything up to node_modules/
    nm = 'node_modules/'
    if nm in fname:
        rel = fname[fname.index(nm):]
        candidates.append(Path(repo_root) / rel)
    for p in candidates:
        try:
            return p.read_text(errors='replace').splitlines()
        except Exception:
            pass
    return None

def get_line(source_lines, lineno):
    """Return the source line (1-indexed), or empty string if unavailable."""
    if source_lines and 1 <= lineno <= len(source_lines):
        return source_lines[lineno - 1]
    return ''

data_a, fn_a, br_a = parse_lcov(file_a)
data_b, fn_b, br_b = parse_lcov(file_b)

all_files = set(data_a.keys()) | set(data_b.keys())

lines_only_a = 0
lines_only_b = 0
lines_both   = 0
fns_only_a   = 0
fns_only_b   = 0
brs_only_a   = 0
brs_only_b   = 0

# (file, lineno, status, source_line)
diff_lines = []

# Cache source files
source_cache = {}

for fname in sorted(all_files):
    if fname not in source_cache:
        source_cache[fname] = read_source_lines(fname)
    src = source_cache[fname]

    a_lines = data_a.get(fname, {})
    b_lines = data_b.get(fname, {})
    all_line_nos = set(a_lines.keys()) | set(b_lines.keys())
    for lineno in sorted(all_line_nos):
        a_hit = a_lines.get(lineno, 0) > 0
        b_hit = b_lines.get(lineno, 0) > 0
        if a_hit and b_hit:
            lines_both += 1
        elif a_hit:
            lines_only_a += 1
            diff_lines.append((fname, lineno, 'only_a', get_line(src, lineno)))
        elif b_hit:
            lines_only_b += 1
            diff_lines.append((fname, lineno, 'only_b', get_line(src, lineno)))

    a_fns = fn_a.get(fname, {})
    b_fns = fn_b.get(fname, {})
    for fn in set(a_fns) | set(b_fns):
        a_hit = a_fns.get(fn, 0) > 0
        b_hit = b_fns.get(fn, 0) > 0
        if a_hit and not b_hit:
            fns_only_a += 1
        elif b_hit and not a_hit:
            fns_only_b += 1

    a_brs = br_a.get(fname, {})
    b_brs = br_b.get(fname, {})
    for br in set(a_brs) | set(b_brs):
        a_hit = a_brs.get(br, 0) > 0
        b_hit = b_brs.get(br, 0) > 0
        if a_hit and not b_hit:
            brs_only_a += 1
        elif b_hit and not a_hit:
            brs_only_b += 1

# CSV row
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

# HTML diff report
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
  .summary {{ background: #2a2a2a; padding: 12px; border-radius: 6px; margin-bottom: 20px; line-height: 2; }}
  .summary span {{ margin-right: 24px; }}
  .only_a {{ color: #6fcf97; }}
  .only_b {{ color: #56b4e9; }}
  table {{ border-collapse: collapse; width: 100%; table-layout: fixed; }}
  col.col-badge  {{ width: 90px; }}
  col.col-file   {{ width: 30%; }}
  col.col-lineno {{ width: 60px; }}
  col.col-source {{ width: auto; }}
  th {{ background: #333; color: #fff; padding: 6px 12px; text-align: left; position: sticky; top: 0; z-index: 1; }}
  td {{ padding: 4px 12px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }}
  tr:hover td {{ background: #252525; }}
  .tag-only_a {{ background: #1a3a2a; border-left: 3px solid #6fcf97; }}
  .tag-only_b {{ background: #1a2a3a; border-left: 3px solid #56b4e9; }}
  .filename {{ color: #aaa; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .lineno {{ color: #666; text-align: right; user-select: none; }}
  .source {{ white-space: pre; overflow-x: auto; color: #e0e0e0; }}
  .source.no-source {{ color: #555; font-style: italic; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; }}
  .badge-a {{ background: #6fcf97; color: #000; }}
  .badge-b {{ background: #56b4e9; color: #000; }}
  input#filter {{ background: #2a2a2a; border: 1px solid #444; color: #ccc; padding: 6px 10px;
                  border-radius: 4px; width: 300px; margin-bottom: 12px; font-family: monospace; }}
</style>
</head>
<body>
<h1>Coverage diff: <span class="only_a">{schema_a}</span> vs <span class="only_b">{schema_b}</span></h1>
<div class="summary">
  <span class="only_a">&#9632; only in {schema_a}: {lines_only_a} lines &nbsp;{fns_only_a} fns &nbsp;{brs_only_a} branches</span><br>
  <span class="only_b">&#9632; only in {schema_b}: {lines_only_b} lines &nbsp;{fns_only_b} fns &nbsp;{brs_only_b} branches</span><br>
  <span style="color:#888">both: {lines_both} lines</span>
</div>
<input id="filter" type="text" placeholder="Filter by file or source...">
<table>
<colgroup>
  <col class="col-badge">
  <col class="col-file">
  <col class="col-lineno">
  <col class="col-source">
</colgroup>
<thead><tr><th>Schema</th><th>File</th><th>Line</th><th>Source</th></tr></thead>
<tbody id="tbody">
""")
    for fname, lineno, status, src_line in diff_lines:
        badge = (f'<span class="badge badge-a">{schema_a}</span>'
                 if status == 'only_a'
                 else f'<span class="badge badge-b">{schema_b}</span>')
        short_fname = fname.split('node_modules/')[-1] if 'node_modules/' in fname else fname
        src_escaped = htmllib.escape(src_line.rstrip()) if src_line.strip() else ''
        src_class = 'source' if src_escaped else 'source no-source'
        src_display = src_escaped if src_escaped else '(source unavailable)'
        f.write(
            f'<tr class="tag-{status}">'
            f'<td>{badge}</td>'
            f'<td class="filename" title="{htmllib.escape(fname)}">{htmllib.escape(short_fname)}</td>'
            f'<td class="lineno">{lineno}</td>'
            f'<td class="{src_class}">{src_display}</td>'
            f'</tr>\n'
        )
    f.write("""</tbody>
</table>
<script>
  const input = document.getElementById('filter');
  const rows = Array.from(document.querySelectorAll('#tbody tr'));
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    rows.forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
</script>
</body></html>
""")

print(f"  HTML diff -> {html_path}")
PYEOF

    echo ""
  done
done

echo "============================="
echo "CSV summary: $CSV"
echo "HTML diffs:  $DIFF_DIR/<library>_<schemaA>_vs_<schemaB>/index.html"