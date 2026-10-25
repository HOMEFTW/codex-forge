param(
    [string]$Root,
    [switch]$Force,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Test-Under([string]$Child, [string]$Parent) {
    try {
        $childPath = Get-FullPath $Child
        $parentPath = Get-FullPath $Parent
        return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or $childPath.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-ForgeRoot([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate) -or !(Test-Path -LiteralPath $Candidate -PathType Container)) { return $false }
    $rootPath = Get-FullPath $Candidate
    $launcher = Join-Path $rootPath 'CodexForge.exe'
    $legacyPointer = Join-Path $rootPath 'current.json'
    $msiMarker = Join-Path $rootPath 'bootstrap.json'
    $legacyVersion = @(Get-ChildItem -LiteralPath $rootPath -Directory -ErrorAction SilentlyContinue | Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName 'forge-install.json')) -or (Test-Path -LiteralPath (Join-Path $_.FullName 'app\ChatGPT.exe')) })
    return (Test-Path -LiteralPath $launcher -PathType Leaf) -and ((Test-Path -LiteralPath $legacyPointer -PathType Leaf) -or (Test-Path -LiteralPath $msiMarker -PathType Leaf) -or $legacyVersion.Count -gt 0)
}

function Test-ForgeVersionRoot([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate) -or !(Test-Path -LiteralPath $Candidate -PathType Container)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Candidate 'forge-install.json') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $Candidate 'app\ChatGPT.exe') -PathType Leaf)
}

function Get-Ancestors([string]$Start) {
    $current = Get-FullPath $Start
    for ($i = 0; $i -lt 10 -and ![string]::IsNullOrWhiteSpace($current); $i++) {
        [pscustomobject]@{ Path = $current }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Get-ForgeProcessRecords {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe' OR Name = 'CodexForge.exe' OR Name = 'CodexForgeBootstrap.exe'" | Where-Object { $_.ExecutablePath })
    } catch {
        return @()
    }
}

$processRecords = Get-ForgeProcessRecords
$candidateRoots = New-Object System.Collections.Generic.List[string]

if ($Root) {
    $candidateRoots.Add((Get-FullPath $Root))
} else {
    foreach ($record in $processRecords) {
        foreach ($ancestor in (Get-Ancestors ([IO.Path]::GetDirectoryName($record.ExecutablePath)))) {
            if (!$candidateRoots.Contains($ancestor.Path)) { $candidateRoots.Add($ancestor.Path) }
        }
    }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex Forge'),
        (Join-Path $env:USERPROFILE 'Codex-Forge'),
        'D:\Codex-Forge'
    )) {
        if (!$candidateRoots.Contains($candidate)) { $candidateRoots.Add($candidate) }
    }
}

$installRoot = $null
foreach ($candidate in $candidateRoots) {
    if (Test-ForgeRoot $candidate) { $installRoot = Get-FullPath $candidate; break }
}
if (!$installRoot) {
    foreach ($candidate in $candidateRoots) {
        if (Test-ForgeVersionRoot $candidate) { $installRoot = Get-FullPath $candidate; break }
    }
}
if (!$installRoot) {
    throw '未找到 Codex Forge 安装目录。可使用 -Root 指定包含 CodexForge.exe/current.json 或 forge-install.json 的目录。'
}

$isTopLevelRoot = (Test-Path -LiteralPath (Join-Path $installRoot 'current.json') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $installRoot 'bootstrap.json') -PathType Leaf)
$uninstallProductCode = $null
$uninstallKeyPaths = New-Object System.Collections.Generic.List[string]

try {
    $uninstallBase = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    foreach ($key in @(Get-ChildItem -LiteralPath $uninstallBase -ErrorAction SilentlyContinue)) {
        $property = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if (!$property.InstallLocation -or !(Test-Under $property.InstallLocation $installRoot)) { continue }
        if ($property.DisplayName -like '*Codex*Forge*' -or $property.Publisher -like '*HOMEFTW*') {
            $uninstallKeyPaths.Add($key.PSPath)
            if (!$uninstallProductCode -and $key.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') { $uninstallProductCode = $key.PSChildName }
        }
    }
} catch {
    Write-Verbose ('读取卸载注册表失败：' + $_.Exception.Message)
}

Write-Host ('将卸载：' + $installRoot)
Write-Host '不会删除用户配置、登录信息、历史记录或 .codex 数据。'
if ($uninstallProductCode) { Write-Host ('检测到 MSI 产品：' + $uninstallProductCode) }
if ($WhatIf) {
    Write-Host 'WhatIf：不会关闭进程、运行卸载或删除文件。'
    return
}
if (!$Force) {
    $answer = Read-Host '确认删除此安装目录？请输入 REMOVE 继续'
    if ($answer -ne 'REMOVE') { throw '用户取消卸载。' }
}

foreach ($record in $processRecords) {
    if (!(Test-Under $record.ExecutablePath $installRoot)) { continue }
    $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) { $null = $process.CloseMainWindow() }
}
Start-Sleep -Milliseconds 800
$remaining = @(Get-ForgeProcessRecords | Where-Object { Test-Under $_.ExecutablePath $installRoot })
if ($remaining.Count -gt 0 -and $Force) {
    foreach ($record in $remaining) { Stop-Process -Id $record.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    $remaining = @(Get-ForgeProcessRecords | Where-Object { Test-Under $_.ExecutablePath $installRoot })
}
if ($remaining.Count -gt 0) { throw 'Codex Forge 仍在运行，请先退出客户端后重试。' }

if ($uninstallProductCode) {
    $msi = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $uninstallProductCode, '/passive', '/norestart') -Wait -PassThru -WindowStyle Hidden
    if ($msi.ExitCode -notin @(0, 1605, 1614)) { throw ('Windows Installer 卸载失败，退出码：' + $msi.ExitCode) }
} elseif ($isTopLevelRoot -or $Force) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
} else {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
}

$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Forge.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Codex Forge.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Codex Forge\Codex Forge.lnk')
)
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch { }
foreach ($shortcutPath in $shortcutPaths) {
    if (!(Test-Path -LiteralPath $shortcutPath -PathType Leaf) -or !$shell) { continue }
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        if (Test-Under $shortcut.TargetPath $installRoot) { Remove-Item -LiteralPath $shortcutPath -Force }
    } catch { Write-Verbose ('跳过快捷方式：' + $shortcutPath) }
}

foreach ($keyPath in $uninstallKeyPaths) { Remove-Item -LiteralPath $keyPath -Recurse -Force -ErrorAction SilentlyContinue }
$forgeRegistry = 'HKCU:\Software\HOMEFTW\Codex Forge'
if (Test-Path -LiteralPath $forgeRegistry) { Remove-Item -LiteralPath $forgeRegistry -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host 'Codex Forge 已卸载。用户数据和 .codex 配置已保留。'
