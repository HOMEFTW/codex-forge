param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$ExpectedHash,[Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference='Stop'
try {
    $InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
    if (!(Test-Path -LiteralPath (Join-Path $InstallRoot 'forge-install.json'))) { throw 'Not a Codex Forge installation.' }
    $stream=[IO.File]::OpenRead($Installer); $algorithm=[Security.Cryptography.SHA256]::Create()
    try {$digest=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()} finally {$stream.Dispose();$algorithm.Dispose()}
    if ($digest -ne $ExpectedHash) { throw 'Installer SHA-256 changed.' }
    $receipt=Get-Content -LiteralPath ($Installer+'.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($receipt.sha256 -ne $ExpectedHash -or $receipt.schemaVersion -ne 2 -or $receipt.distribution -ne 'forge-bootstrap' -or $receipt.containsOfficialClient -ne $false) { throw 'Invalid Forge bootstrap release receipt.' }
    $parent=[IO.Directory]::GetParent($InstallRoot).FullName
    if ([IO.Path]::GetFileName($parent) -eq 'clients') {$parent=[IO.Directory]::GetParent($parent).FullName}
    if (!(Test-Path -LiteralPath (Join-Path $parent 'current.json'))) { throw 'Forge launcher root not found.' }
    $process=Start-Process -FilePath $Installer -ArgumentList ('/DIR="'+$parent+'"') -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw ('Installer exited with code '+$process.ExitCode) }
    @{status='installer_finished';restartRequired=$true;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath ($Installer+'.result.json') -Encoding UTF8
} catch {
    @{status='failed';error=$_.Exception.Message;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath ($Installer+'.result.json') -Encoding UTF8
    exit 1
}
