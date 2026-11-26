# Troubleshooting

Nine failures measured on a real install. Each row names the exact symptom, the cause and the
repair that worked.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `ERR_PNPM_FETCH_404` resolving `@deepseek-ai/dsh-type-meta` | root `peerDependencies` + pnpm `auto-install-peers` resolving unpublished internal packages | delete `peerDependencies` from `package.json` and keep only `@deepseek-ai/schemastery`, `@types/node`, `esbuild`, `typescript` in `devDependencies`, then reinstall |
| 2 | `spawn EPERM` from `scripts/build-client.mjs` | the DSH sandbox blocks child-process pipes, so the esbuild native service cannot start | re-run that single command with danger-full-access; do not swap the bundler |
| 3 | `SyntaxError: Unexpected token '\uFEFF'` | `package.json` was rewritten by PowerShell with a UTF-8 BOM | rewrite it with `[System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))` |
| 4 | `[grape-dsh] GRAPE_API_TOKEN is not set` after `install_bundle` | plugin `apply()` requires a user-level token | write the `config.token` line in the profile `cordis.patch.yml`, or set `GRAPE_API_TOKEN` and restart dsh; `application: failed` at install time is expected |
| 5 | `authentication failed: Session expired` | the `token:` field was filled with a URL, or the `grape_` key expired | check that `token:` starts with `grape_`; recreate the key in Grape Web -> Settings |
| 6 | `grape CLI: ... not found` inside the plugin | the dsh process PATH has no venv `Scripts` directory | set `config.bin` (or `GRAPE_CLI_BIN`) to the absolute `grape`/`grape.exe` path |
| 7 | `base_url unreachable: http://localhost:8000` | only the CLI is used and no base URL was configured; the CLI does not read the plugin config | set `GRAPE_BASE_URL` (or the `config.baseUrl` line) to the real Grape origin |
| 8 | Every gate passes, but the user sees no plugin or panel after restarting the desktop app | the package was installed into a profile the app never boots — the desktop app always boots `desktop`, while `grape` is only served by `dsh grape` | reinstall into the profile the app boots (`$DSH_PROFILE`), then restart it |
| 9 | `dsh <name>` starts without a UI, or `--dump-config` has no web app rows | `dsh plugin --profile <name> list` created a base-only profile (`@deepseek-ai/dsh-base`, no app bundle) | create the profile from a shipped template first: `dsh --profile <name> --from-default-profile web --dump-config` |

Two rules keep the list small:

- `dsh plugin add @grape-dev/grape-dsh@<version>` works for a published version (0.5.0+ ships `lib/`);
  for an unreleased branch or tag build the tarball from source and pass its absolute path.
- A `git+https://...` spec hits `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` and reinstalls the full
  devDependencies, which leads back to failure 1.

## Rules for retries

- Retry a failed command at most twice, and only after changing something.
- Never restart the Grape server or unrelated dsh profiles to clear a local error.
- When a gate still fails, stop and report: command, exit code, first 20 lines of output.