param(
    [Parameter(Mandatory=$true)][string]$ExtensionId,
    [string]$InstallDir = "C:\WAWebAgent"
)

$ErrorActionPreference = "Stop"

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$targetNativeDir = Join-Path $InstallDir "native-host"
New-Item -ItemType Directory -Force -Path $targetNativeDir | Out-Null

Copy-Item -Force (Join-Path $sourceDir "wa-native-host.ps1") $targetNativeDir
Copy-Item -Force (Join-Path $sourceDir "run-native-host.bat") $targetNativeDir

$manifest = Get-Content (Join-Path $sourceDir "com.seach.wa_native_host.json") -Raw | ConvertFrom-Json
$manifest.path = (Join-Path $targetNativeDir "run-native-host.bat")
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")

$manifestPath = Join-Path $targetNativeDir "com.seach.wa_native_host.json"
$manifest | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $manifestPath

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.seach.wa_native_host"
New-Item -Force -Path $regPath | Out-Null
Set-ItemProperty -Path $regPath -Name "(default)" -Value $manifestPath

Write-Host "Native host installed"
Write-Host "Manifest: $manifestPath"
Write-Host "Registry: $regPath"
