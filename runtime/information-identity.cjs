'use strict';
const crypto = require('node:crypto');
const requiresAccount = (config, provider) => provider === 'openai' || config?.model_providers?.[provider]?.requires_openai_auth === true;

// Only this digest leaves the host. Credentials, endpoints and account metadata
// are never included in the statistics IPC or persisted result records.
function providerIdentity(config, provider, account, environment = process.env) {
  if (!config || !provider) return '';
  const settings = config.model_providers?.[provider];
  if (!settings && provider !== 'openai') return '';
  const variables = {};
  for (const key of [settings?.env_key, ...Object.values(settings?.env_http_headers || {})]) {
    if (typeof key === 'string') variables[key] = environment[key] || '';
  }
  const accountRequired = requiresAccount(config, provider);
  if (accountRequired) {
    if (!account?.account) return '';
    if (account.account.type === 'apiKey' && !environment.OPENAI_API_KEY) return '';
    variables.OPENAI_API_KEY = environment.OPENAI_API_KEY || '';
  }
  return crypto.createHash('sha256').update(JSON.stringify({ provider, settings: settings || null,
    variables, account: accountRequired ? account.account : null })).digest('hex');
}
module.exports = { providerIdentity, requiresAccount };
