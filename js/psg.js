/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Звуковой чип PSG SN76489
 * Автор: Alexander Orel
 */
MD.define('psg', function (MD) {
"use strict";
// SN76489 PSG (Sega variant: 16-bit LFSR, white noise taps bit0^bit3). Clocked at Z80 clock (master/15), divide-by-16.
class PSG {
  constructor() { this.reset(); }
  reset() {
    this.tone = new Uint16Array([1, 1, 1, 1]);      // [0..2] tone dividers, [3] noise control (low 3 bits)
    this.vol = new Uint8Array([15, 15, 15, 15]);
    this.cnt = new Int32Array(4); this.out = new Int8Array(4).fill(1);
    this.lfsr = 0x8000; this.latch = 0; this.frac = 0;
    this.LV = new Float32Array(16); for (let i = 0; i < 15; i++) this.LV[i] = Math.pow(10, -2 * i / 20); this.LV[15] = 0;
  }
  write(v) {
    if (v & 0x80) {
      this.latch = (v >> 4) & 7; const ch = this.latch >> 1;
      if (this.latch & 1) this.vol[ch] = v & 15;
      else if (ch === 3) { this.tone[3] = v & 7; this.lfsr = 0x8000; }
      else this.tone[ch] = (this.tone[ch] & 0x3F0) | (v & 15);
    } else {
      const ch = this.latch >> 1;
      if (this.latch & 1) this.vol[ch] = v & 15;
      else if (ch === 3) { this.tone[3] = v & 7; this.lfsr = 0x8000; }
      else this.tone[ch] = (this.tone[ch] & 15) | ((v & 0x3F) << 4);
    }
  }
  tick() {   // one divide-by-16 step
    for (let c = 0; c < 3; c++) {
      if (--this.cnt[c] <= 0) { this.cnt[c] = this.tone[c] || 1024; this.out[c] = -this.out[c]; }
    }
    if (--this.cnt[3] <= 0) {
      const nf = this.tone[3] & 3; this.cnt[3] = nf === 3 ? (this.tone[2] || 1024) * 1 : (16 << nf);
      // noise flips every 2*cnt in real chip; flip output on each reload
      this.nout = !this.nout;
      if (this.nout) {
        const fb = (this.tone[3] & 4) ? ((this.lfsr ^ (this.lfsr >> 3)) & 1) : (this.lfsr & 1);
        this.lfsr = (this.lfsr >> 1) | (fb << 15); this.out[3] = (this.lfsr & 1) ? 1 : -1;
      }
    }
  }
  // returns mono sample in about [-1,1]*0.5, averaging ticks that elapse in 'ticksPerSample'
  sample(tps) {
    this.frac += tps; let n = this.frac | 0; this.frac -= n; if (n < 1) n = 1; // always >=1
    let s = 0;
    for (let i = 0; i < n; i++) {
      this.tick();
      for (let c = 0; c < 4; c++) s += this.out[c] * this.LV[this.vol[c]];
    }
    return s / n * 0.18;
  }
}
MD.PSG = PSG;

});
