function Initialize-MapLibreNodeEnvironment {
    # 优先项目开发环境；本机 Codex 附带运行时只作为会话内的备用路径。
    if ((Get-Command pnpm -ErrorAction SilentlyContinue) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $nodeVersionText = & node --version
        if ($LASTEXITCODE -eq 0 -and $nodeVersionText -match '^v(\d+)\.(\d+)\.') {
            if ([int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 12)) { return }
        }
    }
    $runtimePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
    $fallbackPath = Join-Path $runtimePath 'bin\fallback'
    if (Test-Path -LiteralPath (Join-Path $fallbackPath 'pnpm.cmd')) {
        $env:PATH = (Join-Path $runtimePath 'node\bin') + ';' + $fallbackPath + ';' + $env:PATH
        return
    }
    throw '开发构建需要 Node.js 22.12+ 与 pnpm 11；已构建的桌面程序不需要 Node.js。'
}

function Get-MapLibreDesktopPath {
    param([string]$WorkspacePath, [string]$ProfileName = 'debug')
    $profilePath = Join-Path $WorkspacePath "artifacts\maplibre-desktop\$ProfileName"
    $pointerPath = Join-Path $profilePath 'current-build.txt'
    if (Test-Path -LiteralPath $pointerPath) {
        $buildName = ([IO.File]::ReadAllText($pointerPath)).Trim()
        if ($buildName -match '^build-\d{8}-\d{6}-\d{3}$') {
            $candidate = Join-Path $profilePath "$buildName\lujing-desktop.exe"
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return (Join-Path $profilePath 'lujing-desktop.exe')
}
