# GATE 1 (Windows) — toolchain preflight for grape-dsh.
# Usage: pwsh -File scripts/preflight.ps1
# Read-only. Prints versions only, never secrets.

$ErrorActionPreference = 'Continue'
$fail = $false

function ConvertTo-VersionNumber {
    param([string]$Value)
    $number = 0
    [void][int]::TryParse(($Value -replace '[^0-9].*$', ''), [ref]$number)
    return $number
}

function Test-Version {
    param([string]$Name, [string]$Minimum, [string]$Actual, [string]$Command)
    if ([string]::IsNullOrWhiteSpace($Actual)) {
        Write-Output ("FAIL  {0,-7} missing (command: {1})" -f $Name, $Command)
        $script:fail = $true
        return
    }
    $text = ($Actual.Trim() -replace '\s+', ' ')
    $clean = $text -replace '^v', '' -replace '^[^0-9]*', ''
    if ($clean -notmatch '^\d') {
        Write-Output ("FAIL  {0,-7} unparsable version '{1}' (command: {2})" -f $Name, $text, $Command)
        $script:fail = $true
        return
    }
    $a = ($clean -split '\.')
    $b = ($Minimum -split '\.')
    $ok = $false
    for ($i = 0; $i -lt 3; $i++) {
        $av = if ($i -lt $a.Count) { ConvertTo-VersionNumber $a[$i] } else { 0 }
        $bv = if ($i -lt $b.Count) { ConvertTo-VersionNumber $b[$i] } else { 0 }
        if ($av -gt $bv) { $ok = $true; break }
        if ($av -lt $bv) { $ok = $false; break }
        if ($i -eq 2) { $ok = $true }
    }
    if ($ok) {
        Write-Output ("PASS  {0,-7} {1} (require >= {2})" -f $Name, $Actual, $Minimum)
    } else {
        Write-Output ("FAIL  {0,-7} {1} below required {2} (command: {3})" -f $Name, $Actual, $Minimum, $Command)
        $script:fail = $true
    }
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

Write-Output '== grape-dsh preflight =='

$node = (node --version 2>$null)
Test-Version 'node' '18' ($node -replace '^v', '') 'node --version'

$pyRaw = $null
$pyCmd = 'py -3 --version'
if (Get-Command python3 -ErrorAction SilentlyContinue) {
    $pyRaw = (& python3 --version 2>&1)
    $pyCmd = 'python3 --version'
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $pyRaw = (& py -3 --version 2>&1)
}
$py = if ($pyRaw) { ($pyRaw | Out-String).Trim() -replace '^Python ', '' } else { '' }
Test-Version 'python' '3.10' $py $pyCmd

if (Get-Command grape -ErrorAction SilentlyContinue) {
    $grape = ((grape --version 2>$null) | Select-Object -First 1) -replace '^grape\s+', ''
    Test-Version 'grape' '0.3.3' $grape 'grape --version'
} else {
    Write-Output 'FAIL  grape   missing (install the PyPI package "grape-cli": python -m pip install "grape-cli>=0.3.3")'
    $fail = $true
}

$dsh = Resolve-Dsh
if (-not $dsh) {
    Write-Output 'FAIL  dsh     missing (command: dsh --version)'
    Write-Output '              Install dsh ("npm install -g @deepseek-ai/dsh") or the DeepSeek Harness desktop app, then re-run.'
    Write-Output '              Manual check: dsh --version'
    Write-Output '              Desktop entry: %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    $fail = $true
} else {
    $dshRaw = ((& $dsh --version 2>$null) | Select-Object -First 1)
    $onPath = (Get-Command dsh -ErrorAction SilentlyContinue)
    if (-not $onPath) {
        Test-Version 'dsh' '0.2.0' $dshRaw "$dsh --version (desktop entry, not on PATH)"
    } else {
        Test-Version 'dsh' '0.2.0' $dshRaw 'dsh --version'
    }
}

if ($fail) {
    Write-Output 'GATE 1 FAILED — install the missing tool(s) with AGENT-DEPLOYMENT-GUIDE.md section 2, then re-run.'
    exit 1
}
Write-Output 'GATE 1 PASSED'