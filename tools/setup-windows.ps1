# Called by setup-windows.bat (which makes sure Node.js is on PATH).
# Works in Windows PowerShell 5.1 and PowerShell 7.

param(
    [switch]$NoStart,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Repo '.env'
$RuleName = 'displayxr-muse-voice bridge'

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "warning: $msg" -ForegroundColor Yellow }

# ── .env ──────────────────────────────────────────────────────────────────────────────────

function Read-EnvFile {
    $map = [ordered]@{}
    if (Test-Path $EnvFile) {
        foreach ($line in Get-Content $EnvFile) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
                $map[$Matches[1]] = $Matches[2].Trim('"', "'")
            }
        }
    }
    $map
}

function Set-EnvValue($key, $value) {
    $lines = @(Get-Content $EnvFile)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$key\s*=") { $lines[$i] = "$key=$value"; $found = $true }
    }
    if (-not $found) { $lines += "$key=$value" }
    # UTF-8 without BOM, LF, so the same file works on the Pi.
    [IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
}

function New-Secret {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-LanAddress {
    try {
        $cfg = Get-NetIPConfiguration |
            Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
            Select-Object -First 1
        if ($cfg) { return $cfg.IPv4Address[0].IPAddress }
    } catch { }
    return $null
}

if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $Repo '.env.example') $EnvFile
    Say 'Created .env from .env.example'
}
$envMap = Read-EnvFile
$port = if ($envMap['BRIDGE_PORT']) { [int]$envMap['BRIDGE_PORT'] } else { 8791 }

if (-not $envMap['BRIDGE_SECRET'] -or $envMap['BRIDGE_SECRET'].Length -lt 16) {
    Set-EnvValue 'BRIDGE_SECRET' (New-Secret)
    Say 'Generated BRIDGE_SECRET'
}
$lan = Get-LanAddress
$url = $envMap['BRIDGE_URL']
if (-not $url -or $url -match '192\.168\.1\.50' -or $url -match '://(localhost|127\.)') {
    if ($lan) {
        Set-EnvValue 'BRIDGE_URL' "ws://${lan}:$port/ws"
        Say "BRIDGE_URL set to ws://${lan}:$port/ws (this PC on the LAN)"
    } else {
        Warn "couldn't find this PC's LAN address; set BRIDGE_URL in .env by hand."
    }
}
$envMap = Read-EnvFile

# ── Bridge dependencies ───────────────────────────────────────────────────────────────────

Say 'Installing the bridge (npm ci)'
Push-Location (Join-Path $Repo 'bridge')
try {
    & npm.cmd ci --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally { Pop-Location }

# ── Firewall (only when elevated) ─────────────────────────────────────────────────────────

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
    IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($rule) {
    Say 'Firewall rule already present'
} elseif ($admin) {
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $port `
        -Profile Private -Action Allow | Out-Null
    Say "Allowed inbound TCP $port on Private networks"
} else {
    Warn "the Pi can't reach the bridge until TCP $port is allowed in. Run setup-windows.bat as administrator once (adds a Private-network-only rule), or allow it yourself."
}

# ── Start the bridge ─────────────────────────────────────────────────────────────────────

function Test-OurBridge {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
        return ($h.ok -eq $true -and $null -ne $h.displays)
    } catch { return $false }
}

$displayUrl = "http://localhost:$port/#secret=$($envMap['BRIDGE_SECRET'])"

if (-not $NoStart) {
    if (Test-OurBridge) {
        Say "The bridge is already running on port $port"
    } else {
        $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($busy) {
            throw "port $port is used by another program (PID $($busy[0].OwningProcess)). Set BRIDGE_PORT in .env to a free port, update BRIDGE_URL to match, and run this again."
        }
        Say 'Starting the bridge in its own window'
        Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory (Join-Path $Repo 'bridge')
        $deadline = (Get-Date).AddSeconds(10)
        while (-not (Test-OurBridge)) {
            if ((Get-Date) -gt $deadline) { throw 'the bridge did not start; check its window for the error.' }
            Start-Sleep -Milliseconds 250
        }
        Say "Bridge up on port $port"
    }
    if (-not $NoBrowser) { Start-Process $displayUrl }
}

Write-Host ''
Write-Host 'Display page (open in the DisplayXR Browser for glasses-free 3D):' -ForegroundColor Green
Write-Host "  $displayUrl"
Write-Host ''
Write-Host 'For the Raspberry Pi, put these two lines in its .env (keep the secret private):' -ForegroundColor Green
Write-Host "  BRIDGE_URL=$($envMap['BRIDGE_URL'])"
Write-Host "  BRIDGE_SECRET=$($envMap['BRIDGE_SECRET'])"
Write-Host ''
Write-Host 'Try it now without Muse:' -ForegroundColor Green
Write-Host '  node bridge\mock.js show_model car'
