# Native Messaging host for WA Web Agent
# Reads Chrome native-messaging length-prefixed JSON from STDIN and writes length-prefixed JSON to STDOUT.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Read-ExactBytes([int]$Count) {
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = [Console]::OpenStandardInput().Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) { return $null }
        $offset += $read
    }
    return $buffer
}

function Read-NativeMessage {
    $lenBytes = Read-ExactBytes 4
    if ($null -eq $lenBytes) { return $null }
    $length = [BitConverter]::ToUInt32($lenBytes, 0)
    if ($length -eq 0 -or $length -gt 10485760) { throw "Invalid message length: $length" }
    $msgBytes = Read-ExactBytes ([int]$length)
    if ($null -eq $msgBytes) { return $null }
    $json = [System.Text.Encoding]::UTF8.GetString($msgBytes)
    return $json | ConvertFrom-Json
}

function Write-NativeMessage($Object) {
    $json = $Object | ConvertTo-Json -Depth 50 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $lenBytes = [BitConverter]::GetBytes([UInt32]$bytes.Length)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($lenBytes, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Send-KeysSafe([string]$Keys) {
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.SendKeys($Keys)
}

function Set-ClipboardImage([string]$FilePath) {
    if (-not (Test-Path $FilePath)) { throw "File not found: $FilePath" }
    $image = [System.Drawing.Image]::FromFile($FilePath)
    [System.Windows.Forms.Clipboard]::SetImage($image)
    $image.Dispose()
}

function Set-ClipboardFiles([string[]]$FilePaths) {
    $collection = New-Object System.Collections.Specialized.StringCollection
    foreach ($p in $FilePaths) {
        if (-not (Test-Path $p)) { throw "File not found: $p" }
        [void]$collection.Add($p)
    }
    [System.Windows.Forms.Clipboard]::SetFileDropList($collection)
}

function Set-ClipboardText([string]$Text) {
    [System.Windows.Forms.Clipboard]::SetText($Text)
}

function Invoke-CommandObject($cmd) {
    switch ($cmd.action) {
        "ping" { return @{ ok = $true; pong = $true; at = (Get-Date).ToString("o") } }

        "paste_image" {
            Set-ClipboardImage -FilePath ([string]$cmd.filePath)
            Start-Sleep -Milliseconds 300
            Send-KeysSafe "^v"
            Start-Sleep -Milliseconds 800
            if ($cmd.caption) {
                Set-ClipboardText ([string]$cmd.caption)
                Start-Sleep -Milliseconds 100
                Send-KeysSafe "^v"
                Start-Sleep -Milliseconds 200
            }
            if ($cmd.send -ne $false) { Send-KeysSafe "{ENTER}" }
            return @{ ok = $true; action = "paste_image" }
        }

        "paste_file" {
            Set-ClipboardFiles -FilePaths @([string]$cmd.filePath)
            Start-Sleep -Milliseconds 300
            Send-KeysSafe "^v"
            Start-Sleep -Milliseconds 800
            if ($cmd.caption) {
                Set-ClipboardText ([string]$cmd.caption)
                Start-Sleep -Milliseconds 100
                Send-KeysSafe "^v"
                Start-Sleep -Milliseconds 200
            }
            if ($cmd.send -ne $false) { Send-KeysSafe "{ENTER}" }
            return @{ ok = $true; action = "paste_file" }
        }

        "type_text" {
            Set-ClipboardText ([string]$cmd.text)
            Start-Sleep -Milliseconds 100
            Send-KeysSafe "^v"
            return @{ ok = $true; action = "type_text" }
        }

        "hotkey" {
            Send-KeysSafe ([string]$cmd.keys)
            return @{ ok = $true; action = "hotkey" }
        }

        default { throw "Unknown native action: $($cmd.action)" }
    }
}

while ($true) {
    try {
        $cmd = Read-NativeMessage
        if ($null -eq $cmd) { break }
        $result = Invoke-CommandObject $cmd
        Write-NativeMessage $result
    }
    catch {
        Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
    }
}
