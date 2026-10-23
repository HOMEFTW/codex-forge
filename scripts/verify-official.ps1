param([Parameter(Mandatory=$true)][string]$Package,[Parameter(Mandatory=$true)][string]$Publisher)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$signature=Get-AuthenticodeSignature -LiteralPath $Package
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $Publisher) { throw ('Official package signature or publisher mismatch: '+$signature.Status+'; '+$signature.StatusMessage+'; '+$signature.SignerCertificate.Subject) }
Write-Output ('Verified official signature: '+$signature.SignerCertificate.Subject)
