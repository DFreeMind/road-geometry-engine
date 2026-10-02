param(
    [string]$QgisRoot,
    [switch]$Release,
    [switch]$Debug,
    [switch]$Foreground,
    [switch]$SmokeTest,
    [string]$OutputDir
)
$ErrorActionPreference = 'Stop'
$workspacePath = $PSScriptRoot
if ($Release -and $Debug) { throw 'Choose either -Release or -Debug.' }
$profileName = if ($Debug) { 'debug' } else { 'release' }
$enginePath = Join-Path $workspacePath "target\$profileName\road-geometry-engine.exe"
if (-not (Test-Path $enginePath)) {
    Push-Location $workspacePath
    try {
        if ($Debug) { & cargo build --locked } else { & cargo build --release --locked }
        if ($LASTEXITCODE -ne 0) { throw 'Rust engine build failed.' }
    } finally { Pop-Location }
}
. (Join-Path $workspacePath 'scripts\qgis-env.ps1')
$runtimeRoot = Initialize-RoadQgisEnvironment -QgisRoot $QgisRoot
$env:ROAD_ENGINE_PATH = $enginePath
$appPath = Join-Path $workspacePath 'desktop\main.py'
if (-not (Test-Path $appPath)) { throw "Client script missing: $appPath" }
$pythonArgs = @($appPath)
if ($SmokeTest) {
    if (-not $OutputDir) { $OutputDir = Join-Path $workspacePath 'artifacts\smoke' }
    $pythonArgs += @('--smoke-test', '--output-dir', $OutputDir)
}
if ($Foreground -or $SmokeTest) {
    & (Join-Path $runtimeRoot 'bin\python.exe') @pythonArgs
    if ($LASTEXITCODE -ne 0) { throw "Client exited with code $LASTEXITCODE" }
} else {
    $logDir = Join-Path $workspacePath 'artifacts'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    # 为每个客户端实例独立记录日志，避免新窗口与已有窗口争用文件。
    $instanceTag = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $process = Start-Process -FilePath (Join-Path $runtimeRoot 'bin\pythonw.exe') -ArgumentList @('"' + $appPath + '"') -WorkingDirectory $workspacePath -WindowStyle Normal -PassThru -RedirectStandardError (Join-Path $logDir "client-$instanceTag-error.log") -RedirectStandardOutput (Join-Path $logDir "client-$instanceTag.log")
    Write-Output "Road Geometry client started. PID: $($process.Id)"
}

