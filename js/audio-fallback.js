/*
 * Эмулятор Mega Drive / Genesis (MDJS) — запасной звуковой тракт (ScriptProcessor) на случай, если AudioWorklet недоступен
 * Автор: Alexander Orel
 */
(function (MD) {
"use strict";
// Линейный ресемплер из «родной» частоты чипа в частоту AudioContext. Запас звука ~150 мс.
MD.spNode = function spNode(ctx, srcRate) {
  const sp = ctx.createScriptProcessor(4096, 0, 2); let q = [], qLen = 0, cur = null, pos = 0, started = false;
  sp.port = { postMessage(c) { q.push(c); qLen += c.length / 2; while (qLen > srcRate * 0.5 && q.length > 1) qLen -= q.shift().length / 2; } };
  sp.onaudioprocess = e => {
    const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1), step = srcRate / ctx.sampleRate * (1 + Math.max(-0.02, Math.min(0.02, (qLen - srcRate * 0.15) / srcRate * 0.1)));
    if (!started) { if (qLen < srcRate * 0.15) { L.fill(0); R.fill(0); return; } started = true; }
    for (let i = 0; i < L.length; i++) {
      if (!cur || pos >= cur.length / 2 - 1) { if (cur) { pos -= cur.length / 2 - 1; qLen -= cur.length / 2; cur = null; } if (q.length) cur = q.shift(); else { started = false; window.__underruns = (window.__underruns || 0) + 1; L.fill(0, i); R.fill(0, i); return; } }
      const p = pos | 0, f = pos - p; L[i] = (cur[2 * p] + (cur[2 * p + 2] - cur[2 * p]) * f) / 32768; R[i] = (cur[2 * p + 1] + (cur[2 * p + 3] - cur[2 * p + 1]) * f) / 32768; pos += step;
    }
  };
  return sp;
};
})(window.MD = window.MD || {});
