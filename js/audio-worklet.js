/*
 * Эмулятор Mega Drive / Genesis (MDJS) — звуковой поток AudioWorklet
 * Автор: Alexander Orel
 *
 * Один файл работает в двух ролях:
 *  1) на странице он подключается обычным <script> и только публикует MD.workletSource
 *     (текст процессора; из него строится data:-URL, т.к. отдельные файлы нельзя грузить в worklet с file://);
 *  2) тот же текст исполняется внутри AudioWorklet.
 */
(function (MD) {
  "use strict";
  function gen_audio_processor() {
    class GenAudio extends AudioWorkletProcessor {
      constructor(o) {
        super(); this.srcRate = o.processorOptions.srcRate; this.q = []; this.qLen = 0; this.pos = 0; this.cur = null; this.prev = [0, 0]; this.started = false; this.und = 0; this.drp = 0; this.n = 0; this.ema = 0; this.und = 0; this.drp = 0; this.n = 0;
        const push = c => {
          this.q.push(c); this.qLen += c.length / 2;
          const maxF = this.srcRate * 0.35;   // отбрасываем самое старое при запасе > 500 мс
          while (this.qLen > maxF && this.q.length > 1) { const d = this.q.shift(); this.qLen -= d.length / 2; this.drp++; }
        };
        // звук приходит либо через главный порт, либо напрямую из воркера эмуляции (отдельный MessagePort)
        this.port.onmessage = e => {
          const d = e.data;
          if (d && d.audioPort) d.audioPort.onmessage = ev => push(ev.data); else push(d);
        };
      }
      process(_, outs) {
        const o = outs[0], L = o[0], R = o[1];
        // подстройка скорости чтения под заполнение очереди (цель ~120 мс): часы эмуляции и звуковой карты расходятся, без этого очередь растёт (звук отстаёт от картинки) или пустеет (щелчки)
        const tgt = this.srcRate * 0.09; this.ema += (this.qLen - this.ema) * 0.02; const adj = Math.max(-0.03, Math.min(0.03, (this.ema - tgt) / this.srcRate * 0.3)), step = this.srcRate / sampleRate * (1 + adj);
        if (!this.started) { if (this.qLen < this.srcRate * 0.06) { L.fill(0); R.fill(0); return true; } this.started = true; }
        for (let i = 0; i < L.length; i++) {
          if (!this.cur || this.pos >= this.cur.length / 2 - 1) {
            if (this.cur) { this.pos -= this.cur.length / 2; this.prev = [this.cur[this.cur.length - 2], this.cur[this.cur.length - 1]]; this.cur = null; }
            if (this.q.length) { this.cur = this.q.shift(); this.qLen -= this.cur.length / 2; }
            else { this.started = false; this.und++; L.fill(0, i); R.fill(0, i); return true; }
          }
          const p = Math.floor(this.pos), f = this.pos - p;
          const a0 = p >= 0 ? this.cur[2 * p] : this.prev[0], a1 = this.cur[2 * p + 2], b0 = p >= 0 ? this.cur[2 * p + 1] : this.prev[1], b1 = this.cur[2 * p + 3];
          L[i] = (a0 + (a1 - a0) * f) / 32768; R[i] = (b0 + (b1 - b0) * f) / 32768; this.pos += step;
        }
        if (++this.n % 100 === 0) this.port.postMessage({ stat: 1, ms: Math.round(this.qLen / this.srcRate * 1000), und: this.und, drp: this.drp });
        return true;
      }
    }
    registerProcessor('gen-audio', GenAudio);
  }
  if (typeof AudioWorkletProcessor === 'undefined') {
    MD.workletSource = '(' + gen_audio_processor.toString() + ')();';
    MD.workletUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(MD.workletSource);
  } else { gen_audio_processor(); }
})(typeof window !== 'undefined' ? (window.MD = window.MD || {}) : {});
