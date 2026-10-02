param([string]$AppPath, [string]$OutputDir)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'maplibre-node-env.ps1')
Initialize-MapLibreNodeEnvironment
if (-not $AppPath) { $AppPath = Get-MapLibreDesktopPath -WorkspacePath $workspacePath }
if (-not (Test-Path -LiteralPath $AppPath)) { throw '请先构建 MapLibre 桌面程序。' }
if (-not $OutputDir) { $OutputDir = Join-Path $workspacePath ('artifacts\maplibre-qa\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')) }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $workspacePath 'artifacts\fixtures\test-basemap.tif'))) {
    # 只在验证时创建合成影像，生产客户端不调用 Python。
    . (Join-Path $PSScriptRoot 'qgis-env.ps1')
    $runtimeRoot = Initialize-RoadQgisEnvironment
    Push-Location $workspacePath
    try { & (Join-Path $runtimeRoot 'bin\python.exe') scripts/create-test-raster.py } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw '合成影像生成失败。' }
}
$port = 9225
$oldBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldUserDataFolder = $env:WEBVIEW2_USER_DATA_FOLDER
# 验证进程使用独立 WebView2 数据目录，不争用用户正在运行的工作台配置。
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $OutputDir 'webview-profile'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
$process = Start-Process -FilePath $AppPath -WorkingDirectory (Split-Path -Parent $AppPath) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OutputDir 'native-stdout.log') -RedirectStandardError (Join-Path $OutputDir 'native-stderr.log')
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) { throw '桌面进程提前退出。' }
        try { $null = Invoke-RestMethod "http://127.0.0.1:$port/json" -TimeoutSec 1; $ready = $true; break } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) { throw 'WebView2 调试端口未就绪。' }
    & node (Join-Path $PSScriptRoot 'maplibre-smoke.mjs') "http://127.0.0.1:$port" $OutputDir $workspacePath
    if ($LASTEXITCODE -ne 0) { throw "MapLibre 桌面闭环验证失败；报告：$OutputDir" }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArguments
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldUserDataFolder
}
