$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# 编译器未找到。' }
New-Item -ItemType Directory -Path (Join-Path $root 'dist') -Force | Out-Null
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ (('/win32manifest:')+(Join-Path $root 'cli\app.manifest')) /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (('/win32icon:')+(Join-Path $root 'assets\codex-forge.ico')) (('/out:')+(Join-Path $root 'dist\CodexForge.exe')) (Join-Path $root 'cli\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败。' }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ (('/win32manifest:')+(Join-Path $root 'cli\app.manifest')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Net.Http.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (('/win32icon:')+(Join-Path $root 'assets\codex-forge.ico')) (('/out:')+(Join-Path $root 'dist\CodexForgeBootstrap.exe')) (Join-Path $root 'cli\Bootstrap.cs')
if ($LASTEXITCODE -ne 0) { throw '准备程序编译失败。' }
Copy-Item -LiteralPath (Join-Path $root 'cli\app.config') -Destination (Join-Path $root 'dist\CodexForge.exe.config') -Force
Copy-Item -LiteralPath (Join-Path $root 'cli\app.config') -Destination (Join-Path $root 'dist\CodexForgeBootstrap.exe.config') -Force
Write-Output 'Built dist/CodexForge.exe'
