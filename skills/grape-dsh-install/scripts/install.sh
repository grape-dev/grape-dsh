#!/usr/bin/env bash
# GATE 2 — build @grape-dev/grape-dsh from source and install the tarball.
# Usage: install.sh [profile] [ref]      (profile defaults to $DSH_PROFILE, then to grape)
#
# The package is published on npm since 0.5.0, but the verified path here builds from source:
#   clone -> minimize build dependencies -> tsc -> build-client.mjs -> pnpm pack
#   -> plugin_manager install_bundle <absolute tgz>
# From a shell this script performs the same install_bundle steps:
#   dsh plugin add file:<tgz> + register the package in dsh.profile.bundles.
# Idempotent: an already present exact version prints "skipped: already-present".
set -u

PROFILE="${1:-${DSH_PROFILE:-grape}}"
REF="${2:-}"
PKG="@grape-dev/grape-dsh"
REPO_URL="https://gitcode.com/grape-dev/grape-dsh.git"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
BUILD_DIR="${GRAPE_DSH_BUILD_DIR:-$DSH_HOME_DIR/tools/grape-dsh-build}"
TARBALL_DIR="${GRAPE_DSH_TARBALL_DIR:-$DSH_HOME_DIR/tools/grape-dsh-tarballs}"

fail() {
  echo "FAILED [$1] $2" >&2
  exit "${3:-1}"
}

to_native() {
  # Git Bash/MSYS/Cygwin pass POSIX paths to native node/pnpm/dsh; convert them.
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

resolve_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi
  if [ -n "${LOCALAPPDATA:-}" ]; then
    candidate="$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  candidate="$HOME/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

run_in() {
  # run_in <label> <dir> <command...> — prints command, exit code and first 20 lines on failure
  label="$1"; dir="$2"; shift 2
  echo "+ (cd $dir && $*)"
  out="$(cd "$dir" && "$@" 2>&1)"
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "FAILED [$label] exit=$code"
    printf '%s\n' "$out" | head -n 20
    exit "$code"
  fi
}

echo "== grape-dsh install (source build -> install_bundle) =="
echo "profile: $PROFILE"
echo "build:   $BUILD_DIR"

if [ -z "$PROFILE" ]; then
  fail args "empty profile name"
fi

DSH_BIN="$(resolve_dsh)" || fail preflight \
  "dsh not found. Install it with 'npm install -g @deepseek-ai/dsh' or the DeepSeek Harness desktop app; expected desktop entry: %LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd"
echo "dsh:     $DSH_BIN"

mkdir -p "$DSH_HOME_DIR/tools" || fail mkdir "cannot create $DSH_HOME_DIR/tools"
mkdir -p "$TARBALL_DIR" || fail mkdir "cannot create $TARBALL_DIR"
TARBALL_DIR="$(cd "$TARBALL_DIR" && pwd)"

# 1. Clone (reuse an existing checkout to stay idempotent)
if [ -d "$BUILD_DIR/.git" ]; then
  echo "reusing build checkout: $BUILD_DIR"
else
  if [ -e "$BUILD_DIR" ]; then
    fail clone "build dir exists but is not a git checkout: $BUILD_DIR (remove it or set GRAPE_DSH_BUILD_DIR)"
  fi
  echo "+ git clone --depth 1 $REPO_URL $BUILD_DIR"
  clone_out="$(git -c http.sslBackend=openssl clone --depth 1 ${REF:+--branch "$REF"} "$REPO_URL" "$BUILD_DIR" 2>&1)"
  clone_code=$?
  if [ "$clone_code" -ne 0 ]; then
    echo "FAILED [clone] exit=$clone_code"
    printf '%s\n' "$clone_out" | head -n 20
    exit "$clone_code"
  fi
fi
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"

VERSION="$(cd "$BUILD_DIR" && node -p "require('./package.json').version")" \
  || fail metadata "cannot read package version from $BUILD_DIR/package.json"
BASE_NAME="$(cd "$BUILD_DIR" && node -p "require('./package.json').name.replace(/^@/,'').replace(/\//g,'-')")" \
  || fail metadata "cannot read package name from $BUILD_DIR/package.json"
TGZ="$TARBALL_DIR/$BASE_NAME-$VERSION.tgz"
TGZ_NATIVE="$(to_native "$TGZ")"
echo "version: $VERSION"

# Profile list also creates the profile on first use.
list_out="$("$DSH_BIN" plugin --profile "$PROFILE" list 2>&1)"
list_code=$?
if [ "$list_code" -ne 0 ]; then
  echo "FAILED [profile-list] exit=$list_code"
  printf '%s\n' "$list_out" | head -n 20
  exit "$list_code"
fi

if printf '%s\n' "$list_out" | grep -Fq "$PKG@$VERSION" && [ -f "$TGZ" ]; then
  echo "skipped: already-present ($PKG@$VERSION in profile $PROFILE)"
  echo "tarball: $TGZ_NATIVE"
  echo "GATE 2 PASSED (idempotent skip)"
  exit 0
fi

INSTALLED_NOW=no
if printf '%s\n' "$list_out" | grep -Fq "$PKG@$VERSION"; then
  INSTALLED_NOW=yes
fi

# 2. Minimize build dependencies: drop peerDependencies, keep four devDependencies.
echo "+ minimize package.json (drop peerDependencies, keep 4 devDependencies)"
(cd "$BUILD_DIR" && node <<'NODE'
const fs = require('fs')
const p = './package.json'
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
delete pkg.peerDependencies
const keep = ['@deepseek-ai/schemastery', '@types/node', 'esbuild', 'typescript']
const current = pkg.devDependencies || {}
const fallback = {
  '@deepseek-ai/schemastery': '^3.19.0',
  '@types/node': '^22.0.0',
  esbuild: '^0.28.2',
  typescript: '^5.0.0',
}
const next = {}
for (const name of keep) next[name] = current[name] || fallback[name]
pkg.devDependencies = next
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
NODE
) || fail minimize "failed to rewrite package.json"

run_in pnpm-install "$BUILD_DIR" pnpm install --config.ignore-scripts=true --no-frozen-lockfile

# 3. Compile the server half.
run_in build-server "$BUILD_DIR" node node_modules/typescript/bin/tsc

# 4. Bundle the client half.
run_in build-client "$BUILD_DIR" node scripts/build-client.mjs

# 5. Restore manifests, then pack the tarball into a stable absolute path.
run_in restore-manifests "$BUILD_DIR" git checkout -- package.json package-lock.json
mkdir -p "$TARBALL_DIR" || fail mkdir "cannot create $TARBALL_DIR"
run_in pack-tarball "$BUILD_DIR" pnpm pack --config.ignore-scripts=true --pack-destination "$TARBALL_DIR"

if [ ! -f "$TGZ" ]; then
  echo "FAILED [pack] expected tarball not found: $TGZ_NATIVE"
  ls -1 "$TARBALL_DIR" 2>/dev/null | head -n 20
  exit 1
fi

# 6. Install the bundle (equivalent to plugin_manager install_bundle <abs tgz>).
if [ "$INSTALLED_NOW" = "yes" ]; then
  echo "skipped: already-present ($PKG@$VERSION in profile $PROFILE)"
  echo "tarball: $TGZ_NATIVE"
  echo "GATE 2 PASSED (idempotent skip)"
  exit 0
fi

echo "+ $DSH_BIN plugin --profile $PROFILE add file:$TGZ_NATIVE"
add_out="$("$DSH_BIN" plugin --profile "$PROFILE" add "file:$TGZ_NATIVE" 2>&1)"
add_code=$?
if [ "$add_code" -ne 0 ]; then
  echo "FAILED [install-bundle] exit=$add_code"
  printf '%s\n' "$add_out" | head -n 20
  exit "$add_code"
fi

# install_bundle also writes the profile bundles list; do the same from a shell.
PROFILE_JSON="$DSH_HOME_DIR/profiles/$PROFILE/package.json"
PROFILE_JSON_NATIVE="$(to_native "$PROFILE_JSON")"
if [ -f "$PROFILE_JSON" ]; then
  node -e '
const fs = require("fs")
const [file, name] = process.argv.slice(1)
const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
j.dsh = j.dsh || {}
j.dsh.profile = j.dsh.profile || {}
j.dsh.profile.bundles = j.dsh.profile.bundles || []
if (!j.dsh.profile.bundles.includes(name)) j.dsh.profile.bundles.push(name)
fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n", "utf8")
' "$PROFILE_JSON_NATIVE" "$PKG" || fail register-bundle "cannot update $PROFILE_JSON_NATIVE"
else
  echo "note: profile package.json not found at $PROFILE_JSON; bundle registration skipped"
fi

echo "tarball: $TGZ_NATIVE"
echo "installed: $PKG@$VERSION in profile $PROFILE (equivalent of plugin_manager install_bundle)"
echo "GATE 2 PASSED"