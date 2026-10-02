param(
    [switch]$LegacyQgis,
    [string]$QgisRoot,
    [switch]$Release,
    [switch]$Debug,
    [switch]$Foreground,
    [switch]$SmokeTest,
    [string]$OutputDir
)
$ErrorActionPreference = 'Stop'
if ($Release -and $Debug) { throw '请选择 -Release 或 -Debug。' }
if ($LegacyQgis) {
    & (Join-Path $PSScriptRoot 'scripts\launch-qgis.ps1') -QgisRoot $QgisRoot -Release:$Release -Debug:$Debug -Foreground:$Foreground -SmokeTest:$SmokeTest -OutputDir $OutputDir
    exit
}
$profileName = if ($Release) { 'release' } else { 'debug' }
. (Join-Path $PSScriptRoot 'scripts\maplibre-node-env.ps1')
$appPath = Get-MapLibreDesktopPath -WorkspacePath $PSScriptRoot -ProfileName $profileName
if (-not (Test-Path -LiteralPath $appPath)) {
    & (Join-Path $PSScriptRoot 'scripts\build-maplibre.ps1') -GisRoot $QgisRoot -Release:$Release
    $appPath = Get-MapLibreDesktopPath -WorkspacePath $PSScriptRoot -ProfileName $profileName
}
if ($SmokeTest) {
    & (Join-Path $PSScriptRoot 'scripts\validate-maplibre.ps1') -AppPath $appPath -OutputDir $OutputDir
} elseif ($Foreground) {
    & $appPath
    if ($LASTEXITCODE -ne 0) { throw "桌面程序退出：$LASTEXITCODE" }
} else {
    # 用户明确启动工作台时显示主窗口。
    $process = Start-Process -FilePath $appPath -WorkingDirectory (Split-Path -Parent $appPath) -WindowStyle Normal -PassThru
    Write-Output "MapLibre 桌面工作台已启动，PID：$($process.Id)"
}
