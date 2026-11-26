# GATE 3 (Windows) — post-install acceptance.
# Usage: pwsh -File scripts/verify.ps1 [-Profile <name>]   (default: $env:DSH_PROFILE, then grape)
# Checks plugin list, grape-tools bundle, and user auth profile. Never prints token values.
param(
    [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'grape' })
)

$ErrorActionPreference = 'Continue'
$Pkg = '@grape-dev/grape-dsh'
$fail = $false

function Show-Failure {
    param([string]$Label, [int]$Code, [string]$Output)
    Write-Output "FAIL [$Label] exit=$Code"
    ($Output -split "`r?`n" | Select-Object -First 20) | ForEach-Object { Write-Output $_ }
    $script:fail = $true
}

Write-Output '== grape-dsh acceptance =='
Write-Output "profile: $Profile"

Write-Output "+ dsh plugin --profile $Profile list"
$listOutput = (dsh plugin --profile $Profile list 2>&1 | Out-String)
$listCode = $LASTEXITCODE
if ($listCode -ne 0) {
    Show-Failure 'plugin-list' $listCode $listOutput
} elseif ($listOutput -match [regex]::Escape($Pkg)) {
    Write-Output "PASS  plugin-list: $Pkg present"
} else {
    Write-Output "FAIL  plugin-list: $Pkg not found in profile $Profile"
    $fail = $true
}

Write-Output "+ dsh --profile $Profile --dump-config"
$dumpOutput = (dsh --profile $Profile --dump-config 2>&1 | Out-String)
$dumpCode = $LASTEXITCODE
if ($dumpCode -ne 0) {
    Show-Failure 'dump-config' $dumpCode $dumpOutput
} elseif ($dumpOutput -match 'grape-tools') {
    Write-Output 'PASS  dump-config: grape-tools mounted'
} else {
    Write-Output 'FAIL  dump-config: grape-tools not mounted (see AGENT-DEPLOYMENT-GUIDE.md section 4 Repair B)'
    $fail = $true
}

if ([string]::IsNullOrEmpty($env:GRAPE_API_TOKEN)) {
    Write-Output 'FAIL  auth-profile: GRAPE_API_TOKEN is not set (a user-level grape_ key is required)'
    $fail = $true
} else {
    Write-Output ("info  auth-profile: GRAPE_API_TOKEN set ({0} chars, value not printed)" -f $env:GRAPE_API_TOKEN.Length)
    $env:GRAPE_CLI_MODE = 'USER'
    Write-Output '+ grape auth profile --json-out'
    $authOutput = (grape auth profile --json-out 2>&1 | Out-String)
    $authCode = $LASTEXITCODE
    if ($authCode -ne 0) {
        Show-Failure 'auth-profile' $authCode $authOutput
    } else {
        Write-Output 'PASS  auth-profile: user profile reachable'
    }
}

if ($fail) {
    Write-Output 'GATE 3 FAILED — stop here and report the failing command, exit code and output above.'
    exit 1
}
Write-Output 'GATE 3 PASSED'
Write-Output "note: in-product smoke test is user-side — start dsh --profile $Profile and ask: Which repositories are managed in Grape?"