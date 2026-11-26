# Verification Method

Every gate is decided by a command exit code plus an explicit content assertion. Nothing is marked
passed on intent.

## GATE 1 — toolchain

`scripts/preflight.sh` / `scripts/preflight.ps1` prints one line per dependency:

```
PASS  node    v22.x (require >= 18)
PASS  python  3.12.x (require >= 3.10)
PASS  grape   0.3.x (require >= 0.3.3)
PASS  dsh     0.2.x (require >= 0.2.0)
```

Exit `0` = all pass. Any `FAIL` line means the gate failed; the script prints the command to run.

## GATE 2 — install

`scripts/install.sh <profile> [spec]`:

1. `dsh plugin --profile <profile> list` must exit 0 (this also creates the profile — base-only when
   it did not exist, see Step 0 in `SKILL.md`).
2. If the listing already contains `@grape-dev/grape-dsh`, print `skipped: already-present` and exit 0.
3. Otherwise run `dsh plugin --profile <profile> add <spec>`; exit code must be 0.

On failure the script prints the exact command, its exit code and the first 20 lines of output.

## GATE 3 — acceptance

`scripts/verify.sh <profile>`:

| # | Assertion | Source of truth |
|---|---|---|
| 3.1 | `@grape-dev/grape-dsh` in `dsh plugin --profile <profile> list` | stdout contains the package name |
| 3.2 | `grape-tools` in `dsh --profile <profile> --dump-config` | stdout contains the module id |
| 3.3 | `GRAPE_CLI_MODE=USER grape auth profile --json-out` exits 0 | command exit code |

The scripts deliberately separate CLI-side acceptance from the in-product smoke test:

- CLI-side (automatable): gates above.
- User-side (cannot be asserted by the agent): start dsh, run the prompt, see the call card.
  Report it as `awaiting-user`, not `pass`.

## Reporting template

```json
{
  "status": "ok | failed",
  "profile": "grape",
  "platform": "linux | darwin | windows",
  "versions": {"node": "v22.x", "python": "3.12.x", "grape": "0.3.x", "dsh": "0.2.x"},
  "plugin": {"spec": "@grape-dev/grape-dsh", "mounted": true},
  "gates": {"1_preflight": "pass", "2_install": "pass", "3_acceptance": "pass"},
  "in_product": "awaiting-user",
  "capabilities": ["pipeline trigger/status", "issue lifecycle", "scenes", "repos", "skills", "knowledge", "dashboard", "templates"]
}
```

If `status = failed`, add `failed_gate`, the exact command, exit code and trimmed output.