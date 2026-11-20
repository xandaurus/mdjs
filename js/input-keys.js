/*
 * Эмулятор Mega Drive / Genesis (MDJS) — клавиатура и геймпад
 * Автор: Alexander Orel
 */
(function (MD) {
"use strict";
const S = MD.S;
const KEYS = { ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3, KeyX: 4, KeyC: 5, KeyZ: 6, Enter: 7 };
const keys = new Set();
addEventListener('keydown', e => {
  if (e.code === 'F5') { e.preventDefault(); MD.act.doSave(); }
  if (e.code === 'F8') { e.preventDefault(); MD.act.doLoad(); }
  if (e.code === 'KeyP') MD.act.togglePause();
  if (e.code in KEYS) { keys.add(e.code); e.preventDefault(); }
  if (e.code === 'KeyM') MD.act.toggleMute();
});
addEventListener('keyup', e => { if (e.code in KEYS) { keys.delete(e.code); e.preventDefault(); } });
MD.updatePad = function updatePad() {
  let v = 0; for (const k of keys) v |= 1 << KEYS[k];
  try { const gp = (navigator.getGamepads && [...navigator.getGamepads()].find(p => p)); if (gp) { const b = i => gp.buttons[i] && gp.buttons[i].pressed;
    if (b(12) || gp.axes[1] < -0.5) v |= 1; if (b(13) || gp.axes[1] > 0.5) v |= 2; if (b(14) || gp.axes[0] < -0.5) v |= 4; if (b(15) || gp.axes[0] > 0.5) v |= 8;
    if (b(2)) v |= 0x40; if (b(0)) v |= 0x10; if (b(1) || b(3)) v |= 0x20; if (b(9) || b(8)) v |= 0x80; } } catch (e) {}
  if (S.g) S.g.pad[0] = v | (MD.touch.v || 0);
};
})(window.MD = window.MD || {});
