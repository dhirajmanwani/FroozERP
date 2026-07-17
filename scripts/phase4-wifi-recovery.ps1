param(
    [Parameter(Mandatory = $true)][string]$AdapterName,
    [Parameter(Mandatory = $true)][string]$ControlPath
)

$ErrorActionPreference = "Stop"
while ($true) {
    if (Test-Path -LiteralPath $ControlPath) {
        $command = (Get-Content -LiteralPath $ControlPath -Raw).Trim()
        if ($command -eq "STOP") { break }
        if ($command -match "^DEADLINE=(\d+)$") {
            $deadline = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Matches[1])
            if ([DateTimeOffset]::UtcNow -ge $deadline) {
                Enable-NetAdapter -Name $AdapterName -Confirm:$false
                Set-Content -LiteralPath $ControlPath -Value "RECOVERED"
                break
            }
        }
    }
    Start-Sleep -Milliseconds 500
}
