param([string]$Destination=(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Codex Forge'),[switch]$NoShortcut,[switch]$SideBySide,[string]$InstallSuffix='')
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot -Parent) 'release\package-full'
$manifest=Get-Content -LiteralPath (Join-Path $source 'forge-install.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.product -ne 'Codex Forge' -or !$manifest.fullInstallation) { throw '需要 Forge 完整构建。' }
$Destination=[IO.Path]::GetFullPath($Destination)
$versionName='Codex-Forge-'+$manifest.forgeVersion+'-'+$manifest.sourceMSIXVersion
if($SideBySide){$versionName+='-'+$manifest.asarSHA256.Substring(0,12)}
if($InstallSuffix){if($InstallSuffix -notmatch '^[A-Za-z0-9._-]{1,64}$'){throw '安装后缀无效。'};$versionName+='-'+$InstallSuffix}
$target=Join-Path $Destination $versionName
if ((Test-Path -LiteralPath $target) -and !(Test-Path -LiteralPath (Join-Path $target 'forge-install.json'))) { throw '目标目录非空且不是 Forge 安装。' }
$running=@(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)})
if ($running.Count) { throw '目标 Forge 仍在运行，请退出目标版本后安装。' }
foreach($entry in $manifest.files){$file=[IO.Path]::GetFullPath((Join-Path $source $entry.path));if(!$file.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('源文件校验失败：'+$entry.path)}}
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach($entry in $manifest.files){$file=Join-Path $target $entry.path;New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($file)) -Force | Out-Null;Copy-Item -LiteralPath (Join-Path $source $entry.path) -Destination $file -Force;if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('安装文件校验失败：'+$entry.path)}}
Copy-Item -LiteralPath (Join-Path $source 'forge-install.json') -Destination (Join-Path $target 'forge-install.json') -Force
Copy-Item -LiteralPath (Join-Path $target 'CodexForge.exe') -Destination (Join-Path $Destination 'CodexForge.exe') -Force
Copy-Item -LiteralPath (Join-Path $target 'CodexForge.exe.config') -Destination (Join-Path $Destination 'CodexForge.exe.config') -Force
$pointer=Join-Path $Destination 'current.json';$next=$pointer+'.next'
[IO.File]::WriteAllText($next,(@{directory=$versionName}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
if(Test-Path -LiteralPath $pointer){[IO.File]::Replace($next,$pointer,$pointer+'.previous')}else{[IO.File]::Move($next,$pointer)}
if(!$NoShortcut){$shell=New-Object -ComObject WScript.Shell;$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Forge.lnk'));$shortcut.TargetPath=Join-Path $Destination 'CodexForge.exe';$shortcut.WorkingDirectory=$Destination;$shortcut.IconLocation=(Join-Path $Destination 'CodexForge.exe')+',0';$shortcut.Description='Codex Forge 插件客户端';$shortcut.Save()}
@{product='Codex Forge';version=$manifest.forgeVersion;path=$target;launcher=(Join-Path $Destination 'CodexForge.exe');verifiedFiles=$manifest.files.Count} | ConvertTo-Json
