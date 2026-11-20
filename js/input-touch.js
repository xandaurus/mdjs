/*
 * Эмулятор Mega Drive / Genesis (MDJS) — сенсорные кнопки и «скользящая» крестовина
 * Автор: Alexander Orel
 */
(function (MD) {
"use strict";
const $ = MD.$, touch = MD.touch;
const TB = { up: 1, down: 2, left: 4, right: 8, b: 0x10, c: 0x20, a: 0x40, start: 0x80 };
const held = new Map();
function recompute() { let v = 0; for (const m of held.values()) v |= m; touch.v = v; }
document.querySelectorAll('#touch [data-k]').forEach(el => {
  const m = TB[el.dataset.k];
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); held.set(e.pointerId, m); recompute(); if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {} });
  const up = e => { held.delete(e.pointerId); recompute(); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', e => e.preventDefault());
});
if (matchMedia('(pointer: coarse)').matches) $('touch').hidden = false;
$('tt').onclick = () => { $('touch').hidden = !$('touch').hidden; };

// ---- запрет контекстного меню, выделения, двойного тапа и масштабирования в игровой области
for (const id of ['stage', 'touch', 'screen', 'fsbar', 'ctl']) {
  const el = $(id); if (!el) continue;
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('selectstart', e => e.preventDefault());
  el.addEventListener('dragstart', e => e.preventDefault());
}
for (const id of ['stage', 'touch']) {
  const el = $(id); if (!el) continue;
  const skip = e => e.target.closest && e.target.closest('#fsbar');   // клики по паузе/выходу должны работать
  el.addEventListener('touchstart', e => { if (!skip(e) && e.cancelable) e.preventDefault(); }, { passive: false });
  el.addEventListener('touchend', e => { if (!skip(e) && e.cancelable) e.preventDefault(); }, { passive: false });
}
document.addEventListener('gesturestart', e => e.preventDefault());   // iOS pinch-zoom

// ---- скользящая крестовина: вся площадка — одна зона, направление следует за пальцем
(() => {
  const dp = document.querySelector('#touch .dp'); if (!dp) return;
  const arrows = { up: dp.querySelector('[data-d=up]'), down: dp.querySelector('[data-d=down]'), left: dp.querySelector('[data-d=left]'), right: dp.querySelector('[data-d=right]') };
  let pid = null;
  function dir(e) {
    const r = dp.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), len = Math.hypot(dx, dy);
    if (len < r.width * 0.12) return 0;                       // мёртвая зона в центре
    const c = dx / len, s = dy / len, T = 0.38;                // секторы ~±68° перекрываются -> диагонали
    return (s < -T ? 1 : 0) | (s > T ? 2 : 0) | (c < -T ? 4 : 0) | (c > T ? 8 : 0);
  }
  function apply(m) {
    held.set('dp', m); recompute();
    arrows.up.classList.toggle('on', !!(m & 1)); arrows.down.classList.toggle('on', !!(m & 2)); arrows.left.classList.toggle('on', !!(m & 4)); arrows.right.classList.toggle('on', !!(m & 8));
  }
  dp.addEventListener('pointerdown', e => { if (pid !== null) return; e.preventDefault(); pid = e.pointerId; try { dp.setPointerCapture(pid); } catch (_) {} apply(dir(e)); if (navigator.vibrate) try { navigator.vibrate(6); } catch (_) {} });
  dp.addEventListener('pointermove', e => { if (e.pointerId !== pid) return; e.preventDefault(); apply(dir(e)); });
  const up = e => { if (e.pointerId !== pid) return; pid = null; held.delete('dp'); recompute(); for (const a of Object.values(arrows)) a.classList.remove('on'); };
  dp.addEventListener('pointerup', up); dp.addEventListener('pointercancel', up); dp.addEventListener('lostpointercapture', up);
})();
})(window.MD = window.MD || {});
