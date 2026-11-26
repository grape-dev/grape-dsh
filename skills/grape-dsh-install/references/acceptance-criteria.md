# Acceptance Criteria — grape-dsh-install

The skill is accepted when every row is true.

| # | Criterion | Evidence |
|---|---|---|
| 1 | `SKILL.md` frontmatter parses as YAML | `name`, `description`, `tags` present; no `version` |
| 2 | Frontmatter name matches the directory | `name: grape-dsh-install` |
| 3 | Description contains feature summary + triggers | English and Chinese trigger phrases present |
| 4 | Required sections exist | Overview / Prerequisites / Workflow / Core Commands / Parameter Confirmation / Reference Documents |
| 5 | Idempotent install | second `install.sh` run prints `skipped: already-present` |
| 6 | Preflight covers four tools | Node >= 18, Python >= 3.10, grape >= 0.3.3, dsh >= 0.2.0 |
| 7 | Acceptance covers three checks | plugin list, `--dump-config` bundle, `grape auth profile` |
| 8 | Failure semantics | stop at first failed gate; command + exit code + first 20 lines |
| 9 | Token safety | no token value printed by any script; only set/length |
| 10 | Profile isolation | only the named profile is touched |
| 11 | Huawei Cloud gate explained | `SKILL.md` + `references/cloud-credential-gate.md` state N/A; no `hcloud` command |
| 12 | Cross-platform | bash and PowerShell variants for preflight/install/verify |
| 13 | Package limits | total files <= 30, SKILL.md <= 500 lines, allowed extensions only |
| 14 | Phase artifacts retained | `phase-1-summary.json` ... `phase-6-summary.json` present (Issue #24 requirement) |
| 15 | No runtime coupling | files are markdown/json/sh/ps1; not referenced by tsconfig or test globs |