param(
    [switch]$WhatIf,
    [ValidateRange(1, 20)][int]$KeepCount = 2
)
$ErrorActionPreference = 'Stop'
$workspacePath = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$artifactRoot = Join-Path $workspacePath 'artifacts'
# 保留正在运行的版本；查询失败时停止，避免误删用户窗口所用的资源。
$runningPaths = @(Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object { $_.ExecutablePath } | ForEach-Object { $_.ExecutablePath })
$profiles = @('maplibre-desktop\debug', 'maplibre-desktop\release')
foreach ($profile in $profiles) {
    $profilePath = Join-Path $artifactRoot $profile
    $pointerPath = Join-Path $profilePath 'current-build.txt'
    if (-not (Test-Path -LiteralPath $pointerPath)) { continue }
    $ancestorPath = $profilePath
    while ($ancestorPath -ne $workspacePath) {
        if ((Get-Item -LiteralPath $ancestorPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "部署路径含链接，停止清理：$ancestorPath"
        }
        $ancestorPath = Split-Path -Parent $ancestorPath
    }
    $currentName = [IO.File]::ReadAllText($pointerPath).Trim()
    if ($currentName -notmatch '^build-\d{8}-\d{6}-\d{3}$') { throw "无效的当前版本指针：$pointerPath" }
    $appName = 'lujing-desktop.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $profilePath "$currentName\$appName"))) {
        throw "当前程序不存在，停止清理：$profilePath"
    }
    $builds = @(Get-ChildItem -LiteralPath $profilePath -Directory |
        Where-Object { $_.Name -match '^build-\d{8}-\d{6}-\d{3}$' } | Sort-Object Name -Descending)
    $keepNames = @($currentName)
    $keepNames += @($builds | Where-Object { $_.Name -ne $currentName } |
        Select-Object -First ($KeepCount - 1) | ForEach-Object { $_.Name })
    foreach ($build in $builds) {
        if ($build.Name -in $keepNames) { continue }
        $targetPath = [IO.Path]::GetFullPath($build.FullName)
        $expectedParent = [IO.Path]::GetFullPath($profilePath)
        if ([IO.Path]::GetDirectoryName($targetPath) -ne $expectedParent -or
            -not $targetPath.StartsWith($artifactRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "清理路径超出部署目录：$targetPath"
        }
        $prefix = $targetPath + '\'
        if (@($runningPaths | Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
            Write-Output "保留运行中的版本：$targetPath"
            continue
        }
        # 拒绝链接目录，确保递归删除不经过其他目录或磁盘。
        $links = @($build; Get-ChildItem -LiteralPath $targetPath -Force -Recurse -ErrorAction Stop) |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
        if ($links) { throw "部署目录含链接，停止清理：$targetPath" }
        if ($WhatIf) { Write-Output "将删除历史部署：$targetPath"; continue }
        Remove-Item -LiteralPath $targetPath -Recurse -Force -ErrorAction Stop
        Write-Output "已删除历史部署：$targetPath"
    }
}
