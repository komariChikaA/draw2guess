'use strict';

(function (root) {
  const TTL = 24 * 60 * 60 * 1000;
  const MAX_SESSIONS = 4;
  const INDEX = 'game:recovery:sessions';

  class RecoveryStore {
    constructor(storage, clock = Date.now) {
      this.storage = storage;
      this.clock = clock;
    }
    read(key) {
      try { return JSON.parse(this.storage.getItem(key) || 'null'); } catch { return null; }
    }
    write(key, value) {
      try { this.storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    }
    remove(key) {
      try { this.storage.removeItem(key); } catch { /* Storage may be disabled. */ }
    }
    sessions() {
      const rows = this.read(INDEX);
      return (Array.isArray(rows) ? rows : []).filter((row) => row && /^[A-Z2-9]{6}$/.test(row.code)
        && /^[A-Za-z0-9_-]{43}$/.test(row.token) && Number.isFinite(row.savedAt)
        && this.clock() - row.savedAt < TTL && row.savedAt <= this.clock());
    }
    remember(session) {
      const row = { code: session.code, token: session.token, name: session.name, savedAt: this.clock() };
      const previous = this.sessions();
      const rows = [row, ...previous.filter((item) => item.token !== row.token)].slice(0, MAX_SESSIONS);
      for (const old of previous) {
        if (!rows.some((item) => item.token === old.token)) this.remove(this.roomKey(old));
      }
      return this.write(INDEX, rows);
    }
    latest(code) { return this.sessions().find((row) => !code || row.code === code) || null; }
    roomKey(session) { return `game:recovery:room:${session.code}:${session.token}`; }
    cache(session, room) { return this.write(this.roomKey(session), { savedAt: this.clock(), room }); }
    cached(session) {
      const data = this.read(this.roomKey(session));
      return data && this.clock() - data.savedAt < TTL && data.room?.code === session.code ? data.room : null;
    }
    forget(session) {
      this.write(INDEX, this.sessions().filter((row) => row.token !== session.token));
      this.remove(this.roomKey(session));
    }
    draft(key) {
      const data = this.read(key);
      return data && this.clock() - data.savedAt < TTL ? data : null;
    }
    saveDraft(key, payload, pending = false) {
      return this.write(key, { savedAt: this.clock(), payload, pending });
    }
  }

  function assignmentKey(room) {
    return room?.phase === 'playing' && room.task
      ? `${room.game_id ?? 0}:${room.round}:${room.task.kind}:${room.task.chain_id}` : '';
  }
  function canRetry(room, pending) {
    return !!pending && !room.pause && assignmentKey(room) === pending.key
      && !room.players.some((player) => String(player.id) === String(room.me.id) && player.submitted);
  }

  const api = { RecoveryStore, assignmentKey, canRetry, TTL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GameRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
