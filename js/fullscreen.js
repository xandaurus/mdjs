/*
 * Эмулятор Mega Drive / Genesis (MDJS) — полноэкранный режим
 * Автор: Alexander Orel
 */
(function (MD) {
"use strict";
const $ = MD.$, S = MD.S;
// Настоящий Fullscreen API, где он есть; для iPhone Safari — CSS-режим «псевдополный экран»
let fsNative = false, touchWasHidden = true;
function inFS() { return document.body.classList.contains('fs'); }
function enterFS() {
  if (!S.g) { MD.flash('Сначала выберите ROM'); return; }
  document.body.classList.add('fs'); $('fsbar').hidden = false; touchWasHidden = $('touch').hidden;
  if (matchMedia('(pointer: coarse)').matches) $('touch').hidden = false;
  const el = $('stage'), rq = el.requestFullscreen || el.webkitRequestFullscreen;
  if (rq) { try { const r = rq.call(el); fsNative = true; if (r && r.catch) r.catch(() => { fsNative = false; }); } catch (e) { fsNative = false; } }
  try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
  try { window.scrollTo(0, 0); } catch (e) {}
}
function exitFS() {
  if (!inFS()) return; document.body.classList.remove('fs'); $('fsbar').hidden = true; $('touch').hidden = touchWasHidden && !matchMedia('(pointer: coarse)').matches;
  try { if (document.fullscreenElement) document.exitFullscreen(); else if (document.webkitFullscreenElement) document.webkitExitFullscreen(); } catch (e) {}
  try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) {}
  fsNative = false;
}
function onFsChange() { if (fsNative && !document.fullscreenElement && !document.webkitFullscreenElement) exitFS(); }
document.addEventListener('fullscreenchange', onFsChange); document.addEventListener('webkitfullscreenchange', onFsChange);
MD.act.enterFS = enterFS; MD.act.exitFS = exitFS; MD.act.inFS = inFS;
$('fs').onclick = () => inFS() ? exitFS() : enterFS(); $('fsx').onclick = exitFS; $('fspause').onclick = () => MD.act.togglePause();
addEventListener('keydown', e => { if (e.code === 'KeyF') { inFS() ? exitFS() : enterFS(); } if (e.code === 'Escape') exitFS(); });
})(window.MD = window.MD || {});
