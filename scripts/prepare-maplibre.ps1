param([string]$GisRoot, [switch]$SkipEngine)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $workspacePath 'desktop-tauri'
$resourcePath = Join-Path $clientPath 'src-tauri\resources'
if (-not $GisRoot) { $GisRoot = $env:ROAD_GIS_BUILD_ROOT }
if (-not $GisRoot) {
    $candidate = Get-ChildItem -LiteralPath $env:ProgramFiles -Directory -Filter 'QGIS *' |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\gdalinfo.exe') } |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($candidate) { $GisRoot = $candidate.FullName }
}
if (-not $GisRoot) { throw '请指定包含 GDAL 命令行及 PROJ 数据的 -GisRoot。' }
$GisRoot = (Resolve-Path -LiteralPath $GisRoot).Path
$nativeBin = Join-Path $GisRoot 'bin'
$dumpbin = Get-ChildItem -LiteralPath "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" -Directory |
    Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64\dumpbin.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $dumpbin) { throw '找不到 MSVC dumpbin；请安装 Windows Rust 构建所需的 C++ Build Tools。' }
$gisPath = Join-Path $resourcePath 'gis'
$gisBin = Join-Path $gisPath 'bin'
New-Item -ItemType Directory -Path $gisBin,(Join-Path $gisPath 'share'),(Join-Path $resourcePath 'engine') -Force | Out-Null
$queue = [System.Collections.Generic.Queue[string]]::new()
@('gdalinfo.exe','gdalwarp.exe','gdal_translate.exe','ogrinfo.exe','ogr2ogr.exe','gdalsrsinfo.exe') | ForEach-Object { $queue.Enqueue($_) }
$copied = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$missing = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
while ($queue.Count -gt 0) {
    $name = $queue.Dequeue()
    if (-not $copied.Add($name)) { continue }
    $sourcePath = Join-Path $nativeBin $name
    if (-not (Test-Path -LiteralPath $sourcePath)) { throw "缺少原生依赖：$sourcePath" }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $gisBin $name) -Force
    $dependencies = & $dumpbin /dependents $sourcePath
    if ($LASTEXITCODE -ne 0) { throw "依赖解析失败：$name" }
    foreach ($line in $dependencies) {
        if ($line -match '^\s+([\w.\-]+\.dll)\s*$') {
            $dependency = $Matches[1]
            if (Test-Path -LiteralPath (Join-Path $nativeBin $dependency)) { $queue.Enqueue($dependency) }
            elseif ($dependency -notmatch '^(api-ms-|ext-ms-)' -and -not (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$dependency"))) { [void]$missing.Add($dependency) }
        }
    }
}
if ($missing.Count) { throw "未解析的 DLL：$($missing -join ', ')" }
# 只打包许可明确的 GDAL 数据库插件，不捆绑 Microsoft/Oracle 专有客户端。
$databasePluginPath = Join-Path $gisPath 'plugins'
New-Item -ItemType Directory -Path $databasePluginPath -Force | Out-Null
$databasePlugins = @()
foreach ($pluginName in @('ogr_MSSQLSpatial.dll','ogr_OCI.dll')) {
    $pluginSource = Join-Path $GisRoot "apps\gdal\lib\gdalplugins\$pluginName"
    if (Test-Path -LiteralPath $pluginSource) {
        $pluginTarget = Join-Path $databasePluginPath $pluginName
        Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force
        $databasePlugins += @{ name = $pluginName; sha256 = (Get-FileHash -LiteralPath $pluginTarget -Algorithm SHA256).Hash; client = 'external' }
    }
}
# 只复制 GDAL/PROJ 运行资源，不捆绑 QGIS、Qt、Python 或影像可选驱动。
foreach ($data in @(@{source='apps\gdal\share\gdal'; target='share\gdal'}, @{source='share\proj'; target='share\proj'})) {
    $destination = Join-Path $gisPath $data.target
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $GisRoot $data.source) | Copy-Item -Destination $destination -Recurse -Force
}
$licensePath = Join-Path $gisPath 'licenses'
New-Item -ItemType Directory -Path $licensePath -Force | Out-Null
if (Test-Path (Join-Path $GisRoot 'share\doc')) {
    $osgeoLicensePath = Join-Path $licensePath 'osgeo4w'
    New-Item -ItemType Directory -Path $osgeoLicensePath -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $GisRoot 'share\doc') | Copy-Item -Destination $osgeoLicensePath -Recurse -Force
}
$env:GDAL_DATA = Join-Path $gisPath 'share\gdal'
$env:PROJ_DATA = Join-Path $gisPath 'share\proj'
$env:GDAL_DRIVER_PATH = 'disable'
$env:PATH = $gisBin + ';' + $env:PATH
$gdalVersion = & (Join-Path $gisBin 'gdalinfo.exe') --version
if ($LASTEXITCODE -ne 0) { throw '独立 GDAL 运行时验证失败。' }
$files = @($copied | Sort-Object | ForEach-Object {
    $filePath = Join-Path $gisBin $_
    @{ name = $_; sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash; version = (Get-Item -LiteralPath $filePath).VersionInfo.FileVersion }
})
@{ built_at = (Get-Date).ToString('o'); gdal = "$gdalVersion"; source = $GisRoot; files = $files; optional_plugins = ($databasePlugins.Count -gt 0); database_plugins = $databasePlugins; database_clients = "external" } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $gisPath 'runtime-manifest.json') -Encoding utf8
$assetPath = Join-Path $clientPath 'public\assets'
New-Item -ItemType Directory -Path $assetPath -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $workspacePath 'tools\facility-assets\assets') | Copy-Item -Destination $assetPath -Recurse -Force
Copy-Item -LiteralPath (Join-Path $workspacePath 'fixtures\example-request.json') -Destination (Join-Path $clientPath 'public\demo-request.json') -Force
Copy-Item -LiteralPath (Join-Path $clientPath 'public\catalog.json') -Destination (Join-Path $resourcePath 'catalog.json') -Force
if (-not $SkipEngine) {
    Push-Location $workspacePath
    try { & cargo build --release --locked; if ($LASTEXITCODE -ne 0) { throw 'Rust 核心构建失败。' } } finally { Pop-Location }
}
Copy-Item -LiteralPath (Join-Path $workspacePath 'target\release\road-geometry-engine.exe') -Destination (Join-Path $resourcePath 'engine\road-geometry-engine.exe') -Force
Write-Output "已准备 MapLibre 桌面资源：$gdalVersion，$($copied.Count) 个原生文件。"
