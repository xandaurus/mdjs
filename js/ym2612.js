/*
 * Эмулятор Mega Drive / Genesis (MDJS) — FM-синтезатор YM2612
 * Автор: Alexander Orel
 */
MD.define('ym2612', function (MD) {
"use strict";
// YM2612 (OPN2) – 6 channels x 4 operators, DAC, timers, LFO. One generate() call = one output sample (clock/144).
const SIN = new Float32Array(1024); for (let i = 0; i < 1024; i++) SIN[i] = Math.sin((i + 0.5) / 1024 * 2 * Math.PI);
const EXP = new Float32Array(1024 * 2); for (let i = 0; i < 2048; i++) EXP[i] = Math.pow(2, -i / 64);   // env units: 1/64 octave
const EGINC = [0,1,0,1,0,1,0,1, 0,1,0,1,1,1,0,1, 0,1,1,1,0,1,1,1, 0,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1, 1,1,1,2,1,1,1,2, 1,2,1,2,1,2,1,2, 1,2,2,2,1,2,2,2,
  2,2,2,2,2,2,2,2, 2,2,2,4,2,2,2,4, 2,4,2,4,2,4,2,4, 2,4,4,4,2,4,4,4,
  4,4,4,4,4,4,4,4, 4,4,4,8,4,4,4,8, 4,8,4,8,4,8,4,8, 4,8,8,8,4,8,8,8,
  8,8,8,8,8,8,8,8];
const DT = [null,
  [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7,8,8,8,8],
  [1,1,1,1,2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7,8,8,9,10,11,12,13,14,16,16,16,16],
  [2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7,8,8,9,10,11,12,13,14,16,17,19,20,22,22,22,22]];
const LFO_PER = [108, 77, 71, 67, 62, 44, 8, 5];
const AMS_SH = [8, 3, 1, 0];
const FMS = [0, 3.4, 6.7, 10, 14, 20, 40, 80];   // cents peak
// LFO PM: 32-step quantised triangle (LFO_PM = counter >> 2), applied as an integer F-number offset (no per-sample float math).
const PM_W = new Float64Array(32); for (let s = 0; s < 32; s++) { const k = s & 7, q = s >> 3; const v = (q & 1) ? (7 - k) : k; PM_W[s] = (q & 2 ? -v : v) / 7; }
const PM_MUL = []; for (let f = 0; f < 8; f++) { const a = new Float64Array(32); for (let s = 0; s < 32; s++) a[s] = Math.pow(2, FMS[f] * PM_W[s] / 1200) - 1; PM_MUL.push(a); }
const OPMAP = [0, 2, 1, 3];                          // register slot offset -> operator index
// states
const ATT = 0, DEC = 1, SUS = 2, REL = 3, OFF = 4;

const h = x => x / 2;   // индекс модуляции (выход оператора / 2)
class Op {
  constructor() { this.dt = 0; this.mul = 1; this.tl = 0; this.ks = 0; this.ar = 0; this.am = 0; this.d1r = 0; this.d2r = 0; this.d1l = 0; this.rr = 0; this.ssg = 0;
    this.ph = 0; this.inc = 0; this.env = 1023; this.state = OFF; this.key = 0; this.o = 0; this.o1 = 0; this.cnt = 0; this.rate = 0; this.sl = 0; }
}
class YM2612 {
  constructor() { this.reset(); }
  reset() {
    this.regs = [new Uint8Array(256), new Uint8Array(256)];
    this.op = []; for (let c = 0; c < 6; c++) { const a = []; for (let o = 0; o < 4; o++) a.push(new Op()); this.op.push(a); }
    this.fn = new Uint16Array(6); this.blk = new Uint8Array(6); this.fb = new Uint8Array(6); this.alg = new Uint8Array(6);
    this.pan = new Uint8Array(6).fill(3); this.ams = new Uint8Array(6); this.fms = new Uint8Array(6);
    this.ch3fn = new Uint16Array(4); this.ch3blk = new Uint8Array(4); this.mode3 = 0;
    this.latch = [0, 0]; this.dacEn = 0; this.dac = 0;
    this.ta = 0; this.tb = 0; this.taCnt = 0; this.tbCnt = 0; this.taOn = 0; this.tbOn = 0; this.taEn = 0; this.tbEn = 0; this.status = 0;
    this.egTimer = 0; this.egCnt = 0; this.lfoOn = 0; this.lfoFreq = 0; this.lfoCnt = 0; this.lfoPos = 0;
    this.sub = 0; this.chOut = new Float32Array(6);
  }
  read() { return this.status; }
  write(port, v) {
    v &= 0xFF;
    if (!(port & 1)) { this.latch[port >> 1] = v; return; }
    const part = port >> 1, a = this.latch[part]; this.regs[part][a] = v;
    if (part === 0 && a < 0x30) return this.sys(a, v);
    if (a < 0x30) return;
    let ch = a & 3; if (ch === 3) return; ch += part * 3;
    const o = OPMAP[(a >> 2) & 3], op = this.op[ch][o];
    switch (a & 0xF0) {
      case 0x30: op.dt = (v >> 4) & 7; op.mul = v & 15; this.updInc(ch); break;
      case 0x40: op.tl = v & 0x7F; break;
      case 0x50: op.ks = v >> 6; op.ar = v & 31; break;
      case 0x60: op.am = v >> 7; op.d1r = v & 31; break;
      case 0x70: op.d2r = v & 31; break;
      case 0x80: op.d1l = v >> 4; op.rr = v & 15; op.sl = op.d1l === 15 ? 0x3E0 : op.d1l << 5; break;
      case 0x90: op.ssg = v & 15; break;
      case 0xA0: case 0xB0: this.chreg(part, a, v); break;
    }
  }
  chreg(part, a, v) {
    const c = a & 3; if (c === 3) return; const ch = c + part * 3;
    switch (a) {
      case 0xA0: case 0xA1: case 0xA2: case 0x1A0: break;
    }
    const lo = a & 0xFC;
    if (lo === 0xA0) { this.fn[ch] = ((this.hi || 0) << 8) | v; this.fn[ch] = ((this.hiv[part][c] & 7) << 8) | v; this.blk[ch] = (this.hiv[part][c] >> 3) & 7; this.updInc(ch); }
    else if (lo === 0xA4) { this.hiv[part][c] = v; }
    else if (lo === 0xA8) { if (part === 0) { const i = [2, 0, 1][c]; this.ch3fn[i] = ((this.ch3hi[c] & 7) << 8) | v; this.ch3blk[i] = (this.ch3hi[c] >> 3) & 7; this.updInc(2); } }
    else if (lo === 0xAC) { if (part === 0) this.ch3hi[c] = v; }
    else if (lo === 0xB0 || lo === 0xB4) { if (a < 0xB4) { this.fb[ch] = (v >> 3) & 7; this.alg[ch] = v & 7; } else { this.pan[ch] = v >> 6; this.ams[ch] = (v >> 4) & 3; { const f = v & 7; if (f !== this.fms[ch]) { this.fms[ch] = f; this.updInc(ch); } } } }
  }
  sys(a, v) {
    switch (a) {
      case 0x22: { const was = this.lfoOn; this.lfoOn = (v >> 3) & 1; this.lfoFreq = v & 7; if (!this.lfoOn) { this.lfoPos = 0; this.lfoCnt = 0; } if (was !== this.lfoOn) for (let c = 0; c < 6; c++) if (this.fms[c]) this.updInc(c); break; }
      case 0x24: this.ta = (this.ta & 3) | (v << 2); break;
      case 0x25: this.ta = (this.ta & 0x3FC) | (v & 3); break;
      case 0x26: this.tb = v; break;
      case 0x27: {
        if ((v & 1) && !this.taOn) this.taCnt = 1024 - this.ta; this.taOn = v & 1;
        if ((v & 2) && !this.tbOn) this.tbCnt = (256 - this.tb) * 16; this.tbOn = (v >> 1) & 1;
        this.taEn = (v >> 2) & 1; this.tbEn = (v >> 3) & 1;
        if (v & 0x10) this.status &= ~1; if (v & 0x20) this.status &= ~2;
        const m = (v >> 6) & 3; if (m !== this.mode3) { this.mode3 = m; this.updInc(2); } break;
      }
      case 0x28: {
        let c = v & 7; if ((c & 3) === 3) return; if (c >= 4) c--;
        for (let o = 0; o < 4; o++) this.keyOp(this.op[c][o], (v >> (4 + o)) & 1, c);
        break;
      }
      case 0x2A: this.dac = v; break;
      case 0x2B: this.dacEn = v >> 7; break;
    }
  }
  keyOp(op, on, ch) {
    if (on && !op.key) { op.ph = 0; op.state = ATT; this.rateCalc(op, ch); if (this.arRate(op, ch) >= 62) { op.env = 0; op.state = DEC; } }
    else if (!on && op.key) { if (op.state !== OFF) op.state = REL; }
    op.key = on;
  }
  kc(ch, o) { const fn = (this.mode3 && ch === 2) ? this.ch3fn[o] : this.fn[ch]; const bl = (this.mode3 && ch === 2) ? this.ch3blk[o] : this.blk[ch];
    const f11 = (fn >> 10) & 1, f10 = (fn >> 9) & 1, f9 = (fn >> 8) & 1, f8 = (fn >> 7) & 1; const n3 = (f11 & (f10 | f9 | f8)) | ((!f11 ? 1 : 0) & f10 & f9 & f8);
    return (bl << 2) | (f11 << 1) | n3; }
  arRate(op, ch) { return op.ar ? Math.min(63, 2 * op.ar + (this.kcOf(ch, op) >> (3 - op.ks))) : 0; }
  kcOf(ch, op) { return this.op[ch].indexOf(op) >= 0 ? this.kc(ch, this.op[ch].indexOf(op)) : 0; }
  rateCalc(op, ch) { }
  updInc(ch) {
    const pms = this.lfoOn ? this.fms[ch] : 0, mul = pms ? PM_MUL[pms][this.lfoPos >> 2] : 0;
    for (let o = 0; o < 4; o++) {
      const op = this.op[ch][o]; const sp = this.mode3 && ch === 2;
      const fn0 = sp ? this.ch3fn[o] : this.fn[ch], bl = sp ? this.ch3blk[o] : this.blk[ch];
      const fn = pms ? fn0 + Math.round(fn0 * mul) : fn0;
      let inc = (fn << bl) >> 1; const kc = this.kc(ch, o); const d = DT[op.dt & 3] ? DT[op.dt & 3][kc] : 0; inc += (op.dt & 4) ? -d : d; if (inc < 0) inc += 0x20000; inc &= 0x1FFFF;
      op.inc = op.mul ? inc * op.mul : inc >> 1; op.kc = kc;
    }
  }
  egRate(op, r) { // r: effective rate 0..63 for state step
    return r;
  }
  stepEnv(ch) {
    const cnt = this.egCnt;
    for (let o = 0; o < 4; o++) {
      const op = this.op[ch][o]; if (op.state === OFF && !op.key) continue;
      const kcs = op.kc >> (3 - op.ks);
      let R;
      switch (op.state) {
        case ATT: R = op.ar ? Math.min(63, 2 * op.ar + kcs) : 0; break;
        case DEC: R = op.d1r ? Math.min(63, 2 * op.d1r + kcs) : 0; break;
        case SUS: R = op.d2r ? Math.min(63, 2 * op.d2r + kcs) : 0; break;
        default: R = Math.min(63, 4 * op.rr + 2 + kcs);
      }
      if (R < 2) continue;
      let sh = 11 - (R >> 2); if (sh < 0) sh = 0;
      if (cnt & ((1 << sh) - 1)) continue;
      let row; if (R < 48) row = R & 3; else if (R < 60) row = 4 + (R - 48); else row = 16; // rows of 8
      let inc = EGINC[row * 8 + ((cnt >> sh) & 7)];
      if (op.state === ATT) {
        if (R >= 62) { op.env = 0; } else op.env += ((~op.env) * inc) >> 4;
        if (op.env <= 0) { op.env = 0; op.state = DEC; }
      } else if (op.state === DEC) {
        op.env += inc; if (op.env >= op.sl) { op.env = op.sl; op.state = SUS; }
      } else if (op.state === SUS) { op.env += inc; if (op.env > 1023) op.env = 1023; }
      else { op.env += inc; if (op.env >= 1023) { op.env = 1023; op.state = OFF; } }
    }
  }
  opOut(op, pm, ch, lfoAm) {
    let e = op.env + (op.tl << 3); if (op.am) e += lfoAm >> AMS_SH[this.ams[ch]]; if (this.ams[ch] === 0 && op.am) e -= lfoAm >> AMS_SH[0]; if (e > 1023) e = 1023;
    if (e < 0) e = 0; else if (e >= 1023) return 0;   // полная тишина: синус не считаем
    const idx = ((op.ph >> 10) + (pm | 0)) & 1023;
    return SIN[idx] * EXP[e] * 4095;
  }
  generate() {   // returns [L,R] in this.l / this.r (about +-32768 for full-scale single channel*..)
    // timers (one tick per sample)
    if (this.taOn && --this.taCnt <= 0) { this.taCnt = 1024 - this.ta; if (this.taEn) this.status |= 1; }
    if (this.tbOn && --this.tbCnt <= 0) { this.tbCnt = (256 - this.tb) * 16; if (this.tbEn) this.status |= 2; }
    // envelope clock every 3 samples
    if (++this.egTimer >= 3) { this.egTimer = 0; this.egCnt = (this.egCnt + 1) & 0xFFF; for (let c = 0; c < 6; c++) this.stepEnv(c); }
    // LFO
    let lfoAm = 0;
    if (this.lfoOn) {
      if (++this.lfoCnt >= LFO_PER[this.lfoFreq]) { this.lfoCnt = 0; this.lfoPos = (this.lfoPos + 1) & 127; }
      const p = this.lfoPos; lfoAm = p < 64 ? (p ^ 63) * 2 : (p & 63) * 2;   // inverted triangle 0..126 in steps of 2
      if (this.lfoCnt === 0 && (p & 3) === 0) { for (let c = 0; c < 6; c++) if (this.fms[c]) this.updInc(c); }   // PM step changed
    }
    let L = 0, R = 0;
    for (let c = 0; c < 6; c++) {
      const ops = this.op[c], o1 = ops[0], o2 = ops[1], o3 = ops[2], o4 = ops[3];
      let out = 0;
      // Канал целиком молчит (все операторы выключены, огибающая на максимуме): не считаем его (фаза сбрасывается при key-on).
      if (o1.state === OFF && o2.state === OFF && o3.state === OFF && o4.state === OFF) { o1.o = 0; o1.o1 = 0; } else {
      for (let o = 0; o < 4; o++) { const op = ops[o]; op.ph = (op.ph + op.inc) & 0xFFFFF; }
      const O1 = this.opOut(o1, this.fb[c] ? (o1.o + o1.o1) / (1 << (10 - this.fb[c])) : 0, c, lfoAm);
      o1.o1 = o1.o; o1.o = O1;
      switch (this.alg[c]) {
        case 0: { const a2 = this.opOut(o2, h(O1), c, lfoAm), a3 = this.opOut(o3, h(a2), c, lfoAm); out = this.opOut(o4, h(a3), c, lfoAm); break; }
        case 1: { const a2 = this.opOut(o2, 0, c, lfoAm), a3 = this.opOut(o3, h(O1 + a2), c, lfoAm); out = this.opOut(o4, h(a3), c, lfoAm); break; }
        case 2: { const a2 = this.opOut(o2, 0, c, lfoAm), a3 = this.opOut(o3, h(a2), c, lfoAm); out = this.opOut(o4, h(O1 + a3), c, lfoAm); break; }
        case 3: { const a2 = this.opOut(o2, h(O1), c, lfoAm), a3 = this.opOut(o3, 0, c, lfoAm); out = this.opOut(o4, h(a2 + a3), c, lfoAm); break; }
        case 4: { const a2 = this.opOut(o2, h(O1), c, lfoAm), a4 = this.opOut(o4, h(this.opOut(o3, 0, c, lfoAm)), c, lfoAm); out = a2 + a4; break; }
        case 5: { const a2 = this.opOut(o2, h(O1), c, lfoAm), a3 = this.opOut(o3, h(O1), c, lfoAm), a4 = this.opOut(o4, h(O1), c, lfoAm); out = a2 + a3 + a4; break; }
        case 6: { const a2 = this.opOut(o2, h(O1), c, lfoAm), a3 = this.opOut(o3, 0, c, lfoAm), a4 = this.opOut(o4, 0, c, lfoAm); out = a2 + a3 + a4; break; }
        default: { out = O1 + this.opOut(o2, 0, c, lfoAm) + this.opOut(o3, 0, c, lfoAm) + this.opOut(o4, 0, c, lfoAm); }
      }
      }
      if (c === 5 && this.dacEn) out = (this.dac - 128) * 32;
      out *= 3;   // ~ +-12k per full channel
      const p = this.pan[c]; if (p & 2) L += out; if (p & 1) R += out;
    }
    this.l = L; this.r = R;
  }
}
YM2612.prototype.hiv = null;
const _ctor = YM2612.prototype.reset;
YM2612.prototype.reset = function () { _ctor.call(this); this.hiv = [new Uint8Array(4), new Uint8Array(4)]; this.ch3hi = new Uint8Array(4); };
MD.YM2612 = YM2612;

});
