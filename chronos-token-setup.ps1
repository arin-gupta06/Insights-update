param(
  [string]$EnvFilePath = "$PSScriptRoot\.env",
  [string]$TokenFilePath = "$env:USERPROFILE\.chronos\github_token.dpapi",
  [switch]$CreateStartupShortcut,
  [switch]$UseDpapi
)

$ErrorActionPreference = 'Stop'

function Write-Info {
  param([string]$Message)
  Write-Host "[chronos-setup] $Message"
}

$tokenDir = Split-Path -Parent $TokenFilePath
if (-not (Test-Path $tokenDir)) {
  New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null
}

$envDir = Split-Path -Parent $EnvFilePath
if ($envDir -and -not (Test-Path $envDir)) {
  New-Item -ItemType Directory -Path $envDir -Force | Out-Null
}

try {
  $secureToken = Read-Host "Paste GitHub token (input hidden)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

  if ([string]::IsNullOrWhiteSpace($plain)) {
    throw "Empty token provided."
  }

  if ($UseDpapi) {
    $secureToken | ConvertFrom-SecureString | Set-Content -Path $TokenFilePath -Encoding ASCII
    Write-Info "Encrypted token saved at $TokenFilePath"
  } else {
    $envContent = @(
      '# ChronOS local proxy token file',
      '# Keep this file private on your machine',
      "GITHUB_TOKEN=$plain"
    ) -join [Environment]::NewLine
    Set-Content -Path $EnvFilePath -Value $envContent -Encoding ASCII
    Write-Info "Token saved to env file: $EnvFilePath"
  }
} catch {
  Write-Error "Failed to save token: $($_.Exception.Message)"
  exit 1
}

try {
  if ($UseDpapi) {
    icacls $tokenDir /inheritance:r | Out-Null
    icacls $tokenDir /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
    Write-Info "DPAPI token directory ACL tightened for current user."
  } else {
    icacls $EnvFilePath /inheritance:r | Out-Null
    icacls $EnvFilePath /grant:r "$($env:USERNAME):F" | Out-Null
    Write-Info "Env token file ACL tightened for current user."
  }
} catch {
  Write-Info "Could not update ACL automatically. You can ignore if the file is already private."
}

if ($CreateStartupShortcut) {
  try {
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startup 'ChronOS Local Proxy.lnk'
    $proxyScript = Join-Path $PSScriptRoot 'chronos-proxy-server.ps1'

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File '$proxyScript'"
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Save()

    Write-Info "Startup shortcut created: $shortcutPath"
  } catch {
    Write-Info "Could not create startup shortcut: $($_.Exception.Message)"
  }
}

Write-Info "Done. Start proxy with: powershell -ExecutionPolicy Bypass -File .\chronos-proxy-server.ps1"
