'use strict';
// Serialize before Electron IPC, which otherwise drops custom Error properties.
class ForgeError extends Error {
  constructor(code, message) { super(message); this.name = 'ForgeError'; this.code = code; }
}
function serializeError(error) {
  return { code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'INTERNAL_ERROR', message: String(error?.message || 'Forge 请求失败') };
}
async function reply(action) {
  try { return { ok: true, result: await action() }; }
  catch (error) { return { ok: false, error: serializeError(error) }; }
}
module.exports = { ForgeError, serializeError, reply };
