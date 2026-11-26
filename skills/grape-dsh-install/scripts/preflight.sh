#!/usr/bin/env bash
# GATE 1 — toolchain preflight for grape-dsh. Read-only, prints versions, never prints secrets.
set -u

FAIL=0

ver_ge() {
  # ver_ge <actual> <required> — true when actual >= required (numeric dotted compare)
  awk -v a="$1" -v b="$2" 'BEGIN {
    gsub(/^v/, "", a); gsub(/^[^0-9]*/, "", a)
    gsub(/^v/, "", b); gsub(/^[^0-9]*/, "", b)
    n = split(a, x, "."); m = split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      av = (i <= n) ? x[i] + 0 : 0
      bv = (i <= m) ? y[i] + 0 : 0
      if (av > bv) exit 0
      if (av < bv) exit 1
    }
    exit 0
  }'
}

check() {
  # check <name> <min> <actual> <command>
  local name="$1" min="$2" actual="$3" cmd="$4"
  if [ -z "$actual" ]; then
    printf 'FAIL  %-7s missing (command: %s)\n' "$name" "$cmd"
    FAIL=1
    return
  fi
  if ver_ge "$actual" "$min"; then
    printf 'PASS  %-7s %s (require >= %s)\n' "$name" "$actual" "$min"
  else
    printf 'FAIL  %-7s %s is below required %s (command: %s)\n' "$name" "$actual" "$min" "$cmd"
    FAIL=1
  fi
}

resolve_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi
  if [ -n "${LOCALAPPDATA:-}" ]; then
    candidate="$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  candidate="$HOME/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

echo "== grape-dsh preflight =="

node_v="$(node --version 2>/dev/null | head -n1 | sed 's/^v//')"
check node 18 "$node_v" "node --version"

if command -v python3 >/dev/null 2>&1; then
  py_v="$(python3 --version 2>&1 | head -n1 | sed 's/^Python //')"
  py_cmd="python3 --version"
elif command -v py >/dev/null 2>&1; then
  py_v="$(py -3 --version 2>&1 | head -n1 | sed 's/^Python //')"
  py_cmd="py -3 --version"
elif command -v python >/dev/null 2>&1; then
  py_v="$(python --version 2>&1 | head -n1 | sed 's/^Python //')"
  py_cmd="python --version"
else
  py_v=""
  py_cmd="python3 --version (or py -3 --version)"
fi
check python 3.10 "$py_v" "$py_cmd"

if command -v grape >/dev/null 2>&1; then
  grape_v="$(grape --version 2>/dev/null | head -n1 | sed 's/^grape //')"
  check grape 0.3.3 "$grape_v" "grape --version"
else
  echo 'FAIL  grape   missing (install the PyPI package "grape-cli": python -m pip install "grape-cli>=0.3.3")'
  FAIL=1
fi

dsh_bin="$(resolve_dsh || true)"
if [ -z "$dsh_bin" ]; then
  echo 'FAIL  dsh     missing (command: dsh --version)'
  echo '              Install dsh ("npm install -g @deepseek-ai/dsh") or the DeepSeek Harness desktop app, then re-run.'
  echo '              Manual check: dsh --version'
  echo '              Desktop entry: %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  FAIL=1
else
  dsh_v="$("$dsh_bin" --version 2>/dev/null | head -n1)"
  if [ "$dsh_bin" != "$(command -v dsh 2>/dev/null || true)" ]; then
    check dsh 0.2.0 "$dsh_v" "$dsh_bin --version (desktop entry, not on PATH)"
  else
    check dsh 0.2.0 "$dsh_v" "dsh --version"
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "GATE 1 FAILED — install the missing tool(s) with AGENT-DEPLOYMENT-GUIDE.md §2, then re-run."
  exit 1
fi

echo "GATE 1 PASSED"