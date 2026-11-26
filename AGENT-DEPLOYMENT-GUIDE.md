# grape-dsh — Agent Deployment Runbook

**Audience:** an autonomous coding agent (Claude Code, Codex, dsh, opencode, …) deploying this plugin
on a user's machine.
**Goal:** reach a verified working install without asking the user to interpret errors.

Read this file top to bottom. Execute one step at a time. After every step there is a **GATE**:
if the gate fails, stop and report — do not continue, do not improvise.

---

## 0. Rules

1. **Never print secrets.** Do not echo `GRAPE_API_TOKEN`, LLM keys, or any `grape_`/`tko_`/`rta_`
   value into the transcript or into files that are world-readable.
2. **Never modify a dsh profile you were not asked about.** The profile name comes from the user
   (default: `grape`). Other profiles under `~/.dsh/profiles/` are off-limits.
3. **Idempotent by design.** Re-running a step must be safe. If a step is already satisfied, skip it
   and note `skipped: already-present`.
4. **Stop-on-gate-failure.** A failing gate means unknown state: report the command, the exit code
   and the first 20 lines of output, then stop.
5. **No interactive installers.** If a required tool needs an interactive login (npm publish, dsh
   web login), stop and hand back to the user.
6. **Do not restart production services** (grape server, other users' dsh). Only restart the dsh
   profile you are configuring, and only if it is not currently executing tasks.

---

## 1. Inputs

Collect or confirm these before running anything. If a value is missing, ask the user **once**,
listing exactly what is missing.

| Name | Required | Default | Notes |
|---|---|---|---|
| `PROFILE` | yes | `$DSH_PROFILE`, else `grape` | the profile the user actually boots — the desktop app always boots `desktop`; `grape` is only served by `dsh grape` |
| `GRAPE_BASE_URL` | yes | — | e.g. `http://127.0.0.1:8000`, `https://www.grapedev.cn` |
| `GRAPE_API_TOKEN` | yes | — | user-level key, `grape_` prefix |
| `PLUGIN_SPEC` | no | `@grape-dev/grape-dsh` | or `git+https://gitcode.com/grape-dev/grape-dsh.git`, or a tarball path |
| `REGISTER_WORKER` | no | `false` | whether this machine should execute pipeline tasks |
| `LLM_API_KEY` | only if dsh has none | — | needed to actually run the agent |

---

## 2. Preflight

Run each command; record the output. Do not install anything yet.

```bash
node --version
npm --version
pnpm --version
python3 --version
dsh --version
command -v grape && grape --version
```

Windows (PowerShell): use `node --version`, `py -3 --version`, `where.exe grape`,
`grape --version`.

**GATE 1 — versions**

| Check | Pass criterion |
|---|---|
| node | `>= 18` |
| pnpm | `>= 8` |
| python | `>= 3.10` |
| dsh | `>= 0.2.0` |
| grape | `>= 0.3.3` and resolvable on PATH |

Fail action: install the missing piece with the platform recipe below, then re-run GATE 1.

```bash
# Node (Debian/Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
# pnpm + dsh
sudo npm install -g pnpm @deepseek-ai/dsh
# grape CLI
pip install grape --break-system-packages || (python3 -m venv ~/.grape-cli && ~/.grape-cli/bin/pip install grape && sudo ln -sf ~/.grape-cli/bin/grape /usr/local/bin/grape)
```

macOS: `brew install node python@3.12 && sudo npm install -g pnpm @deepseek-ai/dsh && pip3 install grape`.
Windows: install Node 22 LTS + Python 3.12 from their installers, then
`npm install -g pnpm @deepseek-ai/dsh` and `py -3 -m pip install grape`.

---

## 3. Connectivity

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$GRAPE_BASE_URL/health"
GRAPE_CLI_MODE=USER GRAPE_BASE_URL="$GRAPE_BASE_URL" GRAPE_API_TOKEN="$GRAPE_API_TOKEN" \
  grape repos managed --json-out | head -c 200; echo
```

**GATE 2 — server**

| Check | Pass criterion |
|---|---|
| health | HTTP `200` |
| CLI auth | output starts with `[` or `{` and contains a repo list, not `authentication`/`401`/`403` |

Fail action:

- HTTP != 200 → wrong URL or server down. Ask the user for the correct base URL. Stop.
- `401`/`authentication` → the API key is wrong or expired. Ask the user to recreate a `grape_` key.
  Stop.
- `403 session token` → the user supplied a `tk_`/`tko_` token. Ask for a `grape_` user key. Stop.

---

## 4. Install the plugin

Confirm `PROFILE` is the profile the user actually boots before running anything: the DeepSeek
Harness desktop app always boots `desktop`, and a plugin installed into `grape` is invisible there.
When the profile does not exist yet, `dsh plugin --profile <name> list` creates a base-only profile
with no app bundle; create it from a shipped template first —
`dsh --profile <name> --from-default-profile web --dump-config` — then install.

```bash
dsh plugin --profile "$PROFILE" list          # creates the profile if missing (base-only)
dsh plugin --profile "$PROFILE" add "$PLUGIN_SPEC"
```

Restart that profile once a new package lands: editing the patch hot-reloads, installing a package
does not.

**GATE 3 — plugin mounted**

```bash
dsh --profile "$PROFILE" --dump-config 2>&1 | grep -c 'grape-tools'
```

Pass: count is exactly `1`. Fail: continue with the two known repairs, then re-check.

Repair A — pnpm blocked the git dependency build
(`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`): append to
`~/.dsh/profiles/$PROFILE/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "@grape-dev/grape-dsh@git+https://gitcode.com/grape-dev/grape-dsh.git": true
```

then `cd ~/.dsh/profiles/$PROFILE && pnpm add "$PLUGIN_SPEC"`.

Repair B — package present but not listed as a bundle: ensure
`~/.dsh/profiles/$PROFILE/package.json` → `dsh.profile.bundles` contains
`"@grape-dev/grape-dsh"`. Merge into the existing array; do not drop other entries.

---

## 5. Write configuration

Create a credential file owned by the dsh user, mode `600`, and point the dsh service at it.

```bash
umask 077
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/grape-dsh"
mkdir -p "$CONF_DIR"
[ -f "$CONF_DIR/grape.env" ] || {
  printf 'GRAPE_BASE_URL=%s\nGRAPE_API_TOKEN=%s\nGRAPE_TIMEOUT=30\n' \
    "$GRAPE_BASE_URL" "$GRAPE_API_TOKEN" > "$CONF_DIR/grape.env"
}
chmod 600 "$CONF_DIR/grape.env"
```

`/etc/grape-dsh/grape.env` may be used instead when dsh runs as a system service (needs root).

systemd unit (only if dsh is a service and the user owns it):

```
EnvironmentFile=<CONF_DIR>/grape.env
```

then `systemctl daemon-reload && systemctl restart <dsh-unit>`.

**GATE 4 — config file**

Pass: file exists, mode `600`, contains both `GRAPE_BASE_URL=` and `GRAPE_API_TOKEN=`.
Verify without printing values:

```bash
stat -c '%a %n' "$CONF_DIR/grape.env"
grep -c '^GRAPE_BASE_URL=' "$CONF_DIR/grape.env"
grep -c '^GRAPE_API_TOKEN=' "$CONF_DIR/grape.env"   # expect exactly 1, do not print it
```

---

## 6. Verify in-product

Start the profile (if not already running):

```bash
dsh --profile "$PROFILE"            # Linux/macOS: or `dsh web --profile "$PROFILE"`
```

**GATE 5 — tools respond.** Either drive the UI, or — preferred for agents — assert the tool surface
directly:

```bash
GRAPE_CLI_MODE=USER grape repos managed --json-out >/dev/null && echo "CLI OK"
dsh --profile "$PROFILE" --dump-config 2>&1 | grep -q 'grape-tools' && echo "PLUGIN OK"
```

Pass: both print `OK`. Then ask the user (or the host model) to run one prompt:
`Which repositories are managed in Grape?` — expected `grape_list_managed_repos` call with a table
result. If the model reports `grape CLI not found`, set `GRAPE_CLI_BIN` to `$(command -v grape)` in
the env file and restart, then repeat GATE 5.

---

## 7. Optional — register this machine as a worker

Only when `REGISTER_WORKER=true`. Do this through the plugin, not by hand:

1. Open the dsh sidebar → Grape panel → **Register this machine as worker**.
2. The panel issues an `rta_` credential and prints the platform-specific installer command.
3. Execute exactly that command in a terminal:

```bash
# Linux / macOS
curl -sSL "$GRAPE_BASE_URL/api/runtime/install" | bash -s -- --token <rta_…> --server "$GRAPE_BASE_URL"
# Windows (PowerShell)
& ([scriptblock]::Create((irm "$GRAPE_BASE_URL/api/runtime/install.ps1"))) -Token <rta_…> -Server "$GRAPE_BASE_URL"
```

4. The installer is idempotent: it reuses `$HOME/grape`, writes the credential, starts the runtime
   agent in the background and registers it.

**GATE 6 — worker online**

```bash
GRAPE_CLI_MODE=USER grape runtime list --json-out | grep -c "$(hostname)"
```

Pass: `>= 1` and the entry shows an online/healthy engine. Fail: read the installer output, check
that the runtime process is alive (`pgrep -f runtime_agent` on Linux/macOS), report and stop.
Note: the installer does **not** install execution engines; if Grape shows the engine with no
executable, tell the user to install opencode/hermes/codex and let the worker rediscover it.

---

## 8. Optional — takeover readiness

Takeover requires a server exposing `/api/takeover/sessions*`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$GRAPE_BASE_URL/api/takeover/sessions" \
  -H "content-type: application/json" -H "PRIVATE-TOKEN: $GRAPE_API_TOKEN" -d '{}'
```

| Response | Meaning |
|---|---|
| `400`/`422` | endpoint exists (bad body) → takeover supported |
| `404`/`405` | server predates takeover → tell the user to deploy a newer Grape |

**GATE 7 — takeover scripts render per host OS.** This is verified by the plugin at runtime, not by
the agent. If the user reports a takeover failure, inspect the workspace:

```bash
# Linux/macOS
ls -la <workspace>/.grape-takeover-env.sh <workspace>/.grape-takeover-report.sh
# Windows
dir <workspace>\.grape-takeover-env.ps1
```

Missing scripts + dsh log line `bundle has no scripts assets (legacy server?)` means the server is
older than the plugin; run `curl -s -o /dev/null -w '%{http_code}' "$GRAPE_BASE_URL/api/takeover/sessions"`.

---

## 9. Report format

Finish with a single block in this shape (no secrets):

```json
{
  "status": "ok | failed",
  "profile": "grape",
  "platform": "linux | darwin | windows",
  "versions": {"node": "v22.x", "pnpm": "10.x", "python": "3.12.x", "dsh": "0.2.x", "grape": "0.3.x"},
  "plugin": {"spec": "@grape-dev/grape-dsh", "mounted": true},
  "config_file": "~/.config/grape-dsh/grape.env",
  "gates": {"1_versions": "pass", "2_server": "pass", "3_plugin": "pass", "4_config": "pass", "5_tools": "pass"},
  "worker_registered": false,
  "takeover_supported": true,
  "next_steps": ["ask the user to run one prompt to confirm the tool cards render"]
}
```

If `status=failed`, include `failed_gate`, the exact command, its exit code and the trimmed output.

---

## 10. Rollback

```bash
dsh plugin --profile "$PROFILE" remove @grape-dev/grape-dsh
# optional: stop the worker registered in step 7
#   Grape Web → Workers → revoke the rta_ credential, then stop the local runtime process
```

The plugin never writes outside: the dsh profile directory, the credential file from step 5, and
takeover workspace directories created at runtime.

---

## 11. Agent anti-patterns (do not do these)

- Installing into `~/.dsh/profiles/<other-profile>` or editing other profiles' `cordis.patch.yml`.
- Writing `GRAPE_API_TOKEN` into a shell profile (`~/.bashrc`) or into a repo file.
- Restarting `grape-main` / the Grape server to make a plugin error go away.
- Calling `dsh plugin add` without `--profile`.
- Retrying a failed gate more than twice with the same command — change something first or stop.
- Declaring success without GATE 3 and GATE 5 passing.