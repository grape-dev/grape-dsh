# grape-dsh — User Deployment Guide

> For users who want Grape pipeline tools inside DeepSeek Harness (dsh).
> Covers Linux, macOS and Windows (native PowerShell). Windows via WSL2 also works — treat it as Linux.

**English** | [中文](USER-DEPLOYMENT-GUIDE.zh.md)

---

## 0. Platform matrix

| Platform | Status | Notes |
|---|---|---|
| Linux (Ubuntu 22.04+, CentOS/RHEL) | Fully supported | Reference platform |
| macOS 12+ | Fully supported | Homebrew for Node/Python; same steps as Linux afterwards |
| Windows 10/11 (native) | Supported | PowerShell install path (`install.ps1`), plugin writes `.ps1` takeover scripts |
| Windows + WSL2 | Supported | Just follow the Linux steps inside WSL |

---

## 1. Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| dsh | >= 0.2.0 | host runtime |
| Node.js | >= 18 (22 recommended) | dsh + plugin |
| pnpm | >= 8 | dsh profile dependency manager |
| Python | >= 3.10 | grape CLI |
| grape CLI | >= 0.3.3 | transport for all `grape_*` tools |
| Grape server | reachable from this machine | the platform itself |

Collect these before you start:

- Grape base URL, e.g. `http://<grape-host>:8000` or `https://www.grapedev.cn`
- Grape **user-level API key** (`grape_…`) — created in Grape Web → Settings → API Keys
- An LLM API key for dsh (DeepSeek, relay, etc.)
- Optional, only for takeover: the machine must be able to reach the Grape server and run a local
  agent (dsh session) with `git` available

---

## 2. Install the runtime dependencies

### 2.1 Node.js

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs

node --version    # expect v22.x or newer
```

macOS: `brew install node`. Windows: install Node 22 LTS from nodejs.org (MSI), then verify in a new
PowerShell window.

### 2.2 pnpm and dsh

```bash
sudo npm install -g pnpm
pnpm --version

sudo npm install -g @deepseek-ai/dsh
dsh --version
```

macOS/Windows: same commands, drop `sudo` (Windows: run PowerShell as Administrator).

### 2.3 Python and grape CLI

```bash
python3 --version          # >= 3.10

# system install (simplest)
pip install grape --break-system-packages   # PEP 668 environments need this flag

# or a venv (recommended on locked-down hosts)
python3 -m venv ~/.grape-cli && ~/.grape-cli/bin/pip install grape
sudo ln -sf ~/.grape-cli/bin/grape /usr/local/bin/grape

grape --version
which grape
```

Windows native:

```powershell
py -3 --version
py -3 -m pip install grape
# grape.exe lands in %LOCALAPPDATA%\Programs\Python\Python3xx\Scripts
where.exe grape
# If it is missing from PATH, set GRAPE_CLI_BIN to the full path of grape.exe
```

---

## 3. Create a dsh profile

> This guide uses a dedicated profile named `grape`, which is only served by `dsh grape`. If you
> want the plugin in the DeepSeek Harness desktop app, that app always boots `desktop` — replace
> every `grape` below with `desktop` instead of creating another profile.

```bash
dsh plugin --profile grape list     # dsh creates the profile on first use
```

> A newly created profile is base-only (`@deepseek-ai/dsh-base`, no app bundle), so `dsh grape` has
> no UI. Create it from a shipped template first —
> `dsh --profile grape --from-default-profile web --dump-config` — then install.

---

## 4. Install the plugin

### 4.1 From npm (recommended)

```bash
dsh plugin --profile grape add @grape-dev/grape-dsh
```

The published package already contains the compiled `lib/` output, so no extra build step is needed.

### 4.2 From git (tracking the repo)

```bash
dsh plugin --profile grape add git+https://gitcode.com/grape-dev/grape-dsh.git
```

pnpm 11+ blocks build scripts of git dependencies. If you hit
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, add to `~/.dsh/profiles/grape/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "@grape-dev/grape-dsh@git+https://gitcode.com/grape-dev/grape-dsh.git": true
```

then reinstall:

```bash
cd ~/.dsh/profiles/grape && pnpm add git+https://gitcode.com/grape-dev/grape-dsh.git
```

### 4.3 If the dsh web UI says "cannot determine which package was installed"

The package is in `node_modules` but the profile does not list it as a bundle. Edit
`~/.dsh/profiles/grape/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@grape-dev/grape-dsh"
      ]
    }
  }
}
```

Restart dsh afterwards. Both issues above only affect git installs — the npm package is not affected.

---

## 5. Configure credentials

The plugin passes these to the grape CLI (and uses the first two for its panel routes):

```bash
GRAPE_BASE_URL=http://localhost:8000     # Grape server
GRAPE_API_TOKEN=grape_xxxxxxxx           # user-level API key
GRAPE_TIMEOUT=30                         # optional
GRAPE_CLI_BIN=/usr/local/bin/grape       # optional (default: grape from PATH)
```

Recommended: keep them in one file with tight permissions and let the dsh service read it.

```bash
sudo install -d -m 700 /etc/grape-dsh
sudo tee /etc/grape-dsh/grape.env >/dev/null <<'EOF'
GRAPE_BASE_URL=http://localhost:8000
GRAPE_API_TOKEN=grape_xxxxxxxx
EOF
sudo chmod 600 /etc/grape-dsh/grape.env
```

If dsh runs under systemd, add `EnvironmentFile=/etc/grape-dsh/grape.env` to its unit, then
`systemctl daemon-reload && systemctl restart dsh-web`.

Where to get the key: Grape Web → **Settings → API Keys** → create a user-level key (`grape_` prefix).
Do **not** use a `tk_` worker session token or a `tko_` takeover token here — those are scoped to a
single task and are rejected by user-level endpoints.

Optional LLM provider override — `~/.dsh/profiles/grape/cordis.patch.yml`:

```yaml
- id: llm
  config:
    provider: deepseek
    baseUrl: https://api.deepseek.com
    apiKey: sk-xxx
    model: deepseek-chat
```

---

## 6. Verify

### 6.1 Dependency checklist

```bash
echo "node:      $(node --version 2>/dev/null || echo MISSING)"
echo "pnpm:      $(pnpm --version 2>/dev/null || echo MISSING)"
echo "dsh:       $(dsh --version 2>/dev/null || echo MISSING)"
echo "python:    $(python3 --version 2>/dev/null || echo MISSING)"
echo "grape CLI: $(grape --version 2>/dev/null || echo MISSING) at $(which grape 2>/dev/null || echo 'NOT IN PATH')"
echo "base URL:  ${GRAPE_BASE_URL:-NOT SET}"
echo "token:     ${GRAPE_API_TOKEN:+SET (${#GRAPE_API_TOKEN} chars)}"
```

### 6.2 Server reachability and CLI auth

```bash
curl -s "${GRAPE_BASE_URL}/health"
GRAPE_CLI_MODE=USER grape repos managed --json-out | head -c 200
```

### 6.3 Plugin is mounted

```bash
dsh --profile grape --dump-config 2>&1 | grep -i 'grape-tools'
```

### 6.4 In-product smoke test

Start `dsh --profile grape`, then ask:

```
Which repositories are managed in Grape?
```

Expected: the model calls `grape_list_managed_repos`, the call card appears, and the result renders
as a table. Then try `Which pipeline scenes are available?` (`grape_list_scenes`).

### 6.5 Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `grape CLI not found` | not on PATH | `which grape`, or set `GRAPE_CLI_BIN` |
| `authentication failed: token invalid` | wrong/expired key | recreate the `grape_` key in Grape Web |
| `base_url unreachable` | wrong URL / server down | check `GRAPE_BASE_URL`, `curl /health` |
| `HTTP 403: session token (tk_)` | used a worker token | use a `grape_` user API key |
| tools never appear | plugin not in profile bundles | see 4.3, or reinstall from npm |

---

## 7. Register this machine as a Grape worker (optional)

Only needed if this machine should **execute** pipeline tasks, not just observe them.

1. Open the dsh sidebar → Grape panel → **Register this machine as worker**.
2. The panel asks Grape for a worker credential (`rta_…`) and shows the install command for your OS:
   - Linux/macOS: `curl -sSL <base>/api/runtime/install | bash -s -- --token rta_… --server <base>`
   - Windows: `& ([scriptblock]::Create((irm <base>/api/runtime/install.ps1))) -Token rta_… -Server <base>`
3. Run that command in a terminal on this machine. The installer creates its own venv under your
   home directory, writes the credential, starts the runtime agent in the background and registers
   itself with Grape.
4. Verify: Grape Web → Workers/Engines shows a new engine with `status=online`, or run
   `grape runtime list --json-out` and look for this host.

Notes:

- The installer does **not** install execution engines (opencode / hermes / codex …). Install those
  yourself; the worker discovers them on start.
- Re-running the installer is safe (idempotent): it reuses the directory/venv and restarts the agent.
- Revoke: Grape Web → Workers → revoke the credential, then stop the local agent process.

---

## 8. Takeover prerequisites (optional)

Takeover lets a human — with a local agent — execute one pipeline node locally, then hand the result
back to the cloud pipeline. It requires:

- a Grape server that exposes the takeover API (`/api/takeover/sessions*`);
- plugin >= 0.4.0 (this version) and the panel visible in the dsh sidebar;
- `git` available on this machine (the local agent will clone/commit/branch in the workspace);
- the local agent's LLM configured — takeover opens a normal dsh session.

Flow:

1. Panel → issue card → a node in `running` state shows **Take over**.
2. Grape cancels the cloud task, issues a `tko_` token (repo-scoped, 12h) and returns the full bundle.
3. The plugin writes the workspace (`<workspace>/issues/<n>/<agent>/`) including the skill package,
   project graph and the OS-specific scripts, then opens a local session with the rendered prompt.
4. The local agent loads `.grape-takeover-env.sh|ps1`, works, reports progress with
   `.grape-takeover-report.sh|ps1 "…"`, and submits a summary with
   `.grape-takeover-request-finish.sh|ps1 "conclusion" "evidence"`.
5. You click **Confirm complete · dispatch next node** in the panel. Grape records the structured
   conclusion (`conclusion/actions/artifacts/next_step/issue_summary`) and dispatches the next node.
   The node you took over is never re-run.
6. **Abort** instead hands the node back to the pipeline: Grape redispatches the *current* node.

Scripts are rendered by the server for your host OS:

| Host | Environment file | Progress / finish scripts |
|---|---|---|
| Linux / macOS | `.grape-takeover-env.sh` (`source …`) | `.grape-takeover-report.sh`, `.grape-takeover-request-finish.sh` (`sh …`) |
| Windows | `.grape-takeover-env.ps1` (`. .\…ps1`) | `…report.ps1`, `…request-finish.ps1` (`pwsh -ExecutionPolicy Bypass -File …`) |

Token handling: the token is written to `.grape-takeover-token` (0600) and referenced through
`GRAPE_AUTH_FILE`; it never appears inside the scripts.

---

## 9. Exposing dsh behind nginx (optional)

If the dsh web UI must be reachable from outside this host, reverse-proxy it — do not bind dsh's port
to the public interface directly.

```nginx
server {
    listen 443 ssl;
    server_name dsh.example.com;

    location / {
        proxy_pass http://127.0.0.1:3001;      # dsh web
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # SSE / websocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Keep the resulting URL's `?token=` out of shell history; it is the dsh session token.

---

## 10. Full deployment checklist

```bash
#!/bin/bash
set -u
echo "1. node      : $(node --version 2>/dev/null || echo MISSING)"
echo "2. pnpm      : $(pnpm --version 2>/dev/null || echo MISSING)"
echo "3. dsh       : $(dsh --version 2>/dev/null || echo MISSING)"
echo "4. python    : $(python3 --version 2>/dev/null || echo MISSING)"
echo "5. grape CLI : $(grape --version 2>/dev/null || echo MISSING)"
echo "6. grape path: $(command -v grape || echo NOT_IN_PATH)"
echo "7. base URL  : ${GRAPE_BASE_URL:-NOT_SET}"
echo "8. token     : ${GRAPE_API_TOKEN:+SET(${#GRAPE_API_TOKEN})}"
echo "9. plugin    : $(dsh --profile grape --dump-config 2>/dev/null | grep -c 'grape-tools') (>=1 means mounted)"
echo "10. server   : $(curl -s -o /dev/null -w '%{http_code}' "${GRAPE_BASE_URL:-http://127.0.0.1:8000}/health")"
echo "11. cli auth : $(GRAPE_CLI_MODE=USER grape repos managed --json-out 2>&1 | head -c 60)"
```

Every line must be a version, `SET(n)`, `200` and a JSON payload. Anything else — see §6.5.

---

## 11. Platform notes

**macOS**

- Prefer Homebrew for Node/Python; `pip install --break-system-packages` is not needed inside a venv.
- The first run may ask for access to Desktop/Documents (TCC). Keep workspaces under your home
  directory, not in protected folders.
- dsh can be started manually (`nohup dsh --profile grape &`) or with a `launchd` plist.

**Windows (native)**

- Install the plugin and run commands in **PowerShell**, not `cmd`.
- The plugin writes takeover scripts as `.ps1` with UTF-8 BOM; run them with
  `pwsh -ExecutionPolicy Bypass -File .\script.ps1`.
- `systemd` is not available: keep dsh running via a scheduled task or a startup shortcut.
- If `grape` is not on PATH, set `GRAPE_CLI_BIN` to the full path of `grape.exe`.

**WSL2**

- Everything is Linux inside WSL; follow the Linux steps. Note that processes in WSL cannot be
  reached from Windows tooling unless you expose the port.