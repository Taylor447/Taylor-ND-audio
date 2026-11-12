# Build toàn bộ Stage C bằng Rust stable, MSVC, Windows SDK và WDK x64.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dspManifest = Join-Path $root 'dsp-core\Cargo.toml'
$bridgeManifest = Join-Path $root 'bridge\Cargo.toml'
$buildDir = Join-Path $root 'build\stage-c'
$stageDir = Join-Path $root 'stage-c'
$staticLib = Join-Path $root 'dsp-core\target\release\tnd_dsp_core.lib'

cargo build --release --manifest-path $dspManifest
cargo build --release --manifest-path $bridgeManifest
cmake -S $root -B $buildDir -A x64 "-DTND_DSP_CORE_LIB=$staticLib" -DTND_BUILD_HARNESS=ON
cmake --build $buildDir --config Release

$destinations = @(
  @{ Source = (Join-Path $buildDir 'apo\Release\taylor-apo.dll'); Target = (Join-Path $stageDir 'apo\taylor-apo.dll') },
  @{ Source = (Join-Path $root 'bridge\target\release\tnd-bridge.exe'); Target = (Join-Path $stageDir 'bridge\tnd-bridge.exe') },
  @{ Source = (Join-Path $buildDir 'configurator\Release\taylor-configurator.exe'); Target = (Join-Path $stageDir 'tools\taylor-configurator.exe') },
  @{ Source = (Join-Path $buildDir 'recover\Release\tnd-recover.exe'); Target = (Join-Path $stageDir 'tools\tnd-recover.exe') },
  @{ Source = (Join-Path $buildDir 'apo\tests\Release\taylor-apo-harness.exe'); Target = (Join-Path $stageDir 'tools\taylor-apo-harness.exe') }
)
foreach ($item in $destinations) {
  if (-not (Test-Path -LiteralPath $item.Source)) { throw "Thiếu đầu ra build: $($item.Source)" }
  $parent = Split-Path -Parent $item.Target
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $item.Source -Destination $item.Target -Force
}
Write-Host "Stage C đã build và được gom trong $stageDir"
