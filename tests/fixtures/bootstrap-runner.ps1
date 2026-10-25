$ErrorActionPreference='Stop'
$project=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$root=Join-Path (Join-Path $project 'output') ('bootstrap-unit-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$exitCode=1
try {
  $exe=Join-Path $root 'BootstrapTests.exe'
  $compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $args=@('/nologo','/target:exe','/main:BootstrapTests',('/win32manifest:'+ (Join-Path $project 'cli\app.manifest')),('/out:'+ $exe),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:System.Net.Http.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',(Join-Path $project 'cli\Bootstrap.cs'),(Join-Path $project 'tests\fixtures\bootstrap-tests.cs'))
  & $compiler @args
  if($LASTEXITCODE -ne 0){$exitCode=$LASTEXITCODE}
  else {
    Copy-Item (Join-Path $project 'cli\app.config') ($exe+'.config')
    $stdout=Join-Path $root 'stdout.txt';$stderr=Join-Path $root 'stderr.txt'
    $child=Start-Process -FilePath $exe -ArgumentList @($root,(Join-Path $project 'adapters\26.1016.8622.0.json')) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if(Test-Path $stdout){Get-Content $stdout -Raw};if(Test-Path $stderr){[Console]::Error.Write((Get-Content $stderr -Raw))};$exitCode=$child.ExitCode
  }
} finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
exit $exitCode
