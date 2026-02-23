# PowerShell script to demonstrate execution
Write-Host "Hello from Antigravity!" -ForegroundColor Cyan
Write-Host "Current Directory: $(Get-Location)"

$vsixFiles = Get-ChildItem -Filter *.vsix
if ($vsixFiles.Count -gt 0) {
    Write-Host "`nFound $($vsixFiles.Count) VSIX files:" -ForegroundColor Green
    foreach ($file in $vsixFiles) {
        Write-Host " - $($file.Name) ($([math]::Round($file.Length / 1KB, 2)) KB)"
    }
} else {
    Write-Host "`nNo VSIX files found in the current directory." -ForegroundColor Yellow
}

Write-Host "`nSystem Information:" -ForegroundColor Magenta
Write-Host "OS: $([System.Environment]::OSVersion)"
Write-Host "Machine Name: $env:COMPUTERNAME"
Write-Host "User: $env:USERNAME"
