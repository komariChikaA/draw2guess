'use strict';
(function () {
  const WIDTH = 960, HEIGHT = 640, LAYERS = 3;
  const $ = (id) => document.getElementById(id);
  function text(id, value) { const element = $(id); if (element) element.textContent = String(value); }
  const state = { account: null, artworks: [], replays: [], studio: null, replay: null, spectate: null, tab: 'gallery' };

  function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
  function toast(message, error = false) { const box = $('library-toast'); box.textContent = message; box.style.borderColor = error ? '#f39b96' : '#ffe75d'; box.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.hidden = true; }, 2600); }
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {};
    try { data = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  }
  function avatar(value) {
    const image = node('img'); image.src = `/game-assets/avatars/avatar-${((Number(value) || 0) % 8 + 8) % 8 + 1}.png`; image.alt = ''; return image;
  }

  const BRUSHES = ['pen', 'marker', 'pencil', 'brush', 'crayon', 'spray'];
  function layerOf(stroke) { const value = Number(stroke?.layer); return Number.isInteger(value) && value >= 0 && value < LAYERS ? value : 0; }
  function brushOf(stroke) { return BRUSHES.includes(stroke?.brush) ? stroke.brush : 'pen'; }
  function hash01(a, b) { const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return value - Math.floor(value); }
  function safeDrawing(drawing) {
    if (!drawing || !Array.isArray(drawing.strokes)) return { strokes: [] };
    const strokes = [];
    for (const raw of drawing.strokes.slice(0, 2000)) {
      if (!raw || !['pen', 'eraser', 'fill'].includes(raw.tool) || !Array.isArray(raw.points)) continue;
      const points = [];
      for (const p of raw.points.slice(0, 100000)) {
        if (!Array.isArray(p) || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) continue;
        points.push([Math.round(Math.max(0, Math.min(WIDTH - 0.01, Number(p[0]))) * 10) / 10, Math.round(Math.max(0, Math.min(HEIGHT - 0.01, Number(p[1]))) * 10) / 10]);
        if (raw.tool === 'fill') break;
      }
      if (!points.length) continue;
      const stroke = { tool: raw.tool, color: raw.tool === 'eraser' ? '#ffffff' : /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : '#293047', size: Math.max(1, Math.min(64, Number(raw.size) || 6)), points, layer: layerOf(raw), brush: brushOf(raw) };
      const opacity = Math.round(Number(raw.opacity));
      if (Number.isFinite(opacity) && opacity >= 1 && opacity <= 100) stroke.opacity = opacity;
      if (raw.tool !== 'eraser' && Array.isArray(raw.gradient) && raw.gradient.length === 2 && raw.gradient.every((c) => /^#[0-9a-f]{6}$/i.test(c))) stroke.gradient = raw.gradient.map((c) => c.toLowerCase());
      const angle = Number(raw.angle); if (raw.tool === 'fill' && Number.isFinite(angle)) stroke.angle = Math.max(0, Math.min(360, angle));
      if (Array.isArray(raw.pressures) && raw.pressures.length === raw.points.length) stroke.pressures = raw.pressures.slice(0, points.length);
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
  function renderDrawing(canvas, drawing, visibleLayers = null) {
    const parsed = safeDrawing(drawing);
    const layers = Array.from({ length: LAYERS }, () => { const c = document.createElement('canvas'); c.width = WIDTH; c.height = HEIGHT; return c; });
    const contexts = layers.map((c) => c.getContext('2d', { willReadFrequently: true }));
    for (const stroke of parsed.strokes) { const layer = layerOf(stroke); if (!visibleLayers || visibleLayers[layer] !== false) renderStroke(contexts[layer], stroke); }
    const out = canvas.getContext('2d'); out.clearRect(0, 0, WIDTH, HEIGHT); out.fillStyle = '#fff'; out.fillRect(0, 0, WIDTH, HEIGHT);
    for (const layer of layers) out.drawImage(layer, 0, 0);
  }
  function animateDrawing(canvas, drawing, duration = 4000) {
    const parsed = safeDrawing(drawing), strokes = parsed.strokes;
    if (!strokes.length) { renderDrawing(canvas, drawing); return; }
    const layers = Array.from({ length: LAYERS }, () => { const c = document.createElement('canvas'); c.width = WIDTH; c.height = HEIGHT; return c; });
    const contexts = layers.map((c) => c.getContext('2d', { willReadFrequently: true }));
    const out = canvas.getContext('2d');
    const start = performance.now(); const per = Math.max(30, duration / strokes.length); let index = 0;
    const frame = (now) => {
      while (index < strokes.length && now - start >= index * per) { renderStroke(contexts[layerOf(strokes[index])], strokes[index]); index += 1; }
      out.fillStyle = '#fff'; out.fillRect(0, 0, WIDTH, HEIGHT); for (const layer of layers) out.drawImage(layer, 0, 0);
      if (index < strokes.length && state.spectate?.token === token) requestAnimationFrame(frame);
    };
    const token = state.spectate?.token;
    requestAnimationFrame(frame);
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    $('gallery-view').hidden = tab !== 'gallery'; $('replays-view').hidden = tab !== 'replays';
    if (tab === 'gallery') loadGallery(); else loadReplays();
  }
  async function loadAccount() {
    try { const result = await api('/api/auth/me'); state.account = result.account; } catch { state.account = null; }
    $('library-login').hidden = !!state.account; $('library-content').hidden = !state.account;
    $('library-account').textContent = state.account ? `已登录：${state.account.username}` : '';
    if (state.account) setTab(state.tab);
  }
  async function loadGallery() {
    try {
      const result = await api('/api/library/gallery');
      state.artworks = result.artworks || [];
      const grid = $('gallery-grid'); grid.replaceChildren();
      $('gallery-empty').hidden = state.artworks.length > 0;
      for (const artwork of state.artworks) {
        const card = node('article', 'gallery-card');
        const canvas = node('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT; renderDrawing(canvas, artwork.drawing); card.append(canvas);
        const info = node('div', 'gallery-card-info'); info.append(node('strong', '', artwork.title), node('small', '', artwork.updated_at?.slice(0, 10) || '')); card.append(info);
        const del = node('button', 'gallery-delete', '×'); del.type = 'button'; del.title = '删除画作'; del.addEventListener('click', async (event) => { event.stopPropagation(); if (!confirm(`删除《${artwork.title}》？`)) return; try { await api(`/api/library/gallery/${artwork.id}`, 'DELETE'); toast('已删除'); loadGallery(); } catch (error) { toast(error.message, true); } });
        card.append(del);
        card.addEventListener('click', () => openStudio(artwork));
        grid.append(card);
      }
    } catch (error) { toast(error.message, true); }
  }
  async function loadReplays() {
    try {
      const result = await api('/api/library/replays');
      state.replays = result.replays || [];
      const grid = $('replay-grid'); grid.replaceChildren();
      $('replay-empty').hidden = state.replays.length > 0;
      for (const replay of state.replays) {
        const card = node('article', 'replay-card');
        const top = node('div', 'replay-card-top'); top.append(node('span', 'replay-code', replay.code), node('span', 'replay-date', replay.created_at?.slice(0, 16).replace('T', ' ') || ''));
        card.append(top);
        const players = node('div', 'replay-players');
        for (const player of replay.players || []) { const chip = node('span', 'replay-player'); chip.append(avatar(player.avatar), node('span', '', player.name)); players.append(chip); }
        card.append(players, node('div', 'replay-stats', `${replay.player_count} 人 · ${replay.chain_count} 条接龙`));
        card.addEventListener('click', () => openReplay(replay.id));
        grid.append(card);
      }
    } catch (error) { toast(error.message, true); }
  }

  function openStudio(artwork) {
    const drawing = artwork?.drawing || { strokes: [] };
    state.studio = { id: artwork?.id || 0, title: artwork?.title || '未命名画作', strokes: safeDrawing(drawing).strokes.slice(), tool: 'pen', color: '#293047', size: 6, active: null, brush: 'pen', opacity: 100, layer: 2, layerVisible: [true, true, true], gradientEnabled: false, gradientA: '#ff6b6b', gradientB: '#4d7cff' };
    $('studio-name').value = state.studio.title;
    $('studio-title-label').textContent = artwork ? '继续创作' : '新建画作';
    $('studio-status').textContent = artwork ? '继续画并保存，会更新画廊里的这一幅' : '可直接开始画，保存后进入画廊';
    $('studio-size').value = '6'; $('studio-size-value').textContent = '6';
    $('studio-opacity').value = '100'; $('studio-opacity-value').textContent = '100';
    $('studio-gradient-a').value = state.studio.gradientA; $('studio-gradient-b').value = state.studio.gradientB; $('studio-gradient-toggle').setAttribute('aria-pressed', 'false');
    $('studio').hidden = false;
    paintStudio();
    paintStudioTools();
  }
  function closeStudio() { $('studio').hidden = true; state.studio = null; loadGallery(); }
  function paintStudioTools() {
    document.querySelectorAll('[data-studio-tool]').forEach((button) => button.classList.toggle('active', button.dataset.studioTool === state.studio.tool));
    document.querySelectorAll('.studio-color').forEach((button) => button.classList.toggle('active', button.dataset.color === state.studio.color));
    document.querySelectorAll('.studio-brush').forEach((button) => button.classList.toggle('active', button.dataset.brush === state.studio.brush));
    document.querySelectorAll('.studio-layer').forEach((button, index) => { const layer = 2 - index; button.classList.toggle('active', layer === state.studio.layer); button.classList.toggle('hidden-layer', !state.studio.layerVisible[layer]); });
    $('studio-color').value = state.studio.color;
    $('studio-gradient-toggle').setAttribute('aria-pressed', String(state.studio.gradientEnabled));
    text('studio-gradient-toggle', state.studio.gradientEnabled ? '关闭渐变' : '启用渐变');
  }
  function paintStudio() {
    const canvas = $('studio-canvas');
    const strokes = state.studio.active ? state.studio.strokes.concat([state.studio.active]) : state.studio.strokes;
    renderDrawing(canvas, { strokes }, state.studio.layerVisible);
  }
  function studioPoint(event) {
    const canvas = $('studio-canvas'), rect = canvas.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(WIDTH - 0.1, (event.clientX - rect.left) / rect.width * WIDTH)) * 10) / 10,
      Math.round(Math.max(0, Math.min(HEIGHT - 0.1, (event.clientY - rect.top) / rect.height * HEIGHT)) * 10) / 10];
  }
  function studioHit(stroke, point) {
    const radius = 10 + (Number(stroke.size) || 6) / 2;
    const points = stroke.points || [];
    if (points.length === 1) return Math.hypot(points[0][0] - point[0], points[0][1] - point[1]) <= radius;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
      if (Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t)) <= radius) return true;
    }
    return false;
  }
  function bindStudio() {
    const canvas = $('studio-canvas');
    canvas.addEventListener('pointerdown', (event) => {
      if (!state.studio) return;
      event.preventDefault(); canvas.setPointerCapture(event.pointerId);
      const point = studioPoint(event);
      if (state.studio.tool === 'line-eraser') {
        const target = [...state.studio.strokes].reverse().find((stroke) => studioHit(stroke, point));
        if (target) { state.studio.strokes = state.studio.strokes.filter((stroke) => stroke !== target); paintStudio(); }
        return;
      }
      const stroke = { tool: state.studio.tool, color: state.studio.tool === 'eraser' ? '#ffffff' : state.studio.color, size: state.studio.size, points: [point], layer: state.studio.layer, opacity: state.studio.opacity, brush: state.studio.brush };
      if (state.studio.gradientEnabled && state.studio.tool !== 'eraser') stroke.gradient = [state.studio.gradientA, state.studio.gradientB];
      if (state.studio.tool === 'fill') stroke.angle = 0;
      if (state.studio.tool === 'fill' || state.studio.tool === 'eraser') { state.studio.strokes.push(stroke); state.studio.active = null; paintStudio(); return; }
      state.studio.active = stroke; state.studio.pointer = event.pointerId; canvas.setPointerCapture(event.pointerId); paintStudio();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!state.studio?.active || state.studio.pointer !== event.pointerId) return;
      const point = studioPoint(event), points = state.studio.active.points, last = points[points.length - 1];
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.6) return;
      points.push(point); paintStudio();
    });
    const finish = (event) => {
      if (!state.studio?.active || (event && state.studio.pointer !== event.pointerId)) return;
      state.studio.strokes.push(state.studio.active); state.studio.active = null; state.studio.pointer = null; paintStudio();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    $('studio-undo').addEventListener('click', () => { if (!state.studio) return; state.studio.strokes.pop(); paintStudio(); });
    $('studio-clear').addEventListener('click', () => { if (!state.studio || !confirm('清空当前画作？')) return; state.studio.strokes = []; paintStudio(); });
    $('studio-save').addEventListener('click', saveStudio);
    $('studio-close').addEventListener('click', closeStudio);
    $('studio-size').addEventListener('input', () => { if (!state.studio) return; state.studio.size = Number($('studio-size').value); $('studio-size-value').textContent = String(state.studio.size); });
    $('studio-color').addEventListener('input', () => { if (!state.studio) return; state.studio.color = $('studio-color').value; paintStudioTools(); });
    document.querySelectorAll('[data-studio-tool]').forEach((button) => button.addEventListener('click', () => { if (!state.studio) return; state.studio.tool = button.dataset.studioTool; paintStudioTools(); }));
    const colors = ['#293047', '#ed6b75', '#f3a65a', '#f8d66a', '#88bf72', '#719ee6', '#a184d5', '#956e59', '#ffffff', '#8892a3', '#d7dbe3', '#fff0cd'];
    for (const color of colors) { const button = node('button', 'studio-color'); button.type = 'button'; button.dataset.color = color; button.style.background = color; button.setAttribute('aria-label', color); button.addEventListener('click', () => { if (!state.studio) return; state.studio.color = color; paintStudioTools(); }); $('studio-colors').append(button); }
    const brushNames = ['标准', '马克', '铅笔', '毛笔', '蜡笔', '喷枪'];
    BRUSHES.forEach((brush, index) => { const button = node('button', 'studio-brush', brushNames[index]); button.type = 'button'; button.dataset.brush = brush; button.addEventListener('click', () => { if (!state.studio) return; state.studio.brush = brush; if (state.studio.tool !== 'pen') state.studio.tool = 'pen'; paintStudioTools(); }); $('studio-brushes').append(button); });
    $('studio-opacity').addEventListener('input', () => { if (!state.studio) return; state.studio.opacity = Number($('studio-opacity').value); text('studio-opacity-value', state.studio.opacity); });
    $('studio-gradient-a').addEventListener('input', () => { if (state.studio) state.studio.gradientA = $('studio-gradient-a').value; });
    $('studio-gradient-b').addEventListener('input', () => { if (state.studio) state.studio.gradientB = $('studio-gradient-b').value; });
    $('studio-gradient-toggle').addEventListener('click', () => { if (!state.studio) return; state.studio.gradientEnabled = !state.studio.gradientEnabled; paintStudioTools(); });
    for (let index = 2; index >= 0; index--) {
      const button = node('div', 'studio-layer'); button.dataset.layer = String(index);
      button.append(node('span', '', `图层 ${index + 1}`));
      const eye = node('button', 'layer-eye eye', '◉'); eye.type = 'button'; eye.setAttribute('aria-label', `显示或隐藏图层 ${index + 1}`);
      eye.addEventListener('click', (event) => { event.stopPropagation(); if (!state.studio) return; state.studio.layerVisible[index] = !state.studio.layerVisible[index]; paintStudio(); paintStudioTools(); });
      button.append(eye);
      button.addEventListener('click', () => { if (!state.studio) return; state.studio.layer = index; paintStudioTools(); });
      $('studio-layers').append(button);
    }
  }
  async function saveStudio() {
    if (!state.studio) return;
    const title = $('studio-name').value.trim() || '未命名画作';
    const drawing = { strokes: state.studio.strokes };
    try {
      $('studio-status').textContent = '正在保存…';
      if (state.studio.id) await api(`/api/library/gallery/${state.studio.id}`, 'POST', { title, drawing });
      else { const result = await api('/api/library/gallery', 'POST', { title, drawing }); state.studio.id = result.artwork.id; }
      state.studio.title = title; $('studio-title-label').textContent = '继续创作';
      $('studio-status').textContent = '已保存到画廊';
      toast('已保存到画廊');
    } catch (error) { $('studio-status').textContent = error.message; toast(error.message, true); }
  }

  async function openReplay(id) {
    try {
      const result = await api(`/api/library/replays/${id}`);
      state.replay = result.replay;
      $('replay-title').textContent = `回放 ${state.replay.code}`;
      $('replay-meta').textContent = `${state.replay.players.length} 人 · ${state.replay.chains.length} 条接龙 · ${state.replay.created_at.slice(0, 16).replace('T', ' ')}`;
      const list = $('replay-chains'); list.replaceChildren();
      state.replay.chains.forEach((chain, chainIndex) => {
        const box = node('section', 'replay-chain');
        const head = node('div', 'replay-chain-head'); head.append(node('h2', '', `题目：${chain.prompt || '（未选）'}`), node('span', '', `题主：${chain.owner_name} · ${chain.success ? '匹配通过' : '未通过'}`)); box.append(head);
        const steps = node('div', 'replay-steps');
        chain.entries.forEach((entry, entryIndex) => {
          const step = node('div', `replay-step ${entry.kind}`);
          if (entry.kind === 'draw') {
            const canvas = node('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT; renderDrawing(canvas, entry.drawing); step.append(canvas);
            step.append(node('div', '', `第 ${entryIndex + 1} 棒 · ${entry.player_name} 画`));
            const fav = node('button', 'button button-small button-cream replay-fav', '收藏到画廊'); fav.type = 'button';
            fav.addEventListener('click', async () => { try { await api(`/api/library/replays/${id}/favorite`, 'POST', { chain: chainIndex, entry: entryIndex }); toast('已收藏到画廊'); } catch (error) { toast(error.message, true); } });
            step.append(fav);
          } else {
            step.append(node('div', '', `${entry.player_name} 猜：${entry.text || '（未猜出）'}`));
          }
          steps.append(step);
        });
        box.append(steps); list.append(box);
      });
      $('replay-detail').hidden = false;
    } catch (error) { toast(error.message, true); }
  }
  function closeReplay() { $('replay-detail').hidden = true; state.replay = null; }
  function spectateSteps(demo) {
    const steps = [];
    for (const chain of demo.chains) {
      steps.push({ type: 'prompt', chain });
      chain.entries.forEach((entry) => steps.push({ type: 'entry', chain, entry }));
    }
    return steps;
  }
  function startSpectate() {
    if (!state.replay) return;
    state.spectate = { demo: state.replay, steps: spectateSteps(state.replay), index: -1, playing: true, timer: null, token: 0 };
    $('spectate').hidden = false; $('spectate-title').textContent = `模拟观战 · ${state.replay.code}`; $('spectate-toggle').textContent = '暂停';
    $('spectate-speech').hidden = true;
    nextSpectate();
  }
  function stopSpectate() { if (!state.spectate) return; clearTimeout(state.spectate.timer); state.spectate.token += 1; $('spectate').hidden = true; state.spectate = null; }
  function scheduleSpectate(delay) { if (!state.spectate?.playing) return; clearTimeout(state.spectate.timer); state.spectate.timer = setTimeout(nextSpectate, delay); }
  function nextSpectate() {
    const session = state.spectate; if (!session) return;
    session.index += 1;
    if (session.index >= session.steps.length) { $('spectate-step').textContent = '观战结束'; $('spectate-toggle').textContent = '重播'; session.playing = false; return; }
    const step = session.steps[session.index], canvas = $('spectate-canvas'), speech = $('spectate-speech'); session.token += 1;
    speech.hidden = true;
    if (step.type === 'prompt') {
      canvas.getContext('2d').fillStyle = '#fff'; canvas.getContext('2d').fillRect(0, 0, WIDTH, HEIGHT);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#14132a'; ctx.font = '900 48px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(step.chain.prompt || '（未选题目）', WIDTH / 2, HEIGHT / 2);
      $('spectate-caption').textContent = `${step.chain.owner_name} 的接龙 · 原始题目`;
      $('spectate-step').textContent = `故事 ${session.demo.chains.indexOf(step.chain) + 1} / ${session.demo.chains.length}`;
      scheduleSpectate(2200); return;
    }
    const entry = step.entry;
    if (entry.kind === 'draw') {
      canvas.getContext('2d').clearRect(0, 0, WIDTH, HEIGHT); canvas.getContext('2d').fillStyle = '#fff'; canvas.getContext('2d').fillRect(0, 0, WIDTH, HEIGHT);
      animateDrawing(canvas, entry.drawing, 4200);
      $('spectate-caption').textContent = `${entry.player_name} 画`;
      scheduleSpectate(4600);
    } else {
      const entryPosition = step.chain.entries.indexOf(entry);
      const previous = [...step.chain.entries.slice(0, entryPosition)].reverse().find((item) => item.kind === 'draw');
      renderDrawing(canvas, previous?.drawing || { strokes: [] });
      $('spectate-caption').textContent = `${entry.player_name} 猜`;
      speech.textContent = entry.text || '（未猜出）'; speech.hidden = false;
      scheduleSpectate(3000);
    }
    $('spectate-step').textContent = `${step.chain.owner_name} · ${entry.kind === 'draw' ? '绘画' : '猜词'}`;
  }

  function bind() {
    document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
    $('new-artwork').addEventListener('click', () => openStudio(null));
    $('refresh-replays').addEventListener('click', loadReplays);
    $('close-replay').addEventListener('click', closeReplay);
    $('start-spectate').addEventListener('click', startSpectate);
    $('spectate-close').addEventListener('click', stopSpectate);
    $('spectate-toggle').addEventListener('click', () => {
      if (!state.spectate) return;
      if (state.spectate.index >= state.spectate.steps.length) { state.spectate.index = -1; state.spectate.playing = true; $('spectate-toggle').textContent = '暂停'; nextSpectate(); return; }
      state.spectate.playing = !state.spectate.playing; $('spectate-toggle').textContent = state.spectate.playing ? '暂停' : '继续'; if (state.spectate.playing) nextSpectate();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.spectate) { stopSpectate(); return; }
      if (!$('replay-detail').hidden) { closeReplay(); return; }
      if (state.studio) closeStudio();
    });
  }

  bind();
  bindStudio();
  loadAccount();
})();
