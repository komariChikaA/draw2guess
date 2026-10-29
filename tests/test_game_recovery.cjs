'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoveryStore, assignmentKey, canRetry, TTL } = require('../static/game-recovery.js');
const storage = () => {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
};
const session = { code: 'ABC234', token: 'a'.repeat(43), name: '小猫' };
const room = { code: session.code, game_id: 1, phase: 'playing', round: 0,
  task: { kind: 'draw', chain_id: 0 }, me: { id: 1 }, players: [{ id: 1, submitted: false }], pause: null };

test('same browser can recover identity, room and local draft after closing a page', () => {
  const disk = storage();
  const before = new RecoveryStore(disk, () => 1000);
  assert.equal(before.remember(session), true);
  before.cache(session, room);
  before.saveDraft('draft', { drawing: { strokes: [] } }, true);
  const after = new RecoveryStore(disk, () => 2000);
  assert.equal(after.latest(session.code).token, session.token);
  assert.deepEqual(after.cached(session), room);
  assert.equal(after.draft('draft').pending, true);
});
test('submission retry is allowed only for the exact unsent assignment and never while paused', () => {
  const pending = { key: assignmentKey(room) };
  assert.equal(canRetry(room, pending), true);
  assert.equal(canRetry({ ...room, round: 1 }, pending), false);
  assert.equal(canRetry({ ...room, game_id: 2 }, pending), false);
  assert.equal(canRetry({ ...room, pause: {} }, pending), false);
  assert.equal(canRetry({ ...room, players: [{ id: 1, submitted: true }] }, pending), false);
});
test('explicit leave revokes local recovery and expired sessions are not reused', () => {
  let now = 0;
  const store = new RecoveryStore(storage(), () => now);
  store.remember(session);
  store.cache(session, room);
  store.forget(session);
  assert.equal(store.latest(), null);
  assert.equal(store.cached(session), null);
  store.remember(session);
  now = TTL + 1;
  assert.equal(store.latest(), null);
});
test('storage errors and corrupt stored content do not crash the game', () => {
  const broken = new RecoveryStore({ getItem: () => '{', setItem: () => { throw new Error('quota'); }, removeItem: () => {} });
  assert.equal(broken.latest(), null);
  assert.equal(broken.saveDraft('draft', {}), false);
});
