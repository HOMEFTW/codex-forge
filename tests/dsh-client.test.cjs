'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const context = () => import('../ui/dsh-context.js');
test('DSH browser context supplies locale, optional injection and retractable UI slots', async () => {
  const { createDshContext } = await context(), ctx = createDshContext();
  ctx.locale.register('fixture', { zh: { title: '测试 {count}' }, en: { title: 'Test {count}' } });
  assert.equal(ctx.locale.bind('fixture')('title', { count: 2 }), '测试 2');
  let injected = 0; ctx.inject(['market'], value => { injected++; assert.equal(value.market.ready, true); });
  ctx.provide('market', { ready: true }); assert.equal(injected, 1);
  const off = ctx.slots.register({ name: 'main', id: 'fixture' }, () => null);
  assert.equal(ctx.slots.getSnapshot().length, 1); off(); assert.equal(ctx.slots.getSnapshot().length, 0);
  ctx.slots.inject('unsupported.optional.slot', () => { throw Error('optional UI must not mount'); });
  ctx.dispose(); assert.equal(ctx.disposed, true);
});
test('DSH dispose releases all effects once even if one cleanup reports an error', async () => {
  const { createDshContext } = await context(), errors = [], calls = [], ctx = createDshContext({ onError: error => errors.push(error.message) });
  const off = ctx.effect(() => () => calls.push('manual')); off(); off();
  ctx.on('dispose', () => { throw Error('fixture cleanup error'); }); ctx.on('dispose', () => calls.push('event'));
  ctx.effect(() => () => calls.push('first')); ctx.effect(() => () => calls.push('second'));
  ctx.dispose(); ctx.dispose(); assert.deepEqual(calls, ['manual', 'event', 'second', 'first']);
  assert.deepEqual(errors, ['fixture cleanup error']);
});
test('DSH late asynchronous effect is cleaned when initialization finishes after closure', async () => {
  const { createDshContext } = await context(), ctx = createDshContext(); let finish, stopped = 0;
  const result = ctx.effect(() => new Promise(resolve => { finish = resolve; }));
  ctx.dispose(); finish(() => stopped++); await result; assert.equal(stopped, 1);
});
