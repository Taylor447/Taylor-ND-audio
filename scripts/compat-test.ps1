param(
  [string]$ProbePath = (Join-Path $PSScriptRoot '..\engine\target\release\tnd-probe.exe'),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\compat-reports')
)

$ErrorActionPreference = 'Stop'
$resolvedProbe = (Resolve-Path -LiteralPath $ProbePath).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$jsonPath = Join-Path $OutputDirectory 'probe-report.json'
$markdownPath = Join-Path $OutputDirectory 'probe-report.md'

$raw = & $resolvedProbe
if ($LASTEXITCODE -ne 0) { throw "tnd-probe kết thúc với mã $LASTEXITCODE" }
$report = ($raw -join "`n") | ConvertFrom-Json
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $jsonPath -Encoding utf8

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# Báo cáo thăm dò tương thích')
$lines.Add('')
$lines.Add("- Thời gian: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$lines.Add("- Windows: $([Environment]::OSVersion.Version)")
$lines.Add("- Kiến trúc tiến trình probe: $($report.system.architecture)")
$lines.Add("- Ghi chú: $($report.notice)")
$lines.Add('')
$lines.Add('| Endpoint | Loại | Bus | Driver | APO/Enhancements |')
$lines.Add('|---|---|---|---|---|')
foreach ($device in $report.devices) {
  # Đây là file cục bộ; người dùng tự xem lại trước khi chia sẻ.
  $safeName = [string]$device.name -replace '\|', '\|'
  $driver = if ($device.driverVersion) { "$($device.vendor) $($device.driverVersion)" } else { 'Chưa xác định' }
  $fx = if ($null -ne $device.enhancementsDisabled) { "Enhancements disabled=$($device.enhancementsDisabled)" } else { 'APO/Enhancements chưa xác định' }
  $lines.Add("| $safeName ($($device.direction)) | $($device.deviceType) | $($device.bus) | $driver | $fx |")
}
$lines.Add('')
$lines.Add('Các trường trống/null nghĩa là probe MVP chưa dò được; không có nghĩa endpoint không có driver/APO.')
$lines | Set-Content -LiteralPath $markdownPath -Encoding utf8
Write-Output "Đã lưu báo cáo cục bộ:`n$jsonPath`n$markdownPath"
