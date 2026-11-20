/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Быстрые сохранения состояния
 * Автор: Alexander Orel
 */
MD.define('state', function (MD) {
"use strict";
// Save states: generic deep snapshot of the emulator objects (excluding ROM, framebuffer, audio ring).
const SKIP = new Set(['rom', 'fb', 'bus', 'g', 'buf', 'pal32', 'sound', 'ymWrite', 'psgWrite', 'LV']);
function cap(o) {
  if (o === null || typeof o !== 'object') return typeof o === 'function' ? undefined : o;
  if (ArrayBuffer.isView(o)) return { __t: 1, d: o.slice() };
  if (Array.isArray(o)) return o.map(cap);
  const r = {}; for (const k of Object.keys(o)) { if (SKIP.has(k)) continue; const v = cap(o[k]); if (v !== undefined) r[k] = v; } return r;
}
function res(t, s) {
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (v && v.__t) { t[k].set(v.d); }
    else if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { if (v[i] && typeof v[i] === 'object') { if (v[i].__t) t[k][i].set(v[i].d); else res(t[k][i], v[i]); } else t[k][i] = v[i]; } }
    else if (v && typeof v === 'object') res(t[k], v);
    else t[k] = v;
  }
}
function saveState(g) {
  const s = g.sound;
  return { g: cap(g), cpu: cap(g.cpu), z: cap(s.z), ym: cap(s.ym), psg: cap(s.psg), snd: { bank: s.bank, ymSamples: s.ymSamples, wpos: s.wpos, zt: s.zt }, v: 1 };
}
function loadState(g, st) {
  const s = g.sound; const cpu = g.cpu, z = s.z, ym = s.ym, psg = s.psg;
  res(g, st.g); delete st.g.cpu; res(cpu, st.cpu); res(z, st.z); res(ym, st.ym); res(psg, st.psg);
  s.bank = st.snd.bank; s.ymSamples = st.snd.ymSamples; s.zt = st.snd.zt; s.wpos = st.snd.wpos;
}
MD.saveState = saveState;
MD.loadState = loadState;

});
