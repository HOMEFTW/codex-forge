import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'forge.config.json'), 'utf8'));
const releaseRoot = path.join(root, 'release');
const forgeOnly = path.join(releaseRoot, 'forge-only');
const payload = path.join(forgeOnly, 'payload');
const output = path.join(releaseRoot, 'dist');
const msiSource = path.join(releaseRoot, 'msi-source');
const portableSource = path.join(releaseRoot, 'portable-source');
const version = config.version;
const msiName = `Codex-Forge-${version}-Windows.msi`;
const portableName = `Codex-Forge-${version}-Windows-Portable.zip`;

const defaultWix = path.join(root, '..', '.tools', 'nuget-packages', 'wixtoolset.sdk', '7.0.0', 'tools', 'net472', 'x64', 'wix.exe');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function copy(source, destination) {
  const from = path.join(root, source);
  const to = path.join(payload, destination || source);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function walk(directory, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error(`不允许符号链接进入安装包：${next}`);
    if (entry.isDirectory()) result.push(...walk(absolute, next));
    else result.push({ absolute, relative: next.replaceAll('\\', '/') });
  }
  return result;
}

function assertForgeOnly(files) {
  for (const file of files) {
    if (/(?:^|\/)(?:ChatGPT\.exe|Codex\.exe|app\.asar|node\.exe)$|\.(?:msix|msixbundle)$/i.test(file.relative)) {
      throw Error(`官方客户端文件混入 Forge 安装包：${file.relative}`);
    }
  }
}

function preparePayload() {
  if (fs.existsSync(forgeOnly)) fs.rmSync(forgeOnly, { recursive: true, force: true });
  fs.mkdirSync(payload, { recursive: true });
  for (const item of [
    'forge.config.json', 'adapters', 'runtime', 'bundles', 'assets/codex-forge.ico', 'dist/fast-extension',
    'dist/CodexForge.exe', 'dist/CodexForge.exe.config', 'scripts/build-client.mjs',
    'scripts/native-tabs-patch.mjs', 'scripts/native-fast-patch.mjs', 'scripts/native-settings-patch.mjs',
    'scripts/Launch-Codex-Forge.ps1', 'scripts/verify-official.ps1', 'README.md', 'LICENSE', 'docs',
    'sdk', 'examples', 'CODEG-SKILLS-NOTICES.md'
  ]) copy(item);
  copy('dist/CodexForgeBootstrap.exe', 'CodexForgeBootstrap.exe');
  copy('dist/CodexForgeBootstrap.exe.config', 'CodexForgeBootstrap.exe.config');

  const files = walk(payload);
  assertForgeOnly(files);
  const payloadFiles = files.map(file => ({
    path: file.relative,
    bytes: fs.statSync(file.absolute).size,
    sha256: fileHash(file.absolute)
  }));
  const manifest = {
    schemaVersion: 1,
    product: 'Codex Forge',
    forgeVersion: version,
    apiVersion: config.apiVersion,
    containsOfficialClient: false,
    files: payloadFiles,
    payloadDigest: hash(payloadFiles.map(file => `${file.path}\0${file.bytes}\0${file.sha256}`).sort().join('\n'))
  };
  fs.writeFileSync(path.join(payload, 'forge-payload.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(forgeOnly, 'bootstrap.json'), JSON.stringify({ directory: `forge/${version}` }));
  return files;
}

function stageInstallRoots() {
  for (const directory of [msiSource, portableSource]) {
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
  }
  const forgeDirectory = path.join('forge', version);
  for (const destination of [msiSource, portableSource]) {
    fs.copyFileSync(path.join(root, 'dist', 'CodexForge.exe'), path.join(destination, 'CodexForge.exe'));
    fs.copyFileSync(path.join(root, 'dist', 'CodexForge.exe.config'), path.join(destination, 'CodexForge.exe.config'));
    fs.copyFileSync(path.join(forgeOnly, 'bootstrap.json'), path.join(destination, 'bootstrap.json'));
    fs.cpSync(payload, path.join(destination, forgeDirectory), { recursive: true });
  }
  fs.writeFileSync(path.join(portableSource, 'portable.ini'), '[Portable]\nProduct=Codex Forge\n');
}

function sha1Guid(seed) {
  const bytes = crypto.createHash('sha1').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function wixId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha1').update(value).digest('hex').slice(0, 20)}`;
}

function directDirectoryPaths(files) {
  const directories = new Set(['']);
  for (const file of files) {
    const parts = file.relative.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function buildDirectoryTree(files) {
  const directories = directDirectoryPaths(files);
  const children = new Map(directories.map(directory => [directory, []]));
  for (const directory of directories) {
    if (!directory) continue;
    const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '';
    children.get(parent).push(directory);
  }
  const render = parent => children.get(parent).sort().map(directory => {
    const name = directory.slice(directory.lastIndexOf('/') + 1);
    return `<Directory Id="${wixId('DIR', directory)}" Name="${xml(name)}">${render(directory)}</Directory>`;
  }).join('');
  return { directories, tree: render('') };
}

function createWixSource(files, sourceRoot) {
  const { directories, tree } = buildDirectoryTree(files);
  const groups = [];
  const cleanupGroups = [];
  const fragments = [];
  for (const directory of directories) {
    const directFiles = files.filter(file => {
      const parent = file.relative.includes('/') ? file.relative.slice(0, file.relative.lastIndexOf('/')) : '';
      return parent === directory;
    });
    if (!directFiles.length) continue;
    const groupId = wixId('CG', directory || 'root');
    groups.push(groupId);
    const directoryId = directory ? wixId('DIR', directory) : 'PRODUCTFOLDER';
    const components = directFiles.map(file => {
      const componentId = wixId('CMP', file.relative);
      const fileId = wixId('FIL', file.relative);
      const removeCurrent = directory === '' && file.relative === 'CodexForge.exe'
        ? '<RemoveFile Id="RemoveCurrentJson" Name="current.json" On="uninstall" /><RemoveFile Id="RemovePreviousCurrentJson" Name="current.json.previous" On="uninstall" />'
        : '';
      return `<Component Id="${componentId}" Guid="${sha1Guid(`component:${file.relative}`)}"><File Id="${fileId}" Source="${xml(path.join(sourceRoot, file.relative))}" />${removeCurrent}<RegistryValue Root="HKCU" Key="Software\\HOMEFTW\\Codex Forge\\Files" Name="${componentId}" Type="integer" Value="1" KeyPath="yes" /></Component>`;
    }).join('');
    fragments.push(`<Fragment><ComponentGroup Id="${groupId}" Directory="${directoryId}">${components}</ComponentGroup></Fragment>`);
  }
  const cleanupTargets = [
    { key: 'install-root', directoryId: 'INSTALLFOLDER' },
    ...directories.map(directory => ({ key: directory || 'root', directoryId: directory ? wixId('DIR', directory) : 'PRODUCTFOLDER' }))
  ];
  for (const { key, directoryId } of cleanupTargets) {
    const cleanupGroupId = wixId('CG_Cleanup', key);
    const cleanupId = wixId('CMP_Cleanup', key);
    const removeId = wixId('RMF', key);
    cleanupGroups.push(cleanupGroupId);
    fragments.push(`<Fragment><ComponentGroup Id="${cleanupGroupId}" Directory="${directoryId}"><Component Id="${cleanupId}" Guid="${sha1Guid(`cleanup:${key}`)}"><RemoveFolder Id="${removeId}" On="uninstall" /><RegistryValue Root="HKCU" Key="Software\\HOMEFTW\\Codex Forge\\Cleanup" Name="${cleanupId}" Type="integer" Value="1" KeyPath="yes" /></Component></ComponentGroup></Fragment>`);
  }
  const refs = [...groups, ...cleanupGroups].map(id => `<ComponentGroupRef Id="${id}" />`).join('');
  const bootstrapTarget = `[PRODUCTFOLDER]forge\\${version}\\CodexForgeBootstrap.exe`;
  const shortcutFragment = `<Fragment>
    <ComponentGroup Id="CG_Shortcuts">
      <Component Id="CMP_StartMenuShortcuts" Directory="ApplicationProgramsFolder" Guid="${sha1Guid('shortcut:start-menu')}">
        <Shortcut Id="StartMenuLaunch" Name="Codex Forge" Target="[PRODUCTFOLDER]CodexForge.exe" WorkingDirectory="PRODUCTFOLDER" />
        <Shortcut Id="StartMenuPrepare" Name="Prepare Codex Client" Target="${bootstrapTarget}" Arguments="--root &quot;[PRODUCTFOLDER]&quot;" WorkingDirectory="PRODUCTFOLDER" />
        <RemoveFolder Id="RemoveStartMenuFolder" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\HOMEFTW\\Codex Forge" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
      <Component Id="CMP_DesktopShortcut" Directory="DesktopFolder" Guid="${sha1Guid('shortcut:desktop')}" Condition="CREATEDESKTOPSHORTCUT=1">
        <Shortcut Id="DesktopLaunch" Name="Codex Forge" Target="[PRODUCTFOLDER]CodexForge.exe" WorkingDirectory="PRODUCTFOLDER" />
        <RegistryValue Root="HKCU" Key="Software\\HOMEFTW\\Codex Forge" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </ComponentGroup>
  </Fragment>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Codex Forge" Manufacturer="HOMEFTW" Version="${xml(version)}" UpgradeCode="CC655CB5-B493-4544-8EBE-FD396307DF74" Scope="perUser" Compressed="yes">
    <MajorUpgrade DowngradeErrorMessage="A newer version of Codex Forge is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Property Id="CREATEDESKTOPSHORTCUT" Value="1" Secure="yes" />
    <Feature Id="MainFeature" Title="Codex Forge" Level="1">${refs}<ComponentGroupRef Id="CG_Shortcuts" /></Feature>
  </Package>
  <Fragment>
    <StandardDirectory Id="LocalAppDataFolder"><Directory Id="INSTALLFOLDER" Name="Programs"><Directory Id="PRODUCTFOLDER" Name="Codex Forge">${tree}</Directory></Directory></StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder"><Directory Id="ApplicationProgramsFolder" Name="Codex Forge" /></StandardDirectory>
    <StandardDirectory Id="DesktopFolder" />
  </Fragment>
  ${fragments.join('\n  ')}
  ${shortcutFragment}
</Wix>
`;
}

function resolveTool() {
  const candidates = [
    process.env.WIX_EXE,
    defaultWix,
    path.join(root, '..', '.tools', 'nuget-packages', 'wixtoolset.sdk', '7.0.0', 'tools', 'net472', 'x86', 'wix.exe')
  ].filter(Boolean);
  const tool = candidates.find(candidate => fs.existsSync(candidate));
  if (!tool) throw Error('未找到 WiX 7 wix.exe。请设置 WIX_EXE，或安装 WiX Toolset SDK 7。');
  return tool;
}

function runOrThrow(file, args, label, env = process.env) {
  // The confined Windows sandbox blocks Node's piped child stdio, so inherit the
  // console instead. WiX/tar output still shows up in the build log.
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
  if (result.status !== 0) throw Error(`${label}失败（${result.status}）`);
  return result;
}

function cleanGeneratedOutput() {
  fs.mkdirSync(output, { recursive: true });
  const generated = /^(?:Codex-Forge-|codex-forge-release\.json$|SHA256SUMS\.txt$|probe[^/]*|direct[^/]*|debug\.log$|.*\.(?:msi|zip)$)/i;
  for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
    if (!generated.test(entry.name) && !entry.name.toLowerCase().endsWith('.wixpdb')) continue;
    fs.rmSync(path.join(output, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}

const files = preparePayload();
stageInstallRoots();
cleanGeneratedOutput();
const wixSource = path.join(releaseRoot, 'CodexForge.wxs');
fs.writeFileSync(wixSource, createWixSource(walk(msiSource), msiSource), 'utf8');
const msi = path.join(output, msiName);
const wixTool = resolveTool();
// WiX resolves its per-user EULA acceptance through WIX_EXE. Set it in the
// current process as well as the child environment so a clean shell behaves
// the same as an explicitly configured WIX_EXE build.
process.env.WIX_EXE = wixTool;
const wixEnv = { ...process.env, WIX_EXE: wixTool };
runOrThrow(wixTool, ['eula', 'accept', 'wix7'], 'WiX EULA 初始化', wixEnv);
runOrThrow(wixTool, ['--acceptEula', 'true', 'build', wixSource, '-o', msi, '--nologo'], 'WiX MSI 构建', wixEnv);
// The PDB is useful while diagnosing WiX, but it is not a release artifact and
// must not be uploaded alongside the signed/hash-verified packages.
fs.rmSync(path.join(output, `${msiName.slice(0, -4)}.wixpdb`), { force: true });
const portable = path.join(output, portableName);
runOrThrow('tar.exe', ['-a', '-c', '-f', portable, '-C', portableSource, '.'], 'Portable ZIP 构建');

const msiBytes = fs.statSync(msi).size;
const portableBytes = fs.statSync(portable).size;
const msiSHA256 = fileHash(msi);
const portableSHA256 = fileHash(portable);
const manifest = {
  schemaVersion: 3,
  platform: 'win32-x64',
  apiVersion: config.apiVersion,
  forgeVersion: version,
  codexVersion: config.codexVersion,
  codexBuildVersion: config.codexBuildVersion || config.codexVersion,
  repository: config.githubRepository,
  distribution: 'msi-portable',
  containsOfficialClient: false,
  url: `https://github.com/${config.githubRepository}/releases/download/v${version}/${msiName}`,
  sha256: msiSHA256,
  bytes: msiBytes,
  portableUrl: `https://github.com/${config.githubRepository}/releases/download/v${version}/${portableName}`,
  portableSha256: portableSHA256,
  portableBytes
};
fs.writeFileSync(path.join(output, 'codex-forge-release.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${msiSHA256}  ${msiName}\n${portableSHA256}  ${portableName}\n`);
fs.writeFileSync(path.join(root, 'output', 'installer-audit.json'), JSON.stringify({
  installer: msiName,
  portable: portableName,
  msiSHA256,
  portableSHA256,
  msiBytes,
  portableBytes,
  payloadFiles: files.length,
  officialClientFiles: 0,
  forgeVersion: version,
  codexVersion: config.codexVersion,
  codexBuildVersion: config.codexBuildVersion || config.codexVersion,
  checkedAt: new Date().toISOString()
}, null, 2));
console.log(JSON.stringify({ msi, portable, msiSHA256, portableSHA256, payloadFiles: files.length, officialClientFiles: 0 }, null, 2));
