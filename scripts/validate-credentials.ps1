param([string]$AppPath, [string]$OutputDir)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'maplibre-node-env.ps1')
Initialize-MapLibreNodeEnvironment
if (-not $AppPath) { $AppPath = Get-MapLibreDesktopPath -WorkspacePath $workspacePath }
if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) { throw '请先提供已构建的桌面程序路径；此脚本不会构建或启动其他程序。' }
if (-not $OutputDir) { $OutputDir = Join-Path $workspacePath ('artifacts\credential-qa\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')) }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$AppPath = (Resolve-Path -LiteralPath $AppPath).Path

$port = 9226
$endpoint = "http://127.0.0.1:$port"
$smokePath = Join-Path $PSScriptRoot 'credential-smoke.mjs'
$statePath = Join-Path $OutputDir 'QAstate.json'
$runId = [guid]::NewGuid().ToString().ToLowerInvariant()
$connectionId = [guid]::NewGuid().ToString().ToLowerInvariant()
$otherId = [guid]::NewGuid().ToString().ToLowerInvariant()
$mismatchId = [guid]::NewGuid().ToString().ToLowerInvariant()
$emptyId = [guid]::NewGuid().ToString().ToLowerInvariant()
$profilePath = Join-Path $OutputDir "webview-profile-$runId"
$connectionName = "QA 凭据验证 $runId"
$identity = '["postgis",{"host":"127.0.0.1","port":5432,"database":"credential_smoke","user":"qa_smoke","sslmode":"prefer"}]'
$state = [ordered]@{
    version = 1
    runId = $runId
    connectionId = $connectionId
    otherId = $otherId
    mismatchId = $mismatchId
    emptyId = $emptyId
    connectionName = $connectionName
    identity = $identity
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 4), $utf8NoBom)

$oldBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldUserDataFolder = $env:WEBVIEW2_USER_DATA_FOLDER
$env:WEBVIEW2_USER_DATA_FOLDER = $profilePath
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
$process = $null
$primaryFailure = $null
$cleanupFailure = $null

function Test-CdpPortAvailable {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $port)
        return $false
    } catch {
        return $true
    } finally {
        $client.Dispose()
    }
}

function Start-CredentialApp {
    param([string]$LogName)
    $script:process = Start-Process -FilePath $AppPath -WorkingDirectory (Split-Path -Parent $AppPath) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $OutputDir "$LogName.stdout.log") `
        -RedirectStandardError (Join-Path $OutputDir "$LogName.stderr.log")
    $ready = $false
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        if ($script:process.HasExited) { throw '桌面进程提前退出；详见输出目录中的运行日志。' }
        try {
            $null = Invoke-RestMethod "$endpoint/json" -TimeoutSec 1
            $ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) { throw 'WebView2 调试端口未就绪。' }
}

function Wait-CredentialPortClosed {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (Test-CdpPortAvailable) { return }
        Start-Sleep -Milliseconds 250
    }
    throw '桌面进程退出后 WebView2 调试端口仍被占用。'
}

function Stop-CredentialApp {
    $hadProcess = $false
    if ($script:process) {
        $hadProcess = $true
        if (-not $script:process.HasExited) {
            Stop-Process -Id $script:process.Id -Force
            try { $script:process.WaitForExit(10000) } catch { }
        }
    }
    $script:process = $null
    if ($hadProcess) { Wait-CredentialPortClosed }
}

function Invoke-CredentialPhase {
    param([string]$Phase)
    & node $smokePath $endpoint $OutputDir $statePath $Phase
    if ($LASTEXITCODE -ne 0) { throw "Windows 凭据验证阶段失败：$Phase。请检查输出目录中的阶段报告。" }
}

try {
    if (-not (Test-CdpPortAvailable)) { throw "调试端口 $port 已被占用；请关闭使用该端口的测试进程后重试。" }
    Start-CredentialApp "credential-$runId-phase1"
    Invoke-CredentialPhase 'phase1'
    Stop-CredentialApp

    Start-CredentialApp "credential-$runId-phase2"
    Invoke-CredentialPhase 'phase2'
} catch {
    $primaryFailure = $_
} finally {
    try {
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            if (-not $process -or $process.HasExited) {
                if (-not (Test-CdpPortAvailable)) { throw "调试端口 $port 在清理阶段被其他进程占用。" }
                Start-CredentialApp "credential-$runId-cleanup"
            }
            Invoke-CredentialPhase 'cleanup'
        }
    } catch {
        $cleanupFailure = $_
    } finally {
        try {
            Stop-CredentialApp
        } finally {
            $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArguments
            $env:WEBVIEW2_USER_DATA_FOLDER = $oldUserDataFolder
        }
    }
}

if ($primaryFailure) { throw $primaryFailure }
if ($cleanupFailure) { throw "原生凭据或合成连接清理未完成：$($cleanupFailure.Exception.Message)" }
Write-Output "Windows 凭据跨进程恢复验证通过。结果与合成 QA 状态位于：$OutputDir"
