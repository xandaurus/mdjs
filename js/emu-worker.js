/*
 * Эмулятор Mega Drive / Genesis (MDJS) — код Web Worker: вся эмуляция (процессоры, видео, звук) работает здесь,
 * главный поток занят только интерфейсом. Этот файл подключается и на странице (где ничего не делает),
 * и собирается в воркер вместе с файлами ядра (см. worker-host.js).
 * Автор: Alexander Orel
 */
MD.define('emu-worker', function (MD) {
"use strict";
if (typeof WorkerGlobalScope === 'undefined' || !(self instanceof WorkerGlobalScope)) return;   // на главном потоке — ничего не делаем
const { Genesis, Sound, saveState, loadState } = MD;
let g = null, snd = null, timer = 0, pad = 0, paused = false, lastW = 0, FRAME = 20, acc = 0, last = 0, audioPort = null, viaMain = false, ms = 0, failed = false;

function sendAudio() {
  const k = snd.wpos - lastW; if (k <= 0) return; const c = new Int16Array(k * 2), M = snd.RING - 1;
  for (let i = 0; i < k; i++) { const p = ((lastW + i) & M) * 2; c[2 * i] = snd.buf[p]; c[2 * i + 1] = snd.buf[p + 1]; }
  lastW = snd.wpos;
  if (audioPort) audioPort.postMessage(c, [c.buffer]); else if (viaMain) postMessage({ type: 'audio', buf: c }, [c.buffer]);
}
function postFrame() {
  const fb = g.fb.slice(); postMessage({ type: 'frame', fb, fbW: g.fbW, h: g.activeLines, frame: g.frame, ms, audio: snd.wpos }, [fb.buffer]);
}
function tick() {
  timer = setTimeout(tick, 4);
  if (!g || failed) return;
  const now = performance.now(); if (paused) { last = now; return; }
  const t0 = now; acc += Math.min(now - last, 100); last = now;
  let n = 0;
  try {
    while (acc >= FRAME && n < 4) { g.pad[0] = pad; g.render = acc < 2 * FRAME; g.runFrame(); acc -= FRAME; n++; sendAudio(); }
    g.render = true; if (n === 4) acc = 0;
  } catch (e) { failed = true; postMessage({ type: 'error', message: String(e && e.message || e) }); return; }
  if (n) { const dt = performance.now() - t0; ms = (ms || dt) * 0.95 + dt * 0.05; postFrame(); }
}
self.onmessage = e => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      clearTimeout(timer); failed = false; paused = false; pad = 0;
      try { g = new Genesis(m.rom, { region: m.region }); snd = new Sound(g); g.cpu.fast = !!m.fast; } catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); return; }
      FRAME = 1000 * g.lines * 488 / snd.ymClk; lastW = 0; acc = 0; audioPort = null; viaMain = false;
      postMessage({ type: 'ready', pal: g.pal, rate: snd.rate });
      break;
    case 'go': audioPort = m.port || null; viaMain = !!m.viaMain; last = performance.now(); acc = 0; clearTimeout(timer); timer = setTimeout(tick, 0); break;
    case 'pad': pad = m.v; break;
    case 'pause': paused = !!m.v; last = performance.now(); break;
    case 'save': if (g) postMessage({ type: 'saved', state: saveState(g) }); break;
    case 'load': if (g) { loadState(g, m.state); lastW = snd.wpos; postMessage({ type: 'loaded' }); } break;
    case 'stop': clearTimeout(timer); g = null; snd = null; break;
  }
};
});
