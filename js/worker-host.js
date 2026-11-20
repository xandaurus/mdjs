/*
 * Эмулятор Mega Drive / Genesis (MDJS) — главная сторона Web Worker: создание воркера из файлов ядра,
 * получение кадров, передача ввода и сохранений. Если воркер недоступен — приложение работает на главном потоке.
 * Автор: Alexander Orel
 */
(function (MD) {
"use strict";
const WORKER_PARTS = ['cpu-m68k', 'cpu-z80', 'vdp', 'ym2612', 'psg', 'sound', 'genesis', 'state', 'emu-worker'];
MD.workerSupported = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && !!(window.URL && URL.createObjectURL) && !window.MD_NO_WORKER;   // MD_NO_WORKER=true — принудительно главный поток (отладка)
// Собираем исходник воркера из тех же функций ядра, что выполняются на главном потоке (дубликатов кода нет).
MD.createEmuWorker = function () {
  const byName = new Map(MD.defs); const parts = ['"use strict";var MD=self.MD={define:function(n,f){f(MD);}};'];
  for (const n of WORKER_PARTS) { const fn = byName.get(n); if (!fn) throw new Error('нет части ядра: ' + n); parts.push('MD.define(' + JSON.stringify(n) + ',' + fn.toString() + ');'); }
  const url = URL.createObjectURL(new Blob([parts.join('\n')], { type: 'text/javascript' }));
  const w = new Worker(url); w.__url = url; return w;
};
})(window.MD = window.MD || {});
