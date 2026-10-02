param([string]$GisRoot, [switch]$Release)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'maplibre-node-env.ps1')
Initialize-MapLibreNodeEnvironment
$env:TAURI_ENV_DEBUG = if ($Release) { 'false' } else { 'true' }
& (Join-Path $PSScriptRoot 'prepare-maplibre.ps1') -GisRoot $GisRoot
$clientPath = Join-Path $workspacePath 'desktop-tauri'
Push-Location $clientPath
try {
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '前端依赖安装失败。' }
    $buildArgs = @('tauri','build','--no-bundle')
    if (-not $Release) { $buildArgs += '--debug' }
    & pnpm @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Tauri 桌面构建失败。' }
} finally { Pop-Location }
$profileName = if ($Release) { 'release' } else { 'debug' }
$profilePath = Join-Path $workspacePath "artifacts\maplibre-desktop\$profileName"
# 新构建使用独立目录，不覆盖仍在运行的版本或强制关闭用户窗口。
$buildName = 'build-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$destination = Join-Path $profilePath $buildName
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $clientPath "src-tauri\target\$profileName\lujing-desktop.exe") -Destination $destination -Force
foreach ($resource in Get-ChildItem -LiteralPath (Join-Path $clientPath 'src-tauri\resources')) {
    if ($resource.PSIsContainer) {
        $target = Join-Path $destination $resource.Name
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Get-ChildItem -LiteralPath $resource.FullName | Copy-Item -Destination $target -Recurse -Force
    } else { Copy-Item -LiteralPath $resource.FullName -Destination $destination -Force }
}
$pointerPath = Join-Path $profilePath 'current-build.txt'
$temporaryPointer = Join-Path $profilePath 'current-build.tmp'
[IO.File]::WriteAllText($temporaryPointer, $buildName, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryPointer -Destination $pointerPath -Force
Write-Output "桌面程序：$(Join-Path $destination 'lujing-desktop.exe')"
