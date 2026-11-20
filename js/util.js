/*
 * Эмулятор Mega Drive / Genesis (MDJS) — общее состояние и вспомогательные функции интерфейса
 * Автор: Alexander Orel
 */
window.MD = window.MD || {};
// Ядро эмулятора регистрируется через MD.define: код выполняется на главном потоке (запасной режим),
// а текст функций затем собирается в Web Worker (см. worker-host.js) — один и тот же код без дубликатов.
MD.defs = [];
MD.define = function (name, fn) { MD.defs.push([name, fn]); fn(MD); };
(function (MD) {
"use strict";
const $ = id => document.getElementById(id);
MD.$ = $;
// Общее состояние приложения (читается всеми файлами интерфейса)
MD.S = { g: null, snd: null, actx: null, node: null, last: 0, acc: 0, running: false, lastW: 0, muted: false, paused: false, romId: '0', slot: null, FRAME: 1000 / 50 };
MD.touch = { v: 0 };      // биты кнопок с сенсорного экрана
MD.act = {};              // действия (заполняются остальными файлами): doSave, doLoad, togglePause, toggleMute, enterFS, exitFS, inFS
MD.flash = function flash(t) { const el = $('toast'); el.textContent = t; el.style.opacity = 1; clearTimeout(flash.t); flash.t = setTimeout(() => el.style.opacity = 0, 1800); };
window.__touch = MD.touch;
})(window.MD = window.MD || {});
