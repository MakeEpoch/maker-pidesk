#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python_bin=${PYTHON:-python3}
"$python_bin" - <<'PY'
import ast, json
from pathlib import Path
for directory in ('app/src', 'tests', 'ops/tools', 'ops/scripts'):
    for path in Path(directory).rglob('*.py'):
        ast.parse(path.read_text(), filename=str(path))
json.loads(Path('app/config/pidesk.example.json').read_text())
print('Python syntax and example config: OK')
PY
for path in ops/scripts/*.sh; do bash -n "$path"; done
if command -v node >/dev/null; then
  shopt -s nullglob
  js_files=(app/web/*.js)
  shopt -u nullglob
  if [ ${#js_files[@]} -gt 0 ]; then
    for path in "${js_files[@]}"; do node --check "$path"; done
  fi
else
  printf '%s\n' 'Node unavailable; JavaScript syntax check skipped.'
fi
PYTHONPATH=app/src "$python_bin" -m unittest discover -s tests -v
