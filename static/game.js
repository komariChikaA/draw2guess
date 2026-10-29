'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const AVATAR_NAMES = ['默认头像 1', '默认头像 2', '默认头像 3', '默认头像 4', '默认头像 5', '默认头像 6', '默认头像 7', '默认头像 8'];
  const COLORS = [
    ['#293047', 'ink', '墨蓝'], ['#8892a3', 'gray', '灰色'], ['#ffffff', 'white', '白色'],
    ['#ed6b75', 'red', '红色'], ['#f3a65a', 'orange', '橙色'], ['#f8d66a', 'yellow', '黄色'],
    ['#88bf72', 'green', '绿色'], ['#719ee6', 'blue', '蓝色'], ['#a184d5', 'purple', '紫色'],
    ['#956e59', 'brown', '棕色'], ['#d7dbe3', 'lightgray', '浅灰'], ['#fff0cd', 'cream', '奶油色'],
    ['#f9bbc8', 'pink', '粉色'], ['#ffd3aa', 'peach', '桃色'], ['#fff49b', 'lemon', '柠檬黄'],
    ['#c4e5bb', 'mint', '薄荷绿'], ['#b8dafa', 'sky', '天蓝'], ['#d7c6f3', 'lilac', '浅紫']
  ];
  const BRUSHES = ['pen', 'marker', 'pencil', 'brush', 'crayon', 'spray'];
  const LAYERS = 3;
  const MAX_BYTES = 960 * 1024;
  const MAX_DRAW_BYTES = 850 * 1024;
  const WIDTH = 960;
  const HEIGHT = 640;
  const storage = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Private-mode storage can be unavailable. */ } },
    remove(key) { try { sessionStorage.removeItem(key); } catch { /* Optional persistence. */ } }
  };
  const recovery = new GameRecovery.RecoveryStore({
    getItem(key) { return localStorage.getItem(key); },
    setItem(key, value) { localStorage.setItem(key, value); },
    removeItem(key) { localStorage.removeItem(key); }
  });
  const sound = window.GameSound ? new window.GameSound.SoundEngine() : { enabled: false, supported: false, toggle() { return false; }, setEnabled() { return false; }, tick() {}, prep() {}, go() {}, submit() {}, revealTick() {}, revealWait() {}, reveal() {}, alert() {}, reconnect() {}, success() {}, fanfare() {} };
  const state = {
    room: null, code: '', token: '', avatar: 0, generation: 0,
    pollTimer: null, pollBusy: false, failures: 0, pollAgain: false,
    clockOffset: 0, connected: false, workingKey: '', locked: false, submitting: false,
    dirty: false, revision: 0, draftTimer: null, draftPromise: null,
    settingsDirty: false, settingsSignature: '', playersSignature: '',
    revealKey: '', revealSignature: '', matchSignature: '', favoriteSignature: '', revealAnimToken: 0, account: null, revealWaitTimer: null, revealAnswerTimer: null, replayDrawTimer: null, autoPlayTimer: null, autoPlaying: false, chatIds: new Set(), libraries: [], engine: null,
    noticeTimer: null, lastCountdownAnnouncement: '', lastPhase: '', actionBusy: new Set(),
    pendingSubmission: null, authoritative: false, cachedSignature: '', pauseShown: null, boardSignature: '', promptOpen: false, selectedWord: '', selectionOpen: false, prepLocked: false, prepTimer: null, flowTimer: null, loadingGame: null, flowPlayersSig: '', waitingSignature: '', scoreSignature: '', lastSoundSecond: '', lastRevealStage: '', favoriteAwardKey: '', pendingEntry: null, choiceLocked: false, choiceTimer: null, lineupSignature: '', sequenceSignature: '', tea: { open: false, strokes: [], hidden: new Set(), lastId: 0, pollTimer: null, active: null, tool: 'pen', color: '#293047', size: 6, opacity: 100, brush: 'pen', gradientEnabled: false, gradientA: '#ff6b6b', gradientB: '#4d7cff', localId: -1, polling: false }
  };

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined && text !== null) result.textContent = String(text);
    return result;
  }
  function text(id, value) { const el = $(id); const next = String(value ?? ''); if (el.textContent !== next) el.textContent = next; }
  function show(id, visible) { $(id).hidden = !visible; }
  function updateSoundButton() {
    const button = $('sound-toggle'); if (!button) return;
    const on = !!sound.enabled;
    button.disabled = !sound.supported;
    button.classList.toggle('off', !on);
    button.textContent = on ? '音' : '静';
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? '关闭提示音' : '开启提示音';
    button.setAttribute('aria-label', button.title);
  }
  function announce(message) { text('live-status', message); }
  function notice(message, error = false, persistent = false) {
    clearTimeout(state.noticeTimer);
    text('notice', message);
    $('notice').classList.toggle('error', error);
    show('notice', true);
    if (!persistent) state.noticeTimer = setTimeout(() => show('notice', false), error ? 9000 : 5000);
  }
  function avatarIndex(value) { const number = Number(value); return Number.isInteger(number) ? ((number % 8) + 8) % 8 : 0; }
  function avatarNode(value, className = 'player-avatar') {
    const holder = node('span', className);
    const image = node('img');
    image.src = `/game-assets/avatars/avatar-${avatarIndex(value) + 1}.png`;
    image.alt = '';
    image.width = 96; image.height = 96; image.loading = 'lazy'; image.decoding = 'async';
    holder.append(image);
    holder.setAttribute('aria-hidden', 'true');
    return holder;
  }
  function mine(room = state.room) { return room?.players?.find((p) => String(p.id) === String(room.me?.id)); }
  function isHost() { return !!state.room?.me?.host; }
  function setConnection(connected, reconnecting = false) {
    state.connected = connected;
    $('connection-status').classList.toggle('offline', !connected && !reconnecting);
    $('connection-status').classList.toggle('reconnecting', reconnecting);
    text('connection-text', connected ? '已连接' : reconnecting ? '重连中…' : '连接中断');
    show('reconnect-panel', !connected && !!state.code);
    if (!connected) text('reconnect-message', state.pendingSubmission
      ? '交卷正在等待联网。自动重连后会先核对轮次，再安全重试。'
      : '连接中断，正在自动重连。可以继续创作，本地草稿会保留；计时不会暂停。');
  }
  function layerOf(stroke) { const value = Number(stroke?.layer); return Number.isInteger(value) && value >= 0 && value < LAYERS ? value : 0; }
  function brushOf(stroke) { return BRUSHES.includes(stroke?.brush) ? stroke.brush : 'pen'; }
  function hash01(a, b) { const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return value - Math.floor(value); }
  function safeDrawing(drawing) {
    if (!drawing || !Array.isArray(drawing.strokes)) return { strokes: [] };
    let count = 0;
    const strokes = [];
    for (const raw of drawing.strokes.slice(0, 2000)) {
      if (!raw || !['pen', 'eraser', 'fill'].includes(raw.tool) || !Array.isArray(raw.points)) continue;
      const validPressures = Array.isArray(raw.pressures) && raw.pressures.length === raw.points.length ? raw.pressures : null;
      const points = [], pressures = [];
      for (let index = 0; index < raw.points.length; index++) {
        const p = raw.points[index];
        if (count >= 100000) break;
        if (!Array.isArray(p) || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) continue;
        points.push([Math.round(Math.max(0, Math.min(WIDTH - 0.01, Number(p[0]))) * 10) / 10,
          Math.round(Math.max(0, Math.min(HEIGHT - 0.01, Number(p[1]))) * 10) / 10]);
        if (validPressures) {
          const pressure = Number(validPressures[index]);
          pressures.push(Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 1);
        }
        count++;
        if (raw.tool === 'fill') break;
      }
      if (!points.length) continue;
      const stroke = { tool: raw.tool, color: raw.tool === 'eraser' ? '#ffffff' : /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : '#293047',
        size: Math.max(1, Math.min(64, Number(raw.size) || 6)), points, brush: brushOf(raw), layer: layerOf(raw) };
      const opacity = Math.round(Number(raw.opacity));
      if (Number.isFinite(opacity) && opacity >= 1 && opacity <= 100) stroke.opacity = opacity;
      if (raw.tool !== 'eraser' && Array.isArray(raw.gradient) && raw.gradient.length === 2
          && raw.gradient.every((value) => /^#[0-9a-f]{6}$/i.test(value))) stroke.gradient = raw.gradient.map((value) => value.toLowerCase());
      const angle = Number(raw.angle);
      if (raw.tool === 'fill' && Number.isFinite(angle)) stroke.angle = Math.max(0, Math.min(360, angle));
      if (raw.tool !== 'fill' && pressures.length === points.length && pressures.some((value) => value < 0.995)) stroke.pressures = pressures;
      strokes.push(stroke);
    }
    return { strokes };
  }
  function fillPixels(ctx, point, color, gradient = null, angle = 0) {
    const image = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const pixels = image.data;
    const x = Math.max(0, Math.min(WIDTH - 1, Math.floor(point[0])));
    const y = Math.max(0, Math.min(HEIGHT - 1, Math.floor(point[1])));
    const seed = y * WIDTH + x;
    const offset = seed * 4;
    const target = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
    const replacement = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255];
    const grad = Array.isArray(gradient) && gradient.length === 2
      ? [parseInt(gradient[0].slice(1, 3), 16), parseInt(gradient[0].slice(3, 5), 16), parseInt(gradient[0].slice(5, 7), 16),
         parseInt(gradient[1].slice(1, 3), 16), parseInt(gradient[1].slice(3, 5), 16), parseInt(gradient[1].slice(5, 7), 16)] : null;
    if (!grad && target.every((v, i) => v === replacement[i])) return;
    let minProjection = 0, range = 1, cos = 1, sin = 0;
    if (grad) {
      const radians = (Number(angle) || 0) * Math.PI / 180;
      cos = Math.cos(radians); sin = Math.sin(radians);
      const projections = [[0, 0], [WIDTH - 1, 0], [0, HEIGHT - 1], [WIDTH - 1, HEIGHT - 1]].map(([px, py]) => px * cos + py * sin);
      minProjection = Math.min(...projections); range = Math.max(1, Math.max(...projections) - minProjection);
    }
    const seen = new Uint8Array(WIDTH * HEIGHT);
    const queue = new Uint32Array(WIDTH * HEIGHT);
    let front = 0, back = 1;
    queue[0] = seed;
    seen[seed] = 1;
    const enqueue = (pixel) => {
      if (seen[pixel]) return;
      seen[pixel] = 1;
      const i = pixel * 4;
      if (Math.abs(pixels[i] - target[0]) <= 16 && Math.abs(pixels[i + 1] - target[1]) <= 16 && Math.abs(pixels[i + 2] - target[2]) <= 16 && Math.abs(pixels[i + 3] - target[3]) <= 16) queue[back++] = pixel;
    };
    while (front < back) {
      const pixel = queue[front++], i = pixel * 4, col = pixel % WIDTH, row = Math.floor(pixel / WIDTH);
      if (grad) {
        const ratio = Math.max(0, Math.min(1, (col * cos + row * sin - minProjection) / range));
        pixels[i] = Math.round(grad[0] + (grad[3] - grad[0]) * ratio);
        pixels[i + 1] = Math.round(grad[1] + (grad[4] - grad[1]) * ratio);
        pixels[i + 2] = Math.round(grad[2] + (grad[5] - grad[2]) * ratio);
      } else {
        pixels[i] = replacement[0]; pixels[i + 1] = replacement[1]; pixels[i + 2] = replacement[2];
      }
      pixels[i + 3] = 255;
      if (col > 0) enqueue(pixel - 1);
      if (col < WIDTH - 1) enqueue(pixel + 1);
      if (pixel >= WIDTH) enqueue(pixel - WIDTH);
      if (pixel < WIDTH * (HEIGHT - 1)) enqueue(pixel + WIDTH);
    }
    ctx.putImageData(image, 0, 0);
  }
  function gradientPaint(ctx, stroke) {
    if (!Array.isArray(stroke.gradient) || stroke.gradient.length !== 2 || stroke.points.length < 2) return null;
    const first = stroke.points[0], last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.1) return null;
    const gradient = ctx.createLinearGradient(first[0], first[1], last[0], last[1]);
    gradient.addColorStop(0, stroke.gradient[0]); gradient.addColorStop(1, stroke.gradient[1]);
    return gradient;
  }
  function renderStroke(ctx, stroke) {
    if (!stroke.points?.length) return;
    const tool = stroke.tool, color = tool === 'eraser' ? '#ffffff' : stroke.color;
    if (tool === 'fill') { fillPixels(ctx, stroke.points[0], color, stroke.gradient, stroke.angle); return; }
    const opacity = Math.max(0.01, Math.min(1, (Number(stroke.opacity) || 100) / 100));
    const paint = tool === 'eraser' ? color : (gradientPaint(ctx, stroke) || color);
    const points = stroke.points;
    const pressures = Array.isArray(stroke.pressures) && stroke.pressures.length === points.length ? stroke.pressures : null;
    const brush = brushOf(stroke);
    const size = Math.max(1, Number(stroke.size) || 6);
    const pressureAt = (index) => pressures ? (pressures[Math.max(0, index - 1)] + pressures[Math.min(points.length - 1, index)]) / 2 : 1;
    const widthAt = (index) => {
      let width = size * (0.25 + 0.75 * Math.max(0, Math.min(1, pressureAt(index))));
      if (brush === 'brush' && !pressures) {
        const edge = Math.min(index, points.length - 1 - index);
        width *= Math.min(1, 0.32 + edge / Math.max(1, points.length * 0.18) * 0.68);
      }
      return Math.max(0.7, width);
    };
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = paint; ctx.fillStyle = paint; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (tool === 'eraser') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0], points[0][1], widthAt(0) / 2, 0, Math.PI * 2); ctx.fill(); }
      else {
        for (let i = 1; i < points.length; i++) { ctx.lineWidth = widthAt(i); ctx.beginPath(); ctx.moveTo(points[i - 1][0], points[i - 1][1]); ctx.lineTo(points[i][0], points[i][1]); ctx.stroke(); }
      }
      ctx.restore();
      return;
    }
    if (brush === 'spray') {
      const samples = [];
      if (points.length === 1) samples.push(points[0]);
      else {
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i];
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const steps = Math.max(1, Math.ceil(length / Math.max(2, size * 0.22)));
          for (let step = 1; step <= steps; step++) samples.push([a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps]);
        }
      }
      const seed = (points[0][0] || 0) * 3.1 + (points[0][1] || 0) * 7.3 + size;
      const dots = Math.max(4, Math.round(4 + size / 12));
      ctx.globalAlpha = 0.55 * opacity;
      for (let i = 0; i < samples.length; i++) {
        for (let dot = 0; dot < dots; dot++) {
          const angle = hash01(i * 31 + dot, seed) * Math.PI * 2;
          const distance = hash01(i * 17 + dot, seed + 4) * size * 0.85;
          const radius = Math.max(0.6, size * 0.055 + hash01(i * 7 + dot, seed + 9) * size * 0.08);
          ctx.beginPath(); ctx.arc(samples[i][0] + Math.cos(angle) * distance, samples[i][1] + Math.sin(angle) * distance, radius, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
      return;
    }
    if (brush === 'marker') {
      ctx.globalAlpha = 0.5 * opacity;
      ctx.lineWidth = widthAt(0);
      if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0], points[0][1], widthAt(0) / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]); for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]); ctx.stroke(); }
      ctx.restore();
      return;
    }
    if (brush === 'pencil' || brush === 'crayon') {
      const alpha = brush === 'pencil' ? 0.72 : 0.55;
      const widthFactor = brush === 'pencil' ? 0.65 : 0.9;
      ctx.globalAlpha = alpha * opacity;
      ctx.lineWidth = Math.max(0.6, size * widthFactor);
      if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0], points[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]); for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]); ctx.stroke(); }
      const grains = [];
      if (points.length === 1) grains.push(points[0]);
      else {
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i];
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const steps = Math.max(1, Math.ceil(length / Math.max(3, size * 0.32)));
          for (let step = 1; step <= steps; step++) grains.push([a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps]);
        }
      }
      const passes = brush === 'pencil' ? 2 : 3;
      const seed = (points[0][0] || 0) * 5.7 + (points[0][1] || 0) * 2.3 + size;
      ctx.globalAlpha = (brush === 'pencil' ? 0.22 : 0.18) * opacity;
      ctx.lineWidth = Math.max(0.55, size * (brush === 'pencil' ? 0.22 : 0.35));
      for (let pass = 0; pass < passes; pass++) {
        for (let i = 0; i < grains.length; i++) {
          const jitterX = (hash01(i * 13 + pass, seed) - 0.5) * size * 0.45;
          const jitterY = (hash01(i * 29 + pass, seed + 3) - 0.5) * size * 0.45;
          ctx.beginPath(); ctx.arc(grains[i][0] + jitterX, grains[i][1] + jitterY, Math.max(0.4, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
      return;
    }
    // pen and brush
    if (points.length === 1) {
      const radius = widthAt(0) / 2;
      ctx.beginPath(); ctx.arc(points[0][0], points[0][1], radius, 0, Math.PI * 2); ctx.fill();
    } else if (!pressures && brush === 'pen') {
      ctx.lineWidth = size;
      ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]); for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]); ctx.stroke();
    } else if (brush === 'brush' && !pressures) {
      const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0) || 1;
      let traveled = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(length / 4));
        for (let step = 1; step <= steps; step++) {
          const progress = (traveled + length * step / steps) / total;
          const edge = Math.min(progress, 1 - progress);
          const taper = Math.min(1, 0.32 + edge / 0.16 * 0.68);
          ctx.lineWidth = Math.max(0.7, size * taper);
          const x = a[0] + (b[0] - a[0]) * step / steps, y = a[1] + (b[1] - a[1]) * step / steps;
          ctx.beginPath(); ctx.moveTo(a[0] + (b[0] - a[0]) * (step - 1) / steps, a[1] + (b[1] - a[1]) * (step - 1) / steps); ctx.lineTo(x, y); ctx.stroke();
        }
        traveled += length;
      }
    } else {
      for (let i = 1; i < points.length; i++) { ctx.lineWidth = widthAt(i); ctx.beginPath(); ctx.moveTo(points[i - 1][0], points[i - 1][1]); ctx.lineTo(points[i][0], points[i][1]); ctx.stroke(); }
    }
    ctx.restore();
  }
  function renderDrawing(canvas, drawing, limit = Infinity) {
    const parsed = safeDrawing(drawing);
    const layers = Array.from({ length: LAYERS }, () => { const layer = document.createElement('canvas'); layer.width = WIDTH; layer.height = HEIGHT; return layer; });
    const contexts = layers.map((layer) => layer.getContext('2d', { willReadFrequently: true }));
    for (const stroke of parsed.strokes.slice(0, limit)) renderStroke(contexts[stroke.layer], stroke);
    const out = canvas.getContext('2d');
    out.clearRect(0, 0, canvas.width, canvas.height);
    out.fillStyle = '#ffffff'; out.fillRect(0, 0, canvas.width, canvas.height);
    for (const layer of layers) out.drawImage(layer, 0, 0);
  }
  function simplifyPoints(points, tolerance = 0.65, pressures = null) {
    if (points.length < 3) return pressures ? { points, pressures } : points;
    const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    const sqTolerance = tolerance * tolerance;
    while (stack.length) {
      const [start, end] = stack.pop();
      const a = points[start], b = points[end];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
      let furthest = -1, maxDistance = sqTolerance;
      for (let i = start + 1; i < end; i++) {
        const p = points[i];
        const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
        const px = p[0] - a[0] - t * dx, py = p[1] - a[1] - t * dy;
        const distance = px * px + py * py;
        if (distance > maxDistance) { maxDistance = distance; furthest = i; }
      }
      if (furthest !== -1) { keep[furthest] = 1; stack.push([start, furthest], [furthest, end]); }
    }
    const nextPoints = points.filter((_, i) => keep[i]);
    if (pressures) return { points: nextPoints, pressures: pressures.filter((_, i) => keep[i]) };
    return nextPoints;
  }
  class DrawingEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.layers = Array.from({ length: LAYERS }, () => { const layer = document.createElement('canvas'); layer.width = WIDTH; layer.height = HEIGHT; return layer; });
      this.layerCtx = this.layers.map((layer) => layer.getContext('2d', { willReadFrequently: true }));
      this.layer = LAYERS - 1;
      this.layerVisible = Array(LAYERS).fill(true);
      this.layerRows = [];
      this.drawing = { strokes: [] }; this.undoStack = []; this.redoStack = [];
      this.tool = 'pen'; this.brush = BRUSHES.includes(localStorage.getItem('game:brush')) ? localStorage.getItem('game:brush') : 'pen';
      this.color = '#293047'; this.size = 6; this.locked = true;
      this.pressureEnabled = true; try { this.pressureEnabled = localStorage.getItem('game:pressure') !== '0'; } catch { /* Storage is optional. */ }
      this.opacity = 100; try { const savedOpacity = Number(localStorage.getItem('game:opacity')); if (savedOpacity >= 10 && savedOpacity <= 100) this.opacity = savedOpacity; } catch { /* Storage is optional. */ }
      this.gradientEnabled = false;
      this.gradientA = '#ff6b6b'; this.gradientB = '#4d7cff';
      this.fillAngle = 0;
      this.lineErasing = false;
      this.hoverPoint = null; this.hoverTimer = null;
      this.pointer = null; this.active = null; this.pending = []; this.frame = null; this.pointCount = 0;
      this.preview = document.createElement('canvas'); this.preview.width = WIDTH; this.preview.height = HEIGHT;
      this.previewCtx = this.preview.getContext('2d', { willReadFrequently: true }); this.previewVisible = false;
      this.fillPreview = document.createElement('canvas'); this.fillPreview.width = WIDTH; this.fillPreview.height = HEIGHT;
      this.fillPreviewCtx = this.fillPreview.getContext('2d', { willReadFrequently: true }); this.fillPreviewVisible = false;
      this.linePreview = document.createElement('canvas'); this.linePreview.width = WIDTH; this.linePreview.height = HEIGHT;
      this.linePreviewCtx = this.linePreview.getContext('2d', { willReadFrequently: true }); this.linePreviewVisible = false;
      this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      canvas.width = WIDTH * this.dpr; canvas.height = HEIGHT * this.dpr;
      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.finish(e));
      canvas.addEventListener('pointercancel', (e) => this.finish(e));
      canvas.addEventListener('lostpointercapture', (e) => this.finish(e));
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointerleave', () => this.clearHoverPreviews());
      document.querySelectorAll('[data-brush]').forEach((button) => button.addEventListener('click', () => this.setBrush(button.dataset.brush)));
      this.buildLayerUI();
      this.refreshBrushUI();
      this.replay();
    }
    present() {
      const out = this.canvas.getContext('2d');
      out.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      out.clearRect(0, 0, WIDTH, HEIGHT);
      out.fillStyle = '#ffffff'; out.fillRect(0, 0, WIDTH, HEIGHT);
      if (this.linePreviewVisible) out.drawImage(this.linePreview, 0, 0);
      else {
        for (let index = 0; index < LAYERS; index++) {
          if (!this.layerVisible[index]) continue;
          out.drawImage(this.fillPreviewVisible && index === this.layer ? this.fillPreview : this.layers[index], 0, 0);
        }
        if (this.previewVisible) out.drawImage(this.preview, 0, 0);
      }
    }
    replay() {
      this.previewVisible = false; this.fillPreviewVisible = false; this.linePreviewVisible = false;
      for (const context of this.layerCtx) context.clearRect(0, 0, WIDTH, HEIGHT);
      for (const stroke of this.drawing.strokes) renderStroke(this.layerCtx[layerOf(stroke)], stroke);
      this.present(); this.refreshLayerUI(); this.updateHistory();
    }
    load(drawing) {
      this.finish(); this.drawing = safeDrawing(drawing);
      this.pointCount = this.drawing.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      this.layerVisible = Array(LAYERS).fill(true);
      this.undoStack = []; this.redoStack = []; this.replay();
    }
    position(e) {
      const box = this.canvas.getBoundingClientRect();
      return [Math.round(Math.max(0, Math.min(WIDTH - 0.1, (e.clientX - box.left) / box.width * WIDTH)) * 10) / 10,
        Math.round(Math.max(0, Math.min(HEIGHT - 0.1, (e.clientY - box.top) / box.height * HEIGHT)) * 10) / 10];
    }
    pressureFor(e) {
      if (!this.pressureEnabled || !e || e.pointerType !== 'pen') return 1;
      const value = Number(e.pressure);
      if (!Number.isFinite(value)) return 1;
      return value > 0 ? Math.max(0.04, Math.min(1, value)) : 0.35;
    }
    down(e) {
      if (document.querySelector('.tool-popover:not([hidden])')) { closeToolPopovers(); e.preventDefault(); return; }
      if (this.locked || this.pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (!this.layerVisible[this.layer]) { notice('当前图层已隐藏，请先显示图层再画。'); return; }
      if (this.drawing.strokes.length >= 2000 || this.pointCount >= 100000) { notice('这幅画已经很丰富了！达到绘画容量上限，可撤销一些笔画后继续。', true); return; }
      if (state.room?.round === 0 && !selectedPrompt()) { notice('请先选择一个题目。'); document.querySelector('.flow-choice')?.focus(); return; }
      e.preventDefault(); this.canvas.focus({ preventScroll: true });
      this.clearHoverPreviews();
      if (this.tool === 'line-eraser') {
        this.pointer = e.pointerId; this.canvas.setPointerCapture(e.pointerId); this.lineErasing = true;
        this.eraseAt(this.position(e)); return;
      }
      this.pointer = e.pointerId; this.canvas.setPointerCapture(e.pointerId);
      this.active = { tool: this.tool, color: this.tool === 'eraser' ? '#ffffff' : this.color, size: this.size, brush: this.brush, layer: this.layer, opacity: this.opacity, points: [this.position(e)] };
      if (this.gradientEnabled && this.tool !== 'eraser') this.active.gradient = [this.gradientA, this.gradientB];
      if (this.tool === 'fill') this.active.angle = this.fillAngle;
      if (this.tool !== 'fill' && this.pressureEnabled) this.active.pressures = [this.pressureFor(e)];
      if (this.tool === 'fill' || this.tool === 'eraser') { renderStroke(this.layerCtx[this.layer], this.active); this.present(); }
      else { this.previewCtx.clearRect(0, 0, WIDTH, HEIGHT); renderStroke(this.previewCtx, this.active); this.previewVisible = true; this.present(); }
      if (this.tool === 'fill') this.finish();
    }
    move(e) {
      if (this.locked) return;
      if (this.pointer !== null && this.pointer !== e.pointerId) return;
      if (this.tool === 'line-eraser' && this.lineErasing) { e.preventDefault(); this.eraseAt(this.position(e)); return; }
      if (this.pointer === null && !this.active) { this.queueHoverPreview(this.position(e)); return; }
      if (this.pointer !== e.pointerId || !this.active) return;
      e.preventDefault();
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const sample of events.length ? events : [e]) this.pending.push({ point: this.position(sample), pressure: this.pressureFor(sample) });
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = null; this.flush(); });
    }
    flush() {
      if (!this.active) { this.pending = []; return; }
      let changed = false;
      const context = this.layerCtx[this.layer];
      const segments = [];
      for (const sample of this.pending) {
        const point = sample.point;
        if (this.pointCount + this.active.points.length >= 100000 || this.active.points.length >= 16000) break;
        const previous = this.active.points[this.active.points.length - 1];
        if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.65) continue;
        const previousPressure = this.active.pressures ? this.active.pressures[this.active.pressures.length - 1] : 1;
        this.active.points.push(point);
        if (this.active.pressures) this.active.pressures.push(sample.pressure);
        const segment = { ...this.active, points: [previous, point] };
        if (this.active.pressures) segment.pressures = [previousPressure, sample.pressure];
        segments.push(segment); changed = true;
      }
      this.pending = [];
      if (!changed) return;
      if (this.active.tool === 'eraser') {
        for (const segment of segments) renderStroke(context, segment);
      } else {
        this.previewCtx.clearRect(0, 0, WIDTH, HEIGHT);
        renderStroke(this.previewCtx, this.active);
        this.previewVisible = true;
      }
      this.present();
    }
    finish(e) {
      if (this.lineErasing) {
        if (e && e.pointerId !== this.pointer) return;
        const pointer = this.pointer; this.pointer = null; this.lineErasing = false;
        try { if (this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer); } catch { /* Pointer may already be released. */ }
        markDirty();
        return;
      }
      if (!this.active || (e && e.pointerId !== this.pointer)) return;
      if (e && e.type === 'pointerup') this.pending.push({ point: this.position(e), pressure: this.pressureFor(e) });
      if (this.frame) cancelAnimationFrame(this.frame); this.frame = null; this.flush();
      const stroke = this.active;
      if (stroke.pressures) {
        const simplified = simplifyPoints(stroke.points, 0.65, stroke.pressures);
        stroke.points = simplified.points; stroke.pressures = simplified.pressures;
        if (!stroke.pressures.some((value) => value < 0.995)) delete stroke.pressures;
      } else stroke.points = simplifyPoints(stroke.points);
      this.active = null;
      const pointer = this.pointer; this.pointer = null;
      try { if (this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer); } catch { /* Pointer may already be released. */ }
      this.previewVisible = false; this.fillPreviewVisible = false; this.linePreviewVisible = false;
      this.drawing.strokes.push(stroke);
      if (new Blob([JSON.stringify(this.drawing)]).size > MAX_DRAW_BYTES) {
        this.drawing.strokes.pop(); notice('画作接近保存大小上限，最后一笔未保留。请撤销一些笔画后继续。', true); this.replay(); return;
      }
      this.pointCount += stroke.points.length;
      this.undoStack.push({ kind: 'stroke', stroke }); this.undoStack = this.undoStack.slice(-100); this.redoStack = [];
      this.replay(); markDirty();
    }
    strokeHit(stroke, point, radius) {
      const points = stroke.points || [];
      const limit = radius + (Number(stroke.size) || 0) / 2;
      if (stroke.tool === 'fill') return Math.hypot(points[0][0] - point[0], points[0][1] - point[1]) <= limit;
      if (points.length === 1) return Math.hypot(points[0][0] - point[0], points[0][1] - point[1]) <= limit;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const length = dx * dx + dy * dy;
        const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
        const x = a[0] + dx * t, y = a[1] + dy * t;
        if (Math.hypot(point[0] - x, point[1] - y) <= limit) return true;
      }
      return false;
    }
    eraseAt(point) {
      if (this.locked) return;
      const radius = Math.max(9, this.size * 0.7);
      const removed = [];
      const keep = [];
      this.drawing.strokes.forEach((stroke, index) => {
        if (layerOf(stroke) === this.layer && this.strokeHit(stroke, point, radius)) removed.push({ stroke, index });
        else keep.push(stroke);
      });
      if (!removed.length) return;
      this.drawing.strokes = keep;
      this.undoStack.push({ kind: 'erase', items: removed });
      this.undoStack = this.undoStack.slice(-100); this.redoStack = [];
      this.recount(); this.replay(); markDirty();
    }
    setOpacity(value) {
      this.opacity = Math.max(10, Math.min(100, Math.round(Number(value) || 100)));
      $('opacity-range').value = String(this.opacity); text('opacity-value', this.opacity);
      try { localStorage.setItem('game:opacity', String(this.opacity)); } catch { /* Storage is optional. */ }
    }
    setGradientEnabled(enabled) {
      this.gradientEnabled = !!enabled;
      const button = $('gradient-toggle');
      button.setAttribute('aria-pressed', String(this.gradientEnabled));
      button.classList.toggle('selected', this.gradientEnabled);
      text('gradient-toggle', this.gradientEnabled ? '关闭渐变' : '启用渐变');
      if (this.gradientEnabled && !['pen', 'marker', 'pencil', 'brush', 'crayon', 'spray'].includes(this.brush)) this.setBrush('pen');
    }
    setGradientColors(first, second) {
      if (/^#[0-9a-f]{6}$/i.test(first)) this.gradientA = first.toLowerCase();
      if (/^#[0-9a-f]{6}$/i.test(second)) this.gradientB = second.toLowerCase();
    }
    queueHoverPreview(point) {
      this.hoverPoint = point;
      if (this.hoverTimer) return;
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        if (this.pointer !== null || this.locked || !this.hoverPoint) return;
        if (this.tool === 'fill') this.renderFillPreview(this.hoverPoint);
        else if (this.tool === 'line-eraser') this.renderLinePreview(this.hoverPoint);
      }, 90);
    }
    clearHoverPreviews() {
      clearTimeout(this.hoverTimer); this.hoverTimer = null; this.hoverPoint = null;
      if (!this.fillPreviewVisible && !this.linePreviewVisible) return;
      this.fillPreviewVisible = false; this.linePreviewVisible = false; this.present();
    }
    renderFillPreview(point) {
      const context = this.fillPreviewCtx;
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.drawImage(this.layers[this.layer], 0, 0);
      fillPixels(context, point, this.color, this.gradientEnabled ? [this.gradientA, this.gradientB] : null, this.fillAngle);
      this.linePreviewVisible = false; this.fillPreviewVisible = true; this.present();
    }
    renderLinePreview(point) {
      const context = this.linePreviewCtx;
      context.clearRect(0, 0, WIDTH, HEIGHT);
      const radius = Math.max(9, this.size * 0.7);
      for (const stroke of this.drawing.strokes) {
        if (!this.layerVisible[layerOf(stroke)]) continue;
        if (layerOf(stroke) === this.layer && this.strokeHit(stroke, point, radius)) {
          renderStroke(context, { ...stroke, opacity: Math.max(1, Math.round((stroke.opacity ?? 100) * 0.25)) });
        } else renderStroke(context, stroke);
      }
      this.fillPreviewVisible = false; this.linePreviewVisible = true; this.present();
    }
    setLocked(value) { if (this.locked === value) return; this.finish(); this.locked = value; this.canvas.closest('.canvas-frame').classList.toggle('locked', value); this.canvas.setAttribute('aria-disabled', String(value)); this.updateHistory(); }
    setTool(tool) {
      this.finish(); this.clearHoverPreviews(); this.tool = tool;
      document.querySelectorAll('[data-tool]').forEach((button) => { const selected = button.dataset.tool === tool; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    }
    setBrush(brush) {
      if (!BRUSHES.includes(brush)) return;
      this.finish(); this.brush = brush;
      if (this.tool !== 'pen') this.setTool('pen');
      try { localStorage.setItem('game:brush', brush); } catch { /* Storage is optional. */ }
      this.refreshBrushUI();
    }
    setColor(color) {
      if (!/^#[0-9a-f]{6}$/i.test(color)) return;
      this.color = color.toLowerCase(); $('custom-color').value = this.color;
      const dot = $('current-color-dot'); if (dot) dot.style.background = this.color;
      if (this.gradientEnabled) this.setGradientEnabled(false);
      document.querySelectorAll('.color-swatch').forEach((button) => { const selected = button.dataset.color === this.color; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    }
    setSize(size) {
      this.size = Math.max(1, Math.min(64, Number(size) || 6)); $('brush-size').value = String(this.size); text('brush-size-value', this.size);
      if ($('eraser-size')) { $('eraser-size').value = String(this.size); text('eraser-size-value', this.size); }
      if ($('line-eraser-size')) { $('line-eraser-size').value = String(this.size); text('line-eraser-size-value', this.size); }
      document.querySelectorAll('[data-size]').forEach((button) => { const selected = Number(button.dataset.size) === this.size; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    }
    setFillAngle(value) {
      this.fillAngle = Math.max(0, Math.min(360, Math.round(Number(value) || 0)));
      $('fill-angle').value = String(this.fillAngle); text('fill-angle-value', this.fillAngle);
      const hand = $('fill-dial-hand'); if (hand) hand.style.transform = `rotate(${this.fillAngle}deg)`;
      const dial = $('fill-dial'); if (dial) dial.setAttribute('aria-valuenow', String(this.fillAngle));
    }
    setPressure(enabled) {
      this.pressureEnabled = !!enabled;
      try { localStorage.setItem('game:pressure', enabled ? '1' : '0'); } catch { /* Storage is optional. */ }
      const toggle = $('pressure-toggle'); if (toggle) toggle.checked = this.pressureEnabled;
    }
    setLayer(index) {
      if (!Number.isInteger(index) || index < 0 || index >= LAYERS) return;
      this.finish(); this.layer = index; this.refreshLayerUI();
    }
    setLayerVisible(index, visible) {
      if (!Number.isInteger(index) || index < 0 || index >= LAYERS) return;
      this.finish(); this.layerVisible[index] = !!visible; this.present(); this.refreshLayerUI();
    }
    buildLayerUI() {
      const list = $('layer-list'); if (!list) return;
      list.replaceChildren();
      for (let index = LAYERS - 1; index >= 0; index--) {
        const row = node('div', 'layer-row');
        row.dataset.layer = String(index);
        const eye = node('button', 'layer-eye'); eye.type = 'button'; eye.setAttribute('aria-label', `显示或隐藏图层 ${index + 1}`);
        const thumb = node('canvas', 'layer-thumb'); thumb.width = 52; thumb.height = 34;
        const info = node('div', 'layer-info');
        const name = node('span', 'layer-name', `图层 ${index + 1}`);
        const stateLabel = node('span', 'layer-state');
        info.append(name, stateLabel); row.append(eye, thumb, info);
        eye.addEventListener('click', (event) => { event.stopPropagation(); this.setLayerVisible(index, !this.layerVisible[index]); });
        row.addEventListener('click', () => this.setLayer(index));
        list.append(row);
        this.layerRows[index] = { row, eye, thumb, stateLabel };
      }
      this.refreshLayerUI();
    }
    refreshLayerUI() {
      for (let index = 0; index < LAYERS; index++) {
        const item = this.layerRows[index]; if (!item) continue;
        const visible = this.layerVisible[index], active = index === this.layer;
        item.row.classList.toggle('active', active);
        item.row.classList.toggle('hidden-layer', !visible);
        item.eye.textContent = visible ? '◉' : '○';
        item.eye.setAttribute('aria-pressed', String(visible));
        const position = index === LAYERS - 1 ? '顶层' : index === 0 ? '底层' : '中层';
        item.stateLabel.textContent = !visible ? '已隐藏' : active ? `当前 · ${position}` : position;
        const context = item.thumb.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, item.thumb.width, item.thumb.height);
        if (visible) context.drawImage(this.layers[index], 0, 0, item.thumb.width, item.thumb.height);
      }
      const label = $('current-layer-label');
      if (label) { label.textContent = `图层 ${this.layer + 1}${this.layerVisible[this.layer] ? '' : '（隐藏）'}`; label.classList.toggle('hidden-layer', !this.layerVisible[this.layer]); }
    }
    refreshBrushUI() {
      document.querySelectorAll('[data-brush]').forEach((button) => { const selected = button.dataset.brush === this.brush; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    }
    updateHistory() { $('undo-button').disabled = this.locked || !this.undoStack.length; $('redo-button').disabled = this.locked || !this.redoStack.length; }
    undo() {
      if (this.locked) return; this.finish();
      const action = this.undoStack.pop(); if (!action) return;
      if (action.kind === 'clear') this.drawing.strokes.push(...action.strokes);
      else if (action.kind === 'erase') {
        for (const item of action.items.slice().sort((a, b) => a.index - b.index)) this.drawing.strokes.splice(item.index, 0, item.stroke);
      } else this.drawing.strokes.pop();
      this.redoStack.push(action); this.recount(); this.replay(); markDirty();
    }
    redo() {
      if (this.locked) return;
      const action = this.redoStack.pop(); if (!action) return;
      if (action.kind === 'clear') this.drawing.strokes = this.drawing.strokes.filter((stroke) => layerOf(stroke) !== action.layer);
      else if (action.kind === 'erase') {
        const removed = new Set(action.items.map((item) => item.stroke));
        this.drawing.strokes = this.drawing.strokes.filter((stroke) => !removed.has(stroke));
      } else this.drawing.strokes.push(action.stroke);
      this.undoStack.push(action); this.recount(); this.replay(); markDirty();
    }
    recount() { this.pointCount = this.drawing.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0); }
    clear() {
      if (this.locked) return; this.finish();
      const removed = this.drawing.strokes.filter((stroke) => layerOf(stroke) === this.layer);
      if (!removed.length) return;
      this.undoStack.push({ kind: 'clear', layer: this.layer, strokes: removed }); this.undoStack = this.undoStack.slice(-100);
      this.drawing.strokes = this.drawing.strokes.filter((stroke) => layerOf(stroke) !== this.layer);
      this.redoStack = []; this.recount(); this.replay(); markDirty();
    }
    export(filename) { this.finish(); downloadCanvas(this.canvas, filename); }
  }
  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      if (!blob) { notice('暂时无法导出画作，请重试。', true); return; }
      const url = URL.createObjectURL(blob); const link = node('a'); link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, 'image/png');
  }
  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  async function request(path, method = 'GET', body, authenticated = true) {
    const headers = { Accept: 'application/json' };
    if (authenticated && state.token) headers['X-Game-Token'] = state.token;
    let encoded;
    if (body !== undefined) {
      encoded = JSON.stringify(body);
      if (new Blob([encoded]).size >= MAX_BYTES) throw new ApiError('这幅画太复杂了，请撤销一些笔画再保存。', 413);
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { method, headers, body: encoded, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      let result;
      try { result = await response.json(); } catch { result = {}; }
      if (!response.ok) {
        const detail = result.error ?? result.message ?? result.detail;
        throw new ApiError(typeof detail === 'string' ? detail : response.status === 404 ? '房间不存在或已经结束，请检查房间码。' : response.status === 429 ? '操作有点快，请稍等再试。' : `请求暂未完成（${response.status}），请重试。`, response.status);
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('连接超时，正在尝试恢复连接。', 0);
      if (error instanceof ApiError) throw error;
      throw new ApiError('网络暂时断开，请检查连接。你的草稿会保留在本标签页。', 0);
    } finally { clearTimeout(timeout); }
  }
  function roomPath(suffix = '') { return `/api/game/rooms/${encodeURIComponent(state.code)}${suffix}`; }
  async function act(action, body = {}, button) {
    if (state.actionBusy.has(action)) return null;
    state.actionBusy.add(action); if (button) button.disabled = true;
    const generation = state.generation;
    try {
      const result = await request(roomPath(`/${action}`), 'POST', body);
      if (generation !== state.generation) return null;
      if (result.room) applyRoom(result.room); else schedulePoll(0);
      return result;
    } catch (error) {
      if (generation === state.generation) { notice(error.message, true); if (error.status === 409) schedulePoll(0); }
      return null;
    } finally {
      state.actionBusy.delete(action);
      if (button) button.disabled = false;
      if (state.room) updateControls();
    }
  }
  async function loadLibraries() {
    try {
      const result = await request('/api/libraries', 'GET', undefined, false);
      const rows = Array.isArray(result) ? result : result.libraries ?? result.items ?? [];
      state.libraries = rows.filter((item) => item && Number.isFinite(Number(item.id)));
      const select = $('setting-library');
      for (const item of state.libraries) { const option = node('option', '', item.name ?? item.title ?? `词库 ${item.id}`); option.value = String(item.id); select.append(option); }
      if (state.room && !state.settingsDirty) syncSettings(state.room, true);
    } catch { notice('词库列表暂时没加载出来，仍可使用默认随机词库。'); }
  }
  function renderAccount() {
    const account = state.account;
    $('account-button').hidden = !!account;
    $('account-name').hidden = !account;
    $('logout-button').hidden = !account;
    if (account) text('account-name', `已登录：${account.username}`);
    if (account && !$('player-name').value) $('player-name').value = account.username;
  }
  function openAuthDialog() {
    if (state.room) { notice('请先离开房间，再登录或注册账号。'); return; }
    text('auth-feedback', ''); show('auth-feedback', false);
    $('auth-username').value = state.account?.username || '';
    $('auth-password').value = '';
    $('auth-dialog').showModal();
    $('auth-username').focus();
  }
  function closeAuthDialog() { $('auth-dialog').close(); }
  async function submitAuth(mode) {
    const username = $('auth-username').value.trim();
    const password = $('auth-password').value;
    if (!username || !password) { text('auth-feedback', '请填写账号和密码。'); show('auth-feedback', true); return; }
    $('auth-login').disabled = true; $('auth-register').disabled = true; show('auth-feedback', false);
    try {
      const result = await request(`/api/auth/${mode}`, 'POST', { username, password }, false);
      if (!result.account) throw new ApiError('账号数据不完整，请重试。', 0);
      state.account = result.account; renderAccount(); closeAuthDialog();
      const pending = state.pendingEntry; state.pendingEntry = null;
      const active = result.active_room;
      const hash = location.hash.match(/^#room\/([A-Za-z0-9]{6})$/);
      if (pending && !state.room) {
        enterRoom(pending.mode, pending.code);
      } else if (active && !state.room && (!hash || hash[1].toUpperCase() === active.code)) {
        resumeAccountRoom(active.code);
        notice('已登录，正在回到上次的房间。');
      } else {
        notice(mode === 'register' ? '注册成功，账号已自动登录。' : '登录成功，Cookie 会自动保持登录。');
      }
    } catch (error) {
      text('auth-feedback', error.message); show('auth-feedback', true);
    } finally {
      $('auth-login').disabled = false; $('auth-register').disabled = false;
    }
  }
  async function logoutAccount() {
    if (state.room) { notice('请先离开房间，再退出账号。'); return; }
    try {
      await request('/api/auth/logout', 'POST', {}, false);
      state.account = null; renderAccount(); notice('已退出账号；房间席位会保留到你重新登录。');
    } catch (error) { notice(error.message, true); }
  }
  async function loadAccount() {
    try {
      const result = await request('/api/auth/me', 'GET', undefined, false);
      state.account = result.account || null;
      renderAccount();
      if (state.account && result.active_room && !state.room) {
        const hash = location.hash.match(/^#room\/([A-Za-z0-9]{6})$/);
        if (!hash || hash[1].toUpperCase() === result.active_room.code) {
          resumeAccountRoom(result.active_room.code);
          notice('已通过账号 Cookie 自动登录，正在回到上次的房间。');
        }
      }
    } catch { /* The game remains usable as a guest. */ }
  }
  function identity() {
    const name = $('player-name').value.trim();
    if (!name) { $('player-name').focus(); $('player-name').reportValidity(); return null; }
    storage.set('game:name', name); storage.set('game:avatar', String(state.avatar));
    return { name, avatar: state.avatar };
  }
  async function enterRoom(mode, code = '') {
    if (!state.account) {
      state.pendingEntry = { mode, code };
      openAuthDialog();
      notice('进入房间需要先登录或注册账号。');
      return;
    }
    const who = identity(); if (!who || state.actionBusy.has('enter')) return;
    state.actionBusy.add('enter'); ['create-button', 'join-button', 'practice-button'].forEach((id) => { $(id).disabled = true; });
    try {
      const path = mode === 'join' ? `/api/game/rooms/${encodeURIComponent(code)}/join` : '/api/game/rooms';
      const body = mode === 'practice' ? { ...who, practice: true } : who;
      const result = await request(path, 'POST', body, false);
      if (!result.token || !result.room?.code) throw new ApiError('房间返回的数据不完整，请稍后再试。', 0);
      state.token = String(result.token); state.code = String(result.room.code).toUpperCase();
      storage.set(`game:token:${state.code}`, state.token); storage.set('game:active', state.code);
      recovery.remember({ code: state.code, token: state.token, name: who.name });
      beginRoom(); applyRoom(result.room); schedulePoll(1000);
      notice(mode === 'practice' ? '已进入单人试玩，三位演示玩家会自动完成作画与猜词。' : mode === 'join' ? '已加入房间。' : '房间已创建，复制邀请链接邀请朋友。');
    } catch (error) {
      if (error.status === 401) {
        state.pendingEntry = { mode, code }; state.account = null; renderAccount();
        openAuthDialog();
      }
      notice(error.message, true);
    }
    finally { state.actionBusy.delete('enter'); ['create-button', 'join-button', 'practice-button'].forEach((id) => { $(id).disabled = false; }); }
  }
  function beginRoom() {
    state.generation++; clearTimeout(state.pollTimer); state.pollBusy = false; state.failures = 0; state.pollAgain = false;
    state.room = null; state.playersSignature = ''; state.settingsSignature = ''; state.settingsDirty = false;
    state.authoritative = false; state.cachedSignature = ''; state.pendingSubmission = null;
    state.workingKey = ''; state.revealKey = ''; state.revealSignature = ''; state.revealStepKey = ''; state.revealAnimToken += 1; state.lastPhase = ''; state.chatIds = new Set(); state.boardSignature = ''; state.selectedWord = ''; state.loadingGame = null; state.waitingSignature = ''; state.scoreSignature = ''; state.lastSoundSecond = ''; state.lastRevealStage = ''; state.favoriteAwardKey = ''; hideFlow(); stopRevealPlayback(); show('prompt-popover', false); show('pass-from', false); show('pass-to', false); $('waiting-players').replaceChildren();
    $('chat-messages').replaceChildren(); $('replay-media')?.replaceChildren(); show('home-view', false); show('room-view', true); show('leave-button', true);
    show('lobby-panel', false); show('workspace', false); show('reveal-panel', false); show('notice', false); clearInterval(state.tea.pollTimer); state.tea.pollTimer=null; state.tea.open=false; state.tea.strokes=[]; state.tea.lastId=0; state.tea.hidden=new Set(); state.tea.active=null; document.body.classList.remove('tea-open'); document.querySelector('.game-layout').hidden=false; show('tea-view', false);
    text('room-code-label', state.code); history.replaceState(null, '', `/game#room/${state.code}`); setConnection(false, true);
    announce(`已进入房间 ${state.code}`);
  }
  function returnHome(clearToken = false) {
    if (state.dirty) persistDraft();
    clearTimeout(state.pollTimer); clearTimeout(state.draftTimer); state.generation++; state.pollBusy = false;
    if (clearToken && state.code) {
      storage.remove(`game:token:${state.code}`);
      recovery.forget({ code: state.code, token: state.token });
    }
    state.pendingSubmission = null; state.authoritative = false;
    hideFlow(); stopRevealPlayback(); delete document.body.dataset.phase; clearInterval(state.tea.pollTimer); state.tea.pollTimer=null; state.tea.open=false; state.tea.strokes=[]; state.tea.lastId=0; state.tea.hidden=new Set(); state.tea.active=null; document.body.classList.remove('tea-open'); document.querySelector('.game-layout').hidden=false; show('tea-view', false);
    storage.remove('game:active'); state.room = null; state.token = ''; state.code = ''; state.workingKey = ''; state.dirty = false;
    state.engine?.setLocked(true); show('home-view', true); show('room-view', false); show('leave-button', false); show('leave-confirm', false); show('share-panel', false);
    history.replaceState(null, '', '/game'); announce('已返回首页');
  }
  function schedulePoll(delay = 1000) {
    clearTimeout(state.pollTimer);
    if (!state.code) return;
    if (state.pollBusy) { if (delay === 0) state.pollAgain = true; return; }
    state.pollTimer = setTimeout(poll, delay);
  }
  async function poll() {
    if (!state.code || state.pollBusy) return;
    state.pollBusy = true; const generation = state.generation;
    try {
      const version = state.authoritative ? state.room?.version : undefined;
      const result = await request(roomPath(Number.isInteger(version) ? `?since_version=${version}` : ''));
      if (generation !== state.generation) return;
      if (!result.room) throw new ApiError('房间数据暂未到达，正在重试。', 0);
      const wasDisconnected = state.failures > 0;
      state.failures = 0;
      applyRoom(result.unchanged && state.room ? { ...state.room, ...result.room } : result.room);
      if (wasDisconnected) { sound.reconnect(); notice('已恢复连接，席位和当前进度已同步。'); }
      if (state.pendingSubmission && GameRecovery.canRetry(state.room, state.pendingSubmission)) {
        state.submitting = false; state.pendingSubmission = null; updateControls();
        await submit(state.room.task.kind);
      }
      if (state.dirty && !state.submitting && !state.locked) queueDraft(300);
    } catch (error) {
      if (generation !== state.generation) return;
      const wasConnected = state.connected;
      state.failures++; setConnection(false, true);
      if (wasConnected && state.failures === 1) sound.alert();
      if ([401, 403, 404, 410].includes(error.status)) {
        const code = state.code; returnHome(true); $('room-code').value = code;
        notice(error.status === 401 || error.status === 403 ? '本标签页的房间凭证已失效，请重新加入。' : error.message, true, true); return;
      }
      if (state.failures === 1) notice(error.message, true);
    } finally {
      if (generation === state.generation) {
        state.pollBusy = false;
        const steady = state.room?.phase === 'reveal' ? 400 : 1000;
        const delay = state.pollAgain ? 0 : state.failures ? Math.min(15000, 1000 * 2 ** Math.min(4, state.failures)) : document.hidden ? 4000 : steady;
        state.pollAgain = false; schedulePoll(delay);
      }
    }
  }
  function applyRoom(room, cached = false) {
    if (!room || String(room.code).toUpperCase() !== state.code) return;
    if (state.room && Number(room.version) < Number(state.room.version)) return;
    state.clockOffset = Number(room.server_time) * 1000 - Date.now();
    if (!Number.isFinite(state.clockOffset)) state.clockOffset = 0;
    if (state.workingKey && state.workingKey !== GameRecovery.assignmentKey(room)) {
      state.engine.finish(); persistDraft();
    }
    if (!cached && state.room && room.phase === 'playing' && state.room.game_id !== room.game_id) {
      state.workingKey = '';
    }
    state.room = room;
    document.body.dataset.phase = room.phase;
    if (!cached) {
      state.authoritative = true; setConnection(true);
      const signature = `${room.game_id ?? 0}:${room.version}:${room.phase}`;
      if (signature !== state.cachedSignature) {
        recovery.cache({ code: state.code, token: state.token }, room);
        state.cachedSignature = signature;
      }
    }
    const assignment = GameRecovery.assignmentKey(room);
    if (room.pause && state.pendingSubmission) state.submitting = true;
    if (state.pendingSubmission && (state.pendingSubmission.key !== assignment || mine(room)?.submitted)) {
      recovery.remove(state.pendingSubmission.savedKey); state.pendingSubmission = null; state.submitting = false;
    }
    text('room-code-label', room.code); text('player-count', `${room.players.length}/${room.settings.max_players}`);
    renderPlayers(room); renderBoard(room); renderPhaseSequence(room); renderWaitingPlayers(room); renderChat(room.chat ?? []);
    if (state.tea.open && room.phase !== 'lobby') setTeaView(false);
    else if (state.tea.open && room.phase === 'lobby') renderTeaPlayers();
    const phaseChanged = state.lastPhase !== room.phase;
    if (phaseChanged) {
      if (room.phase !== 'reveal') stopRevealPlayback();
      if (room.phase !== 'playing') hideFlow();
      state.lastPhase = room.phase; $('room-view').className = `room-view phase-${room.phase}`;
      show('lobby-panel', room.phase === 'lobby'); show('workspace', room.phase === 'playing'); show('reveal-panel', room.phase === 'reveal');
      announce(room.phase === 'lobby' ? '准备阶段，等待玩家加入并准备' : room.phase === 'playing' ? '绘画与猜词进行中' : '接龙完成，进入回放');
    }
    show('timer', room.phase === 'playing' && !!room.deadline);
    if (room.phase === 'lobby') {
      abandonWorkspace(); hideFlow(); show('prompt-popover', false); show('source-chip', false); show('pass-from', false); show('pass-to', false); text('phase-title', '等待玩家');
      text('phase-description', room.players.some((p) => p.is_bot) ? '单人试玩 · 3 位演示玩家' : '等待所有玩家准备');
      syncSettings(room); text('players-foot-text', '至少 4 人即可开始');
    } else if (room.phase === 'playing') {
      text('phase-title', `第 ${room.round + 1} 棒 / 共 ${room.total_rounds} 棒`);
      text('phase-description', room.task?.kind === 'guess' ? '看图猜词 · 完成后交给下一位' : '同时作画 · 完成后交给下一位');
      text('players-foot-text', '大家同时进行，完成后一起接棒'); setupWorkspace(room); syncChoice(room); updateTimer();
    } else if (room.phase === 'reveal') {
      abandonWorkspace(); hideFlow(); text('phase-title', '接龙完成 · 回放阶段'); text('phase-description', '逐条自动回放，回放后投票与评选'); text('players-foot-text', '所有人自动同步观看'); renderReveal(room);
    }
    renderPause(room); updateControls();
  }
  function renderPause(room) {
    const pause = room.pause;
    const dialog = $('pause-dialog');
    if (!pause) { if (dialog.open) dialog.close(); state.pauseShown = null; return; }
    text('pause-player-names', room.players.filter((player) => pause.players.includes(player.id)).map((player) => player.name).join('、') + '正在重连');
    show('pause-host-actions', !!room.me.host);
    if (state.pauseShown !== pause.id) { state.pauseShown = pause.id; sound.alert(); if (!dialog.open) dialog.showModal(); }
    updateTimer();
  }
  function renderPlayers(room) {
    const completed = room.players.filter((p) => room.phase === 'lobby' ? p.ready : p.submitted).length;
    text('progress-label', room.phase === 'lobby' ? `${completed} 人准备` : room.phase === 'playing' ? `${completed}/${room.players.length} 已完成` : '一起揭晓');
    text('waiting-progress', `${completed} / ${room.players.length}`);
    const signature = JSON.stringify([room.phase, room.host_id, room.me?.id, room.players, room.settings.max_players]);
    if (signature === state.playersSignature) return;
    state.playersSignature = signature;
    const fragment = document.createDocumentFragment();
    const slots = room.phase === 'lobby' ? Math.max(room.players.length, room.settings.max_players) : room.players.length;
    for (let index = 0; index < slots; index++) {
      const player = room.players[index];
      if (!player) {
        const empty = node('div', 'player-row player-empty');
        empty.append(node('span', 'player-empty-plus', '＋'), node('span', 'player-empty-text', '空位'));
        fragment.append(empty); continue;
      }
      const own = String(player.id) === String(room.me?.id); const done = room.phase === 'lobby' ? player.ready : player.submitted;
      const row = node('div', `player-row${own ? ' is-me' : ''}${player.online === false ? ' offline' : ''}`);
      row.append(avatarNode(player.avatar));
      const detail = node('div', 'player-detail'); const name = node('div', 'player-name', player.name); name.title = player.name; detail.append(name);
      const badges = node('div', 'player-badges');
      if (own) badges.append(node('span', '', '你'));
      if (String(player.id) === String(room.host_id)) badges.append(node('span', '', '房主'));
      if (player.is_bot) badges.append(node('span', '', '演示'));
      if (player.online === false) badges.append(node('span', '', '暂离'));
      detail.append(badges); row.append(detail);
      const status = node('span', `player-status${done ? ' done' : ''}`, room.phase === 'reveal' ? '◇' : done ? '✓' : room.phase === 'playing' ? '●' : '·');
      status.title = room.phase === 'reveal' ? '观看揭晓' : done ? room.phase === 'lobby' ? '已准备' : '已完成' : room.phase === 'lobby' ? '未准备' : '创作中';
      status.setAttribute('aria-label', status.title); row.append(status); fragment.append(row);
    }
    $('player-list').replaceChildren(fragment);
  }
  function avatarImage(value) {
    const image = node('img');
    image.src = `/game-assets/avatars/avatar-${avatarIndex(value) + 1}.png`;
    image.alt = '';
    image.width = 96; image.height = 96; image.loading = 'lazy'; image.decoding = 'async';
    return image;
  }
  function setPromptOpen(open) {
    const visible = !!open;
    state.promptOpen = visible;
    $('prompt-toggle').setAttribute('aria-expanded', String(visible));
    show('choice-panel', visible);
    $('prompt-toggle').querySelector('.prompt-caret').textContent = visible ? '⌃' : '⌄';
  }
  const TOOL_POPOVERS = { pen: 'brush-popover', eraser: 'eraser-popover', 'line-eraser': 'line-eraser-popover', fill: 'fill-popover' };
  function closeToolPopovers() {
    for (const name of ['brush-popover', 'eraser-popover', 'line-eraser-popover', 'fill-popover', 'color-popover', 'layer-popover']) {
      const panel = $(name); if (panel) panel.hidden = true;
      const toggle = $(name + '-toggle'); if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
  }
  function toggleToolPopover(name) {
    const panel = $(name); if (!panel) return;
    const open = panel.hidden;
    closeToolPopovers();
    panel.hidden = !open;
    $(name + '-toggle')?.setAttribute('aria-expanded', String(open));
  }
  function selectedPrompt() { return state.selectedWord || chosenWord(); }
  function hideFlow() {
    clearTimeout(state.flowTimer); clearInterval(state.prepTimer);
    state.flowTimer = null; state.prepTimer = null;
    $('flow-overlay').hidden = true;
    state.selectionOpen = false; state.prepLocked = false;
  }
  function flowPlayerRow(room, selectedWord) {
    const fragment = document.createDocumentFragment();
    for (const player of room.players) {
      const own = String(player.id) === String(room.me?.id);
      const row = node('div', `flow-player${own && selectedWord ? ' done' : ''}`);
      row.append(avatarNode(player.avatar));
      row.append(node('span', '', own ? '你' : player.name));
      fragment.append(row);
    }
    return fragment;
  }
  function showFlow(options) {
    const overlay = $('flow-overlay');
    overlay.hidden = false;
    text('flow-title', options.title || '');
    text('flow-text', options.text || '');
    const icon = $('flow-icon');
    icon.hidden = !options.icon; icon.textContent = options.icon || '';
    const count = $('flow-count');
    count.hidden = options.count === undefined;
    if (options.count !== undefined) count.textContent = String(options.count);
    const choices = $('flow-choices');
    choices.replaceChildren();
    choices.hidden = !(options.words && options.words.length);
    if (options.words && options.words.length && options.room) {
      for (const word of options.words.slice(0, 4)) {
        const button = node('button', 'flow-choice', word);
        button.type = 'button';
        button.dataset.word = String(word);
        button.addEventListener('click', () => chooseWord(String(word), options.room));
        choices.append(button);
      }
    }
    const players = $('flow-players');
    players.replaceChildren();
    players.hidden = !options.room;
    if (options.room) players.append(flowPlayerRow(options.room, options.selectedWord || ''));
  }
  function openPromptSelection(room) {
    if (!room || room.phase !== 'playing' || room.round !== 0 || room.task?.kind !== 'draw' || mine(room)?.submitted) { hideFlow(); return; }
    if (room.task?.choice) { state.selectedWord = room.task.choice; state.choiceLocked = true; showPrep('draw'); return; }
    if (state.selectedWord) { showPrep('draw'); return; }
    state.selectionOpen = true; state.prepLocked = false;
    const remaining = room.task?.choice_deadline ? Math.max(0, Math.ceil(room.task.choice_deadline - (Date.now() + state.clockOffset) / 1000)) : 15;
    showFlow({ title: '请选择您想画的词：', text: '选好后不能更改，15 秒内未选择会自动分配。', words: room.task.choices || [], room, selectedWord: state.selectedWord, count: remaining });
    updateControls();
  }
  async function chooseWord(word, room) {
    if (state.choiceLocked || state.actionBusy.has('choose')) return;
    state.choiceLocked = true; state.selectedWord = word;
    text('prompt-preview', word); text('task-title', `题目：${word}`);
    const choices = $('flow-choices');
    choices.querySelectorAll('.flow-choice').forEach((button) => { const selected = button.dataset.word === word; button.classList.toggle('selected', selected); button.disabled = true; });
    const result = await act('choose', { word });
    if (!result) {
      state.choiceLocked = false; state.selectedWord = '';
      choices.querySelectorAll('.flow-choice').forEach((button) => { button.disabled = false; button.classList.remove('selected'); });
      return;
    }
    syncChoice(state.room);
  }
  function syncChoice(room) {
    if (!room || room.phase !== 'playing' || room.round !== 0 || room.task?.kind !== 'draw') {
      state.choiceLocked = false; show('choice-timer', false); return;
    }
    const chosen = room.task.choice || '';
    if (chosen) {
      state.choiceLocked = true; state.selectedWord = chosen;
      document.querySelectorAll('.word-choice').forEach((button) => {
        const selected = button.dataset.word === chosen;
        button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); button.disabled = true;
      });
      text('task-title', `题目：${chosen}`); text('prompt-preview', chosen);
      if (state.selectionOpen) {
        state.selectionOpen = false;
        text('flow-text', '已选择，准备作画…');
        $('flow-choices').querySelectorAll('.flow-choice').forEach((button) => { button.disabled = true; });
        clearTimeout(state.flowTimer);
        state.flowTimer = setTimeout(() => { if (state.room?.phase === 'playing') { hideFlow(); showPrep('draw'); } }, 600);
      }
    } else {
      state.choiceLocked = false;
    }
  }
  function showPrep(kind) {
    if (state.room?.phase !== 'playing' || mine()?.submitted) { hideFlow(); return; }
    state.selectionOpen = false; state.prepLocked = true;
    state.engine.setLocked(true); updateControls();
    let remaining = 3;
    showFlow({ title: kind === 'guess' ? '准备竞猜！' : '准备作画！', text: '请准备好', count: remaining, icon: '' });
    sound.prep(remaining);
    clearInterval(state.prepTimer);
    state.prepTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(state.prepTimer); state.prepTimer = null;
        hideFlow(); updateControls();
        sound.go(kind);
        if (kind === 'guess') $('guess-input').focus({ preventScroll: true });
        return;
      }
      text('flow-count', remaining);
      sound.prep(remaining);
    }, 800);
  }
  function scheduleFlow(room, draft) {
    if (!room || room.phase !== 'playing' || mine(room)?.submitted) { hideFlow(); return; }
    if (room.round === 0 && room.task?.kind === 'draw' && !state.selectedWord) {
      if (state.loadingGame !== room.game_id) {
        state.loadingGame = room.game_id;
        state.selectionOpen = false; state.prepLocked = true;
        showFlow({ title: '请稍候', text: '正在等待所有玩家加载……', icon: '⌛' });
        updateControls();
        clearTimeout(state.flowTimer);
        state.flowTimer = setTimeout(() => { if (state.room?.phase === 'playing') { state.prepLocked = false; openPromptSelection(state.room); } }, 1200);
      } else {
        openPromptSelection(room);
      }
      return;
    }
    showPrep(room.task?.kind === 'guess' ? 'guess' : 'draw');
  }
  function renderPass(room, task) {
    const me = mine(room);
    const fill = (holderId, player, label) => {
      const holder = $(holderId);
      holder.replaceChildren();
      if (!player) { holder.hidden = true; return; }
      holder.hidden = false;
      holder.append(avatarNode(player.avatar));
      const own = String(player.id) === String(me?.id);
      const info = node('div');
      info.append(node('small', '', own && label === '来自' ? '题目' : label));
      info.append(node('strong', '', own && label === '来自' ? '由你选择' : own ? '你' : player.name));
      holder.append(info);
    };
    fill('pass-from', task?.from, '来自');
    const meHolder = $('pass-me');
    meHolder.replaceChildren();
    if (me) {
      meHolder.hidden = false;
      meHolder.append(avatarNode(me.avatar));
      const info = node('div');
      info.append(node('small', '', '你'));
      info.append(node('strong', '', me.name));
      meHolder.append(info);
    } else meHolder.hidden = true;
    if (task && !task.to) {
      const holder = $('pass-to'); holder.replaceChildren(); holder.hidden = false;
      const info = node('div'); info.append(node('small', '', '传给')); info.append(node('strong', '', '接龙终点')); holder.append(info);
    } else {
      fill('pass-to', task?.to, '传给');
    }
  }
  function renderWaitingPlayers(room) {
    if (!mine(room)?.submitted) return;
    const signature = JSON.stringify([room.me.id, room.players.map((p) => [p.id, p.name, p.avatar, p.submitted, p.away])]);
    if (signature === state.waitingSignature) return;
    state.waitingSignature = signature;
    const container = $('waiting-players');
    container.replaceChildren();
    for (const player of room.players) {
      const card = node('div', `waiting-player${player.submitted ? ' done' : ''}${player.away ? ' away' : ''}`);
      card.append(avatarNode(player.avatar));
      const info = node('div');
      info.append(node('strong', '', player.name));
      info.append(node('span', '', player.away ? '已离线' : player.submitted ? '已完成' : '创作中'));
      card.append(info);
      container.append(card);
    }
  }
  function renderPhaseSequence(room) {
    let kinds = [], current = -1, container = '';
    if (room.phase === 'playing' && room.task) {
      kinds = Array.from({ length: room.total_rounds }, (_, index) => index % 2 ? 'guess' : 'draw');
      current = room.round; container = 'phase-sequence';
    } else if (room.phase === 'reveal' && room.reveal?.chains?.length) {
      const reveal = room.reveal, chain = reveal.chains[reveal.chain];
      const stage = reveal.stage || 'lineup';
      if (stage === 'lineup') {
        show('phase-sequence', false); show('reveal-sequence', false); return;
      }
      kinds = chain.entries.map((entry) => entry.kind === 'draw' ? 'draw' : 'guess');
      current = stage === 'replay' ? (reveal.step === 0 ? -1 : Math.min(kinds.length - 1, reveal.step - 1)) : kinds.length;
      container = 'reveal-sequence';
    } else {
      show('phase-sequence', false); show('reveal-sequence', false); return;
    }
    show('phase-sequence', container === 'phase-sequence');
    show('reveal-sequence', container === 'reveal-sequence');
    const signature = JSON.stringify([container, kinds, current]);
    if (signature === state.sequenceSignature) return;
    state.sequenceSignature = signature;
    const holder = $(container); holder.replaceChildren();
    const icons = node('div', 'seq-icons');
    let draws = 0, guesses = 0;
    kinds.forEach((kind, index) => {
      const icon = node('span', `seq-icon ${kind}${index < current ? ' used' : ''}${index === current ? ' current' : ''}`);
      icon.textContent = kind === 'draw' ? '✎' : '…';
      icon.title = kind === 'draw' ? '绘画' : '猜词';
      icons.append(icon);
      if (index >= Math.max(0, current)) { if (kind === 'draw') draws += 1; else guesses += 1; }
    });
    holder.append(icons, node('span', 'seq-counts', `画 ${draws} · 猜 ${guesses}`));
    holder.setAttribute('aria-label', `还剩 ${draws} 次绘画、${guesses} 次猜词`);
  }
  function renderBoard(room) {
    const me = mine(room);
    if (me) {
      $('board-avatar').replaceChildren(avatarImage(me.avatar));
      text('board-name', me.name);
    }
    const activeChain = room.phase === 'reveal' ? room.reveal?.chain : null;
    const signature = JSON.stringify([room.phase, room.me?.id, activeChain, room.reveal?.step,
      room.players.map((p) => [p.id, p.avatar, p.name, p.ready, p.submitted, p.away, p.online])]);
    if (signature === state.boardSignature) return;
    state.boardSignature = signature;
    const strip = $('board-players');
    strip.replaceChildren();
    for (const player of room.players.slice(0, 6)) {
      const badge = node('span', `board-player${player.away ? ' away' : ''}${player.submitted ? ' done' : ''}`);
      badge.append(avatarNode(player.avatar, 'board-player-avatar'));
      badge.append(node('span', 'board-player-state', player.away ? '×' : player.submitted ? '✓' : ''));
      badge.title = `${player.name} · ${player.away ? '已离线' : player.submitted ? '已提交' : '进行中'}`;
      strip.append(badge);
    }
    if (room.players.length > 6) strip.append(node('span', 'board-player board-player-more', `+${room.players.length - 6}`));
    if (room.phase === 'reveal' && room.reveal && $('reveal-players')) {
      const revealStrip = $('reveal-players');
      revealStrip.replaceChildren();
      room.reveal.chains.forEach((chain, index) => {
        const player = room.players.find((p) => String(p.id) === String(chain.owner_id));
        const badge = node('span', `board-player reveal-player${index === room.reveal.chain ? ' active' : ''}${index < room.reveal.chain ? ' done' : ''}`);
        badge.append(avatarNode(player?.avatar ?? 0, 'board-player-avatar'));
        badge.append(node('span', 'board-player-state', String(index + 1)));
        badge.title = `${chain.owner_name} 的接龙${index < room.reveal.chain ? '（已看完）' : ''}`;
        revealStrip.append(badge);
      });
    }
  }
  function closestDrawing(chain, before) {
    for (let i = Math.min(before, chain.entries.length) - 1; i >= 0; i--) {
      if (chain.entries[i].kind === 'draw') return chain.entries[i];
    }
    return null;
  }
  function closestGuess(chain, before) {
    for (let i = Math.min(before, chain.entries.length) - 1; i >= 0; i--) {
      if (chain.entries[i].kind === 'guess') return chain.entries[i];
    }
    return null;
  }
  function partialStroke(stroke, count) {
    const points = (stroke.points || []).slice(0, Math.max(1, count));
    if (!points.length) return null;
    const copy = { ...stroke, points };
    if (Array.isArray(stroke.pressures) && stroke.pressures.length === stroke.points.length) {
      copy.pressures = stroke.pressures.slice(0, points.length);
    }
    return copy;
  }
  function animateDrawing(canvas, drawing, duration = 4200) {
    const token = ++state.revealAnimToken;
    const parsed = safeDrawing(drawing);
    const layers = Array.from({ length: LAYERS }, () => { const layer = document.createElement('canvas'); layer.width = WIDTH; layer.height = HEIGHT; return layer; });
    const contexts = layers.map((layer) => layer.getContext('2d', { willReadFrequently: true }));
    const partial = document.createElement('canvas'); partial.width = WIDTH; partial.height = HEIGHT;
    const partialCtx = partial.getContext('2d', { willReadFrequently: true });
    const out = canvas.getContext('2d', { willReadFrequently: true });
    let partialVisible = false;
    const paint = () => {
      out.fillStyle = '#ffffff'; out.fillRect(0, 0, WIDTH, HEIGHT);
      for (const layer of layers) out.drawImage(layer, 0, 0);
      if (partialVisible) out.drawImage(partial, 0, 0);
    };
    paint();
    const strokes = parsed.strokes;
    if (!strokes.length) return;
    // Give every stroke its own visible slot, then trace its points over that slot.
    const perStroke = Math.max(30, Math.min(1400, (Number(duration) || 4200) / strokes.length));
    let index = 0;
    let strokeStart = performance.now();
    const frame = (now) => {
      if (token !== state.revealAnimToken) return;
      for (;;) {
        if (index >= strokes.length) { partialVisible = false; paint(); return; }
        const stroke = strokes[index];
        const progress = Math.min(1, (now - strokeStart) / perStroke);
        if (stroke.tool === 'eraser') {
          const part = partialStroke(stroke, Math.ceil(stroke.points.length * progress));
          if (part) renderStroke(contexts[stroke.layer], part);
          partialVisible = false;
          paint();
          if (progress >= 1) { index += 1; strokeStart = now; continue; }
          requestAnimationFrame(frame); return;
        }
        if (stroke.tool === 'fill') {
          if (progress >= 0.5) { renderStroke(contexts[stroke.layer], stroke); partialVisible = false; paint(); }
          if (progress >= 1) { index += 1; strokeStart = now; continue; }
          requestAnimationFrame(frame); return;
        }
        const count = Math.max(1, Math.ceil(stroke.points.length * progress));
        partialCtx.clearRect(0, 0, WIDTH, HEIGHT);
        const part = partialStroke(stroke, count);
        if (part) renderStroke(partialCtx, part);
        partialVisible = true;
        paint();
        if (progress >= 1) {
          renderStroke(contexts[stroke.layer], stroke);
          partialCtx.clearRect(0, 0, WIDTH, HEIGHT); partialVisible = false;
          index += 1; strokeStart = now; continue;
        }
        requestAnimationFrame(frame); return;
      }
    };
    requestAnimationFrame(frame);
  }
  function stopRevealPlayback() {
    clearTimeout(state.autoPlayTimer); state.autoPlayTimer = null; state.autoPlaying = false;
    clearTimeout(state.revealAnswerTimer); state.revealAnswerTimer = null;
  }
  function stageRemaining(deadline) {
    if (!deadline) return 0;
    return Math.max(0, Math.ceil(Number(deadline) - (Date.now() + state.clockOffset) / 1000));
  }
  function renderReplayDots(chain, step) {
    const dots = $('replay-dots'); if (!dots) return;
    dots.replaceChildren();
    for (let index = 0; index <= chain.entries.length; index++) {
      const dot = node('span', `replay-dot${index < step ? ' done' : index === step ? ' active' : ''}`);
      dot.title = index === 0 ? '原始题目' : `第 ${index} 棒`;
      dots.append(dot);
    }
  }
  function replayEntryLabel(chain, step) {
    if (step === 0) return `${chain.owner_name} 的原始题目`;
    const entry = chain.entries[step - 1];
    if (entry.kind === 'draw') return `第 ${step} 棒 · ${entry.player_name} 作画`;
    if (entry.kind === 'skip') return `第 ${step} 棒 · ${entry.player_name} 掉线，已跳过`;
    return `第 ${step} 棒 · ${entry.player_name} 的猜测`;
  }
  function replayActor(room, playerId, label, speech) {
    const player = room.players.find((item) => String(item.id) === String(playerId));
    const actor = node('div', 'replay-actor');
    if (speech !== undefined) {
      const bubble = node('div', 'replay-speech');
      bubble.append(node('small', 'replay-speech-label', label));
      bubble.append(node('strong', '', speech));
      actor.append(bubble);
    } else {
      actor.append(node('span', 'replay-actor-label', label));
    }
    actor.append(avatarNode(player?.avatar ?? 0, 'replay-actor-avatar'));
    return actor;
  }
  function renderLineup(room) {
    const reveal = room.reveal;
    const chain = reveal.chains[reveal.chain];
    const entries = reveal.chains.map((item, index) => {
      const player = room.players.find((candidate) => String(candidate.id) === String(item.owner_id));
      return { player: player || { id: item.owner_id, name: item.owner_name, avatar: 0 }, chain: item, index };
    });
    const signature = JSON.stringify([room.game_id, reveal.chain, entries.map((item) => [item.player.id, item.player.avatar, item.player.name, item.chain.prompt])]);
    if (signature !== state.lineupSignature) {
      state.lineupSignature = signature;
      const row = $('lineup-players');
      row.querySelectorAll('.lineup-player').forEach((element) => element.remove());
      row.classList.toggle('many', entries.length > 7);
      let highlight = row.querySelector('.lineup-highlight');
      if (!highlight) { highlight = node('div', 'lineup-highlight'); row.prepend(highlight); }
      for (const item of entries) {
        const active = item.index === reveal.chain;
        const card = node('div', `lineup-player${active ? ' active' : ''}${item.index < reveal.chain ? ' done' : ''}`);
        card.append(node('div', 'lineup-player-prompt', active ? (chain.prompt || '题目待定') : ''));
        card.append(avatarNode(item.player.avatar, 'lineup-avatar'));
        card.append(node('strong', 'lineup-name', item.player.name));
        card.append(node('small', 'lineup-id', `#${item.player.id}`));
        row.append(card);
      }
      requestAnimationFrame(() => {
        const active = row.querySelector('.lineup-player.active');
        if (!active) return;
        highlight.style.left = `${active.offsetLeft - 4}px`;
        highlight.style.top = `${active.offsetTop - 4}px`;
        highlight.style.width = `${active.offsetWidth + 8}px`;
        highlight.style.height = `${active.offsetHeight + 8}px`;
        active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      });
    }
    text('lineup-status', `${chain.owner_name} 的题目：${chain.prompt || '待定'} · ${stageRemaining(reveal.deadline)} 秒后进入`);
  }
  function renderReplay(room) {
    const reveal = room.reveal, chain = reveal.chains[reveal.chain];
    const step = Math.max(0, Math.min(chain.entries.length, Number(reveal.step) || 0));
    const signature = `${room.game_id}:${reveal.chain}:${step}`;
    if (signature !== state.revealSignature) {
      clearTimeout(state.replayDrawTimer); state.replayDrawTimer = null;
      clearTimeout(state.revealAnswerTimer); state.revealAnswerTimer = null;
      state.revealSignature = signature; state.revealStepKey = `${reveal.chain}:${step}`;
      const media = $('replay-media'); media.replaceChildren();
      const frame = node('div', 'replay-frame');
      if (step === 0) {
        const header = node('div', 'replay-header');
        header.append(avatarNode(room.players.find((p) => String(p.id) === String(chain.owner_id))?.avatar ?? 0, 'replay-artist-avatar'));
        header.append(node('strong', 'replay-artist-name', chain.owner_name));
        header.append(node('span', 'replay-chip', chain.prompt || '（原始题目）'));
        frame.append(header);
        const prompt = node('div', 'reveal-prompt');
        prompt.append(node('span', 'reveal-prompt-label', '原始题目'), node('strong', '', chain.prompt || '（原始题目）'));
        frame.append(prompt);
      } else {
        const entry = chain.entries[step - 1];
        const drawing = entry.kind === 'draw' ? entry : closestDrawing(chain, step - 1);
        const artist = room.players.find((p) => String(p.id) === String(drawing?.player_id ?? chain.owner_id)) || { avatar: 0, name: chain.owner_name };
        const header = node('div', 'replay-header');
        header.append(avatarNode(artist.avatar, 'replay-artist-avatar'));
        header.append(node('strong', 'replay-artist-name', artist.name || chain.owner_name));
        header.append(node('span', 'replay-chip', chain.prompt || '（原始题目）'));
        frame.append(header);
        if (entry.kind === 'draw') {
          const canvas = node('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
          canvas.setAttribute('aria-label', `${entry.player_name} 的画作`);
          frame.append(canvas);
          state.replayDrawTimer = setTimeout(() => {
            if (state.revealSignature !== signature) return;
            const remaining = Math.max(1200, (Number(reveal.deadline) - (Date.now() + state.clockOffset) / 1000) * 1000);
            animateDrawing(canvas, entry.drawing, Math.min(7500, Math.max(2200, remaining - 100)));
          }, 500);
        } else {
          if (drawing) {
            const canvas = node('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
            canvas.setAttribute('aria-label', `${drawing.player_name} 的画作`);
            renderDrawing(canvas, drawing.drawing); frame.append(canvas);
          } else {
            frame.append(node('div', 'reveal-prompt', chain.prompt || '（原始题目）'));
          }
          clearTimeout(state.revealAnswerTimer);
          if (entry.kind === 'skip') {
            frame.append(replayActor(room, entry.player_id, `${entry.player_name} 猜`, '掉线，已跳过'));
          } else {
            const actor = replayActor(room, entry.player_id, `${entry.player_name} 猜`);
            frame.append(actor);
            sound.revealWait();
            state.revealAnswerTimer = setTimeout(() => {
              if (state.revealSignature !== signature) return;
              actor.replaceWith(replayActor(room, entry.player_id, `${entry.player_name} 猜`, entry.text));
              sound.reveal();
            }, 2000);
          }
        }
      }
      media.append(frame);
      renderReplayDots(chain, step);
    }
    text('replay-step-label', `${step} / ${chain.entries.length}`);
    text('replay-caption', replayEntryLabel(chain, step));
    text('replay-status', `自动播放中 · ${stageRemaining(reveal.deadline)} 秒后继续`);
  }
  function finalGuess(chain) {
    for (let i = chain.entries.length - 1; i >= 0; i--) {
      if (chain.entries[i].kind === 'guess') return chain.entries[i].text || '（未猜出）';
    }
    return '（未猜出）';
  }
  function renderMatch(room, stage = 'match') {
    const reveal = room.reveal;
    const chain = reveal.chains[reveal.chain];
    const signature = JSON.stringify([stage, chain.prompt, finalGuess(chain), chain.votes, chain.vote_map, chain.my_vote, room.players.map((p) => [p.id, p.avatar, p.name])]);
    text('match-prompt', chain.prompt || '（原始题目）');
    text('match-final', finalGuess(chain));
    const sameVotes = chain.votes?.same ?? 0, changedVotes = chain.votes?.changed ?? 0, totalVotes = sameVotes + changedVotes;
    const percent = totalVotes ? Math.round(sameVotes / totalVotes * 100) : 0;
    const passed = totalVotes > 0 && sameVotes * 4 >= totalVotes * 3;
    text('match-counts', totalVotes ? `匹配 ${sameVotes} · 跑偏 ${changedVotes} · ${percent}% ${passed ? '· 已通过 75% 线' : '· 未通过 75% 线'}` : '匹配 0 · 跑偏 0 · 通过需 ≥75%');
    const result = $('match-result');
    show('match-result', stage === 'match_result');
    if (stage === 'match_result') {
      result.textContent = totalVotes ? (passed ? '匹配成功' : '未通过匹配') : '没有有效投票';
      result.classList.toggle('yes', passed);
      result.classList.toggle('no', !passed);
    }
    show('match-yes', stage === 'match'); show('match-no', stage === 'match');
    if (signature === state.matchSignature) return;
    state.matchSignature = signature;
    const votes = new Map((chain.vote_map || []).map((item) => [String(item.player_id), item.vote]));
    const voters = $('match-voters');
    voters.replaceChildren();
    const marks = $('match-marks');
    marks.replaceChildren();
    for (const player of room.players) {
      const vote = votes.get(String(player.id));
      const voter = node('div', `match-voter${vote === 'same' ? ' yes' : vote === 'changed' ? ' no' : ''}`);
      voter.append(avatarNode(player.avatar));
      voter.append(node('span', 'match-voter-name', player.name));
      voter.append(node('span', 'match-voter-mark', vote === 'same' ? '✓' : vote === 'changed' ? '✗' : '·'));
      voter.title = `${player.name}${vote === 'same' ? '：匹配' : vote === 'changed' ? '：跑偏' : '：未投票'}`;
      voters.append(voter);
      marks.append(node('span', `match-mark${vote === 'same' ? ' yes' : vote === 'changed' ? ' no' : ''}`, vote === 'same' ? '✓' : vote === 'changed' ? '✗' : '·'));
    }
    $('match-yes').setAttribute('aria-pressed', String(chain.my_vote === 'same'));
    $('match-no').setAttribute('aria-pressed', String(chain.my_vote === 'changed'));
  }
  function guessAfter(chain, entry) {
    const index = chain.entries.indexOf(entry);
    const next = index >= 0 ? chain.entries[index + 1] : null;
    return next?.kind === 'guess' ? next.text || '（未猜出）' : '（未猜出）';
  }
  function renderFavorites(room) {
    const reveal = room.reveal;
    const chain = reveal.chains[reveal.chain];
    const isOwner = String(chain.owner_id) === String(room.me?.id);
    const drawings = chain.entries.filter((entry) => entry.kind === 'draw' && String(entry.player_id) !== String(chain.owner_id));
    text('favorite-title', chain.award ? `${chain.owner_name} 最爱的画作：` : `${chain.owner_name} 正在品鉴画作，选择TA的最爱…`);
    text('favorite-hint', chain.award ? '' : isOwner ? `你的题目：${chain.prompt} · 点一幅画选出最爱` : `等待 ${chain.owner_name} 选出最爱…`);
    show('favorite-hint', !chain.award);
    text('favorite-status', chain.award ? (reveal.chain >= reveal.chains.length - 1 ? '已选出，即将显示最终得分…' : '已选出，即将进入下一条接龙…') : isOwner ? `点击一幅画作即可选择 · ${stageRemaining(reveal.deadline)} 秒` : `${stageRemaining(reveal.deadline)} 秒后自动继续`);
    const signature = JSON.stringify([reveal.chain, chain.prompt, drawings.map((entry) => [entry.player_id, entry.player_name, entry.drawing?.strokes?.length]), chain.award]);
    if (signature !== state.favoriteSignature) {
      state.favoriteSignature = signature;
      const grid = $('favorite-grid');
      grid.replaceChildren();
      if (!drawings.length) grid.append(node('p', 'small-muted', '本链还没有其他人的画作。'));
      for (const entry of drawings) {
        const selected = String(chain.award) === String(entry.player_id);
        const card = node(isOwner && !chain.award ? 'button' : 'article', `favorite-card${selected ? ' selected leader' : ''}`);
        if (card.tagName === 'BUTTON') card.type = 'button';
        card.append(node('span', 'favorite-card-name', entry.player_name));
        const canvas = node('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
        canvas.setAttribute('aria-label', `${entry.player_name} 的画作`);
        renderDrawing(canvas, entry.drawing); card.append(canvas);
        card.append(node('p', 'favorite-card-guess', guessAfter(chain, entry)));
        if (selected) card.append(node('span', 'favorite-count', '✓'));
        if (card.tagName === 'BUTTON') card.addEventListener('click', () => {
          if (state.actionBusy.has('reveal')) return;
          act('reveal', { vote: 'favorite', chain: reveal.chain, artist: entry.player_id });
        });
        grid.append(card);
      }
    }
    const awardKey = `${reveal.chain}:${chain.award}`;
    if (chain.award && state.favoriteAwardKey !== awardKey) { state.favoriteAwardKey = awardKey; sound.success(); }
    text('favorite-result', chain.award ? `${chain.owner_name} 最爱的画作：${chain.award_name}（+1 分）` : isOwner ? '请选择一幅其他人的画作。' : '等待题主选择。');
  }
  function renderScores(room) {
    const reveal = room.reveal;
    const scores = reveal.scores || {};
    const signature = JSON.stringify([scores, reveal.chains.map((chain) => [chain.success, chain.award]), room.players.map((p) => [p.id, p.name, p.avatar])]);
    if (signature !== state.scoreSignature) {
      state.scoreSignature = signature;
      const list = $('score-list');
      list.replaceChildren();
      const rows = room.players.map((player) => {
        let success = 0, awards = 0;
        for (const chain of reveal.chains) {
          if (chain.success && String(chain.owner_id) === String(player.id)) success += 1;
          if (chain.award && String(chain.award) === String(player.id)) awards += 1;
        }
        return { player, score: scores[String(player.id)] || 0, success, awards };
      }).sort((a, b) => b.score - a.score || a.player.id - b.player.id);
      const best = rows[0]?.score || 0;
      for (const row of rows) {
        const card = node('div', `score-card${best > 0 && row.score === best ? ' winner' : ''}`);
        card.append(avatarNode(row.player.avatar));
        const info = node('div');
        info.append(node('div', 'score-name', row.player.name));
        info.append(node('div', 'score-detail', `成功传递 +${row.success} · 最佳作品 +${row.awards}`));
        card.append(info);
        const points = node('div', 'score-points', String(row.score)); points.append(node('small', '', ' 分')); card.append(points);
        list.append(card);
      }
      const successCount = reveal.chains.filter((chain) => chain.success).length;
      const awardCount = reveal.chains.filter((chain) => chain.award).length;
      text('score-summary', `共 ${reveal.chains.length} 条接龙，成功传递 ${successCount} 条，评出 ${awardCount} 幅最佳作品。`);
    }
  }
  function renderReveal(room) {
    const reveal = room.reveal;
    if (!reveal?.chains?.length) return;
    const stage = ['lineup', 'replay', 'match', 'match_result', 'favorite', 'scores'].includes(reveal.stage) ? reveal.stage : 'lineup';
    const chain = reveal.chains[reveal.chain];
    if (stage !== 'replay') { clearTimeout(state.revealAnswerTimer); state.revealAnswerTimer = null; clearTimeout(state.replayDrawTimer); state.replayDrawTimer = null; }
    if (state.lastRevealStage !== stage) {
      state.lastRevealStage = stage;
      if (stage === 'lineup') sound.tick();
      else if (stage === 'match') sound.reveal();
      else if (stage === 'favorite') sound.tick();
      else if (stage === 'scores') sound.fanfare();
      if (stage === 'replay') { state.revealSignature = ''; state.revealStepKey = ''; }
    }
    show('lineup-panel', stage === 'lineup');
    show('replay-panel', stage === 'replay');
    show('match-panel', stage === 'match' || stage === 'match_result');
    show('favorite-panel', stage === 'favorite');
    show('score-panel', stage === 'scores');
    if (stage === 'lineup') {
      text('reveal-stage-label', '接龙队列');
      text('reveal-heading', `第 ${reveal.chain + 1} 条接龙`);
      text('reveal-position', '看完全部玩家后，进入题主的接龙');
      renderLineup(room);
    } else if (stage === 'replay') {
      text('reveal-stage-label', '过程回放');
      text('reveal-heading', `${chain.owner_name} 的接龙`);
      text('reveal-position', `故事 ${reveal.chain + 1} / ${reveal.chains.length} · 自动播放，所有人同步观看`);
      renderReplay(room);
    } else if (stage === 'match' || stage === 'match_result') {
      text('reveal-stage-label', stage === 'match_result' ? '投票结果' : '匹配投票');
      text('reveal-heading', `${chain.owner_name} 的接龙`);
      text('reveal-position', stage === 'match_result' ? '本轮匹配结果' : '这条接龙最后的答案，还接近最初的题目吗？');
      renderMatch(room, stage);
    } else if (stage === 'favorite') {
      text('reveal-stage-label', '题主评选');
      text('reveal-heading', `${chain.owner_name} 的接龙`);
      text('reveal-position', '选出这条接龙中其他人的最佳画作');
      renderFavorites(room);
    } else {
      text('reveal-stage-label', '最终得分');
      text('reveal-heading', '全部接龙已回放');
      text('reveal-position', '所有接龙回放完毕');
      renderScores(room);
    }
    updateRevealStatus(room);
  }
  function updateRevealStatus(room) {
    const reveal = room?.reveal;
    if (!reveal) return;
    const chain = reveal.chains[reveal.chain];
    if (reveal.stage === 'replay') {
      text('replay-status', `自动播放中 · ${stageRemaining(reveal.deadline)} 秒后继续`);
    } else if (reveal.stage === 'match') {
      const votes = new Set((chain.vote_map || []).map((item) => String(item.player_id)));
      const humans = room.players.filter((player) => !player.is_bot && player.online);
      const voted = humans.filter((player) => votes.has(String(player.id))).length;
      text('match-status', voted >= humans.length ? '所有人都投完了，正在进入题主评选…' : `已投 ${voted} / ${humans.length} · ${stageRemaining(reveal.deadline)} 秒后自动继续`);
    } else if (reveal.stage === 'match_result') {
      text('match-status', `结果展示中 · ${stageRemaining(reveal.deadline)} 秒后进入题主评选`);
    } else if (reveal.stage === 'favorite') {
      const isOwner = String(chain.owner_id) === String(room.me?.id);
      text('favorite-status', chain.award ? (reveal.chain >= reveal.chains.length - 1 ? '已选出，即将显示最终得分…' : '已选出，即将进入下一条接龙…') : isOwner ? `点击一幅画作即可选择 · ${stageRemaining(reveal.deadline)} 秒` : `${stageRemaining(reveal.deadline)} 秒后自动继续`);
    }
  }
  function renderChat(messages) {
    const list = $('chat-messages'); const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 55;
    let added = false;
    for (const message of messages) {
      const key = String(message.id); if (state.chatIds.has(key)) continue;
      state.chatIds.add(key); added = true;
      const entry = node('div', `chat-message${message.system ? ' system' : ''}`); entry.dataset.messageId = key;
      if (message.system) entry.textContent = message.text;
      else { entry.append(node('b', '', message.name), node('p', '', message.text)); }
      list.append(entry);
    }
    // Keep the log bounded without replacing it or resetting the reader's scroll position.
    if (list.childElementCount > 250) {
      const previousHeight = list.scrollHeight;
      while (list.childElementCount > 200) { state.chatIds.delete(list.firstElementChild.dataset.messageId); list.firstElementChild.remove(); }
      if (!atBottom) list.scrollTop -= previousHeight - list.scrollHeight;
    }
    if (added && atBottom) { list.scrollTop = list.scrollHeight; show('chat-new', false); }
    else if (added) show('chat-new', true);
  }
  function ensureOption(select, value, label) {
    if (!Array.from(select.options).some((option) => option.value === String(value))) { const option = node('option', '', label); option.value = String(value); select.append(option); }
  }
  function syncSettings(room, force = false) {
    const signature = JSON.stringify(room.settings);
    if (!force && (state.settingsDirty || state.settingsSignature === signature)) return;
    state.settingsSignature = signature;
    for (const [id, key] of [['setting-max', 'max_players'], ['setting-draw', 'draw_seconds'], ['setting-guess', 'guess_seconds']]) {
      const value = room.settings[key]; ensureOption($(id), value, `${value}${key === 'max_players' ? ' 人' : ' 秒'}`); $(id).value = String(value);
    }
    const library = room.settings.library_id ?? ''; ensureOption($('setting-library'), library, library === '' ? '请选择题库' : `词库 ${library}`); $('setting-library').value = String(library);
    text('settings-summary', `${room.settings.max_players} 人 · 画 ${room.settings.draw_seconds} 秒 · 猜 ${room.settings.guess_seconds} 秒 · ${library === '' ? '请选择题库' : `词库 ${library}`}`);
  }
  function updateControls() {
    const room = state.room; if (!room) return;
    const host = isHost(), me = mine(), busy = (name) => state.actionBusy.has(name);
    if (room.phase === 'lobby') {
      ['setting-max', 'setting-draw', 'setting-guess', 'setting-library'].forEach((id) => { $(id).disabled = !host || busy('settings'); });
      show('settings-save', host); $('settings-save').disabled = busy('settings') || !state.settingsDirty;
      text('settings-hint', host ? state.settingsDirty ? '设置已修改，记得保存' : '你是房主，可以调整本局设置' : '房主正在设置本局');
      text('ready-button', me?.ready ? '✓ 已准备 · 取消准备' : '我准备好了'); $('ready-button').disabled = busy('ready');
      const enough = room.players.length >= 4;
      const missing = room.players.filter((p) => !p.ready && !p.is_bot);
      const allReady = room.players.every((p) => p.ready || p.is_bot);
      text('start-hint', !enough ? `还差 ${4 - room.players.length} 位玩家` : state.settingsDirty ? '请先保存房间设置' : !allReady ? `等待 ${missing.map((p) => p.name).join('、')} 准备` : '所有人已准备，5 秒倒计时后自动开始');
      text('lobby-intro', room.players.some((p) => p.is_bot) ? '3 位演示玩家已经就位，准备好后自动开始。' : '邀请朋友，所有人准备后自动开始。');
    }
    if (room.phase === 'playing') {
      const locked = !!me?.submitted || state.submitting || !!room.pause || !room.task || state.selectionOpen || state.prepLocked;
      state.locked = locked; state.engine.setLocked(locked);
      const drawing = room.task?.kind === 'draw';
      ['brush-size', 'custom-color', 'clear-button', 'redo-button'].forEach((id) => { $(id).disabled = locked; });
      document.querySelectorAll('[data-tool], [data-size], .color-swatch, .word-choice').forEach((button) => { button.disabled = locked; });
      $('guess-input').disabled = locked; $('submit-guess').disabled = locked || !$('guess-input').value.trim();
      $('submit-draw').disabled = locked || !drawing || (room.round === 0 && !selectedPrompt());
      text('submit-draw', state.submitting ? '正在提交…' : me?.submitted ? '✓ 已提交' : '提交画作');
      text('submit-guess', state.submitting ? '正在提交…' : me?.submitted ? '✓ 已提交' : '提交');
      text('task-state', me?.submitted ? '已提交' : state.submitting ? state.connected ? '正在提交' : '等待联网' : '进行中');
      $('task-state').classList.toggle('submitted', !!me?.submitted);
      show('waiting-panel', !!me?.submitted);
      text('waiting-text', '已提交，等待其他玩家完成本棒。');
    }
    if (room.phase === 'reveal' && room.reveal) {
      const reveal = room.reveal;
      const stage = ['lineup', 'replay', 'match', 'match_result', 'favorite', 'scores'].includes(reveal.stage) ? reveal.stage : 'lineup';
      const canVote = stage === 'match' && !busy('reveal');
      $('match-yes').disabled = !canVote; $('match-no').disabled = !canVote;
      const scoresReady = stage === 'scores';
      show('scores-replay', host && scoresReady); $('scores-replay').disabled = !host || busy('replay');
      show('reveal-leave', !scoresReady);
      show('replay-button', false);
    }
  }
  function chosenWord() { return $('word-choices').querySelector('[aria-pressed="true"]')?.dataset.word ?? ''; }
  function draftKey() { const seat = state.token || (state.account ? `account-${state.account.id}` : 'guest'); return state.room && state.workingKey ? `game:draft:${state.code}:${seat}:${state.workingKey}` : ''; }
  function abandonWorkspace() {
    if (!state.workingKey) return;
    state.engine.setLocked(true); clearTimeout(state.draftTimer); state.dirty = false; state.submitting = false; state.workingKey = ''; state.revision = 0;
  }
  function setupWorkspace(room) {
    const task = room.task;
    if (!task) { state.engine.setLocked(true); show('draw-workspace', false); show('guess-workspace', false); show('prompt-popover', false); show('source-chip', false); return; }
    const key = GameRecovery.assignmentKey(room);
    if (state.workingKey === key) return;
    closeToolPopovers();
    state.engine.setLocked(true); clearTimeout(state.draftTimer); show('clear-confirm', false); closeToolPopovers();
    if ($('submit-confirm').open) $('submit-confirm').close();
    state.workingKey = key; state.submitting = false; state.dirty = false; state.revision = 0; state.lastCountdownAnnouncement = ''; state.lastSoundSecond = '';
    let local;
    try { local = recovery.draft(draftKey()) ?? JSON.parse(storage.get(draftKey()) || 'null'); } catch { local = null; }
    const draft = local?.payload ?? task.draft ?? {};
    state.selectedWord = room.round === 0 && task.kind === 'draw' ? (task.choice || draft.text || '') : '';
    state.choiceLocked = !!task.choice;
    if (local?.pending && !mine(room)?.submitted) {
      state.pendingSubmission = { key, savedKey: draftKey() }; state.submitting = true;
    }
    const drawing = task.kind === 'draw';
    show('draw-workspace', drawing); show('guess-workspace', !drawing);
    show('prompt-popover', drawing);
    const sourceText = drawing && room.round > 0 ? (task.source?.text || '') : '';
    show('source-chip', !!sourceText);
    if (sourceText) text('source-chip', sourceText);
    text('task-kicker', `第 ${room.round + 1} 棒 · ${drawing ? '绘画' : '猜词'}`);
    if (drawing) {
      state.engine.load(draft.drawing); $('word-choices').replaceChildren();
      const firstRound = room.round === 0;
      show('word-choices', firstRound); show('choice-help', firstRound); show('task-title', !firstRound);
      const promptText = firstRound ? (state.selectedWord ? `题目：${state.selectedWord}` : '选择一个题目') : (task.source?.text || '等待文字内容');
      text('task-title', promptText);
      text('prompt-preview', promptText);
      if (firstRound) {
        const choices = Array.isArray(task.choices) && task.choices.length ? task.choices.slice(0, 3) : task.source?.text ? [task.source.text] : [];
        for (const word of choices) {
          const button = node('button', 'word-choice', word); button.type = 'button'; button.dataset.word = String(word);
          const selected = state.selectedWord === word; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
          button.disabled = state.choiceLocked;
          button.addEventListener('click', () => { if (!state.locked && !state.choiceLocked) chooseWord(word, room); });
          $('word-choices').append(button);
        }
        if (!choices.length) text('choice-help', '题目暂未分配，正在等待服务器。');
        else text('choice-help', state.choiceLocked ? '题目已锁定，不能更改' : '选择一个词作为本棒题目（15 秒内有效）');
        setPromptOpen(false);
      } else {
        setPromptOpen(false);
      }
      text('draft-status', local ? '已恢复本机草稿' : task.draft ? '已恢复服务器草稿' : '落笔后自动保存');
    } else {
      show('source-chip', false);
      text('task-title', '看上一位的画，猜猜是什么');
      renderDrawing($('source-canvas'), task.source?.drawing);
      show('source-empty', !safeDrawing(task.source?.drawing).strokes.length);
      $('guess-input').value = draft.text ?? '';
      text('guess-draft-status', local ? '已恢复本机答案' : task.draft ? '已恢复服务器草稿' : '输入内容会自动保存，按 Enter 提交给下一位。');
      if (!mine(room)?.submitted && !state.submitting) setTimeout(() => $('guess-input').focus({ preventScroll: true }), 120);
    }
    if (local?.payload && !mine(room)?.submitted) { state.dirty = true; state.revision++; queueDraft(800); }
    renderPass(room, task);
    scheduleFlow(room, draft);
    announce(`第 ${room.round + 1} 棒，${drawing ? '绘画' : '看画猜词'}`);
  }
  function currentPayload() {
    if (!state.room?.task) return null;
    const kind = state.room.task.kind;
    const payload = { game_id: state.room.game_id ?? 0, round: state.room.round, kind };
    if (kind === 'draw') { payload.drawing = state.engine.drawing; if (state.room.round === 0) payload.text = selectedPrompt(); }
    else payload.text = $('guess-input').value.trim();
    return payload;
  }
  function persistDraft() {
    const key = draftKey(), payload = currentPayload();
    if (key && payload) {
      const pending = !!state.pendingSubmission;
      storage.set(key, JSON.stringify({ payload, pending, savedAt: Date.now() }));
      if (!recovery.saveDraft(key, payload, pending)) notice('浏览器本地存储不可用，草稿仍保留在当前页面，请不要关闭。', true);
    }
  }
  function markDirty() {
    if (!state.room || state.room.phase !== 'playing' || state.locked || state.submitting || mine()?.submitted) return;
    state.dirty = true; state.revision++; persistDraft();
    text(state.room.task.kind === 'draw' ? 'draft-status' : 'guess-draft-status', state.connected ? '有新笔画 · 正在保存…' : '离线创作 · 草稿已保存在本机'); queueDraft(850);
  }
  function queueDraft(delay = 850) { clearTimeout(state.draftTimer); if (state.dirty) state.draftTimer = setTimeout(saveDraft, delay); }
  async function saveDraft() {
    if (!state.dirty || state.locked || state.submitting || state.room?.phase !== 'playing') return;
    if (state.engine.active) { queueDraft(600); return; }
    if (state.draftPromise) { queueDraft(500); return; }
    const payload = currentPayload(); if (!payload || (payload.kind === 'draw' && state.room.round === 0 && !payload.text)) return;
    persistDraft();
    const generation = state.generation, key = state.workingKey, revision = state.revision, label = payload.kind === 'draw' ? 'draft-status' : 'guess-draft-status';
    text(label, '正在自动保存…');
    state.draftPromise = request(roomPath('/draft'), 'POST', payload);
    try {
      await state.draftPromise;
      if (generation !== state.generation || key !== state.workingKey) return;
      if (revision === state.revision) { state.dirty = false; text(label, '✓ 草稿已保存'); }
      else queueDraft(850);
    } catch (error) {
      if (generation !== state.generation || key !== state.workingKey) return;
      text(label, error.status === 409 ? '本轮已结束，正在接下一棒…' : '草稿已保留在本机 · 联网后重试');
      if (error.status === 409) schedulePoll(0);
      else queueDraft(Math.min(15000, 3000 * (state.failures + 1)));
    } finally { state.draftPromise = null; }
  }
  async function submit(kind) {
    if (state.locked || state.submitting || !state.room?.task || state.room.task.kind !== kind) return;
    state.engine.finish();
    const payload = currentPayload();
    if ((kind === 'guess' && !payload.text) || (kind === 'draw' && state.room.round === 0 && !selectedPrompt())) { notice(kind === 'guess' ? '请先输入猜测。' : '请先选择一个题目。'); return; }
    state.pendingSubmission = { key: state.workingKey, savedKey: draftKey() };
    persistDraft(); state.submitting = true; clearTimeout(state.draftTimer); updateControls();
    if (!state.authoritative || !state.connected || navigator.onLine === false) {
      setConnection(false, true); schedulePoll(0); return;
    }
    const generation = state.generation, key = state.workingKey, savedKey = draftKey();
    try {
      if (state.draftPromise) { try { await state.draftPromise; } catch { /* Submission has its own complete payload. */ } }
      if (generation !== state.generation || key !== state.workingKey) return;
      const result = await request(roomPath('/submit'), 'POST', payload);
      if (generation !== state.generation) return;
      sound.submit();
      storage.remove(savedKey); recovery.remove(savedKey); state.pendingSubmission = null; hideFlow();
      if (key === state.workingKey) { state.dirty = false; state.submitting = false; if (mine()) mine().submitted = true; }
      if (result.room) applyRoom(result.room); else { updateControls(); schedulePoll(0); }
      announce('本棒已提交，等待其他玩家');
    } catch (error) {
      if (generation !== state.generation || key !== state.workingKey) return;
      if (error.status === 0 || error.status >= 500) {
        state.submitting = true; setConnection(false, true);
        notice('交卷连接中断，已保存到本地。重连后会核对服务器结果，避免重复传递。', true); schedulePoll(0);
      } else {
        state.pendingSubmission = null; state.submitting = false; persistDraft(); notice(error.message, true);
        if (error.status === 409) schedulePoll(0); else if (state.dirty) queueDraft(2000);
      }
      updateControls();
    }
  }
  function updateTimer() {
    const room = state.room;
    if (room?.phase === 'reveal') { updateRevealStatus(room); return; }
    if (room?.phase !== 'playing' || !room.deadline) return;
    const serverNow = (Date.now() + state.clockOffset) / 1000;
    if (room.round === 0 && room.task && !room.task.choice && room.task.choice_deadline) {
      const choosing = Math.max(0, Math.ceil(Number(room.task.choice_deadline) - serverNow));
      show('choice-timer', true); text('choice-timer', `选择题目剩余 ${choosing} 秒`);
      if (state.selectionOpen) { show('flow-count', true); text('flow-count', choosing); }
    } else {
      show('choice-timer', false);
    }
    if (room.pause) text('pause-seconds', Math.max(0, Math.ceil(room.pause.until - serverNow)));
    const remaining = Math.max(0, Math.ceil(Number(room.deadline) - (room.pause ? room.pause.started : serverNow)));
    const formatted = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    text('timer-value', formatted); $('timer').classList.toggle('urgent', remaining <= 15);
    $('timer').setAttribute('aria-label', `本轮剩余 ${remaining} 秒`);
    if ([10, 5, 3, 2, 1].includes(remaining) && state.lastSoundSecond !== String(remaining)) { state.lastSoundSecond = String(remaining); sound.tick(remaining <= 3); }
    if ([30, 10, 0].includes(remaining) && state.lastCountdownAnnouncement !== String(remaining)) {
      state.lastCountdownAnnouncement = String(remaining); announce(remaining ? `本轮还剩 ${remaining} 秒` : '本轮时间到，正在等待下一棒');
    }
  }

  function teaMe() { return mine(); }
  function setTeaView(open) {
    if (open && (!state.room || state.room.phase !== 'lobby')) { notice('茶绘只在等待房间开放。'); return; }
    state.tea.open = !!open;
    document.body.classList.toggle('tea-open', !!open);
    document.querySelector('.game-layout').hidden = !!open;
    show('tea-view', !!open);
    document.querySelectorAll('[data-room-tab]').forEach((button) => {
      const active = (button.dataset.roomTab === 'tea') === !!open;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
    });
    if (open) {
      if (state.tea.code !== state.code) { state.tea.code = state.code; state.tea.hidden = new Set(); }
      state.tea.strokes = []; state.tea.lastId = 0;
      text('tea-code', state.code);
      buildTeaTools();
      renderTeaPlayers();
      renderTea();
      teaLoad();
      clearInterval(state.tea.pollTimer);
      state.tea.pollTimer = setInterval(teaPoll, 800);
    } else {
      clearInterval(state.tea.pollTimer); state.tea.pollTimer = null;
    }
  }
  function buildTeaTools() {
    if (state.tea.toolsBuilt) { updateTeaTools(); return; }
    state.tea.toolsBuilt = true;
    for (const [color, name, label] of COLORS) {
      const button = node('button', `tea-color${color === state.tea.color ? ' active' : ''}`); button.type = 'button'; button.style.background = color;
      button.title = label; button.setAttribute('aria-label', label);
      button.addEventListener('click', () => { state.tea.color = color; updateTeaTools(); }); $('tea-colors').append(button);
    }
    const names = ['标准', '马克', '铅笔', '毛笔', '蜡笔', '喷枪'];
    BRUSHES.forEach((brush, index) => {
      const button = node('button', `tea-brush${brush === state.tea.brush ? ' active' : ''}`, names[index]); button.type = 'button';
      button.addEventListener('click', () => { state.tea.brush = brush; updateTeaTools(); }); $('tea-brushes').append(button);
    });
    $('tea-gradient-a').value = state.tea.gradientA; $('tea-gradient-b').value = state.tea.gradientB;
    $('tea-gradient-toggle').addEventListener('click', () => { state.tea.gradientEnabled = !state.tea.gradientEnabled; updateTeaTools(); });
    $('tea-gradient-a').addEventListener('input', () => { state.tea.gradientA = $('tea-gradient-a').value; });
    $('tea-gradient-b').addEventListener('input', () => { state.tea.gradientB = $('tea-gradient-b').value; });
    $('tea-size').value = String(state.tea.size); text('tea-size-value', state.tea.size);
    $('tea-opacity').value = String(state.tea.opacity); text('tea-opacity-value', state.tea.opacity);
    $('tea-size').addEventListener('input', () => { state.tea.size = Number($('tea-size').value); text('tea-size-value', state.tea.size); });
    $('tea-opacity').addEventListener('input', () => { state.tea.opacity = Number($('tea-opacity').value); text('tea-opacity-value', state.tea.opacity); });
    document.querySelectorAll('[data-tea-tool]').forEach((button) => button.addEventListener('click', () => { state.tea.tool = button.dataset.teaTool; updateTeaTools(); }));
    $('tea-undo').addEventListener('click', teaUndo);
    $('tea-clear').addEventListener('click', teaClear);
    $('tea-save').addEventListener('click', teaSave);
    const canvas = $('tea-canvas');
    canvas.addEventListener('pointerdown', teaPointerDown);
    canvas.addEventListener('pointermove', teaPointerMove);
    canvas.addEventListener('pointerup', teaPointerUp);
    canvas.addEventListener('pointercancel', teaPointerUp);
    updateTeaTools();
  }
  function updateTeaTools() {
    document.querySelectorAll('.tea-color').forEach((button, index) => button.classList.toggle('active', COLORS[index][0] === state.tea.color));
    document.querySelectorAll('.tea-brush').forEach((button, index) => button.classList.toggle('active', BRUSHES[index] === state.tea.brush));
    document.querySelectorAll('[data-tea-tool]').forEach((button) => button.classList.toggle('active', button.dataset.teaTool === state.tea.tool));
    $('tea-gradient-toggle').setAttribute('aria-pressed', String(state.tea.gradientEnabled));
    $('tea-gradient-toggle').textContent = state.tea.gradientEnabled ? '关闭渐变' : '启用渐变';
  }
  function renderTeaPlayers() {
    if (!state.room) return;
    const holder = $('tea-player-toggles'); holder.replaceChildren();
    for (const player of state.room.players) {
      const hidden = state.tea.hidden.has(String(player.id));
      const button = node('button', `tea-player-toggle${hidden ? ' hidden-player' : ''}`); button.type = 'button';
      button.append(avatarNode(player.avatar, 'player-avatar'), node('span', '', player.name), node('span', '', hidden ? '○' : '◉'));
      button.title = hidden ? `显示 ${player.name} 的线条` : `隐藏 ${player.name} 的线条`;
      button.setAttribute('aria-pressed', String(hidden));
      button.addEventListener('click', () => { const key = String(player.id); if (state.tea.hidden.has(key)) state.tea.hidden.delete(key); else state.tea.hidden.add(key); renderTeaPlayers(); renderTea(); });
      holder.append(button);
    }
  }
  function renderTea() {
    const canvas = $('tea-canvas'); if (!canvas) return;
    const layers = Array.from({ length: LAYERS }, () => { const layer = document.createElement('canvas'); layer.width = WIDTH; layer.height = HEIGHT; return layer; });
    const contexts = layers.map((layer) => layer.getContext('2d', { willReadFrequently: true }));
    for (const item of state.tea.strokes) {
      if (state.tea.hidden.has(String(item.player_id))) continue;
      renderStroke(contexts[layerOf(item.stroke)], item.stroke);
    }
    if (state.tea.active) renderStroke(contexts[layerOf(state.tea.active)], state.tea.active);
    const out = canvas.getContext('2d'); out.clearRect(0, 0, WIDTH, HEIGHT); out.fillStyle = '#fff'; out.fillRect(0, 0, WIDTH, HEIGHT);
    for (const layer of layers) out.drawImage(layer, 0, 0);
  }
  function teaPoint(event) {
    const canvas = $('tea-canvas'), rect = canvas.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(WIDTH - 0.1, (event.clientX - rect.left) / rect.width * WIDTH)) * 10) / 10,
      Math.round(Math.max(0, Math.min(HEIGHT - 0.1, (event.clientY - rect.top) / rect.height * HEIGHT)) * 10) / 10];
  }
  function teaHit(stroke, point) {
    const radius = Math.max(18, 12 + (Number(stroke.size) || 6));
    const points = stroke.points || [];
    if (points.length === 1) return Math.hypot(points[0][0] - point[0], points[0][1] - point[1]) <= radius;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
      if (Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t)) <= radius) return true;
    }
    return false;
  }
  function teaPointerDown(event) {
    if (!state.tea.open) return;
    const me = teaMe(); if (!me) return;
    event.preventDefault(); $('tea-canvas').setPointerCapture(event.pointerId);
    const point = teaPoint(event);
    if (state.tea.tool === 'line-eraser') {
      state.tea.erasing = event.pointerId; state.tea.pointer = event.pointerId;
      teaEraseAt(point); return;
    }
    state.tea.pointer = event.pointerId;
    state.tea.active = { tool: 'pen', color: state.tea.color, size: state.tea.size, opacity: state.tea.opacity, brush: state.tea.brush, layer: 0, points: [point] };
    if (state.tea.gradientEnabled) state.tea.active.gradient = [state.tea.gradientA, state.tea.gradientB];
    renderTea();
  }
  function teaEraseAt(point) {
    const me = teaMe(); if (!me) return;
    const target = [...state.tea.strokes].reverse().find((item) => item.player_id === me.id && teaHit(item.stroke, point));
    if (!target) return;
    state.tea.strokes = state.tea.strokes.filter((item) => item !== target); renderTea();
    if (target.id > 0) request(roomPath('/tea_delete'), 'POST', { id: target.id }).catch(() => {});
  }
  function teaPointerMove(event) {
    if (state.tea.erasing === event.pointerId) { teaEraseAt(teaPoint(event)); return; }
    if (!state.tea.active || state.tea.pointer !== event.pointerId) return;
    const point = teaPoint(event), points = state.tea.active.points, last = points[points.length - 1];
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.6) return;
    points.push(point); renderTea();
  }
  function teaPointerUp(event) {
    if (state.tea.erasing === event.pointerId) { state.tea.erasing = null; state.tea.pointer = null; return; }
    if (!state.tea.active || (event && state.tea.pointer !== event.pointerId)) return;
    const stroke = state.tea.active; state.tea.active = null; state.tea.pointer = null;
    const me = teaMe(); if (!me) return;
    const local = { id: state.tea.localId--, player_id: me.id, stroke };
    state.tea.strokes.push(local); renderTea();
    request(roomPath('/tea'), 'POST', { stroke })
      .then(() => teaPoll())
      .catch((error) => { notice(error.message, true); state.tea.strokes = state.tea.strokes.filter((item) => item !== local); renderTea(); });
  }
  async function teaLoad() {
    state.tea.lastId = 0; state.tea.strokes = []; state.tea.polling = false;
    await teaPoll();
  }
  async function teaPoll() {
    if (!state.tea.open || state.tea.polling || state.room?.phase !== 'lobby') return;
    state.tea.polling = true;
    try {
      const result = await request(roomPath(`/tea?since=${state.tea.lastId}`));
      let changed = false;
      for (const item of result.strokes || []) {
        const signature = JSON.stringify(item.stroke);
        const local = state.tea.strokes.find((existing) => existing.id < 0 && existing.player_id === item.player_id && JSON.stringify(existing.stroke) === signature);
        if (local) { Object.assign(local, item); changed = true; continue; }
        if (!state.tea.strokes.some((existing) => existing.id === item.id)) { state.tea.strokes.push(item); changed = true; }
      }
      state.tea.lastId = Math.max(state.tea.lastId, Number(result.last_id) || 0);
      if (changed) renderTea();
    } catch (error) { if (error.status !== 0) notice(error.message, true); }
    finally { state.tea.polling = false; }
  }
  async function teaUndo() {
    const me = teaMe(); if (!me) return;
    try {
      await request(roomPath('/tea_undo'), 'POST', {});
      const own = state.tea.strokes.filter((item) => item.player_id === me.id);
      if (own.length) state.tea.strokes = state.tea.strokes.filter((item) => item !== own[own.length - 1]);
      renderTea(); teaPoll();
    } catch (error) { notice(error.message, true); }
  }
  async function teaClear() {
    const me = teaMe(); if (!me || !confirm('清空自己画的全部线条？')) return;
    try {
      await request(roomPath('/tea_clear'), 'POST', {});
      state.tea.strokes = state.tea.strokes.filter((item) => item.player_id !== me.id);
      renderTea(); teaPoll();
    } catch (error) { notice(error.message, true); }
  }
  async function teaSave() {
    if (!state.room) return;
    if (state.tea.active) teaPointerUp();
    const strokes = state.tea.strokes.filter((item) => !state.tea.hidden.has(String(item.player_id))).map((item) => item.stroke);
    if (!strokes.length) { notice('当前没有可收藏的线条。'); return; }
    try {
      await request('/api/library/gallery', 'POST', { title: `茶绘 · ${state.code}`.slice(0, 80), drawing: { strokes } }, false);
      notice('茶绘已收藏到画廊；隐藏玩家的线条没有被保存。');
    } catch (error) { notice(error.message, true); }
  }
  function initialize() {
    const savedAvatar = Number(storage.get('game:avatar')); state.avatar = Number.isInteger(savedAvatar) && savedAvatar >= 0 && savedAvatar < 8 ? savedAvatar : 0;
    $('player-name').value = storage.get('game:name') || '';
    AVATAR_NAMES.forEach((avatar, index) => {
      const button = node('button', `avatar-button${index === state.avatar ? ' selected' : ''}`); button.type = 'button';
      button.append(avatarNode(index, 'avatar-art'));
      button.setAttribute('aria-label', AVATAR_NAMES[index]); button.setAttribute('aria-pressed', String(index === state.avatar)); button.title = AVATAR_NAMES[index];
      button.addEventListener('click', () => { state.avatar = index; $('avatar-picker').querySelectorAll('button').forEach((option, i) => { option.classList.toggle('selected', i === index); option.setAttribute('aria-pressed', String(i === index)); }); });
      $('avatar-picker').append(button);
    });
    COLORS.forEach(([color, name, label]) => {
      const button = node('button', `color-swatch color-${name}${color === '#293047' ? ' selected' : ''}`); button.type = 'button'; button.dataset.color = color;
      button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(color === '#293047')); button.title = label;
      button.addEventListener('click', () => state.engine.setColor(color)); $('color-palette').append(button);
    });
    state.engine = new DrawingEngine($('draw-canvas'));
    $('current-color-dot').style.background = state.engine.color;
    $('pressure-toggle').checked = state.engine.pressureEnabled;
    $('pressure-toggle').addEventListener('change', () => state.engine.setPressure($('pressure-toggle').checked));
    $('opacity-range').value = String(state.engine.opacity); text('opacity-value', state.engine.opacity);
    $('opacity-range').addEventListener('input', () => state.engine.setOpacity($('opacity-range').value));
    $('gradient-a').addEventListener('input', () => state.engine.setGradientColors($('gradient-a').value, $('gradient-b').value));
    $('gradient-b').addEventListener('input', () => state.engine.setGradientColors($('gradient-a').value, $('gradient-b').value));
    $('gradient-toggle').addEventListener('click', () => state.engine.setGradientEnabled(!state.engine.gradientEnabled));
    $('brush-popover-close').addEventListener('click', closeToolPopovers);
    $('eraser-popover-close').addEventListener('click', closeToolPopovers);
    $('line-eraser-popover-close').addEventListener('click', closeToolPopovers);
    $('fill-popover-close').addEventListener('click', closeToolPopovers);
    $('fill-open-color').addEventListener('click', () => { closeToolPopovers(); toggleToolPopover('color-popover'); });
    $('eraser-size').addEventListener('input', () => state.engine.setSize($('eraser-size').value));
    $('line-eraser-size').addEventListener('input', () => state.engine.setSize($('line-eraser-size').value));
    $('fill-angle').addEventListener('input', () => state.engine.setFillAngle($('fill-angle').value));
    const fillDial = $('fill-dial'); let fillDialDrag = false;
    const setDialAngle = (event) => {
      const rect = fillDial.getBoundingClientRect();
      const radians = Math.atan2(event.clientY - (rect.top + rect.height / 2), event.clientX - (rect.left + rect.width / 2));
      state.engine.setFillAngle((radians * 180 / Math.PI + 360) % 360);
    };
    fillDial.addEventListener('pointerdown', (event) => { fillDialDrag = true; fillDial.setPointerCapture(event.pointerId); setDialAngle(event); event.preventDefault(); });
    fillDial.addEventListener('pointermove', (event) => { if (fillDialDrag) setDialAngle(event); });
    fillDial.addEventListener('pointerup', () => { fillDialDrag = false; });
    fillDial.addEventListener('pointercancel', () => { fillDialDrag = false; });
    fillDial.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const step = event.shiftKey ? 15 : 5;
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
      state.engine.setFillAngle(state.engine.fillAngle + direction * step); event.preventDefault();
    });
    state.engine.setSize(state.engine.size); state.engine.setFillAngle(state.engine.fillAngle);
    $('identity-form').addEventListener('submit', (e) => { e.preventDefault(); enterRoom('create'); });
    $('join-form').addEventListener('submit', (e) => { e.preventDefault(); const code = $('room-code').value.trim().toUpperCase(); if (/^[A-Z0-9]{6}$/.test(code)) enterRoom('join', code); else notice('请输入 6 位字母或数字房间码。', true); });
    $('room-code').addEventListener('input', () => { const input = $('room-code'), start = input.selectionStart; input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (start !== null) input.setSelectionRange(start, start); });
    $('practice-button').addEventListener('click', () => enterRoom('practice'));
    renderAccount();
    show('resume-button', !!recovery.latest());
    $('account-button').addEventListener('click', openAuthDialog);
    $('logout-button').addEventListener('click', logoutAccount);
    $('auth-close').addEventListener('click', () => { state.pendingEntry = null; closeAuthDialog(); });
    $('auth-dialog').addEventListener('cancel', () => { state.pendingEntry = null; });
    $('auth-form').addEventListener('submit', (event) => { event.preventDefault(); submitAuth('login'); });
    $('auth-register').addEventListener('click', () => submitAuth('register'));
    $('resume-button').addEventListener('click', () => resumeRoom(recovery.latest()));
    $('reconnect-button').addEventListener('click', () => { state.failures = 0; schedulePoll(0); });
    updateSoundButton();
    document.querySelectorAll('[data-room-tab]').forEach((button) => button.addEventListener('click', () => setTeaView(button.dataset.roomTab === 'tea')));
    $('sound-toggle').addEventListener('click', () => { sound.toggle(); updateSoundButton(); });
    $('bgm-volume').value = String(sound.bgmVolume ?? 35); text('bgm-volume-value', sound.bgmVolume ?? 35);
    $('sfx-volume').value = String(sound.sfxVolume ?? 70); text('sfx-volume-value', sound.sfxVolume ?? 70);
    $('bgm-volume').addEventListener('input', () => { sound.setBgmVolume?.($('bgm-volume').value); text('bgm-volume-value', $('bgm-volume').value); });
    $('sfx-volume').addEventListener('input', () => { sound.setSfxVolume?.($('sfx-volume').value); text('sfx-volume-value', $('sfx-volume').value); });
    const renderBgmList = (active = sound.bgmIndex || 0) => {
      const list = $('bgm-track-list'); list.replaceChildren();
      const names = window.GameSound?.BGM_NAMES || [];
      names.forEach((name, index) => {
        const button = node('button', `bgm-track${index === active ? ' active' : ''}`, name);
        button.type = 'button';
        button.addEventListener('click', () => { sound.playBgm?.(index); renderBgmList(index); });
        list.append(button);
      });
    };
    renderBgmList();
    sound.onBgmChange = (index) => renderBgmList(index);
    $('audio-settings-button').addEventListener('click', () => { renderBgmList(); $('audio-settings').showModal(); });
    $('audio-settings-close').addEventListener('click', () => $('audio-settings').close());
    $('pause-extend').addEventListener('click', () => act('pause', { seconds: 40 }, $('pause-extend')));
    $('pause-cancel').addEventListener('click', () => act('pause', { cancel: true }, $('pause-cancel')));
    $('pause-dismiss').addEventListener('click', () => $('pause-dialog').close());
    $('leave-button').addEventListener('click', () => { show('leave-confirm', true); $('cancel-leave').focus(); });
    document.querySelectorAll('[data-leave]').forEach((button) => button.addEventListener('click', () => { show('leave-confirm', true); $('cancel-leave').focus(); }));
    $('prompt-toggle').addEventListener('click', () => setPromptOpen(!state.promptOpen));
    $('color-popover-toggle').addEventListener('click', () => toggleToolPopover('color-popover'));
    $('layer-popover-toggle').addEventListener('click', () => toggleToolPopover('layer-popover'));
    $('color-popover-close').addEventListener('click', closeToolPopovers);
    $('layer-popover-close').addEventListener('click', closeToolPopovers);
    document.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.tool-popover, .rail-button[data-tool], #color-popover-toggle, #layer-popover-toggle')) return;
      closeToolPopovers();
    });
    $('cancel-leave').addEventListener('click', () => show('leave-confirm', false));
    $('confirm-leave').addEventListener('click', async () => { const result = await act('leave', {}, $('confirm-leave')); if (result) { returnHome(true); notice('已离开房间。'); } });
    $('share-button').addEventListener('click', async () => {
      const link = `${location.origin}/game#room/${state.code}`; $('invite-link').value = link;
      try { await navigator.clipboard.writeText(link); notice('邀请链接已复制，发给朋友就能加入！'); }
      catch { show('share-panel', true); $('invite-link').focus(); $('invite-link').select(); notice('选中并复制链接，发给朋友吧。'); }
    });
    $('close-share').addEventListener('click', () => show('share-panel', false));
    $('ready-button').addEventListener('click', () => act('ready', { ready: !mine()?.ready }, $('ready-button')));
    $('settings-form').addEventListener('change', () => { state.settingsDirty = true; updateControls(); });
    $('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault(); if (!isHost()) return;
      const settings = { max_players: Number($('setting-max').value), draw_seconds: Number($('setting-draw').value), guess_seconds: Number($('setting-guess').value), library_id: $('setting-library').value === '' ? null : Number($('setting-library').value) };
      const result = await act('settings', settings, $('settings-save'));
      if (result) { state.settingsDirty = false; syncSettings(state.room, true); updateControls(); notice('房间设置已保存。'); }
    });
    document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => {
      const tool = button.dataset.tool, already = state.engine.tool === tool;
      state.engine.setTool(tool);
      if (already) toggleToolPopover(TOOL_POPOVERS[tool]); else closeToolPopovers();
    }));
    document.querySelectorAll('[data-size]').forEach((button) => button.addEventListener('click', () => state.engine.setSize(button.dataset.size)));
    $('brush-size').addEventListener('input', () => state.engine.setSize($('brush-size').value));
    $('custom-color').addEventListener('input', () => state.engine.setColor($('custom-color').value));
    $('undo-button').addEventListener('click', () => state.engine.undo()); $('redo-button').addEventListener('click', () => state.engine.redo());
    $('clear-button').addEventListener('click', () => { show('clear-confirm', true); $('cancel-clear').focus({ preventScroll: true }); });
    $('cancel-clear').addEventListener('click', () => show('clear-confirm', false));
    $('confirm-clear').addEventListener('click', () => { state.engine.clear(); show('clear-confirm', false); });
    $('export-button').addEventListener('click', () => state.engine.export(`画猜-${state.code}-第${(state.room?.round ?? 0) + 1}棒.png`));
    $('submit-draw').addEventListener('click', () => { if (!state.locked) $('submit-confirm').showModal(); });
    $('submit-cancel').addEventListener('click', () => $('submit-confirm').close());
    $('submit-ok').addEventListener('click', () => { $('submit-confirm').close(); submit('draw'); });
    $('guess-form').addEventListener('submit', (e) => { e.preventDefault(); submit('guess'); });
    $('guess-input').addEventListener('input', (e) => { if (!e.isComposing) { markDirty(); updateControls(); } });
    $('guess-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) { e.preventDefault(); submit('guess'); } });
    $('guess-input').addEventListener('compositionend', () => { markDirty(); updateControls(); });
    $('chat-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const input = $('chat-input'), message = input.value.trim(); if (!message) return;
      const result = await act('chat', { text: message }, $('chat-send'));
      if (result && input.value.trim() === message) { input.value = ''; input.focus({ preventScroll: true }); }
    });
    $('chat-messages').addEventListener('scroll', () => { const el = $('chat-messages'); if (el.scrollHeight - el.scrollTop - el.clientHeight < 55) show('chat-new', false); });
    $('chat-new').addEventListener('click', () => { $('chat-messages').scrollTop = $('chat-messages').scrollHeight; show('chat-new', false); });
    $('match-yes').addEventListener('click', () => act('reveal', { vote: 'same', chain: state.room?.reveal?.chain ?? 0 }));
    $('match-no').addEventListener('click', () => act('reveal', { vote: 'changed', chain: state.room?.reveal?.chain ?? 0 }));
    $('scores-replay').addEventListener('click', () => { if (isHost()) act('replay', {}, $('scores-replay')); });
    $('replay-button').addEventListener('click', () => { if (isHost()) { stopRevealPlayback(); act('replay', {}, $('replay-button')); } });
    document.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229 || e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        if ($('pause-dialog').open) return;
        show('clear-confirm', false); show('leave-confirm', false); show('share-panel', false); closeToolPopovers(); return;
      }
      if (state.tea.open) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); teaUndo(); return; }
        if (!e.ctrlKey && !e.metaKey && !e.altKey) { const teaTool = { b: 'pen', e: 'line-eraser', l: 'line-eraser', f: 'pen' }[e.key.toLowerCase()]; if (teaTool) { e.preventDefault(); state.tea.tool = teaTool; updateTeaTools(); } }
        return;
      }
      if (state.room?.phase !== 'playing' || state.room.task?.kind !== 'draw' || state.locked || e.altKey) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? state.engine.redo() : state.engine.undo(); return; }
      if (e.ctrlKey || e.metaKey) return;
      const tool = { b: 'pen', e: 'eraser', l: 'line-eraser', f: 'fill' }[e.key.toLowerCase()];
      if (tool) { e.preventDefault(); state.engine.setTool(tool); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.dirty) { state.engine.finish(); persistDraft(); saveDraft(); } if (!document.hidden) { updateTimer(); schedulePoll(0); } });
    window.addEventListener('online', () => { state.failures = 0; schedulePoll(0); });
    window.addEventListener('offline', () => { state.engine.finish(); persistDraft(); setConnection(false, true); });
    window.addEventListener('pagehide', () => { if (state.dirty || state.engine.active) { state.engine.finish(); persistDraft(); } });
    window.addEventListener('hashchange', handleHash);
    setInterval(updateTimer, 250);
    loadLibraries(); loadAccount(); handleHash(true);
  }
  function resumeAccountRoom(code) {
    if (!code || state.room) return;
    state.code = code; state.token = '';
    storage.set('game:active', code);
    beginRoom(); poll();
  }
  function resumeRoom(session) {
    if (!session || state.room) return;
    state.code = session.code; state.token = session.token;
    storage.set(`game:token:${state.code}`, state.token); storage.set('game:active', state.code);
    beginRoom();
    const cached = recovery.cached(session);
    if (cached) { applyRoom(cached, true); setConnection(false, true); }
    poll();
  }
  function handleHash(initial = false) {
    const match = location.hash.match(/^#room\/([A-Za-z0-9]{6})$/);
    const code = match ? match[1].toUpperCase() : initial === true ? storage.get('game:active') : null;
    if (!code || !/^[A-Z0-9]{6}$/.test(code) || code === state.code) return;
    if (state.room) { notice('你已经在一个房间中，请先离开后再加入另一个房间。'); history.replaceState(null, '', `/game#room/${state.code}`); return; }
    const token = storage.get(`game:token:${code}`);
    const previous = token ? { code, token } : recovery.latest(code);
    if (previous) resumeRoom(previous);
    else { $('room-code').value = code; notice(`朋友邀请你加入 ${code}，取个昵称后点击“加入”吧。`, false, true); }
  }

  initialize();
})();
