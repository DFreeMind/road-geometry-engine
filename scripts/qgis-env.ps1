function Initialize-RoadQgisEnvironment {
    param([string]$QgisRoot)
    if (-not $QgisRoot) { $QgisRoot = $env:ROAD_QGIS_ROOT }
    if (-not $QgisRoot) {
        $candidate = Get-ChildItem -LiteralPath $env:ProgramFiles -Directory -Filter 'QGIS *' |
            Where-Object { Test-Path (Join-Path $_.FullName 'bin\python.exe') } |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($candidate) { $QgisRoot = $candidate.FullName }
    }
    if (-not $QgisRoot -or -not (Test-Path (Join-Path $QgisRoot 'bin\python.exe'))) {
        throw 'QGIS runtime not found. Install QGIS or pass -QgisRoot / set ROAD_QGIS_ROOT.'
    }
    $QgisRoot = (Resolve-Path -LiteralPath $QgisRoot).Path
    $qgisApp = Join-Path $QgisRoot 'apps\qgis-ltr'
    if (-not (Test-Path $qgisApp)) { $qgisApp = Join-Path $QgisRoot 'apps\qgis' }
    $pythonApp = Get-ChildItem -LiteralPath (Join-Path $QgisRoot 'apps') -Directory -Filter 'Python*' |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $pythonApp -or -not (Test-Path $qgisApp)) { throw 'Incomplete QGIS installation.' }
    $qtApp = Join-Path $QgisRoot 'apps\Qt5'
    if (-not (Test-Path $qtApp)) { $qtApp = Join-Path $QgisRoot 'apps\Qt6' }
    $env:OSGEO4W_ROOT = $QgisRoot
    $env:QGIS_PREFIX_PATH = $qgisApp.Replace('\', '/')
    $env:PYTHONHOME = $pythonApp.FullName
    $env:PYTHONPATH = Join-Path $qgisApp 'python'
    $env:PYTHONUTF8 = '1'
    $env:GDAL_FILENAME_IS_UTF8 = 'YES'
    $env:GDAL_DATA = Join-Path $QgisRoot 'apps\gdal\share\gdal'
    $env:GDAL_DRIVER_PATH = Join-Path $QgisRoot 'apps\gdal\lib\gdalplugins'
    $env:PROJ_DATA = Join-Path $QgisRoot 'share\proj'
    $env:PROJ_LIB = $env:PROJ_DATA
    $env:QT_PLUGIN_PATH = (Join-Path $qgisApp 'qtplugins') + ';' + (Join-Path $qtApp 'plugins')
    $env:PATH = (Join-Path $qgisApp 'bin') + ';' + (Join-Path $qtApp 'bin') + ';' +
        (Join-Path $QgisRoot 'bin') + ';' + $pythonApp.FullName + ';' + $env:PATH
    return $QgisRoot
}

