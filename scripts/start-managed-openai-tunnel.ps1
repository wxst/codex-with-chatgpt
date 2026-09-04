[CmdletBinding()]
param(
  [ValidateSet("start", "stop")]
  [string]$Mode = "start",
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)]
  [string]$RuntimeAlias,
  [string]$Node = (Get-Command node -ErrorAction Stop).Source,
  [string]$TunnelClient = (Join-Path $env:USERPROFILE ".local\bin\tunnel-client.exe"),
  [string]$ProfileDir = (Join-Path $env:APPDATA "tunnel-client"),
  [string]$StateDir = (Join-Path $env:USERPROFILE ".config\codex-with-chatgpt\c2c-state"),
  [string]$KeyFile = (Join-Path $env:USERPROFILE ".config\codex-with-chatgpt\tunnel-runtime-key.dpapi"),
  [string]$TunnelIdFile = (Join-Path $env:USERPROFILE ".config\codex-with-chatgpt\tunnel-runtime-id.dpapi")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$C2C = Join-Path $WorkspaceRoot "bin\c2c.js"
$env:C2C_STATE_DIR = $StateDir

function Read-C2cJson([string]$Text) {
  $start = $Text.IndexOf("{")
  if ($start -lt 0) { throw "c2c_json_result_missing" }
  return ($Text.Substring($start) | ConvertFrom-Json)
}

function Clear-ControlPlaneEnvironment() {
  Remove-Item Env:CONTROL_PLANE_API_KEY, Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue
}

function Invoke-ManagedRuntimeCredential([scriptblock]$Operation) {
  $apiBytes = $null
  $tunnelIdBytes = $null
  $exitCode = 1
  Clear-ControlPlaneEnvironment
  try {
    if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf) -or -not (Test-Path -LiteralPath $TunnelIdFile -PathType Leaf)) {
      throw "managed_runtime_credential_file_missing"
    }
    Add-Type -AssemblyName System.Security
    $apiBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      [IO.File]::ReadAllBytes($KeyFile), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $tunnelIdBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      [IO.File]::ReadAllBytes($TunnelIdFile), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $env:CONTROL_PLANE_API_KEY = [Text.Encoding]::UTF8.GetString($apiBytes)
    $env:CONTROL_PLANE_TUNNEL_ID = [Text.Encoding]::UTF8.GetString($tunnelIdBytes)
    & $Operation
    $exitCode = $LASTEXITCODE
  }
  finally {
    Clear-ControlPlaneEnvironment
    if ($null -ne $apiBytes) { [Array]::Clear($apiBytes, 0, $apiBytes.Length) }
    if ($null -ne $tunnelIdBytes) { [Array]::Clear($tunnelIdBytes, 0, $tunnelIdBytes.Length) }
  }
  return $exitCode
}

function Get-ManagedRuntimeDiagnosis() {
  $text = (& $Node $C2C runtime diagnose -w $WorkspaceRoot --runtime-alias $RuntimeAlias --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "managed_runtime_diagnose_failed" }
  return (Read-C2cJson $text).runtime
}

try {
  if ($Mode -eq "stop") {
    $stopExit = Invoke-ManagedRuntimeCredential {
      & $TunnelClient runtimes stop $RuntimeAlias --json *> $null
    }
    if ($stopExit -ne 0) { throw "managed_runtime_stop_failed" }
    exit 0
  }

  $setupText = (& $Node $C2C setup -w $WorkspaceRoot --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "c2c_setup_failed" }
  $setup = Read-C2cJson $setupText
  if (-not $setup.ok -or $setup.transportMode -ne "openai") { throw "c2c_setup_state_failed" }

  $statusText = (& $Node $C2C status -w $WorkspaceRoot --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "c2c_status_failed" }
  $status = Read-C2cJson $statusText
  if (-not $status.running) { throw "bridge_not_running" }

  $tokenHeader = "X-C2C-Tunnel-Token: file:$($setup.openai.tokenFile)"
  $connectExit = Invoke-ManagedRuntimeCredential {
    $env:MCP_EXTRA_HEADERS = $tokenHeader
    $env:MCP_DISCOVERY_EXTRA_HEADERS = $tokenHeader
    try {
      & $TunnelClient runtimes connect `
        --alias $RuntimeAlias `
        --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID `
        --profile $RuntimeAlias `
        --profile-dir $ProfileDir `
        --mcp-server-url "http://127.0.0.1:$($status.port)/mcp" `
        --json *> $null
    }
    finally {
      Remove-Item Env:MCP_EXTRA_HEADERS, Env:MCP_DISCOVERY_EXTRA_HEADERS -ErrorAction SilentlyContinue
    }
  }
  if ($connectExit -ne 0) { throw "managed_runtime_connect_failed" }

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $runtime = Get-ManagedRuntimeDiagnosis
    if ($runtime.credentialState -eq "verified" -and $runtime.processRunning -and $runtime.healthy -and $runtime.ready -and -not $runtime.stale) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw "managed_runtime_not_ready" }

  $watchdogFailures = 0
  while ($true) {
    Start-Sleep -Seconds 30
    $bridgeOk = $false
    $runtimeOk = $false
    try {
      $bridgeText = (& $Node $C2C status -w $WorkspaceRoot --json 2>&1 | Out-String)
      if ($LASTEXITCODE -eq 0) { $bridgeOk = [bool](Read-C2cJson $bridgeText).running }
      $runtime = Get-ManagedRuntimeDiagnosis
      $runtimeOk = $runtime.credentialState -eq "verified" -and $runtime.processRunning -and $runtime.healthy -and $runtime.ready -and -not $runtime.stale
    }
    catch {
      $bridgeOk = $false
      $runtimeOk = $false
    }

    if ($bridgeOk -and $runtimeOk) {
      $watchdogFailures = 0
      continue
    }
    $watchdogFailures += 1
    if ($watchdogFailures -ge 3) { throw "managed_runtime_watchdog_unhealthy" }
    Start-Sleep -Seconds 5
  }
}
catch {
  Write-Error $_
  exit 1
}
