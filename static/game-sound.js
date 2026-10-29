'use strict';

(function (root) {
  const STORAGE_KEY = 'game:sound';

  const BGM_TRACKS = Array.from({ length: 6 }, (_, index) => `/game-assets/bgm/bgm-${String(index + 1).padStart(2, '0')}.mp3`);
  const BGM_NAMES = ['君がいるから', 'Sentence know', '風車の丘で', '舞い上がる因果交流のひかり', 'Tea Break', 'Sea, Your Memory'];

  class SoundEngine {
    constructor() {
      this.enabled = true;
      try { this.enabled = localStorage.getItem(STORAGE_KEY) !== '0'; } catch { /* Storage is optional. */ }
      this.sfxVolume = 70; this.bgmVolume = 35;
      try {
        const sfxRaw = localStorage.getItem('game:sfx-volume');
        const bgmRaw = localStorage.getItem('game:bgm-volume');
        const sfx = sfxRaw === null ? NaN : Number(sfxRaw);
        const bgm = bgmRaw === null ? NaN : Number(bgmRaw);
        if (sfx >= 0 && sfx <= 100) this.sfxVolume = sfx;
        if (bgm >= 0 && bgm <= 100) this.bgmVolume = bgm;
      } catch { /* Storage is optional. */ }
      this.ctx = null;
      this.master = null;
      this.bgm = null; this.bgmIndex = 0; this.onBgmChange = null;
      this.bindUnlock();
    }
    get supported() {
      return !!(root.AudioContext || root.webkitAudioContext);
    }
    bindUnlock() {
      const unlock = () => { if (this.enabled) { this.ensure(); this.startBgm(); } };
      root.addEventListener('pointerdown', unlock, { once: true, passive: true });
      root.addEventListener('keydown', unlock, { once: true });
    }
    ensure() {
      if (!this.enabled || !this.supported) return null;
      try {
        if (!this.ctx) {
          const AudioContext = root.AudioContext || root.webkitAudioContext;
          this.ctx = new AudioContext();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.70 * this.sfxVolume / 100;
          this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return this.ctx;
      } catch {
        return null;
      }
    }
    setEnabled(value) {
      this.enabled = !!value;
      try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch { /* Storage is optional. */ }
      if (this.enabled) { this.ensure(); this.tick(false); this.startBgm(); }
      else this.pauseBgm();
      return this.enabled;
    }
    toggle() { return this.setEnabled(!this.enabled); }
    setSfxVolume(value) {
      this.sfxVolume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      if (this.master) this.master.gain.value = 0.70 * this.sfxVolume / 100;
      try { localStorage.setItem('game:sfx-volume', String(this.sfxVolume)); } catch { /* Storage is optional. */ }
      return this.sfxVolume;
    }
    setBgmVolume(value) {
      this.bgmVolume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      if (this.bgm) this.bgm.volume = 0.22 * this.bgmVolume / 100;
      try { localStorage.setItem('game:bgm-volume', String(this.bgmVolume)); } catch { /* Storage is optional. */ }
      return this.bgmVolume;
    }
    playBgm(index) {
      if (!this.enabled || !this.bgmVolume || typeof Audio === 'undefined') return;
      if (!this.bgm) {
        this.bgm = new Audio();
        this.bgm.preload = 'auto';
        this.bgm.addEventListener('ended', () => this.nextBgm());
      }
      this.bgmIndex = ((Number(index) || 0) % BGM_TRACKS.length + BGM_TRACKS.length) % BGM_TRACKS.length;
      this.bgm.src = BGM_TRACKS[this.bgmIndex];
      this.bgm.volume = 0.22 * this.bgmVolume / 100;
      this.bgm.play().catch(() => {});
      this.onBgmChange?.(this.bgmIndex);
    }
    startBgm() {
      if (!this.enabled || !this.bgmVolume || typeof Audio === 'undefined') return;
      this.playBgm(this.bgmIndex);
    }
    nextBgm() { this.playBgm(this.bgmIndex + 1); }
    pauseBgm() { if (this.bgm) this.bgm.pause(); }
    tone(frequency, duration, options = {}) {
      if (typeof document !== 'undefined' && document.hidden) return;
      const context = this.ensure();
      if (!context) return;
      const start = context.currentTime + (options.delay || 0);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = options.type || 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      if (options.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, options.endFrequency), start + duration);
      const volume = Math.max(0.001, Math.min(0.8, options.volume ?? 0.35));
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain); gain.connect(this.master);
      oscillator.start(start); oscillator.stop(start + duration + 0.03);
    }
    tick(urgent = false) { this.tone(urgent ? 1046 : 784, 0.07, { type: 'triangle', volume: 0.3 }); }
    prep(count) { this.tone(count <= 1 ? 1046 : 740, 0.1, { type: 'square', volume: 0.22 }); }
    go(kind) {
      const notes = kind === 'guess' ? [587, 880] : [523, 784];
      notes.forEach((frequency, index) => this.tone(frequency, index ? 0.18 : 0.1, { type: 'sine', volume: 0.42, delay: index * 0.09 }));
    }
    submit() {
      [660, 880, 1175].forEach((frequency, index) => this.tone(frequency, index === 2 ? 0.16 : 0.08, { type: 'triangle', volume: 0.34, delay: index * 0.07 }));
    }
    revealTick(count) { this.tone(count <= 1 ? 1046 : 880, 0.06, { type: 'square', volume: 0.2 }); }
    revealWait() {
      this.tone(330, 0.18, { type: 'sine', volume: 0.28 });
      this.tone(392, 0.22, { type: 'sine', volume: 0.32, delay: 0.2 });
      this.tone(494, 0.18, { type: 'triangle', volume: 0.24, delay: 0.4 });
    }
    reveal() {
      [392, 523, 784].forEach((frequency, index) => this.tone(frequency, index === 2 ? 0.3 : 0.12, { type: index === 1 ? 'triangle' : 'sine', volume: 0.36, delay: index * 0.1 }));
    }
    alert() {
      this.tone(520, 0.16, { type: 'sawtooth', volume: 0.22 });
      this.tone(330, 0.24, { type: 'sawtooth', volume: 0.2, delay: 0.14 });
    }
    reconnect() {
      this.tone(523, 0.1, { type: 'sine', volume: 0.32 });
      this.tone(784, 0.18, { type: 'sine', volume: 0.36, delay: 0.1 });
    }
    success() {
      [659, 880, 1175].forEach((frequency, index) => this.tone(frequency, index === 2 ? 0.2 : 0.1, { type: 'triangle', volume: 0.32, delay: index * 0.08 }));
    }
    fanfare() {
      [523, 659, 784, 1046].forEach((frequency, index) => this.tone(frequency, index === 3 ? 0.36 : 0.16, { type: 'triangle', volume: 0.34, delay: index * 0.12 }));
    }
  }

  root.GameSound = { SoundEngine, BGM_TRACKS, BGM_NAMES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
