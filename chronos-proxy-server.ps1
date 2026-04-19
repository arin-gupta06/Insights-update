param(
  [int]$Port = 8787,
  [string]$TokenFilePath = "$env:USERPROFILE\.chronos\github_token.dpapi",
  [string]$EnvFilePath = "$PSScriptRoot\.env"
)

$ErrorActionPreference = 'Stop'

function Write-Info {
  param([string]$Message)
  Write-Host "[chronos-proxy] $Message"
}

function Get-PlainTokenFromDpapi {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    throw "Token file not found: $Path. Run chronos-token-setup.ps1 first."
  }

  $encrypted = Get-Content -Path $Path -ErrorAction Stop
  $secure = $encrypted | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Get-DotEnvValue {
  param(
    [string]$Path,
    [string]$Key
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  $escapedKey = [regex]::Escape($Key)
  foreach ($line in (Get-Content -Path $Path -ErrorAction SilentlyContinue)) {
    $trimmed = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) {
      continue
    }

    if ($trimmed -match "^(?:export\s+)?$escapedKey\s*=\s*(.*)$") {
      $value = $Matches[1].Trim()
      if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
        $value = $value.Substring(1, $value.Length - 2)
      } elseif ($value.StartsWith("'") -and $value.EndsWith("'") -and $value.Length -ge 2) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }

  return $null
}

function Send-Json {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [object]$Body
  )

  $json = $Body | ConvertTo-Json -Depth 8
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = 'application/json; charset=utf-8'
  $Response.Headers['Access-Control-Allow-Origin'] = '*'
  $Response.Headers['Access-Control-Allow-Headers'] = '*'
  $Response.Headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Send-Text {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [string]$Body
  )

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = 'text/plain; charset=utf-8'
  $Response.Headers['Access-Control-Allow-Origin'] = '*'
  $Response.Headers['Access-Control-Allow-Headers'] = '*'
  $Response.Headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

$tokenSource = ''
$token = $env:GITHUB_TOKEN

if (-not [string]::IsNullOrWhiteSpace($token)) {
  $tokenSource = 'process env:GITHUB_TOKEN'
} else {
  $token = Get-DotEnvValue -Path $EnvFilePath -Key 'GITHUB_TOKEN'
  if (-not [string]::IsNullOrWhiteSpace($token)) {
    $tokenSource = "env file: $EnvFilePath"
  }
}

if ([string]::IsNullOrWhiteSpace($token)) {
  try {
    $token = Get-PlainTokenFromDpapi -Path $TokenFilePath
    if (-not [string]::IsNullOrWhiteSpace($token)) {
      $tokenSource = "dpapi file: $TokenFilePath"
    }
  } catch {
    # Fallback mode: ignore and report final setup guidance below.
  }
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "No token found. Add GITHUB_TOKEN to $EnvFilePath (recommended), set env:GITHUB_TOKEN, or run chronos-token-setup.ps1 for DPAPI mode."
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Info "Listening on http://127.0.0.1:$Port/"
Write-Info "Token source: $tokenSource"
Write-Info 'Press Ctrl+C to stop.'

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    if ($request.HttpMethod -eq 'OPTIONS') {
      Send-Text -Response $response -StatusCode 204 -Body ''
      continue
    }

    $path = $request.Url.AbsolutePath.ToLowerInvariant()

    if ($path -eq '/health') {
      Send-Json -Response $response -StatusCode 200 -Body @{
        ok = $true
        mode = 'local-proxy'
        tokenLoaded = $true
        tokenSource = $tokenSource
        utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      }
      continue
    }

    if ($path -ne '/api') {
      Send-Json -Response $response -StatusCode 404 -Body @{ ok = $false; message = 'Not found' }
      continue
    }

    $target = $request.QueryString['url']
    if ([string]::IsNullOrWhiteSpace($target)) {
      Send-Json -Response $response -StatusCode 400 -Body @{ ok = $false; message = 'Missing url query parameter' }
      continue
    }

    if (-not $target.StartsWith('https://api.github.com/')) {
      Send-Json -Response $response -StatusCode 400 -Body @{ ok = $false; message = 'Only https://api.github.com/* is allowed' }
      continue
    }

    $headers = @{
      'Accept' = 'application/vnd.github+json'
      'User-Agent' = 'ChronOS-Local-Proxy'
      'Authorization' = "Bearer $token"
    }

    try {
      $upstream = Invoke-WebRequest -UseBasicParsing -Uri $target -Headers $headers -Method Get
      $rawBody = $upstream.Content
      if ([string]::IsNullOrWhiteSpace($rawBody)) {
        $rawBody = '{}'
      }

      $response.StatusCode = [int]$upstream.StatusCode
      $response.ContentType = 'application/json; charset=utf-8'
      $response.Headers['Access-Control-Allow-Origin'] = '*'
      $response.Headers['Access-Control-Allow-Headers'] = '*'
      $response.Headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
      $buffer = [System.Text.Encoding]::UTF8.GetBytes($rawBody)
      $response.OutputStream.Write($buffer, 0, $buffer.Length)
      $response.OutputStream.Close()
    } catch {
      if ($_.Exception.Response) {
        $errResp = $_.Exception.Response
        $status = [int]$errResp.StatusCode
        $stream = $errResp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($content)) {
          $content = '{"message":"Upstream GitHub error"}'
        }

        $response.StatusCode = $status
        $response.ContentType = 'application/json; charset=utf-8'
        $response.Headers['Access-Control-Allow-Origin'] = '*'
        $response.Headers['Access-Control-Allow-Headers'] = '*'
        $response.Headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        $buffer = [System.Text.Encoding]::UTF8.GetBytes($content)
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.OutputStream.Close()
      } else {
        Send-Json -Response $response -StatusCode 500 -Body @{ ok = $false; message = $_.Exception.Message }
      }
    }
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
