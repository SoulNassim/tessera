# Install Tessera Studio on Windows (PowerShell):
#   irm https://soulnassim.github.io/tessera/install.ps1 | iex
# Installs uv if needed, then Tessera Studio as a uv tool. Then run `tessera connect` in your game folder.
$ErrorActionPreference = "Stop"

$Api = "https://api.github.com/repos/SoulNassim/tessera/releases/latest"
$Site = "https://soulnassim.github.io/tessera/"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "Installing uv (Python package manager from astral.sh)..."
    powershell -ExecutionPolicy ByPass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

Write-Host "Finding the latest Tessera Studio release..."
$Wheel = $null
try {
    $Release = Invoke-RestMethod -Uri $Api -Headers @{ "User-Agent" = "tessera-installer" }
    $Wheel = $Release.assets | Where-Object { $_.name -like "tessera_studio-*.whl" } | Select-Object -First 1
} catch {
    Write-Host "Could not reach the release feed: $($_.Exception.Message)"
}
if (-not $Wheel) {
    Write-Host "Could not find a Tessera Studio download in the latest release."
    Write-Host "Get the installer from $Site and try again."
    exit 1
}

Write-Host "Installing Tessera Studio $($Release.tag_name)..."
uv tool install --force --python 3.12 $Wheel.browser_download_url
if ($LASTEXITCODE -ne 0) { throw "uv could not install Tessera Studio." }
uv tool update-shell | Out-Null
& "$env:USERPROFILE\.local\bin\tessera.exe" shortcut

Write-Host ""
Write-Host "Tessera Studio is installed. Open it any time with the Tessera shortcut on your desktop or in the Start menu."
Write-Host "To connect a game, run this in its folder:"
Write-Host "  tessera connect     # connect your coding agents and open Tessera Studio in the browser"
Write-Host "(Open a new terminal so 'tessera' is found; until then use $env:USERPROFILE\.local\bin\tessera.exe)"
Write-Host "Or just tell your agent: Set up Tessera for this game: read ${Site}agent.md"
