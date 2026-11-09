'use strict';
function applyNativeFeatures(registry, env = process.env) {
  const keys = { nativeBrowserMode: 'CODEX_FAST_IAB', nativePlugins: 'CODEX_FORGE_NATIVE_PLUGINS', externalBrowser: 'CODEX_FORGE_EXTERNAL_BROWSER', computerUse: 'CODEX_FORGE_COMPUTER_USE' };
  for (const key of Object.values(keys)) env[key] = '0';
  if (!registry.status('forge.browser').enabled) return;
  const settings = registry.settings('forge.browser');
  for (const [key, variable] of Object.entries(keys)) env[variable] = settings[key] === true ? '1' : '0';
}
module.exports = { applyNativeFeatures };
