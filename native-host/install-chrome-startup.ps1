param(
    [string]$TargetUrl = "https://web.whatsapp.com",
    [switch]$Minimized
)

$ErrorActionPreference = "Stop"

$chromePaths = @(
    "$Env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$Env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe"
)

$chromeExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chromeExe) {
    throw "Chrome not found in standard install locations."
}

$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "WA Web Agent Chrome.lnk"

$arguments = @("--new-window", $TargetUrl)
if ($Minimized) {
    $arguments += "--start-minimized"
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $chromeExe
$shortcut.Arguments = ($arguments -join " ")
$shortcut.WorkingDirectory = Split-Path $chromeExe
$shortcut.IconLocation = "$chromeExe,0"
$shortcut.Save()

Write-Host "Startup shortcut created"
Write-Host "Shortcut: $shortcutPath"
Write-Host "Target URL: $TargetUrl"
