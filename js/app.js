/*
 * Эмулятор Mega Drive / Genesis (MDJS) — приложение: загрузка ROM, главный цикл, кнопки интерфейса
 * Автор: Alexander Orel
 */
(function (MD) {
  "use strict";
  const { Genesis, Sound, makePresenter, saveState, loadState } = MD;
  const $ = MD.$, S = MD.S, flash = MD.flash;
  const canvas = $('screen'), present = MD.makeAutoPresenter(canvas), msg = $('msg');

  let wk = null;   // Web Worker с эмуляцией (null — работаем на главном потоке)
  function togglePause() { S.paused = !S.paused; if (wk) wk.postMessage({ type: 'pause', v: S.paused }); $('pause').textContent = S.paused ? 'Продолжить (P)' : 'Пауза (P)'; if (S.actx) S.paused ? S.actx.suspend() : (!S.muted && S.actx.resume()); S.last = performance.now(); }
  function toggleMute() { S.muted = !S.muted; $('mute').textContent = S.muted ? 'Звук: выкл (M)' : 'Звук: вкл (M)'; if (S.actx) S.muted ? S.actx.suspend() : S.actx.resume(); }
  function idb(fn) { try { const r = indexedDB.open('mdjs', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => fn(r.result); } catch (e) {} }
  function putSlot() { idb(db => { try { db.transaction('s', 'readwrite').objectStore('s').put(S.slot, 'slot-' + S.romId); } catch (e) {} }); }
  function doSave() { if (!S.g) return; if (wk) { wk.postMessage({ type: 'save' }); return; } S.slot = saveState(S.g); idb(db => { try { db.transaction('s', 'readwrite').objectStore('s').put(S.slot, 'slot-' + S.romId); } catch (e) {} }); flash('Состояние сохранено (F8 — загрузить)'); }
  function doLoad() {
    if (!S.g) return; const apply = st => { if (wk) { wk.postMessage({ type: 'load', state: st }); return; } loadState(S.g, st); S.lastW = S.snd.wpos; flash('Состояние загружено'); };
    if (S.slot) return apply(S.slot);
    idb(db => { try { const q = db.transaction('s').objectStore('s').get('slot-' + S.romId); q.onsuccess = () => q.result ? (S.slot = q.result, apply(S.slot)) : flash('Нет сохранения'); } catch (e) { flash('Нет сохранения'); } });
  }
  MD.act.togglePause = togglePause; MD.act.toggleMute = toggleMute; MD.act.doSave = doSave; MD.act.doLoad = doLoad;
  $('save').onclick = doSave; $('load').onclick = doLoad; $('pause').onclick = togglePause; $('mute').onclick = toggleMute;

  function header(rom) { return new TextDecoder().decode(rom.subarray(0x120, 0x150)).replace(/\s+/g, ' ').trim(); }
  async function load(file) {
    let rom = new Uint8Array(await file.arrayBuffer());
    if (rom.length >= 0x4200 && rom.length % 0x4000 === 0x200) rom = rom.subarray(0x200);   // убрать SMD-заголовок
    const hd = header(rom), sig = new TextDecoder().decode(rom.subarray(0x100, 0x104));
    if (rom.length < 0x20000 || !/SEGA/.test(sig)) { msg.textContent = 'Это не похоже на ROM Mega Drive (.gen/.md/.bin).'; return; }
    msg.textContent = 'ROM: ' + (hd || 'без названия') + ' (' + (rom.length >> 10) + ' КБ). Данные остаются у вас в браузере.';
    start(rom);
  }
  async function start(rom) {
    S.running = false; stopWorker(); window.__mode = 'main';
    if (S.node) { S.node.disconnect(); S.node = null; }
    { let h = 2166136261 ^ rom.length; for (let i = 0; i < rom.length; i += 61) h = Math.imul(h ^ rom[i], 16777619); S.romId = (h >>> 0).toString(16); S.slot = null; }
    if (MD.workerSupported && await startInWorker(rom)) return;   // эмуляция в отдельном потоке
    S.g = new Genesis(rom, { region: $('region').value }); S.g.cpu.fast = $('cpu').value === '1'; S.FRAME = 1000 * S.g.lines * 488 / (S.g.pal ? 7600489 : 7670454); $('hz').textContent = (S.g.pal ? 'PAL 50 Гц' : 'NTSC 60 Гц'); S.snd = new Sound(S.g); S.lastW = 0;
    try {
      if (!S.actx) S.actx = new AudioContext({ latencyHint: 'interactive' });
      // отдельный файл нельзя грузить в worklet с file:// — используем data:-URL, собранный из audio-worklet.js
      const cands = [MD.workletUrl].filter(Boolean); if (!cands.length) throw new Error('worklet source missing');
      let okW = false, lastErr; for (const u of cands) { try { await S.actx.audioWorklet.addModule(u); okW = true; break; } catch (e) { lastErr = e; } }
      if (!okW) throw lastErr;
      S.node = new AudioWorkletNode(S.actx, 'gen-audio', { outputChannelCount: [2], processorOptions: { srcRate: S.snd.rate } }); S.node.port.onmessage = ev => { if (ev.data && ev.data.stat) window.__aq = ev.data; };
      S.node.connect(S.actx.destination); if (!S.muted) await S.actx.resume();
    } catch (e) {
      try { S.node = MD.spNode(S.actx, S.snd.rate); S.node.connect(S.actx.destination); if (!S.muted) await S.actx.resume(); } catch (e2) { msg.textContent += ' | Звук недоступен: ' + e2.message; }
    }
    $('ctl').hidden = false; $('drop').hidden = true; S.running = true; S.last = performance.now(); S.acc = 0; requestAnimationFrame(loop);
  }

  // ---------- режим Web Worker ----------
  function stopWorker() { if (!wk) return; try { wk.postMessage({ type: 'stop' }); } catch (e) {} wk.terminate(); try { URL.revokeObjectURL(wk.__url); } catch (e) {} wk = null; S.pf = null; }
  function startInWorker(rom) {
    return new Promise(resolve => {
      let w, done = false; try { w = MD.createEmuWorker(); } catch (e) { return resolve(false); }
      const fail = () => { if (done) return; done = true; try { w.terminate(); } catch (e) {} resolve(false); };
      const timer = setTimeout(fail, 4000); w.onerror = fail;
      w.onmessage = ev => { const m = ev.data; if (m.type === 'ready' && !done) { done = true; clearTimeout(timer); wk = w; setupWorkerMode(rom, m).then(() => resolve(true)); } else onWorkerMessage(m); };
      w.postMessage({ type: 'start', rom: new Uint8Array(rom), region: $('region').value, fast: $('cpu').value === '1' });
    });
  }
  async function setupWorkerMode(rom, m) {
    window.__mode = 'worker'; S.g = { pal: m.pal, rom, pad: [0, 0], frame: 0, worker: true }; S.snd = { rate: m.rate, wpos: 0 }; S.lastPad = -1; S.pf = null;
    S.FRAME = 1000 * (m.pal ? 313 : 262) * 488 / (m.pal ? 7600489 : 7670454); $('hz').textContent = (m.pal ? 'PAL 50 Гц' : 'NTSC 60 Гц');
    let go = { type: 'go', viaMain: true }, transfer = [];
    try {
      if (!S.actx) S.actx = new AudioContext({ latencyHint: 'interactive' });
      try {
        const cands = [MD.workletUrl].filter(Boolean); if (!cands.length) throw new Error('worklet source missing');
        let okW = false, lastErr; for (const u of cands) { try { await S.actx.audioWorklet.addModule(u); okW = true; break; } catch (e) { lastErr = e; } }
        if (!okW) throw lastErr;
        S.node = new AudioWorkletNode(S.actx, 'gen-audio', { outputChannelCount: [2], processorOptions: { srcRate: m.rate } }); S.node.port.onmessage = ev => { if (ev.data && ev.data.stat) window.__aq = ev.data; };
        const mc = new MessageChannel(); S.node.port.postMessage({ audioPort: mc.port1 }, [mc.port1]);   // звук идёт из воркера прямо в AudioWorklet
        go = { type: 'go', port: mc.port2 }; transfer = [mc.port2]; window.__audioDirect = true;
      } catch (e) { S.node = MD.spNode(S.actx, m.rate); window.__audioDirect = false; }
      S.node.connect(S.actx.destination); if (!S.muted) await S.actx.resume();
    } catch (e) { msg.textContent += ' | Звук недоступен: ' + e.message; go = { type: 'go' }; transfer = []; }
    wk.postMessage(go, transfer);
    $('ctl').hidden = false; $('drop').hidden = true; S.running = true; if (S.paused) wk.postMessage({ type: 'pause', v: true }); requestAnimationFrame(wloop);
  }
  function onWorkerMessage(m) {
    switch (m.type) {
      case 'frame': S.pf = m; window.__lastFrame = m; window.__frames = m.frame; window.__ms = m.ms; window.__audioFrames = m.audio; if (S.g) S.g.frame = m.frame; break;
      case 'audio': if (S.node) S.node.port.postMessage(m.buf, [m.buf.buffer]); break;
      case 'saved': S.slot = m.state; putSlot(); flash('Состояние сохранено (F8 — загрузить)'); break;
      case 'loaded': flash('Состояние загружено'); break;
      case 'error': msg.textContent += ' | Ошибка эмуляции: ' + m.message; break;
    }
  }
  function wloop() {
    if (!S.running || !wk) return; requestAnimationFrame(wloop);
    MD.updatePad(); const v = S.g.pad[0]; if (v !== S.lastPad) { S.lastPad = v; wk.postMessage({ type: 'pad', v }); }
    const f = S.pf; if (f) { S.pf = null; present({ fb: f.fb, fbW: f.fbW, activeLines: f.h }); }
  }
  function loop(now) {
    if (!S.running) return; requestAnimationFrame(loop); if (S.paused) { S.last = now; return; }
    const g = S.g, tFrame = performance.now(); S.acc += Math.min(now - S.last, 100); S.last = now;
    let n = 0;
    while (S.acc >= S.FRAME && n < 4) { MD.updatePad(); g.render = S.acc < 2 * S.FRAME; g.runFrame(); S.acc -= S.FRAME; n++; sendAudio(); }
    g.render = true; if (n === 4) S.acc = 0;
    if (n) present(g);
    window.__frames = g.frame; window.__audioFrames = S.snd.wpos; if (n) { const dt = performance.now() - tFrame; window.__ms = (window.__ms || dt) * 0.95 + dt * 0.05; }
  }
  function sendAudio() {
    const snd = S.snd, k = snd.wpos - S.lastW; if (k <= 0) return; const c = new Int16Array(k * 2), M = snd.RING - 1;
    for (let i = 0; i < k; i++) { const p = ((S.lastW + i) & M) * 2; c[2 * i] = snd.buf[p]; c[2 * i + 1] = snd.buf[p + 1]; }
    S.lastW = snd.wpos; if (S.node) S.node.port.postMessage(c, [c.buffer]);
  }
  $('file').onchange = e => e.target.files[0] && load(e.target.files[0]);
  const dz = document.body;
  dz.ondragover = e => e.preventDefault(); dz.ondrop = e => { e.preventDefault(); e.dataTransfer.files[0] && load(e.dataTransfer.files[0]); };
  $('region').onchange = () => { if (S.g) start(S.g.rom); };
  try { $('cpu').value = localStorage.getItem('mdjs_fastcpu') === '1' ? '1' : '0'; } catch (e) {}
  $('cpu').onchange = () => { try { localStorage.setItem('mdjs_fastcpu', $('cpu').value); } catch (e) {} if (S.g) start(S.g.rom); };
  $('reset').onclick = () => { if (S.g) start(S.g.rom); };
  window.__emu = () => S.g;
  window.__mode = 'main';
})(window.MD);
