# GATE 2 (Windows) — build @grape-dev/grape-dsh from source and install the tarball.
# Usage: pwsh -File scripts/install.ps1 [-Profile <name>] [-Ref <branch-or-tag>]
#        Profile defaults to $env:DSH_PROFILE, then to 'grape'.
#
# The package is published on npm since 0.5.0, but the verified path here builds from source:
#   clone -> minimize build dependencies -> tsc -> build-client.mjs -> pnpm pack
#   -> plugin_manager install_bundle <absolute tgz>
# From a shell this script performs the same install_bundle steps:
#   dsh plugin add file:<tgz> + register the package in dsh.profile.bundles.
# Idempotent: an already present exact version prints "skipped: already-present".
param(
    [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'grape' }),
    [string]$Ref = '',
    [string]$BuildDir = '',
    [string]$TarballDir = ''
)

$ErrorActionPreference = 'Continue'
$Pkg = '@grape-dev/grape-dsh'
$RepoUrl = 'https://gitcode.com/grape-dev/grape-dsh.git'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if ([string]::IsNullOrWhiteSpace($BuildDir)) { $BuildDir = Join-Path $DshHome 'tools\grape-dsh-build' }
if ([string]::IsNullOrWhiteSpace($TarballDir)) { $TarballDir = Join-Path $DshHome 'tools\grape-dsh-tarballs' }

function Fail {
    param([string]$Gate, [string]$Message, [int]$Code = 1)
    Write-Output "FAILED [$Gate] $Message"
    exit $Code
}

function Resolve-Dsh {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if ($env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $fallback = Join-Path $HOME 'AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

function Invoke-In {
    param([string]$Label, [string]$Directory, [string]$File, [string[]]$Arguments = @())
    Write-Output ("+ (cd {0}) {1} {2}" -f $Directory, $File, ($Arguments -join ' '))
    Push-Location -LiteralPath $Directory
    try {
        $out = (& $File @Arguments 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        Write-Output "FAILED [$Label] exit=$code"
        ($out -split "`r?`n" | Select-Object -First 20) | ForEach-Object { Write-Output $_ }
        exit $code
    }
}

Write-Output '== grape-dsh install (source build -> install_bundle) =='
Write-Output "profile: $Profile"
Write-Output "build:   $BuildDir"

if ([string]::IsNullOrWhiteSpace($Profile)) { Fail 'args' 'empty profile name' }

$dsh = Resolve-Dsh
if (-not $dsh) {
    Fail 'preflight' "dsh not found. Install it with 'npm install -g @deepseek-ai/dsh' or the DeepSeek Harness desktop app; expected desktop entry: %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
}
Write-Output "dsh:     $dsh"

$toolsDir = Split-Path -Parent $BuildDir
if (-not (Test-Path -LiteralPath $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $TarballDir)) { New-Item -ItemType Directory -Path $TarballDir -Force | Out-Null }
$TarballDir = (Resolve-Path -LiteralPath $TarballDir).Path

# 1. Clone (reuse an existing checkout to stay idempotent).
if (Test-Path -LiteralPath (Join-Path $BuildDir '.git')) {
    Write-Output "reusing build checkout: $BuildDir"
} elseif (Test-Path -LiteralPath $BuildDir) {
    Fail 'clone' "build dir exists but is not a git checkout: $BuildDir (remove it or pass -BuildDir)"
} else {
    $parent = Split-Path -Parent $BuildDir
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $gitArgs = @('-c', 'http.sslBackend=openssl', 'clone', '--depth', '1')
    if (-not [string]::IsNullOrWhiteSpace($Ref)) { $gitArgs += @('--branch', $Ref) }
    $gitArgs += @($RepoUrl, $BuildDir)
    Invoke-In 'clone' $parent 'git' $gitArgs
}
$BuildDir = (Resolve-Path -LiteralPath $BuildDir).Path

$pkgJson = Get-Content -LiteralPath (Join-Path $BuildDir 'package.json') -Raw | ConvertFrom-Json
$Version = $pkgJson.version
$BaseName = $pkgJson.name.TrimStart('@').Replace('/', '-')
$Tgz = Join-Path $TarballDir "$BaseName-$Version.tgz"
Write-Output "version: $Version"

# Profile list also creates the profile on first use.
$listOut = (& $dsh plugin --profile $Profile list 2>&1 | Out-String)
$listCode = $LASTEXITCODE
if ($listCode -ne 0) {
    Write-Output "FAILED [profile-list] exit=$listCode"
    ($listOut -split "`r?`n" | Select-Object -First 20) | ForEach-Object { Write-Output $_ }
    exit $listCode
}

if ($listOut -match [regex]::Escape("$Pkg@$Version") -and (Test-Path -LiteralPath $Tgz)) {
    Write-Output "skipped: already-present ($Pkg@$Version in profile $Profile)"
    Write-Output "tarball: $Tgz"
    Write-Output 'GATE 2 PASSED (idempotent skip)'
    exit 0
}

$already = ($listOut -match [regex]::Escape("$Pkg@$Version"))

# 2. Minimize build dependencies: drop peerDependencies, keep four devDependencies.
Write-Output '+ minimize package.json (drop peerDependencies, keep 4 devDependencies)'
$packagePath = Join-Path $BuildDir 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$package.PSObject.Properties.Remove('peerDependencies')
$keep = @('@deepseek-ai/schemastery', '@types/node', 'esbuild', 'typescript')
$fallback = @{
    '@deepseek-ai/schemastery' = '^3.19.0'
    '@types/node'              = '^22.0.0'
    'esbuild'                  = '^0.28.2'
    'typescript'               = '^5.0.0'
}
$current = $package.devDependencies
$next = [ordered]@{}
foreach ($name in $keep) {
    $range = $null
    if ($current -and $current.PSObject.Properties[$name]) { $range = $current.$name }
    if (-not $range) { $range = $fallback[$name] }
    $next[$name] = $range
}
$package | Add-Member -NotePropertyName devDependencies -NotePropertyValue ([pscustomobject]$next) -Force
$json = $package | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($packagePath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

Invoke-In 'pnpm-install' $BuildDir 'pnpm' @('install', '--config.ignore-scripts=true', '--no-frozen-lockfile')

# 3. Compile the server half.
Invoke-In 'build-server' $BuildDir 'node' @('node_modules/typescript/bin/tsc')

# 4. Bundle the client half.
Invoke-In 'build-client' $BuildDir 'node' @('scripts/build-client.mjs')

# 5. Restore manifests, then pack the tarball into a stable absolute path.
Invoke-In 'restore-manifests' $BuildDir 'git' @('checkout', '--', 'package.json', 'package-lock.json')
Invoke-In 'pack-tarball' $BuildDir 'pnpm' @('pack', '--config.ignore-scripts=true', '--pack-destination', $TarballDir)

if (-not (Test-Path -LiteralPath $Tgz)) {
    Write-Output "FAILED [pack] expected tarball not found: $Tgz"
    (Get-ChildItem -LiteralPath $TarballDir -ErrorAction SilentlyContinue | Select-Object -First 20) | ForEach-Object { Write-Output $_ }
    exit 1
}

# 6. Install the bundle (equivalent to plugin_manager install_bundle <abs tgz>).
if ($already) {
    Write-Output "skipped: already-present ($Pkg@$Version in profile $Profile)"
    Write-Output "tarball: $Tgz"
    Write-Output 'GATE 2 PASSED (idempotent skip)'
    exit 0
}

Invoke-In 'install-bundle' $BuildDir $dsh @('plugin', '--profile', $Profile, 'add', "file:$Tgz")

# install_bundle also writes the profile bundles list; do the same from a shell.
$profileJson = Join-Path (Join-Path $DshHome 'profiles') (Join-Path $Profile 'package.json')
if (Test-Path -LiteralPath $profileJson) {
    $j = Get-Content -LiteralPath $profileJson -Raw | ConvertFrom-Json
    if (-not $j.dsh) { $j | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
    if (-not $j.dsh.profile) { $j.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
    if (-not $j.dsh.profile.bundles) { $j.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }
    $bundles = @($j.dsh.profile.bundles)
    if ($bundles -notcontains $Pkg) { $bundles += $Pkg }
    $j.dsh.profile.bundles = $bundles
    [System.IO.File]::WriteAllText($profileJson, (($j | ConvertTo-Json -Depth 20) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
} else {
    Write-Output "note: profile package.json not found at $profileJson; bundle registration skipped"
}

Write-Output "tarball: $Tgz"
Write-Output "installed: $Pkg@$Version in profile $Profile (equivalent of plugin_manager install_bundle)"
Write-Output 'GATE 2 PASSED'