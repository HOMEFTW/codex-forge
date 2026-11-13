'use strict';
// This is trusted Node code. Enabling backend.node grants access to this Windows account's resources.
exports.activate = forge => {
  let calls = 0;
  forge.handle('echo', (args, { context }) => ({ args, threadId: context.threadId }));
  forge.handle('scheduled', args => { calls++; return { calls, args }; });
  forge.services.provide('example.api-five.counter', { read: () => ({ calls }) });
  forge.tools.register({
    name: 'example.api-five.add', description: 'Add two numbers without network or model calls.',
    inputSchema: { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } }, required: ['left', 'right'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'], additionalProperties: false },
  }, ({ left, right }) => { calls++; return { sum: left + right }; });
  forge.llm.registerProvider({ name: 'example.api-five.local', models: [{ id: 'echo', name: 'Local echo fixture' }] }, async function* (args, { signal }) {
    for (const text of ['Local fixture: ', String(args.prompt || '')]) {
      if (signal.aborted) return;
      yield { type: 'text', text };
    }
    yield { type: 'usage', usage: { outputTokens: 0 } };
  });
  forge.hooks.on('conversation.beforeSend', payload => payload);
  forge.onDispose(() => { calls = 0; });
};
