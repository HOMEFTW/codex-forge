param([string]$ProfileRoot, [int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
try {
    $appRoot = Join-Path $PSScriptRoot 'app'
    $appExe = Join-Path $appRoot 'ChatGPT.exe'
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'forge-install.json'))) { throw 'Forge 安装标识不存在，请完整重新安装。' }
    if (!(Test-Path -LiteralPath $appExe)) { throw '客户端文件不完整。' }
    $isolated = ![string]::IsNullOrWhiteSpace($ProfileRoot)
    if (!$isolated) {
        $other = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ne $appExe -and $_.CommandLine -notmatch '(?:^|\s)--type=' -and (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($_.ExecutablePath)) 'resources\codex.exe')) })
        if ($other.Count) { Write-Host '请先退出其他 Codex（包括托盘），再启动 Codex Forge。当前会话保持运行。'; exit 2 }
        if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { $env:CODEX_HOME = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
        $env:CODEX_ELECTRON_USER_DATA_PATH = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Codex'
    } else {
        $ProfileRoot = [IO.Path]::GetFullPath($ProfileRoot)
        $env:CODEX_HOME = Join-Path $ProfileRoot 'codex-home'
        $env:CODEX_ELECTRON_USER_DATA_PATH = Join-Path $ProfileRoot 'electron'
        New-Item -ItemType Directory -Path $env:CODEX_HOME -Force | Out-Null
    }
    $env:CODEX_FORGE_HOME = Join-Path $env:CODEX_HOME 'forge'
    $env:CODEX_FORGE_INSTALL_ROOT = $PSScriptRoot
    $env:CODEX_FAST_CANVAS = '1'
    $env:CODEX_FAST_CANVAS_DIR = Join-Path $env:CODEX_HOME 'fast-canvas'
    $env:CODEX_CLI_PATH = Join-Path $appRoot 'resources\codex.exe'
    $env:CODEX_FORGE_FAST = '1'; $env:CODEX_FORGE_SPEED = 'fast'; $env:CODEX_FAST_IAB = '1'
    $stateFile = Join-Path $env:CODEX_FORGE_HOME 'plugins.json'
    if (Test-Path -LiteralPath $stateFile) {
        $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.plugins.'forge.browser'.enabled -eq $false) { $env:CODEX_FAST_IAB = '0' }
        if ($state.plugins.'forge.fast'.enabled -eq $false) { $env:CODEX_FORGE_FAST = '0' }
    }
    $fastSettings = Join-Path $env:CODEX_FORGE_HOME 'storage\forge.fast.settings.json'
    if (Test-Path -LiteralPath $fastSettings) { $options = Get-Content -LiteralPath $fastSettings -Raw -Encoding UTF8 | ConvertFrom-Json; if ($options.defaultSpeed -eq 'native') { $env:CODEX_FORGE_SPEED = 'native' } }
    $browserSettings = Join-Path $env:CODEX_FORGE_HOME 'storage\forge.browser.settings.json'
    if (Test-Path -LiteralPath $browserSettings) { $options = Get-Content -LiteralPath $browserSettings -Raw -Encoding UTF8 | ConvertFrom-Json; if ($options.nativeBrowserMode -ne $true -or $state.plugins.'forge.browser'.enabled -eq $false) { $env:CODEX_FAST_IAB = '0' } }
    $arguments = @(('--user-data-dir="' + (Join-Path $env:CODEX_ELECTRON_USER_DATA_PATH 'web\Codex') + '"'), ('--codex-forge-fast=' + $env:CODEX_FORGE_FAST))
    if ($DebugPort -gt 0) { if (!$isolated) { throw '调试端口仅供独立测试配置使用。' }; $arguments += '--remote-debugging-port=' + $DebugPort }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $appExe
    $startInfo.WorkingDirectory = $appRoot
    $startInfo.Arguments = $arguments -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    [Diagnostics.Process]::Start($startInfo) | Out-Null
} catch { Write-Error ('Forge 启动失败：' + $_.Exception.Message); exit 1 }
