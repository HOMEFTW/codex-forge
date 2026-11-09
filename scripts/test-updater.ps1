$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$output=Join-Path $root 'output/UpdaterTests.exe'
& $compiler /nologo /target:exe /main:UpdaterTests /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Net.Http.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (('/out:')+$output) (Join-Path $root 'cli/Bootstrap.cs') (Join-Path $root 'cli/Updater.cs') (Join-Path $root 'tests/UpdaterTests.cs')
if ($LASTEXITCODE -ne 0) { throw '更新器测试编译失败' }
& $output (Join-Path $root 'output')
if ($LASTEXITCODE -ne 0) { throw '更新器测试失败' }
