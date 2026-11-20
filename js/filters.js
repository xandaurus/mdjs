/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Фильтры изображения
 * Автор: Alexander Orel
 * Чисто визуальные эффекты поверх холста (CSS + наложение); на эмуляцию не влияют.
 * Строки развёртки, сглаживание (bilinear), VHS. Выбор сохраняется в localStorage.
 */
(function (MD) {
"use strict";
const KEY = 'mdjs_filters', NAMES = ['sl', 'bl', 'vhs'];
let st = {};
try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { st = {}; }
function layout() {   // наложение точно по области изображения внутри холста (object-fit: contain)
  const c = document.getElementById('screen'), fx = document.getElementById('fx'); if (!c || !fx) return;
  const bw = c.clientWidth, bh = c.clientHeight, r = c.width / c.height; if (!bw || !bh) return;
  let w = bw, h = bw / r; if (bw / bh > r) { h = bh; w = bh * r; }
  fx.style.left = (c.offsetLeft + (bw - w) / 2) + 'px'; fx.style.top = (c.offsetTop + (bh - h) / 2) + 'px';
  fx.style.width = w + 'px'; fx.style.height = h + 'px';
  fx.style.setProperty('--p', Math.max(2, h / c.height) + 'px');   // шаг = одна строка исходного кадра
}
function apply() {
  for (const n of NAMES) document.body.classList.toggle('f-' + n, !!st[n]);
  layout();
}
function init() {
  document.querySelectorAll('#flt input[data-f]').forEach(cb => {
    cb.checked = !!st[cb.dataset.f];
    cb.onchange = () => { st[cb.dataset.f] = cb.checked; try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} apply(); };
  });
  const c = document.getElementById('screen');
  if (window.ResizeObserver && c) new ResizeObserver(layout).observe(c);
  window.addEventListener('resize', layout); document.addEventListener('fullscreenchange', layout);
  setInterval(layout, 500);   // смена размера кадра (224/240 строк), поворот, псевдо-полный экран
  apply();
}
MD.filters = { apply, layout };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window.MD = window.MD || {});
