Grape DevOps pipeline tools for **DeepSeek Harness (dsh)** — trigger, monitor and take over
[Grape](https://gitcode.com/grape-dev/grape) multi-agent DevOps pipelines from your local agent.

**English** | [中文](docs/README.zh.md)

---

## What it is

[Grape](https://gitcode.com/grape-dev/grape) is a multi-agent DevOps platform whose pipeline nodes
(VOD → Issue → Coding → QA → SRE) cover the whole lifecycle from requirement intake to deployment.

This plugin exposes Grape inside dsh in two ways:

| Surface | What you get |
|---|---|
| **33 model-facing tools** (`grape_*`) | pipeline trigger/status, issue lifecycle, events, scenes, repos, skills, knowledge, dashboard, project templates |
| **Sidebar panel + focus pins** | live pipeline card per issue, node chain, takeover controls, worker onboarding |

Both surfaces talk to Grape through the **grape CLI subprocess** (or the Grape HTTP API for
panel/takeover routes) — no secrets are stored by the plugin itself.

---

## Let an agent install it

Paste the whole block below into your coding agent (dsh, Claude Code, Codex, opencode). It checks
the toolchain, installs the plugin, verifies the result, and reports back which capabilities the
agent got.

```text
Install the grape-dsh plugin for DeepSeek Harness (dsh) on this machine. Work non-interactively and stop at the first failed gate.

1. Preflight — report the exact versions:
   node --version          # require >= 18
   python3 --version       # require >= 3.10 (Windows: py -3 --version)
   grape --version         # require >= 0.3.3
   dsh --version           # require >= 0.2.0
   If a tool is missing, install it with the platform recipe in AGENT-DEPLOYMENT-GUIDE.md, then re-run this step.
2. Pick the target profile — the one the user actually boots, never a guess:
   read DSH_PROFILE (or ask). The desktop app always boots `desktop`; a plugin installed into
   `grape` is invisible there, because `dsh grape` is a separate browser UI.
3. Install — a published version comes from npm (0.5.0+ ships lib/):
   dsh plugin --profile <profile> add @grape-dev/grape-dsh@0.5.4
   For an unreleased ref or a local change, build the tarball from source and install the bundle:
   git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
   bash grape-dsh/skills/grape-dsh-install/scripts/install.sh <profile>
   (Windows: pwsh -File grape-dsh\skills\grape-dsh-install\scripts\install.ps1 -Profile <profile>)
   The script clones a stable build checkout, compiles lib/, packs the tarball and installs it (the shell equivalent of plugin_manager install_bundle <absolute tgz>). It prints the stable tgz path; "skipped: already-present" means that version is already installed.
4. Verify — restart that profile first (a newly installed package loads only on boot), then all three must pass:
   dsh plugin --profile <profile> list        # contains @grape-dev/grape-dsh
   dsh --profile <profile> --dump-config      # contains exactly one id: grape-tools
   GRAPE_CLI_MODE=USER grape auth profile     # returns a user profile (needs GRAPE_BASE_URL + GRAPE_API_TOKEN)
5. Report — profile name, node/python/grape/dsh versions, whether grape-tools is mounted, and which grape_* tools the dsh session exposes. Never print any token value.
If a gate fails, stop and report the exact command, its exit code and the first 20 lines of output.
```

Shortest manual commands:

```bash
# published version (0.5.0+ ships lib/)
dsh plugin --profile <profile> add @grape-dev/grape-dsh@0.5.4

# unreleased ref or local change: build the tarball, then install the bundle
git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
bash grape-dsh/skills/grape-dsh-install/scripts/install.sh <profile>
```

Windows: `pwsh -File grape-dsh\skills\grape-dsh-install\scripts\install.ps1 -Profile <profile>`.
The script prints the stable absolute tarball path; pass that path to `plugin_manager
install_bundle` when running inside dsh.

A profile that does not exist yet needs an app bundle — `dsh plugin --profile <name> list` alone
creates a base-only profile with no UI. Create it from a shipped template first:
`dsh --profile <name> --from-default-profile web --dump-config`.

The same procedure is packaged as an install skill:
**[skills/grape-dsh-install/SKILL.md](skills/grape-dsh-install/SKILL.md)**. It is repo-local and not
published to a skills registry yet — load it from a checkout (as a file reference or by path,
depending on your agent).

Full pass/fail gates and troubleshooting: **[AGENT-DEPLOYMENT-GUIDE.md](AGENT-DEPLOYMENT-GUIDE.md)** ·
user walkthrough: [USER-DEPLOYMENT-GUIDE.md](USER-DEPLOYMENT-GUIDE.md) ·
[中文](USER-DEPLOYMENT-GUIDE.zh.md)

---

## Highlights (0.5.x line)

> Published versions: **0.5.0** (first public npm release) → **0.5.1** (environment isolation + worker
> launch fixes) → **0.5.2** (declares `deviceName` in the runtime config schema) → **0.5.3**
> (new/renamed machines register under `config.deviceName`) → **0.5.4** (issue-card actions, takeover
> session de-duplication and panel interaction polish). The `0.5.5`–`0.5.8` labels below refer to
> **dev-ch internal milestones**; they were never published and their content is included in the
> npm `0.5.4` release.

- **Agent-ready install (0.5.2)** — a copy-paste prompt and a repo-local install skill take an agent
  from "fresh checkout" to a verified profile: preflight, install, `dsh plugin` / `grape auth profile`
  checks, then a capability report.
- **Package identity is the module id (0.5.0)** — the package is `@grape-dev/grape-dsh`; installs
  under the old `@grape-dev/dsh-grape` name cannot coexist. Migration notes:
  [docs/MIGRATION-rename-to-grape-dsh.md](docs/MIGRATION-rename-to-grape-dsh.md).
- **Takeover hardening (0.5.1)** — DIAG disk diagnostics removed, the working directory is restored
  after a host restart, and takeover tokens are revoked on release.
- **Task takeover** — hand a running pipeline node to a human + local agent: Grape cancels the
  cloud task, renders the full context (skill package, project graph, history, original prompt),
  the plugin opens a local dsh session with that prompt, progress flows back to the platform, and
  `finish` returns a structured conclusion and dispatches the next node.
- **Server-rendered takeover scripts** — the Grape server renders the workspace scripts for the
  host OS (`.sh` on Linux/macOS, `.ps1` with UTF-8 BOM on Windows); the plugin only writes them and
  substitutes the local working directory.
- **Worker onboarding from the panel** — register this machine as a Grape worker, credential
  (`rta_`) issuance included; the install command is chosen per platform
  (`install.sh` on Linux/macOS, `install.ps1` on Windows).
- **Cross-platform** — Linux, macOS and Windows. Path handling, home directory, session lookup and
  archive extraction all avoid POSIX-only assumptions.
- **Structured results** — a finished takeover writes the same
  `conclusion / actions / artifacts / next_step / issue_summary` object that worker tasks produce,
  so the Grape event page renders it identically.

---

## Requirements

| Dependency | Version | Used for |
|---|---|---|
| dsh | >= 0.2.0 | host runtime |
| Node.js | >= 18 | dsh and plugin runtime |
| Python | >= 3.10 | grape CLI |
| grape CLI | >= 0.3.3 | tool transport (`grape … --json-out`) |
| Grape server | with takeover API | takeover, worker onboarding, panel routes |

You also need a Grape **user-level API key** (`grape_…`, created in Grape Web → Settings) and the
Grape base URL (e.g. `http://localhost:8000` or `https://www.grapedev.cn`).

---

## Install

Two ways in. Prefer the first unless you need to drive every command yourself.

### A. Let an agent install it (recommended, skill-driven)

The repository ships an install skill: **[skills/grape-dsh-install/SKILL.md](skills/grape-dsh-install/SKILL.md)**.
Point your agent (dsh / Claude Code / Codex / opencode) at that file and ask:

```text
Install @grape-dev/grape-dsh into dsh profile <profile> by following
skills/grape-dsh-install/SKILL.md. Run preflight → install → verify in order;
stop at the first failed gate and report the exact command, exit code and first 20 lines of output.
```

The deterministic half is one script:

```bash
git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
bash grape-dsh/skills/grape-dsh-install/scripts/install.sh <profile>
# Windows: pwsh -File grape-dsh\skills\grape-dsh-install\scripts\install.ps1 -Profile <profile>
```

It builds `lib/` from source, packs a tarball, installs the bundle and prints the stable tgz path
(`skipped: already-present` means that version is already installed). A copy-paste prompt with
preflight/verify/report built in lives in **Let an agent install it** above; the pass/fail gates and
measured failure repairs are in **[AGENT-DEPLOYMENT-GUIDE.md](AGENT-DEPLOYMENT-GUIDE.md)**.

### B. Manual

```bash
# 1) published version (0.5.0+ ships lib/) — shortest path
dsh plugin --profile <profile> add @grape-dev/grape-dsh@0.5.4

# 2) unreleased ref or local change: build a tarball from source and install it
git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
cd grape-dsh && bash skills/grape-dsh-install/scripts/install.sh <profile>

# 3) or install a tarball you already built (offline / intranet)
npm pack
dsh plugin --profile <profile> add file:/abs/path/grape-dev-grape-dsh-<version>.tgz
#    inside a dsh session the same step is: plugin_manager install_bundle "<abs tgz>"

# 4) from git (works, but pnpm's prepare-script gate can bite — prefer the tarball)
dsh plugin --profile <profile> add git+https://gitcode.com/grape-dev/grape-dsh.git

# 5) local development (link)
cd /path/to/grape-dsh && pnpm link --global
cd ~/.dsh/profiles/<profile> && pnpm link @grape-dev/grape-dsh
```

Pin the version (`@0.5.2`) when the profile must stay reproducible; `npm view
@grape-dev/grape-dsh version` reports what is published.
After installing, configure `grape-tools` (see **Configuration**) and verify:

```bash
dsh plugin --profile <profile> list        # contains @grape-dev/grape-dsh
dsh --profile <profile> --dump-config      # contains id: grape-tools
```

Full walkthrough (prerequisites → verification → worker onboarding → troubleshooting):
**[USER-DEPLOYMENT-GUIDE.md](USER-DEPLOYMENT-GUIDE.md)** ·
[中文](USER-DEPLOYMENT-GUIDE.zh.md)

### Publishing (maintainers)

`npm publish` runs `prepare` → `tsc`, so the devDependencies must be installed in the same tree:

```bash
npm ci && npm run build
npm pack --dry-run --json     # sanity-check the file list (lib/, skills/, docs/, LICENSE)
npm publish
```

---

## Configuration

`baseUrl` / `token` / `deviceName` are configured in the profile's `cordis.patch.yml`
(`grape-tools.config`). **`baseUrl` and `token` are read from that file only** — the plugin no
longer reads `GRAPE_BASE_URL` / `GRAPE_SERVER_URL` / `GRAPE_API_TOKEN` and has no built-in default,
so a mis-pointed environment fails loudly instead of silently talking to another server.

```yaml
- id: grape-tools
  name: '@grape-dev/grape-dsh'
  config:
    baseUrl: 'https://beta.grapedev.cn:9443'  # required — the ONLY source of the environment
    token: 'grape_xxx'                        # required — config only (GRAPE_API_TOKEN is ignored)
    deviceName: 'dsh-worker-001'              # optional; must start with `dsh` (default: dsh-<hostname>)
    bin: ''                                   # optional → GRAPE_CLI_BIN or `grape` from PATH
    timeout: 30
```

Environment isolation: the local worker's `RUNTIME_SERVER_URL` in `~/.grape/runtime.env` must match
`config.baseUrl`. When they differ, the panel treats this environment as having **no worker**,
shows `环境不匹配` (server mismatch), refuses to start/restart it, and the only action is
**接入本机** (reinstall), which rewrites `runtime.env` and re-issues the credential under the
configured device name.

Device-name precedence (the single rule used by `/onboard` — the same name is used for the server
lookup and for the credential/install step): `config.deviceName` → the local `RUNTIME_DEVICE_NAME`
in `runtime.env` → `dsh-<hostname>`. So **a new registration / a rename follows the config**; the
`runtime.env` value is only the output of the previous install and never overrides the config.
Renaming (configured name ≠ running name) requires **注销本机** first (it stops the old process),
then **接入本机** — hot-renaming would leave the old process heartbeating under the old name.
When the server state cannot be read (bad API key / unreachable network) and a worker is already
installed, onboarding is refused instead of guessing "new machine" and minting another credential.

Environment variables still work for the standalone CLI (`GRAPE_BASE_URL`, `GRAPE_API_TOKEN`,
`GRAPE_TIMEOUT`, `GRAPE_CLI_BIN`), but the plugin itself resolves `baseUrl` and `token` from its
config only.

---

## Tools (33)

| Group | Tools |
|---|---|
| Pipeline (5) | `grape_trigger_pipeline` `grape_get_task_status` `grape_wait_task` `grape_get_pipeline_info` `grape_get_pipeline_roadmap` |
| Issues (10) | `grape_list_issues` `grape_list_my_issues` `grape_get_issue_detail` `grape_create_issue` `grape_cancel_issue` `grape_resume_issue` `grape_start_issue` `grape_get_issue_events` `grape_list_repo_events` `grape_search` |
| Events (1) | `grape_terminate_event` |
| Scenes (3) | `grape_list_scenes` `grape_apply_scene` `grape_list_scenes_for_repo` |
| Repos (5) | `grape_list_managed_repos` `grape_list_repos_member` `grape_get_repo_project_info` `grape_host_repo` `grape_sync_repos` |
| Skills (3) | `grape_list_skills` `grape_get_skill_detail` `grape_search_skills` |
| Knowledge (2) | `grape_list_knowledge` `grape_get_knowledge_detail` |
| Dashboard (2) | `grape_get_repo_dashboard` `grape_get_ops_overview` |
| Templates (2) | `grape_list_project_templates` `grape_create_project` |

Design boundary: **trigger, observe, advance on user decisions, never interfere with node-to-node
handoff**. A2A transitions stay inside Grape. Takeover is the one explicit exception: it is a
user-authorized action that replaces a cloud task with a local session.

---

## Pipeline state semantics

The panel never hard-codes the node chain: it renders the issue's **scene nodes**
(`scenes detail --scene_id … --repo …`). When the scene cannot be loaded it falls back to the
first-appearance order of pipeline events and shows “scene unknown, inferred from events”.
Overall state and progress come from Grape business fields, not from the pipeline top-level `status`.

| Grape field | Display |
|---|---|
| `issue_task_status=completed` or `issue_stage=done` | completed |
| `pending_review` (`issue_task_status` / `review_status`) | awaiting review |
| `active` / `processing` / `running` | in progress |
| `failed` / `cancelled` | failed / cancelled |
| scene node that never ran | pending |
| node in another node's `skip` list | skipped |

- Repeated tags from redispatch/retry take the largest `seq`, occupy **one** box, and show “retry N”.
- Nodes outside the scene are still shown and marked “outside scene”.
- Progress = completed boxes / rendered boxes (deduplicated scene nodes), so `done ≤ total` and the
  denominator always equals the number of boxes.
- Pipeline top-level `status` is only an **event-level hint** (whether the current event finished),
  never “requirement completed”.

---

## Takeover workflow

```
Panel → issue card → "Take over" on a running node
  1. Grape cancels the cloud task and issues a `tko_` token (repo-scoped, 12h)
  2. Server renders the prompt + assets for this host OS
  3. Plugin materialises the workspace and opens a local dsh session with the prompt
  4. The local agent reports progress  →  .grape-takeover-report.sh|ps1
  5. The local agent submits a summary  →  .grape-takeover-request-finish.sh|ps1
  6. User clicks "Confirm complete · dispatch next node" → Grape records the structured
     conclusion and dispatches the next node (never re-runs this one)
Abort = hand the node back to the pipeline; Grape redispatches the *current* node.
```

---

## Local worker status

The panel no longer reduces the machine state to a single `running` boolean. The host derives one
of 12 states from local facts **and** the server's `runtime-devices` row
(`health / last_seen_at / worker_version`):

- **Server heartbeat wins inside `2 × RUNTIME_HEARTBEAT_INTERVAL`.** If the server says `online`
  within that window, a failed local probe is reported as **"probe unavailable / server online"**
  — never as "not running", and it never triggers an auto-start.
- **Probe failures never start a worker.** Timeouts, a missing `powershell`/`ps`, or permission
  errors are first-class states (`probe-failed`, `server-online-probe-failed`).
- **Start guard.** If any live agent process is found (including child processes and non-venv
  interpreters), or the probe failed, the start routes refuse to launch a second worker.
- **Post-start verification.** After starting, the host re-reads `runtime.env`, checks
  `RUNTIME_DEVICE_NAME` / `RUNTIME_SERVER_URL` / `RUNTIME_TOKEN` against the expected device row,
  and records pid, exit code and a stderr summary.
- **Diagnosable panel.** Each device card has a collapsible **"basis"** section and a
  **"copy diagnostics"** button; the copied text is redacted (`RUNTIME_TOKEN`, `tk_`, `grape_`,
  `tko_`, `rta_`, `Bearer`, `api_key`…).

Full state diagram and troubleshooting tree: `docs/local-worker-and-takeover-stop.md` §8.

---

## Architecture

```
dsh agent (DeepSeek model)
  → grape_* tool call
    → execGrape() spawns `grape … --json-out`
      → grape CLI → Grape HTTP API (FastAPI)
    → single-line JSON parsed → returned to the model
    → presentCall / render / presentResult render structured cards

dsh sidebar panel (client half)
  → /grape-worker-api/*  (plugin host routes)
    → Grape panel / takeover / worker endpoints
```

---

## Development

```bash
npm install
npm run typecheck    # server half + client half
npm run build        # compile to lib/ and bundle the client half
npm run dev          # watch mode
```

## License

MIT