#!/usr/bin/env bash
# GATE 3 — post-install acceptance. Usage: verify.sh [profile]   (default: $DSH_PROFILE, then grape)
# Checks: plugin listed, grape-tools mounted, user auth profile reachable.
# Never prints token values — only whether GRAPE_API_TOKEN is set.
# Gate output is kept in memory only; dump-config is never written to disk.
set -u

PROFILE="${1:-${DSH_PROFILE:-grape}}"
PKG="@grape-dev/grape-dsh"
FAIL=0
GATE_OUT=""

gate_cmd() {
  # gate_cmd <label> <command...> — runs once, keeps output in memory, and reports
  # exit code + first 20 lines on failure. On success the output is in GATE_OUT.
  local label="$1"; shift
  echo "+ $*"
  local out code
  out="$("$@" 2>&1)"
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "FAIL [$label] exit=$code"
    printf '%s\n' "$out" | head -n 20
    FAIL=1
    return 1
  fi
  GATE_OUT="$out"
  return 0
}

echo "== grape-dsh acceptance =="
echo "profile: $PROFILE"

# 3.1 plugin listed
if gate_cmd plugin-list dsh plugin --profile "$PROFILE" list; then
  if printf '%s\n' "$GATE_OUT" | grep -Fq "$PKG"; then
    echo "PASS  plugin-list: $PKG present"
  else
    echo "FAIL  plugin-list: $PKG not found in profile $PROFILE"
    FAIL=1
  fi
fi

# 3.2 bundle mounted
if gate_cmd dump-config dsh --profile "$PROFILE" --dump-config; then
  if printf '%s\n' "$GATE_OUT" | grep -Fq "grape-tools"; then
    echo "PASS  dump-config: grape-tools mounted"
  else
    echo "FAIL  dump-config: grape-tools not mounted (see AGENT-DEPLOYMENT-GUIDE.md §4 Repair B)"
    FAIL=1
  fi
fi

# 3.3 user auth profile
if [ -z "${GRAPE_API_TOKEN:-}" ]; then
  echo "FAIL  auth-profile: GRAPE_API_TOKEN is not set (a user-level grape_ key is required)"
  FAIL=1
else
  echo "info  auth-profile: GRAPE_API_TOKEN set (${#GRAPE_API_TOKEN} chars, value not printed)"
  if gate_cmd auth-profile env GRAPE_CLI_MODE=USER grape auth profile --json-out; then
    echo "PASS  auth-profile: user profile reachable"
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "GATE 3 FAILED — stop here and report the failing command, exit code and output above."
  exit 1
fi

echo "GATE 3 PASSED"
echo "note: in-product smoke test is user-side — start dsh --profile $PROFILE and ask:"
echo "      Which repositories are managed in Grape?"