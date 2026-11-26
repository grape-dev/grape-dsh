#!/usr/bin/env bash
# Test runner for the grape-dsh-install skill.
# Reads templates/test-vars.json and executes read-only cases. Mutating cases are skipped unless
# --include-mutating is passed. Only commands from a strict whitelist are executed.
set -u

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CASES_FILE="$SKILL_DIR/templates/test-vars.json"
INCLUDE_MUTATING=0
[ "${1:-}" = "--include-mutating" ] && INCLUDE_MUTATING=1

if [ ! -f "$CASES_FILE" ]; then
  echo "FATAL: missing $CASES_FILE — regenerate it before running tests"
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN=python
else
  echo "FATAL: python3/python is required to run the test cases"
  exit 1
fi

"$PYTHON_BIN" - "$CASES_FILE" "$INCLUDE_MUTATING" <<'PY'
import json, os, shlex, shutil, subprocess, sys

cases_path, include_mutating = sys.argv[1], sys.argv[2] == "1"
with open(cases_path, encoding="utf-8") as fh:
    data = json.load(fh)

allowed = {"node", "python3", "py", "grape", "dsh", "echo", "cat", "env"}
passed = failed = skipped = 0

for case in data.get("test_cases", []):
    cid, name = case.get("id", "?"), case.get("name", "")
    command = case.get("command", "")
    variants = case.get("command_variants") or []
    needs = case.get("requires_env") or []
    mutating = bool(case.get("mutating"))

    missing = [k for k in needs if not os.environ.get(k)]
    if missing:
        print(f"SKIP {cid} {name} — missing env: {', '.join(missing)}")
        skipped += 1
        continue
    if mutating and not include_mutating:
        print(f"SKIP {cid} {name} — mutating case (pass --include-mutating to run)")
        skipped += 1
        continue

    if variants:
        command = next(
            (v for v in variants if shutil.which(shlex.split(v, posix=True)[0])),
            "",
        )
        if not command:
            print(f"SKIP {cid} {name} — none of the command variants is available: {variants}")
            skipped += 1
            continue

    try:
        argv = shlex.split(command, posix=True)
    except ValueError as exc:
        print(f"FAIL {cid} {name} — cannot parse command: {exc}")
        failed += 1
        continue
    if not argv or argv[0] not in allowed:
        print(f"FAIL {cid} {name} — command not in whitelist: {argv[:1]}")
        failed += 1
        continue
    if not shutil.which(argv[0]):
        print(f"FAIL {cid} {name} — executable not found: {argv[0]}")
        failed += 1
        continue

    resolved = shutil.which(argv[0])
    run_kwargs = {"capture_output": True, "text": True, "timeout": 120,
                  "encoding": "utf-8", "errors": "replace"}
    try:
        if os.name == "nt" and resolved.lower().endswith((".cmd", ".bat")):
            proc = subprocess.run(subprocess.list2cmdline(argv), shell=True, **run_kwargs)
        else:
            proc = subprocess.run(argv, **run_kwargs)
    except subprocess.TimeoutExpired:
        print(f"FAIL {cid} {name} — timed out after 120s")
        failed += 1
        continue
    if proc.returncode == 0:
        print(f"PASS {cid} {name}")
        passed += 1
    else:
        print(f"FAIL {cid} {name} — exit={proc.returncode}")
        lines = (proc.stdout + proc.stderr).splitlines()[:20]
        for line in lines:
            print(f"      {line}")
        failed += 1

print(f"\nsummary: {passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
PY