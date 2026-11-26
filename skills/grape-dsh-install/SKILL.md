---
name: grape-dsh-install
description: |
  Install, upgrade or troubleshoot @grape-dev/grape-dsh in a DeepSeek Harness (dsh) profile using the
  verified source-build path: clone -> minimize build dependencies -> tsc -> build the client bundle ->
  pnpm pack -> plugin_manager install_bundle <absolute tgz>. Use this when the installed version is
  missing from npm or you need an unreleased ref, pnpm refuses a git dependency's prepare script,
  esbuild fails with EPERM, or the plugin row
  activates with "GRAPE_API_TOKEN is not set".
  Triggers include: "install grape-dsh", "install the dsh grape plugin", "set up grape-dsh for dsh",
  "bootstrap grape-dsh", "one-click grape-dsh install", "安装 grape-dsh", "给 dsh 装 grape 插件",
  "一键安装 grape-dsh", "grape-dsh 装到 dsh".
tags: [dsh, plugin-install, grape-dsh, devops]
---

# Grape-dsh Install Skill

## Overview

This skill installs the Grape DevOps plugin (`@grape-dev/grape-dsh`) into one dsh profile and proves
the install works. It is written for autonomous agents: every step has an explicit pass/fail
criterion, re-running is safe, and failures hand back raw evidence instead of a vague message.

What the plugin adds to the profile:

- 33 model-facing `grape_*` tools (pipeline, issues, events, scenes, repos, skills, knowledge,
  dashboard, project templates);
- a sidebar panel plus focus pins for live pipeline cards and takeover controls.

The skill changes only the target dsh profile (and the optional credential file described in
`README.md` / the deployment guides). It does not touch other profiles, the Grape server, or any
cloud resource.

## Fact baseline (事实基线)

Read this before running anything. Every row below was verified on a real machine. The profile row
matters more than anything else here: a plugin installed into the wrong profile is invisible to the
user even when every gate passes.

| Fact | Consequence |
|---|---|
| Package name `@grape-dev/grape-dsh` | dsh plugin package with `dsh.bundle.patch` + `dsh.client` |
| **Published on npm since 0.5.0** — `npm view @grape-dev/grape-dsh version` returns `0.5.0`; the packed tarball ships `lib/` and `locale/` | `dsh plugin --profile <p> add @grape-dev/grape-dsh@<version>` is the shortest path; keep the source build for a branch or tag that is not published, or when you must ship a local change |
| Repository `https://gitcode.com/grape-dev/grape-dsh` is public | anonymous clone works; no GitCode token is needed and none may be written to disk |
| `lib/` is git-ignored and `prepare` = `tsc` | a fresh checkout has no build output; it must be compiled before packing |
| CLI real package name is PyPI **`grape-cli`** (command stays `grape`) | `pip install grape` is wrong (PyPI `grape` 0.2.5 is an unrelated project) |
| `dsh` is often absent from PATH; desktop entry is `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` | scripts must resolve that path instead of calling bare `dsh` |
| Runtime | dsh 0.2.2-rc.3 / cordis ~4.1.0 / Node 22+ / Python >= 3.10 |

## Prerequisites

| Dependency | Minimum | Check |
|---|---|---|
| dsh | 0.2.0 | `dsh --version`, or the desktop `dsh.cmd` path above |
| Node.js | 18 | `node --version` |
| pnpm | 8 | `pnpm --version` |
| Python | 3.10 | `python3 --version` (Windows: `py -3 --version`) |
| grape CLI | 0.3.3 | `grape --version` (install `grape-cli`, not `grape`) |
| Grape server | reachable | `curl -s -o /dev/null -w '%{http_code}' "$GRAPE_BASE_URL/health"` |
| Grape user API key | `grape_` prefix | `GRAPE_API_TOKEN` is set (never print its value) |

Inputs: `PROFILE` (required — the profile the user actually boots; see Step 0), optional `REF`
(branch or tag, default the default branch), optional `GRAPE_DSH_BUILD_DIR` /
`GRAPE_DSH_TARBALL_DIR` to relocate the build checkout and the stable tarball directory.

## Step 0 — Choose the profile the user actually boots

Install into the profile that will load the plugin, not into one that merely looks like a default.
Getting this wrong is silent: every gate passes and the user still sees nothing.

- Read `DSH_PROFILE` from a shell of a profile-launched dsh (`$env:DSH_PROFILE` in PowerShell). When
  it is unset, ask the user once which profile they start.
- **The DeepSeek Harness desktop app always boots `desktop`.** A plugin installed into `grape` is
  invisible there; that profile is only served by `dsh grape`, a separate browser UI.
- `grape` is not a shipped dsh profile. `dsh plugin --profile <name> list` creates a profile with
  `@deepseek-ai/dsh-base` only — no app bundle, so `dsh <name>` has no UI. Create a custom profile
  from a shipped template first, then install into it:
  `dsh --profile <name> --from-default-profile web --dump-config`
  (composes the fresh profile and exits; it does not boot anything).

## Workflow

Seven steps (1–7), each verified; Step 0 only picks the target. A failing gate stops the run.
`scripts/install.sh` / `scripts/install.ps1` execute steps 1–6 end to end; steps 7 and the
acceptance checks are driven by the agent.

### Step 1 — Clone to a stable workspace

```bash
git -c http.sslBackend=openssl clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git \
  "${GRAPE_DSH_BUILD_DIR:-$HOME/.dsh/tools/grape-dsh-build}"
```

- On Windows, `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` means the
  `-c http.sslBackend=openssl` flag is missing (sandboxed schannel cannot get credentials).
- Keep the checkout at a stable absolute path; it is reused by later runs.

### Step 2 — Minimize build dependencies (required)

Remove `peerDependencies` and keep exactly four `devDependencies`:
`@deepseek-ai/schemastery`, `@types/node`, `esbuild`, `typescript`.

Why: the root `peerDependencies` trigger pnpm's auto-install-peers, which tries to resolve
unpublished internal packages such as `@deepseek-ai/dsh-type-meta` and fails with
`ERR_PNPM_FETCH_404`. Setting `auto-install-peers=false` in `.npmrc` is not reliable; deleting
`peerDependencies` is. Server code only imports `@deepseek-ai/schemastery`; `@deepseek-ai/*` is
external in the client bundle, so no client UI packages, React or `@types/react` are needed.

```bash
pnpm install --config.ignore-scripts=true --no-frozen-lockfile
```

- pnpm has no `--ignore-scripts` flag; use `--config.ignore-scripts=true`.

### Step 3 — Compile the server half

```bash
node node_modules/typescript/bin/tsc        # writes lib/*.js and lib/types/*.d.ts
```

`tsconfig.json` already excludes `src/client`, so tsc needs no client type packages.

### Step 4 — Bundle the client half

```bash
node scripts/build-client.mjs               # writes lib/client.js (about 237 KB)
```

Known issues and fixes:

- `The package "@esbuild/win32-x64" could not be found`: pnpm keeps the platform package in
  `.pnpm` without linking it under `node_modules/esbuild/node_modules`; create the junction manually.
- `spawn EPERM`: the DSH sandbox blocks child-process pipes, so the esbuild service cannot start.
  Re-run this one command with danger-full-access; do not switch bundlers.
- `SyntaxError: Unexpected token '\uFEFF'`: `package.json` was written with a BOM. Rewrite it with
  `[System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))`.

### Step 5 — Pack the tarball and restore manifests

```bash
git checkout -- package.json package-lock.json
pnpm pack --config.ignore-scripts=true --pack-destination "$TARBALL_DIR"
```

Product: `grape-dev-grape-dsh-<version>.tgz`. **This tarball must stay at a stable absolute path**
(the profile dependency records `file:<path>`; deleting it breaks later `pnpm install`, although a
running plugin keeps working). `install.sh` copies it to
`${GRAPE_DSH_TARBALL_DIR:-$HOME/.dsh/tools/grape-dsh-tarballs}` and prints the exact path.

### Step 6 — Install the bundle

Inside a dsh session, call the plugin manager directly with the absolute tarball path:

```jsonc
plugin_manager({ action: "install_bundle", target: "C:\\abs\\path\\grape-dev-grape-dsh-0.5.2.tgz" })
```

It runs `pnpm add`, writes the profile `dependencies` + `dsh.profile.bundles`, and tries to enable
the plugin. A result of `application: failed` together with `GRAPE_API_TOKEN is not set` is
**expected**: `apply()` validates the token, so the bundle is installed and becomes live once the
token is configured.

From a plain shell (no dsh session), the scripts perform the same steps:
`dsh plugin --profile <profile> add file:<abs tgz>` plus adding `@grape-dev/grape-dsh` to
`dsh.profile.bundles`. They print `skipped: already-present` when that exact version is already in
the profile.

Do **not** pass a `git+https://...` spec to `install_bundle`: it hits pnpm's
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` approval gate and reinstalls the full devDependencies,
inevitably hitting the Step 2 404 again.

### Step 7 — Configure and verify

Edit `<DSH_PROFILE_DIR>/cordis.patch.yml` (requires danger-full-access) and append:

```yaml
- id: grape-tools
  name: "@grape-dev/grape-dsh"
  config:
    bin: 'C:\Program Files\Python312\Scripts\grape.exe'   # resolve it; do not guess
    baseUrl: 'https://www.grapedev.cn'      # or http://<host>:<port>/
    token: 'grape_xxxxxxxx'                 # Grape Web -> Settings user-level key
    timeout: 30
```

- `bin` must be the absolute path of the `grape` executable this machine actually has; resolve it
  with `Get-Command grape` (PowerShell) or `command -v grape` (bash). It is usually the Python
  `Scripts` directory, e.g. `%ProgramFiles%\Python3xx\Scripts\grape.exe` — not a venv this skill
  creates.
- Precedence: line config > environment (`GRAPE_BASE_URL` / `GRAPE_API_TOKEN` / `GRAPE_CLI_BIN` /
  `GRAPE_TIMEOUT`) > defaults (baseUrl defaults to `http://localhost:8000`).
- Editing the profile patch hot-reloads the plugin, so a config change needs no restart. Installing
  or upgrading the **package** is different: restart that profile before calling it live.

## Verification checklist (三条都要过)

1. `dsh --profile <profile> --dump-config` contains exactly one `id: grape-tools`, and
   `dsh plugin --profile <profile> list` contains `@grape-dev/grape-dsh`. Prefer this count over any
   paginated `list_plugins` offset, which breaks as soon as rows are added; two `grape-tools` rows
   mean the profile patch inserts a second copy.
2. Call `grape_list_managed_repos` -> a repository table is returned, not an auth error.
3. The skill directory contains the plugin-registered `grape-issue-workflow`.

Then hit a real endpoint through the CLI to prove it is not just the plugin layer reporting success:

```powershell
$env:GRAPE_CLI_MODE='USER'; $env:GRAPE_BASE_URL='<url>'; $env:GRAPE_API_TOKEN='<token>'
& <resolved grape path> repos managed --json-out
```

## Core Commands

| Command | Purpose |
|---|---|
| `bash scripts/preflight.sh` | GATE 1: versions, dsh PATH/desktop resolution, grape-cli package |
| `bash scripts/install.sh [profile] [ref]` | GATE 2: build tarball + install bundle (idempotent) |
| `bash scripts/verify.sh <profile>` | GATE 3: plugin list + mounted bundle + `grape auth profile` |
| `bash scripts/test-cli-commands.sh -s .` | Runs `templates/test-vars.json` read-only cases |
| `plugin_manager({action:"install_bundle",target:"<abs tgz>"})` | Shortest manual install inside dsh |
| `dsh plugin --profile <profile> remove @grape-dev/grape-dsh` | Rollback |

PowerShell equivalents: `preflight.ps1`, `install.ps1`, `verify.ps1` (same arguments;
`-Profile` / `-Ref` for install).

## Parameter Confirmation

| Parameter | Required | Default | Description |
|---|---|---|---|
| `PROFILE` | yes | `$DSH_PROFILE`, else `grape` | profile the user actually boots (desktop app = `desktop`) |
| `REF` | no | default branch | branch or tag to clone |
| `GRAPE_DSH_BUILD_DIR` | no | `$DSH_HOME/tools/grape-dsh-build` | stable clone directory |
| `GRAPE_DSH_TARBALL_DIR` | no | `$DSH_HOME/tools/grape-dsh-tarballs` | stable tarball directory |
| `GRAPE_BASE_URL` | for GATE 3 | — | Grape server origin, e.g. `https://www.grapedev.cn` |
| `GRAPE_API_TOKEN` | for GATE 3 | — | user-level `grape_` key (never printed) |

## Failure Handling

- **Stop at the first failed gate.** Do not continue to the next phase.
- Report: the exact command, its exit code, and the first 20 lines of output.
- Retry a failed command at most twice, and only after changing something (a repair from this table
  or a fixed input). Do not loop the same command.
- `401` / `authentication failed` -> the API key is wrong or expired; ask the user to recreate a
  `grape_` key.
- `403 session token` -> a `tk_`/`tko_` token was supplied; ask for a user-level `grape_` key.
- Full table with the seven measured failures: `references/troubleshooting.md`.

## Security Rules

1. Never print, echo, log or commit `GRAPE_API_TOKEN` or any `grape_`/`tk_`/`tko_`/`rta_` value.
   Scripts only report whether the variable is set and how many characters it has.
2. Never install into a profile the user did not name. Other profiles under `~/.dsh/profiles/` are
   off-limits.
3. Never restart the Grape server or other users' dsh to clear a plugin error.
4. Never write a token into `README.md`, a repository file, or a shell profile such as `~/.bashrc`.
5. No interactive installers: if a step needs an interactive login, stop and hand it back to the user.
6. Clone is anonymous: never persist a GitCode token; the install scripts only build locally and
   never touch cloud resources.

## Huawei Cloud Credential Gate — Not Applicable

The huawei-cloud-skill-creator template requires a Huawei Cloud AK/SK gate before running any
`hcloud` command. That gate does **not** apply here, because:

- this skill installs a local dsh plugin and never operates cloud resources;
- it never calls `hcloud` or the Huawei Cloud SDK, and no credential of that kind is needed;
- therefore no `hcloud configure list` check is performed and no `hcloud` command is fabricated.

The only credential this skill touches is the Grape user API key (`grape_…`), handled under the
Security Rules above. See `references/cloud-credential-gate.md` for the full rationale.

## Reference Documents

- `references/dsh-plugin-commands.md` — verified `dsh plugin`, `--dump-config` and `grape auth profile` syntax
- `references/verification-method.md` — how each gate is evaluated, including the in-product smoke test
- `references/acceptance-criteria.md` — acceptance checklist for this skill
- `references/troubleshooting.md` — the seven measured failures and their repairs
- `references/cloud-credential-gate.md` — why the Huawei Cloud credential gate does not apply