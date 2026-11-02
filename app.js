'use strict';
/* DualCam — grava horizontal (câmera inteira) e vertical 9:16 (recorte) ao mesmo tempo. */

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const even = n => Math.max(2, Math.round(n / 2) * 2);

/* ---------- preferências ---------- */
const DEFAULTS = {
  res: '1920x1080', fps: 30, br: 'auto', cam: '', facing: 'environment',
  audio: true, raw: false, grid: false, showCrop: true, mode: 'both', crop: 0.5
};
const prefs = Object.assign({}, DEFAULTS);
try { Object.assign(prefs, JSON.parse(localStorage.getItem('dualcam.prefs') || '{}')); } catch (e) {}
const savePrefs = () => { try { localStorage.setItem('dualcam.prefs', JSON.stringify(prefs)); } catch (e) {} };

/* ---------- estado ---------- */
const S = {
  stream: null, track: null, caps: {}, settings: {}, adv: {},
  ui: { focusManual: false, expManual: false, wbManual: false },
  recording: false, jobs: [], tick: null, t0: 0, vLoop: false, wake: null,
  results: [], hasSaved: false
};
let applyChain = Promise.resolve();

const video = $('preview'), canvas = $('vcanvas'), ctx = canvas.getContext('2d', { alpha: false });
const overlay = $('cropOverlay'), grid = $('grid'), box = $('cropBox');
const shadeL = $('shadeL'), shadeR = $('shadeR');

/* ---------- utilidades ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const fmtTime = s => { s = Math.floor(s); const m = Math.floor(s / 60); return String(Math.floor(m / 60)).padStart(2, '0') === '00' ? `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const fmtBytes = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(b > 1e8 ? 0 : 1) + ' MB';
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

function pickMime() {
  const list = [
    'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
  ];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function bitrateFor(pixels, fps) {
  if (prefs.br !== 'auto') return Number(prefs.br) * 1e6;
  return Math.round(Math.min(40e6, Math.max(5e6, pixels * fps * 0.12)));
}

/* ---------- gravação em disco (OPFS) com fallback para memória ---------- */
class Sink {
  constructor(name) { this.name = name; this.chunks = []; this.size = 0; this.mode = 'mem'; this.q = Promise.resolve(); this.err = null; }
  async open() {
    try {
      const root = await navigator.storage.getDirectory();
      this.fh = await root.getFileHandle(this.name, { create: true });
      this.w = await this.fh.createWritable();
      this.mode = 'opfs';
    } catch (e) { this.mode = 'mem'; }
  }
  write(blob) {
    this.size += blob.size;
    if (this.mode === 'opfs') this.q = this.q.then(() => this.w.write(blob)).catch(e => { this.err = e; });
    else this.chunks.push(blob);
  }
  async close(type) {
    if (this.mode === 'opfs') {
      await this.q;
      await this.w.close();
      const f = await this.fh.getFile();
      return new File([f], this.name, { type });
    }
    return new File(this.chunks, this.name, { type });
  }
}
async function removeOpfs(names) {
  try {
    const root = await navigator.storage.getDirectory();
    if (!names) { for await (const [n] of root.entries()) if (n.startsWith('CAM_')) await root.removeEntry(n).catch(() => {}); }
    else for (const n of names) await root.removeEntry(n).catch(() => {});
  } catch (e) {}
}

/* ---------- câmera ---------- */
async function startCamera() {
  stopCamera();
  await sleep(400); // o Android precisa de um instante para liberar a câmera antes de reabrir
  const [w0, h0] = prefs.res.split('x').map(Number), f0 = Number(prefs.fps);
  const vid = (useDev, w, h, fps) => {
    const v = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } };
    if (useDev && prefs.cam) v.deviceId = { exact: prefs.cam }; else v.facingMode = { ideal: prefs.facing };
    return v;
  };
  const aud = () => ({ echoCancellation: !prefs.raw, noiseSuppression: !prefs.raw, autoGainControl: !prefs.raw, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } });

  // do pedido do usuário para opções mais leves, caso o aparelho não consiga abrir
  const modes = [[w0, h0, f0]];
  if (f0 > 30) modes.push([w0, h0, 30]);
  if (w0 > 1920) { modes.push([1920, 1080, f0]); if (f0 > 30) modes.push([1920, 1080, 30]); }

  let st = null, lastErr = null, noMic = false, used = null;
  outer:
  for (const m of modes) {
    const tries = [];
    if (prefs.cam) tries.push({ dev: true, audio: prefs.audio });
    tries.push({ dev: false, audio: prefs.audio });
    if (prefs.audio) tries.push({ dev: false, audio: false });
    for (const t of tries) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          st = await navigator.mediaDevices.getUserMedia({ video: vid(t.dev, m[0], m[1], m[2]), audio: t.audio ? aud() : false });
          noMic = prefs.audio && !t.audio; used = m; break outer;
        } catch (e) {
          lastErr = e;
          if (e.name === 'NotReadableError' || e.name === 'AbortError') await sleep(600); else break;
        }
      }
    }
  }
  if (!st) throw lastErr || new Error('Falha ao abrir a câmera');
  if (noMic) toast('Microfone indisponível — gravando sem áudio');
  if (used && (used[0] !== w0 || used[2] !== f0)) toast(`Sem suporte a ${w0 >= 3840 ? '4K' : h0 + 'p'} ${f0} fps neste aparelho — usando ${used[1]}p ${used[2]} fps`, 4500);

  S.stream = st; S.track = st.getVideoTracks()[0]; S.adv = {};
  video.srcObject = st;
  await video.play().catch(() => {});
  if (video.readyState < 1) await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
  S.track.addEventListener('ended', onTrackEnded);

  S.caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  S.settings = S.track.getSettings();
  S.ui.focusManual = S.settings.focusMode === 'manual';
  S.ui.expManual = S.settings.exposureMode === 'manual';
  S.ui.wbManual = S.settings.whiteBalanceMode === 'manual';

  await listCams();
  buildControls();
  layout(); updateInfo(); updateRecEnable();
  requestWake();
}

function stopCamera() {
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null; S.track = null; video.srcObject = null;
}

function onTrackEnded() {
  if (S.recording) { toast('A câmera foi interrompida — gravação finalizada'); stopRec(); }
}

async function listCams() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = $('selCam'); sel.innerHTML = '';
    const cur = S.track.getSettings().deviceId;
    devs.forEach((d, i) => {
      const o = document.createElement('option'); o.value = d.deviceId;
      let l = d.label || `Câmera ${i + 1}`;
      l = l.replace(/camera2?\s*/i, 'Câmera ').replace(/facing back/i, 'traseira').replace(/facing front/i, 'frontal');
      o.textContent = l; if (d.deviceId === cur) o.selected = true; sel.appendChild(o);
    });
  } catch (e) {}
}

/* ---------- controles dinâmicos da câmera ---------- */
function setAdv(patch) {
  Object.assign(S.adv, patch);
  const track = S.track;
  applyChain = applyChain.then(() => track && track.applyConstraints({ advanced: [Object.assign({}, S.adv)] }))
    .catch(e => console.warn('constraint', e));
}
const delAdv = (...k) => k.forEach(x => delete S.adv[x]);

function field(label) { const d = document.createElement('div'); d.className = 'field'; d.append(label); return d; }
function seg(label, opts, cur, pick) {
  const d = field(label), row = document.createElement('div'); row.className = 'seg';
  opts.forEach(o => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = o.t;
    if (o.v === cur) b.classList.add('on'); b.onclick = () => pick(o.v); row.append(b);
  });
  d.append(row); return d;
}
function slider(label, cap, val, fmt, onChange) {
  const d = field(label), out = document.createElement('output'); out.textContent = fmt(val); d.append(out);
  const r = document.createElement('input'); r.type = 'range';
  r.min = cap.min; r.max = cap.max; r.step = cap.step || ((cap.max - cap.min) / 100) || 1; r.value = val;
  r.addEventListener('input', () => { const v = Number(r.value); out.textContent = fmt(v); onChange(v); });
  d.append(r); return d;
}
const num = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();
const shutter = v => { const s = v * 1e-4; return s >= 1 ? s.toFixed(1) + ' s' : '1/' + Math.round(1 / s); };

function buildControls() {
  const host = $('dynControls'); host.innerHTML = '';
  const c = S.caps || {}, st = S.settings || {}, add = el => host.appendChild(el);
  const has = k => c[k] !== undefined;
  const range = k => has(k) && typeof c[k] === 'object' && c[k].max !== undefined && c[k].max > c[k].min;
  const modes = k => Array.isArray(c[k]) ? c[k] : [];

  // foco
  if (modes('focusMode').includes('manual') && modes('focusMode').includes('continuous')) {
    add(seg('Foco', [{ t: 'Auto', v: false }, { t: 'Manual', v: true }], S.ui.focusManual, manual => {
      S.ui.focusManual = manual;
      if (manual) setAdv({ focusMode: 'manual', focusDistance: S.adv.focusDistance ?? st.focusDistance ?? (c.focusDistance ? c.focusDistance.min : 0) });
      else { delAdv('focusDistance'); setAdv({ focusMode: 'continuous' }); }
      buildControls();
    }));
    if (S.ui.focusManual && range('focusDistance'))
      add(slider('Distância do foco', c.focusDistance, S.adv.focusDistance ?? st.focusDistance ?? c.focusDistance.min, v => num(v), v => setAdv({ focusMode: 'manual', focusDistance: v })));
  }

  // exposição / brilho / ISO / obturador
  const canManualExp = modes('exposureMode').includes('manual') && (range('iso') || range('exposureTime'));
  if (canManualExp && modes('exposureMode').includes('continuous')) {
    add(seg('Exposição', [{ t: 'Auto', v: false }, { t: 'Manual', v: true }], S.ui.expManual, manual => {
      S.ui.expManual = manual;
      if (manual) {
        delAdv('exposureCompensation');
        const p = { exposureMode: 'manual' };
        if (range('iso')) p.iso = S.adv.iso ?? st.iso ?? c.iso.min;
        if (range('exposureTime')) p.exposureTime = S.adv.exposureTime ?? st.exposureTime ?? c.exposureTime.min;
        setAdv(p);
      } else { delAdv('iso', 'exposureTime'); setAdv({ exposureMode: 'continuous' }); }
      buildControls();
    }));
  }
  if (S.ui.expManual && canManualExp) {
    if (range('iso')) add(slider('ISO', c.iso, S.adv.iso ?? st.iso ?? c.iso.min, v => String(Math.round(v)), v => setAdv({ exposureMode: 'manual', iso: v })));
    if (range('exposureTime')) add(slider('Obturador', c.exposureTime, S.adv.exposureTime ?? st.exposureTime ?? c.exposureTime.min, shutter, v => setAdv({ exposureMode: 'manual', exposureTime: v })));
  } else if (range('exposureCompensation')) {
    add(slider('Brilho / exposição (EV)', c.exposureCompensation, S.adv.exposureCompensation ?? st.exposureCompensation ?? 0, v => (v > 0 ? '+' : '') + num(v, 1), v => setAdv({ exposureCompensation: v })));
  }
  if (range('brightness')) add(slider('Brilho da imagem', c.brightness, st.brightness ?? c.brightness.min, v => num(v, 1), v => setAdv({ brightness: v })));

  // balanço de branco
  if (modes('whiteBalanceMode').includes('manual') && modes('whiteBalanceMode').includes('continuous') && range('colorTemperature')) {
    add(seg('Balanço de branco', [{ t: 'Auto', v: false }, { t: 'Manual', v: true }], S.ui.wbManual, manual => {
      S.ui.wbManual = manual;
      if (manual) setAdv({ whiteBalanceMode: 'manual', colorTemperature: S.adv.colorTemperature ?? st.colorTemperature ?? 5000 });
      else { delAdv('colorTemperature'); setAdv({ whiteBalanceMode: 'continuous' }); }
      buildControls();
    }));
    if (S.ui.wbManual)
      add(slider('Temperatura', c.colorTemperature, S.adv.colorTemperature ?? st.colorTemperature ?? 5000, v => Math.round(v) + ' K', v => setAdv({ whiteBalanceMode: 'manual', colorTemperature: v })));
  }

  // zoom, imagem, lanterna
  if (range('zoom')) add(slider('Zoom', c.zoom, S.adv.zoom ?? st.zoom ?? c.zoom.min, v => num(v, 1) + '×', v => setAdv({ zoom: v })));
  [['contrast', 'Contraste'], ['saturation', 'Saturação'], ['sharpness', 'Nitidez']].forEach(([k, l]) => {
    if (range(k)) add(slider(l, c[k], st[k] ?? c[k].min, v => num(v, 1), v => setAdv({ [k]: v })));
  });
  if (c.torch) {
    const d = document.createElement('label'); d.className = 'check';
    const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!S.adv.torch;
    i.onchange = () => setAdv({ torch: i.checked }); d.append(i, ' Lanterna'); add(d);
  }
  $('noCaps').hidden = host.children.length > 0;
}

/* ---------- layout do preview / recorte ---------- */
let L = { rw: 0, cw: 0 };
function layout() {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return;
  const W = innerWidth, H = innerHeight, sc = Math.min(W / vw, H / vh);
  const rw = vw * sc, rh = vh * sc, l = (W - rw) / 2, t = (H - rh) / 2;
  for (const el of [overlay, grid]) Object.assign(el.style, { left: l + 'px', top: t + 'px', width: rw + 'px', height: rh + 'px' });
  const cw = Math.min(rw, rh * 9 / 16), bl = (rw - cw) * prefs.crop;
  box.style.left = bl + 'px'; box.style.width = cw + 'px';
  shadeL.style.left = '0'; shadeL.style.width = bl + 'px';
  shadeR.style.left = (bl + cw) + 'px'; shadeR.style.width = Math.max(0, rw - bl - cw) + 'px';
  L = { rw, cw };
  overlay.hidden = !(prefs.showCrop && prefs.mode !== 'h');
  grid.hidden = !prefs.grid;
}
function setCrop(v) {
  prefs.crop = Math.min(1, Math.max(0, v)); savePrefs(); layout();
  $('rngCrop').value = Math.round(prefs.crop * 100);
  $('outCrop').textContent = prefs.crop < .02 ? 'esquerda' : prefs.crop > .98 ? 'direita' : Math.abs(prefs.crop - .5) < .02 ? 'centro' : Math.round(prefs.crop * 100) + '%';
}
(function dragCrop() {
  let sx = 0, s0 = 0, on = false;
  box.addEventListener('pointerdown', e => { on = true; sx = e.clientX; s0 = prefs.crop; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', e => { if (!on) return; const room = L.rw - L.cw; if (room > 0) setCrop(s0 + (e.clientX - sx) / room); });
  const end = () => { on = false; };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
})();

function updateInfo() {
  const st = S.track ? S.track.getSettings() : {}, w = video.videoWidth, h = video.videoHeight;
  $('info').textContent = w ? `${w}×${h}${st.frameRate ? ' · ' + Math.round(st.frameRate) + ' fps' : ''}` : '';
}
function landscapeOK() { return video.videoWidth >= video.videoHeight && video.videoWidth > 0; }
function updateRecEnable() {
  const ok = !!S.stream && landscapeOK() && $('review').hidden;
  $('recBtn').disabled = !ok && !S.recording;
  if (S.stream && !landscapeOK()) toast('Deite o celular (paisagem) para gravar');
}

/* ---------- gravação ---------- */
async function makeJob(kind, mediaStream, bitrate, mime, ts, ext, dims) {
  const sink = new Sink(`CAM_${ts}_${kind}.${ext}`); await sink.open();
  const mr = new MediaRecorder(mediaStream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 256000 });
  const job = { kind, sink, mr, mime, dims };
  mr.ondataavailable = e => { if (e.data && e.data.size) sink.write(e.data); };
  job.done = new Promise(res => { mr.onstop = res; });
  mr.onerror = e => { console.error(e); toast('Erro no gravador ' + kind); };
  return job;
}

function drawLoop() {
  if (!S.vLoop) return;
  const vw = video.videoWidth, vh = video.videoHeight, cw = canvas.width;
  if (vw >= cw && vh) { ctx.drawImage(video, Math.round((vw - cw) * prefs.crop), 0, cw, vh, 0, 0, canvas.width, canvas.height); S.vFrames++; }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(drawLoop); else requestAnimationFrame(drawLoop);
}

/* Recorte vertical sem canvas: VideoFrame com visibleRect (sem cópia de pixels, leve para o celular).
   Se o navegador não suportar, cai para o método com canvas acima. */
const hasCropper = typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined' && typeof VideoFrame !== 'undefined';
function startCropper(track, outW) {
  const proc = new MediaStreamTrackProcessor({ track });
  const gen = new MediaStreamTrackGenerator({ kind: 'video' });
  const ac = new AbortController();
  const ts = new TransformStream({
    transform(frame, ctrl) {
      try {
        const vw = frame.displayWidth, vh = frame.displayHeight;
        const cw = Math.min(outW, vw & ~1);
        const x = Math.min(vw - cw, Math.max(0, Math.round((vw - cw) * prefs.crop))) & ~1;
        const out = new VideoFrame(frame, { visibleRect: { x, y: 0, width: cw, height: vh & ~1 } });
        S.vFrames++;
        ctrl.enqueue(out);
      } catch (e) { console.warn('crop', e); }
      finally { frame.close(); }
    }
  });
  proc.readable.pipeThrough(ts).pipeTo(gen.writable, { signal: ac.signal }).catch(() => {});
  return { track: gen, stop() { ac.abort(); try { gen.stop(); } catch (e) {} } };
}

function setLocked(lock) {
  ['selRes', 'selFps', 'selBr', 'selCam', 'chkAudio', 'chkRawAudio', 'flipBtn', 'btnReset'].forEach(id => $(id).disabled = lock);
  document.querySelectorAll('#modes button').forEach(b => b.disabled = lock);
}

async function startRec() {
  if (S.recording || !S.stream) return;
  const mime = pickMime();
  if (!mime) { toast('Este navegador não suporta gravação de vídeo'); return; }
  const ext = mime.includes('mp4') ? 'mp4' : 'webm', ts = stamp(), mode = prefs.mode;
  const vw = video.videoWidth, vh = video.videoHeight, fps = Number(S.track.getSettings().frameRate) || Number(prefs.fps);

  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (est && est.quota && est.quota - est.usage < 300e6) toast('Pouco espaço livre no aparelho');
  } catch (e) {}

  const jobs = [];
  try {
    const brH = bitrateFor(vw * vh, fps);
    if (mode !== 'v') jobs.push(await makeJob('H', S.stream, brH, mime, ts, ext, `${vw}×${vh}`));
    if (mode !== 'h') {
      const outW = even(Math.min(vw, Math.round(vh * 9 / 16))), outH = even(vh);
      const brV = prefs.br === 'auto' ? bitrateFor(outW * outH, fps) : Math.round(brH * (outW * outH) / (vw * vh) * 1.15);
      let vTrack;
      if (hasCropper) { S.cropper = startCropper(S.track, outW); vTrack = S.cropper.track; }
      else { canvas.width = outW; canvas.height = outH; S.vLoop = true; drawLoop(); vTrack = canvas.captureStream().getVideoTracks()[0]; }
      const vs = new MediaStream([vTrack, ...S.stream.getAudioTracks()]);
      jobs.push(await makeJob('V', vs, brV, mime, ts, ext, `${outW}×${outH}`));
    }
  } catch (e) {
    console.error(e); S.vLoop = false; if (S.cropper) { S.cropper.stop(); S.cropper = null; } toast('Não foi possível iniciar a gravação'); await removeOpfs(jobs.map(j => j.sink.name)); return;
  }

  S.jobs = jobs; S.recording = true; S.t0 = performance.now();
  S.vFrames = 0; S.vN = 0; S.vT = S.t0; S.vf = '';
  jobs.forEach(j => j.mr.start(1000));
  $('recBtn').classList.add('rec'); $('recBadge').hidden = false; setLocked(true);
  S.tick = setInterval(() => {
    const now = performance.now();
    if (mode !== 'h' && now - S.vT >= 1000) { S.vf = ` · V ${Math.round((S.vFrames - S.vN) * 1000 / (now - S.vT))} fps`; S.vN = S.vFrames; S.vT = now; }
    const bytes = S.jobs.reduce((a, j) => a + j.sink.size, 0);
    $('timer').textContent = `${fmtTime((now - S.t0) / 1000)} · ${fmtBytes(bytes)}${S.vf}`;
  }, 250);
  requestWake();
}

async function stopRec() {
  if (!S.recording) return;
  S.recording = false; clearInterval(S.tick);
  $('recBtn').disabled = true;
  S.jobs.forEach(j => { try { if (j.mr.state !== 'inactive') j.mr.stop(); } catch (e) {} });
  await Promise.all(S.jobs.map(j => j.done));
  S.vLoop = false; if (S.cropper) { S.cropper.stop(); S.cropper = null; }
  const results = [];
  for (const j of S.jobs) {
    try {
      const file = await j.sink.close(j.mime.split(';')[0]);
      if (file.size > 0) results.push({ kind: j.kind, file, url: URL.createObjectURL(file), dims: j.dims });
    } catch (e) { console.error(e); toast('Falha ao finalizar o arquivo ' + j.kind); }
  }
  S.jobs = [];
  $('recBtn').classList.remove('rec'); $('recBadge').hidden = true; $('timer').textContent = '00:00';
  setLocked(false);
  if (results.length) showReview(results); else { toast('Nada foi gravado'); updateRecEnable(); }
}

/* ---------- revisão / salvar ---------- */
function showReview(results) {
  S.results = results; S.hasSaved = false;
  const list = $('reviewList'); list.innerHTML = '';
  results.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'item';
    const v = document.createElement('video'); v.src = r.url + '#t=0.1'; v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.onclick = () => (v.paused ? v.play() : v.pause());
    const m = document.createElement('div'); m.className = 'meta';
    m.innerHTML = `<b></b><small>${r.kind === 'H' ? 'Horizontal' : 'Vertical'} · ${r.dims} · ${fmtBytes(r.file.size)}</small>`;
    m.querySelector('b').textContent = r.file.name;
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = true; c.dataset.i = i;
    row.append(v, m, c); list.append(row);
  });
  $('reviewHint').textContent = results.length > 1 ? 'Se o Chrome perguntar, permita baixar vários arquivos. Toque na miniatura para pré-visualizar.' : 'Toque na miniatura para pré-visualizar.';
  $('review').hidden = false; $('recBtn').disabled = true;
}
const selected = () => [...document.querySelectorAll('#reviewList input:checked')].map(c => S.results[Number(c.dataset.i)]);

async function saveSelected() {
  const sel = selected(); if (!sel.length) { toast('Selecione ao menos um vídeo'); return; }
  for (const r of sel) {
    const a = document.createElement('a'); a.href = r.url; a.download = r.file.name;
    document.body.appendChild(a); a.click(); a.remove(); await sleep(900);
  }
  S.hasSaved = true; toast(sel.length > 1 ? 'Vídeos enviados para a pasta Downloads' : 'Vídeo enviado para a pasta Downloads');
}
async function shareSelected() {
  const sel = selected(); if (!sel.length) { toast('Selecione ao menos um vídeo'); return; }
  const files = sel.map(r => r.file);
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); S.hasSaved = true; }
    else toast('Compartilhamento não suportado — use "Salvar"');
  } catch (e) { if (e.name !== 'AbortError') toast('Não foi possível compartilhar'); }
}
function closeReview(discard) {
  if (!discard && !S.hasSaved && !confirm('Você ainda não salvou estes vídeos. Fechar mesmo assim?')) return;
  S.results.forEach(r => URL.revokeObjectURL(r.url));
  const names = S.results.map(r => r.file.name); S.results = [];
  if (discard) removeOpfs(names); else setTimeout(() => removeOpfs(names), 90000);
  $('review').hidden = true; updateRecEnable();
}

/* ---------- tela ligada ---------- */
async function requestWake() {
  try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWake();
    if (!S.stream && $('splash').hidden && !S.recording) startCamera().catch(() => {});
  }
});

/* ---------- ligações da interface ---------- */
function syncUI() {
  $('selRes').value = prefs.res; $('selFps').value = String(prefs.fps); $('selBr').value = String(prefs.br);
  $('chkAudio').checked = prefs.audio; $('chkRawAudio').checked = prefs.raw;
  $('chkGrid').checked = prefs.grid; $('chkCrop').checked = prefs.showCrop;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === prefs.mode));
  setCrop(prefs.crop);
}
let restarting = false, restartAgain = false;
async function restart() {
  if (restarting) { restartAgain = true; return; } // evita aberturas simultâneas da câmera
  restarting = true;
  try {
    do { restartAgain = false; await startCamera(); } while (restartAgain);
  } catch (e) {
    console.error(e); toast('Não foi possível reabrir a câmera: ' + (e && e.name ? e.name : 'erro'), 4500);
  } finally { restarting = false; }
}

$('selRes').onchange = e => { prefs.res = e.target.value; savePrefs(); restart(); };
$('selFps').onchange = e => { prefs.fps = Number(e.target.value); savePrefs(); restart(); };
$('selBr').onchange = e => { prefs.br = e.target.value; savePrefs(); };
$('selCam').onchange = e => { prefs.cam = e.target.value; savePrefs(); restart(); };
$('chkAudio').onchange = e => { prefs.audio = e.target.checked; savePrefs(); restart(); };
$('chkRawAudio').onchange = e => { prefs.raw = e.target.checked; savePrefs(); restart(); };
$('chkGrid').onchange = e => { prefs.grid = e.target.checked; savePrefs(); layout(); };
$('chkCrop').onchange = e => { prefs.showCrop = e.target.checked; savePrefs(); layout(); };
$('rngCrop').oninput = e => setCrop(Number(e.target.value) / 100);
$('flipBtn').onclick = () => { prefs.facing = prefs.facing === 'environment' ? 'user' : 'environment'; prefs.cam = ''; savePrefs(); restart(); };
$('btnReset').onclick = () => { restart(); toast('Câmera restaurada'); };
document.querySelectorAll('#modes button').forEach(b => b.onclick = () => {
  prefs.mode = b.dataset.mode; savePrefs();
  document.querySelectorAll('#modes button').forEach(x => x.classList.toggle('on', x === b)); layout();
});
$('setBtn').onclick = () => { $('sheet').hidden = !$('sheet').hidden; };
$('closeSheet').onclick = () => { $('sheet').hidden = true; };
$('recBtn').onclick = () => (S.recording ? stopRec() : startRec());
$('btnSaveSel').onclick = saveSelected;
$('btnShareSel').onclick = shareSelected;
$('btnDiscard').onclick = () => { if (confirm('Descartar estas gravações?')) closeReview(true); };
$('btnCloseReview').onclick = () => closeReview(false);

video.addEventListener('resize', () => { layout(); updateInfo(); updateRecEnable(); });
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 200));
window.addEventListener('beforeunload', e => { if (S.recording) { e.preventDefault(); e.returnValue = ''; } });

/* instalação (PWA) */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('btnInstall').hidden = false; });
$('btnInstall').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('btnInstall').hidden = true; };
window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; toast('App instalado'); });

/* início */
$('btnStart').onclick = async () => {
  $('splashMsg').textContent = '';
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (e) {}
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
  try {
    await startCamera();
    $('splash').hidden = true;
  } catch (e) {
    console.error(e);
    $('splashMsg').textContent = e && e.name === 'NotAllowedError'
      ? 'Permissão negada. Libere câmera e microfone nas permissões do site e tente de novo.'
      : 'Não foi possível abrir a câmera: ' + (e && e.message ? e.message : e);
  }
};

if (!navigator.mediaDevices || !window.MediaRecorder) {
  $('btnStart').disabled = true;
  $('splashMsg').textContent = 'Este navegador não suporta câmera/gravação. Abra no Chrome para Android.';
}
syncUI();
removeOpfs();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
