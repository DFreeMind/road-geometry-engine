param([string]$QgisRoot)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path $PSScriptRoot -Parent
Push-Location $workspacePath
try {
    & cargo fmt --check
    if ($LASTEXITCODE -ne 0) { throw 'Formatting failed.' }
    & cargo test --locked
    if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
    & cargo clippy --locked --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw 'Clippy failed. Install with: rustup component add clippy' }
    & cargo build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
    . (Join-Path $PSScriptRoot 'qgis-env.ps1')
    $runtimeRoot = Initialize-RoadQgisEnvironment -QgisRoot $QgisRoot
    $env:ROAD_ENGINE_PATH = Join-Path $workspacePath 'target\release\road-geometry-engine.exe'
    $runtimePython = Join-Path $runtimeRoot 'bin\python.exe'
    & $runtimePython scripts\create-test-raster.py
    if ($LASTEXITCODE -ne 0) { throw 'Raster fixture generation failed.' }
    & $runtimePython tests\engine_integration.py
    if ($LASTEXITCODE -ne 0) { throw 'Independent GIS validation failed.' }
    & $runtimePython desktop\main.py --smoke-test --output-dir artifacts\smoke
    if ($LASTEXITCODE -ne 0) { throw 'Client smoke test failed.' }
    & $runtimePython tests\client_connections.py
    if ($LASTEXITCODE -ne 0) { throw 'Client data connection integration failed.' }
    & $runtimePython tests\road_scene_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Road scene geometry validation failed.' }
    & $runtimePython tests\workbench_scene_integration.py
    if ($LASTEXITCODE -ne 0) { throw 'Workbench scene integration failed.' }
    & $runtimePython tests\workbench_interaction.py
    if ($LASTEXITCODE -ne 0) { throw 'Workbench interaction validation failed.' }
    & $runtimePython tests\quick_basemap_switching.py
    if ($LASTEXITCODE -ne 0) { throw 'Quick basemap switching validation failed.' }
    & $runtimePython tests\display_coordinates.py
    if ($LASTEXITCODE -ne 0) { throw 'Display coordinates validation failed.' }
    & $runtimePython tests\display_workbench.py
    if ($LASTEXITCODE -ne 0) { throw 'Display adaptation workbench validation failed.' }
    & $runtimePython tests\client_workflow.py
    if ($LASTEXITCODE -ne 0) { throw 'Complete client workflow validation failed.' }
    & $runtimePython tests\manual_facility_workflow.py
    if ($LASTEXITCODE -ne 0) { throw 'Manual facility workflow validation failed.' }
    & $runtimePython tests\drawing_feedback.py
    if ($LASTEXITCODE -ne 0) { throw 'Live drawing and stable canvas validation failed.' }
    & $runtimePython tests\smooth_basemap_pan.py
    if ($LASTEXITCODE -ne 0) { throw 'Smooth basemap pan validation failed.' }
    & $runtimePython tests\facility_catalog_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility catalog validation failed.' }
    & $runtimePython tests\facility_library_workflow.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility library workflow failed.' }
    & $runtimePython tests\facility_placement_feedback.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility placement feedback validation failed.' }
    & $runtimePython tests\facility_palette_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility palette validation failed.' }
    & $runtimePython tests\facility_support_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility support validation failed.' }
    & $runtimePython tests\sign_map_rendering.py
    if ($LASTEXITCODE -ne 0) { throw 'Sign map rendering validation failed.' }
    & $runtimePython tests\facility_manager_modern.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility manager validation failed.' }
    & $runtimePython tests\facility_creation_flow.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility creation flow validation failed.' }
    & $runtimePython tests\map_chrome_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Map chrome validation failed.' }
    & $runtimePython tests\sign_structure_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Sign structure validation failed.' }
    & $runtimePython tests\sign_span_workflow.py
    if ($LASTEXITCODE -ne 0) { throw 'Sign span workflow failed.' }
    & $runtimePython tests\facility_exchange_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Facility exchange validation failed.' }
    & $runtimePython tests\gantry_visual_acceptance.py
    if ($LASTEXITCODE -ne 0) { throw 'Gantry map visual acceptance failed.' }
    & $runtimePython tests\lujing_map_chrome.py
    if ($LASTEXITCODE -ne 0) { throw 'Lujing map chrome validation failed.' }
    & $runtimePython tests\lujing_workspace_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Lujing workspace validation failed.' }
    & $runtimePython tests\sidebar_regression_validation.py
    if ($LASTEXITCODE -ne 0) { throw 'Sidebar and basemap picker regression validation failed.' }
    & $runtimePython tests\workbench_business_audit.py
    if ($LASTEXITCODE -ne 0) { throw 'Workbench business operation audit failed.' }
    Write-Output 'All prototype checks passed. Reports: artifacts/'
} finally { Pop-Location }

