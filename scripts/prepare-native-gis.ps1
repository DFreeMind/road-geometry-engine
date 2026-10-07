param([switch]$Download, [string]$GdalRoot, [string]$OutputDir)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
if (-not $GdalRoot) { $GdalRoot = Join-Path $workspacePath 'artifacts\gis-sdk' }
if (-not $OutputDir) { $OutputDir = Join-Path $workspacePath 'artifacts\native-gis-runtime' }
$packageCache = Join-Path $workspacePath 'artifacts\micromamba-root'
if ($Download) {
    $toolsPath = Join-Path $workspacePath 'artifacts\native-gis-tools'
    $micromamba = Join-Path $toolsPath 'Library\bin\micromamba.exe'
    if (-not (Test-Path -LiteralPath $micromamba)) {
        New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
        $archivePath = Join-Path $toolsPath 'micromamba.tar.bz2'
        Invoke-WebRequest -Uri 'https://micro.mamba.pm/api/micromamba/win-64/2.3.2' -OutFile $archivePath
        & tar -xf $archivePath -C $toolsPath
        if ($LASTEXITCODE -ne 0) { throw '解压独立 GIS 下载工具失败。' }
    }
    # 无 shell 初始化、无系统安装，仅在项目忽略目录创建原生库环境。
    $packageLock = Join-Path $workspacePath 'scripts\gis-packages-win64.lock'
    $createArgs = @('--no-rc', 'create', '--root-prefix', $packageCache, '--prefix', $GdalRoot, '-y')
    if (Test-Path -LiteralPath $packageLock) {
        $createArgs += @('--file', $packageLock)
    } else {
        $createArgs += @('-c', 'conda-forge', '--strict-channel-priority', 'libgdal-core=3.11.4', 'libgdal-pg=3.11.4', 'proj=9.7.0', 'geos=3.14.0')
    }
    & $micromamba @createArgs
    if ($LASTEXITCODE -ne 0) { throw '独立 GDAL/PROJ/GEOS 下载失败。' }
}
if (-not (Test-Path -LiteralPath $GdalRoot)) { throw '请使用 -Download，或通过 -GdalRoot 提供独立 GDAL SDK 根目录。无需安装 QGIS。' }
$sourceBin = Join-Path $GdalRoot 'Library\bin'
$sourceShare = Join-Path $GdalRoot 'Library\share'
if (-not (Test-Path -LiteralPath $sourceBin)) {
    $sourceBin = Join-Path $GdalRoot 'bin'
    $sourceShare = Join-Path $GdalRoot 'share'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$dumpbin = Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64\dumpbin.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $dumpbin) { throw '需要 MSVC dumpbin 核验独立运行时 DLL 依赖。' }
$destinationBin = Join-Path $OutputDir 'bin'
New-Item -ItemType Directory -Path $destinationBin -Force | Out-Null
$queue = [Collections.Generic.Queue[string]]::new()
@('gdalinfo.exe','gdalwarp.exe','gdal_translate.exe','ogrinfo.exe','ogr2ogr.exe','gdalsrsinfo.exe') | ForEach-Object { $queue.Enqueue($_) }
$copied = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$missing = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
# 原生 PostgreSQL 驱动是独立插件，随应用提供；不安装数据库服务。
$plugins = @()
foreach ($path in @((Join-Path $GdalRoot 'Library\lib\gdalplugins'), (Join-Path $GdalRoot 'Library\bin\gdalplugins'))) {
    if (Test-Path -LiteralPath $path) {
        foreach ($plugin in Get-ChildItem -LiteralPath $path -Filter '*PG*.dll') {
            $pluginDestination = Join-Path $OutputDir 'plugins'
            New-Item -ItemType Directory -Path $pluginDestination -Force | Out-Null
            Copy-Item -LiteralPath $plugin.FullName -Destination $pluginDestination -Force
            $plugins += $plugin.FullName
        }
    }
}
foreach ($plugin in $plugins) {
    foreach ($line in (& $dumpbin /dependents $plugin)) {
        if ($line -match '^\s+([\w.\-]+\.dll)\s*$' -and (Test-Path -LiteralPath (Join-Path $sourceBin $Matches[1]))) { $queue.Enqueue($Matches[1]) }
    }
}
while ($queue.Count -gt 0) {
    $name = $queue.Dequeue()
    if (-not $copied.Add($name)) { continue }
    $source = Join-Path $sourceBin $name
    if (-not (Test-Path -LiteralPath $source)) { throw "独立 SDK 缺少：$name" }
    if ($name -match '^(Qt[56]|qgis|python)') { throw "发现不应捆绑的运行依赖：$name" }
    Copy-Item -LiteralPath $source -Destination $destinationBin -Force
    $dependencies = & $dumpbin /dependents $source
    if ($LASTEXITCODE -ne 0) { throw "解析原生 DLL 依赖失败：$name" }
    foreach ($line in $dependencies) {
        if ($line -match '^\s+([\w.\-]+\.dll)\s*$') {
            $dependency = $Matches[1]
            if (Test-Path -LiteralPath (Join-Path $sourceBin $dependency)) { $queue.Enqueue($dependency) }
            elseif ($dependency -notmatch '^(api-ms-|ext-ms-)' -and -not (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$dependency"))) { [void]$missing.Add($dependency) }
        }
    }
}
if ($missing.Count) { throw "未解析的原生 DLL：$($missing -join ', ')" }
foreach ($name in @('gdal','proj')) {
    $destination = Join-Path $OutputDir "share\$name"
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $sourceShare $name) | Copy-Item -Destination $destination -Recurse -Force
}
$packages = @()
$licenseRoot = Join-Path $OutputDir 'licenses'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
foreach ($metadata in Get-ChildItem -LiteralPath (Join-Path $GdalRoot 'conda-meta') -Filter '*.json' -ErrorAction SilentlyContinue) {
    $package = Get-Content -LiteralPath $metadata.FullName -Raw | ConvertFrom-Json
    $packages += @{ name = $package.name; version = $package.version; build = $package.build; url = $package.url; sha256 = $package.sha256; license = $package.license }
    $cacheLicense = Join-Path $packageCache "pkgs\$($package.name)-$($package.version)-$($package.build)\info\licenses"
    if (Test-Path -LiteralPath $cacheLicense) { Copy-Item -LiteralPath $cacheLicense -Destination (Join-Path $licenseRoot $package.name) -Recurse -Force }
}
$env:GDAL_DATA = Join-Path $OutputDir 'share\gdal'
$env:PROJ_DATA = Join-Path $OutputDir 'share\proj'
$env:GDAL_DRIVER_PATH = if ($plugins.Count) { Join-Path $OutputDir 'plugins' } else { 'disable' }
$gdalVersion = & (Join-Path $destinationBin 'gdalinfo.exe') --version
if ($LASTEXITCODE -ne 0) { throw '独立 GDAL 验证失败。' }
$files = @($copied | Sort-Object | ForEach-Object { @{ name = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $destinationBin $_) -Algorithm SHA256).Hash } })
@{ gdal = "$gdalVersion"; distribution = 'independent native SDK'; qgis_required = $false; python_required = $false; packages = $packages; files = $files; plugins = @($plugins | ForEach-Object { Split-Path -Leaf $_ }) } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDir 'runtime-manifest.json') -Encoding utf8
Write-Output "独立 GIS 资源：$OutputDir；$gdalVersion；$($copied.Count) 个原生文件；不依赖 QGIS。"
