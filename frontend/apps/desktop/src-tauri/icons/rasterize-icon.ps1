# Rasterize app-icon.svg → app-icon-source.png via Chrome headless.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = Join-Path $env:LocalAppData "Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found at $chrome" }

$workdir = Join-Path $env:TEMP "freecoder-icon-chrome"
New-Item -ItemType Directory -Force -Path $workdir | Out-Null

$svgText = Get-Content -Raw -Path (Join-Path $dir "app-icon.svg")
$htmlPath = Join-Path $dir "app-icon-preview.html"
$html = @"
<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
html,body{margin:0;padding:0;width:1024px;height:1024px;overflow:hidden;background:#0F344B}
svg{display:block;width:1024px;height:1024px}
</style></head><body>
$svgText
</body></html>
"@
[System.IO.File]::WriteAllText($htmlPath, $html, (New-Object System.Text.UTF8Encoding $false))

$shot = Join-Path $workdir "shot.png"
if (Test-Path $shot) { Remove-Item $shot -Force }
$uri = ([Uri]$htmlPath).AbsoluteUri + "?t=$([DateTime]::UtcNow.Ticks)"

Push-Location $workdir
& $chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1024,1024 --screenshot="$shot" $uri | Out-Null
Pop-Location

# Chrome may finish writing slightly after process returns
$deadline = (Get-Date).AddSeconds(5)
while (-not (Test-Path $shot) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path $shot)) {
  $alt = Join-Path $workdir "screenshot.png"
  if (Test-Path $alt) { $shot = $alt } else { throw "screenshot failed" }
}

$out = Join-Path $dir "app-icon-source.png"
Copy-Item -Force $shot $out
Write-Host "wrote $out ($((Get-Item $out).Length) bytes)"
