$ErrorActionPreference='Stop'
$project=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$root=Join-Path (Join-Path $project 'output') ('launcher-unit-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe=Join-Path $root 'LauncherTests.exe'
& $compiler /nologo /target:exe /main:LauncherTests (('/out:')+$exe) /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $project 'cli/Launcher.cs') (Join-Path $PSScriptRoot 'launcher-tests.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$stdout=Join-Path $root 'stdout.txt';$stderr=Join-Path $root 'stderr.txt'
$child=Start-Process -FilePath $exe -ArgumentList @($root) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Get-Content $stdout -Raw
if (Test-Path $stderr) { [Console]::Error.Write((Get-Content $stderr -Raw)) }
exit $child.ExitCode
