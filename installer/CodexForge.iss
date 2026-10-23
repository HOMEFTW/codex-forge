#ifndef ForgeVersion
  #define ForgeVersion "0.1.0"
#endif
#ifndef ForgeRoot
  #define ForgeRoot SourcePath + ".."
#endif
[Setup]
AppId={{CC655CB5-B493-4544-8EBE-FD396307DF74}
AppName=Codex Forge
AppVersion={#ForgeVersion}
AppPublisher=HOMEFTW
AppPublisherURL=https://github.com/HOMEFTW/codex-forge
DefaultDirName={localappdata}\Programs\Codex Forge
DefaultGroupName=Codex Forge
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#ForgeRoot}\release\dist
OutputBaseFilename=Codex-Forge-{#ForgeVersion}-Setup-x64
SetupIconFile={#ForgeRoot}\assets\codex-forge.ico
UninstallDisplayIcon={app}\CodexForge.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
SetupLogging=yes

[Files]
Source: "{#ForgeRoot}\dist\CodexForge.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ForgeRoot}\dist\CodexForge.exe.config"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ForgeRoot}\release\forge-only\bootstrap.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ForgeRoot}\release\forge-only\payload\*"; DestDir: "{app}\forge\{#ForgeVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userdesktop}\Codex Forge"; Filename: "{app}\CodexForge.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\Codex Forge"; Filename: "{app}\CodexForge.exe"; WorkingDir: "{app}"
Name: "{group}\Prepare Codex Client"; Filename: "{app}\forge\{#ForgeVersion}\CodexForgeBootstrap.exe"; Parameters: "--root ""{app}"""; WorkingDir: "{app}"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: checkedonce

[Run]
Filename: "{app}\forge\{#ForgeVersion}\CodexForgeBootstrap.exe"; Parameters: "--root ""{app}"""; StatusMsg: "Downloading and preparing the compatible official Codex client..."; Flags: skipifsilent waituntilterminated

[UninstallDelete]
Type: files; Name: "{app}\current.json"
Type: files; Name: "{app}\current.json.previous"
Type: files; Name: "{app}\forge-prepare.log"
Type: files; Name: "{app}\forge-prepare-result.json"
Type: files; Name: "{app}\.forge-prepare.lock"
Type: filesandordirs; Name: "{app}\clients"
Type: filesandordirs; Name: "{app}\.cache"
