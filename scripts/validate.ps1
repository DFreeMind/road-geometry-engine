param([switch]$DesktopSmoke, [switch]$IndependentGis, [string]$QgisRoot)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path $PSScriptRoot -Parent
Push-Location $workspacePath
try {
    # 分别校验唯一引擎、共享服务与 Tauri 后端。
    foreach ($manifest in @('Cargo.toml', 'desktop-service/Cargo.toml', 'desktop-tauri/src-tauri/Cargo.toml')) {
        & cargo fmt --manifest-path $manifest --check
        if ($LASTEXITCODE -ne 0) { throw "格式检查失败：$manifest" }
        & cargo test --manifest-path $manifest --locked
        if ($LASTEXITCODE -ne 0) { throw "Rust 测试失败：$manifest" }
        & cargo clippy --manifest-path $manifest --locked --all-targets -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw "Clippy 检查失败：$manifest" }
    }
    . (Join-Path $PSScriptRoot 'maplibre-node-env.ps1')
    Initialize-MapLibreNodeEnvironment
    Push-Location (Join-Path $workspacePath 'desktop-tauri')
    try {
        & pnpm format:check
        if ($LASTEXITCODE -ne 0) { throw '前端格式检查失败。' }
        & pnpm test
        if ($LASTEXITCODE -ne 0) { throw '前端测试失败。' }
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    } finally { Pop-Location }
    if ($IndependentGis) {
        # QGIS 仅作为外部 GIS 校验工具，不提供客户端界面。
        . (Join-Path $PSScriptRoot 'qgis-env.ps1')
        $runtimeRoot = Initialize-RoadQgisEnvironment -QgisRoot $QgisRoot
        $runtimePython = Join-Path $runtimeRoot 'bin/python.exe'
        & cargo build --release --locked
        if ($LASTEXITCODE -ne 0) { throw '引擎构建失败。' }
        $env:ROAD_ENGINE_PATH = Join-Path $workspacePath 'target/release/road-geometry-engine.exe'
        foreach ($check in @('scripts/create-test-raster.py', 'tests/engine_integration.py', 'tests/facility_catalog_validation.py', 'tests/facility_support_validation.py')) {
            & $runtimePython $check
            if ($LASTEXITCODE -ne 0) { throw "独立校验失败：$check" }
        }
    }
    if ($DesktopSmoke) { & (Join-Path $PSScriptRoot 'validate-maplibre.ps1') }
    Write-Output 'Tauri 工作台检查通过。'
} finally { Pop-Location }
