# dsh / grape command reference for the install skill

All syntax below was verified against `dsh 0.2.2-rc.3` and `grape 0.3.4` on the development
machine; older versions may hide `grape auth profile` behind `GRAPE_CLI_MODE=USER`.

## dsh plugin

```text
dsh plugin [--profile <name>] <pnpm args...>
```

`dsh plugin` forwards the remaining arguments to pnpm inside the profile directory
(`~/.dsh/profiles/<name>/`). It initializes the profile on first use, with `@deepseek-ai/dsh-base`
only — a newly created custom profile has no app bundle, so `dsh <name>` has no UI. Create it from a
shipped template instead when it needs one:
`dsh --profile <name> --from-default-profile web --dump-config`.

| Task | Command |
|---|---|
| Create/list profile content | `dsh plugin --profile <profile> list` |
| Install from npm | `dsh plugin --profile <profile> add @grape-dev/grape-dsh` |
| Install from git | `dsh plugin --profile <profile> add git+https://gitcode.com/grape-dev/grape-dsh.git` |
| Install from tarball | `dsh plugin --profile <profile> add file:<abs-path>.tgz` |
| Remove | `dsh plugin --profile <profile> remove @grape-dev/grape-dsh` |

## Mounted configuration

```bash
dsh --profile <profile> --dump-config
```

Pass criterion: the output contains `grape-tools` (the module id from `cordis.patch.yml`).

## User authentication

```bash
GRAPE_CLI_MODE=USER GRAPE_API_TOKEN=grape_… grape auth profile --json-out
```

- Requires a **user-level** `grape_` key; a `tk_`/`tko_` session token returns HTTP 403.
- Without `GRAPE_API_TOKEN`, `GRAPE_CLI_MODE=USER` falls back to the session token with a warning.
- Pass criterion: exit code 0 and a JSON object on stdout (contains profile metadata, not the key).
- Never echo `GRAPE_API_TOKEN`; report only `set` / `not set` and the character count if useful.

## Server reachability (optional pre-check)

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$GRAPE_BASE_URL/health"
```

Pass: HTTP `200`.

## In-product capability check (user-side)

Start `dsh --profile <profile>` and run:

```text
Which repositories are managed in Grape?
```

Expected: a `grape_list_managed_repos` call card and a table result. This confirms the model-facing
tool surface, which `--dump-config` alone cannot prove.