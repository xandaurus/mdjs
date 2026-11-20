/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Процессор Motorola 68000 (интерпретатор)
 * Автор: Alexander Orel
 */
MD.define('cpu-m68k', function (MD) {
"use strict";
// Motorola 68000 interpreter (ES module, no deps).
// bus: { read8(a), read16(a), read32(a), write8(a,v), write16(a,v), write32(a,v) }  (a is 24-bit, masked by caller)
const MASK = [0, 0xFF, 0xFFFF, 0, 0xFFFFFFFF];
const MSB = [0, 0x80, 0x8000, 0, 0x80000000];
const sx8 = v => (v << 24) >> 24;
const sx16 = v => (v << 16) >> 16;
const SZ = [1, 2, 4];
const U = (v, sz) => (v & MASK[sz]) >>> 0;   // size field 0,1,2 -> bytes

class M68K {
  constructor(bus) {
    this.bus = bus;
    this.d = new Uint32Array(8); this.a = new Uint32Array(8);
    this.pc = 0; this.usp = 0; this.ssp = 0;
    this.X = 0; this.N = 0; this.Z = 0; this.V = 0; this.C = 0;
    this.I = 7; this.S = 1; this.T = 0;
    this.cycles = 0; this.stopped = false; this.irq = 0;
    this.op = 0; this.lastPc = 0;
    this.eaK = 0; this.eaR = 0; this.eaA = 0; this.eaV = 0;   // ea kind: 0 Dn,1 An,2 mem,3 imm
    this.onException = null;   // (vector, pc) => void  (debug)
  }
  reset() {
    this.S = 1; this.I = 7; this.T = 0; this.stopped = false; this.irq = 0;
    this.a[7] = this.bus.read32(0) >>> 0; this.ssp = this.a[7]; this.pc = this.bus.read32(4) >>> 0;
  }
  // ---- status register
  get sr() { return (this.T << 15) | (this.S << 13) | (this.I << 8) | (this.X << 4) | (this.N << 3) | (this.Z << 2) | (this.V << 1) | this.C; }
  set sr(v) {
    this.setSR(v);
  }
  setSR(v) {
    const ns = (v >> 13) & 1;
    if (ns !== this.S) { if (this.S) this.ssp = this.a[7]; else this.usp = this.a[7]; this.a[7] = ns ? this.ssp : this.usp; this.S = ns; }
    this.T = (v >> 15) & 1; this.I = (v >> 8) & 7;
    this.setCCR(v);
  }
  setCCR(v) { this.X = (v >> 4) & 1; this.N = (v >> 3) & 1; this.Z = (v >> 2) & 1; this.V = (v >> 1) & 1; this.C = v & 1; }
  // ---- bus helpers (cycle accounting: 4 per word access)
  r8(a) { this.cycles += 4; return this.bus.read8(a & 0xFFFFFF) & 0xFF; }
  r16(a) { this.cycles += 4; return this.bus.read16(a & 0xFFFFFF) & 0xFFFF; }
  r32(a) { this.cycles += 8; return this.bus.read32(a & 0xFFFFFF) >>> 0; }
  w8(a, v) { this.cycles += 4; this.bus.write8(a & 0xFFFFFF, v & 0xFF); }
  w16(a, v) { this.cycles += 4; this.bus.write16(a & 0xFFFFFF, v & 0xFFFF); }
  w32(a, v) { this.cycles += 8; this.bus.write32(a & 0xFFFFFF, v >>> 0); }
  rd(a, sz) { return sz === 1 ? this.r8(a) : sz === 2 ? this.r16(a) : this.r32(a); }
  wr(a, sz, v) { sz === 1 ? this.w8(a, v) : sz === 2 ? this.w16(a, v) : this.w32(a, v); }
  fetch16() { const v = this.r16(this.pc); this.pc = (this.pc + 2) >>> 0; return v; }
  fetch32() { const h = this.fetch16(); return ((h << 16) | this.fetch16()) >>> 0; }
  push16(v) { this.a[7] = (this.a[7] - 2) >>> 0; this.w16(this.a[7], v); }
  push32(v) { this.a[7] = (this.a[7] - 4) >>> 0; this.w32(this.a[7], v); }
  pop16() { const v = this.r16(this.a[7]); this.a[7] = (this.a[7] + 2) >>> 0; return v; }
  pop32() { const v = this.r32(this.a[7]); this.a[7] = (this.a[7] + 4) >>> 0; return v; }
  // ---- effective addresses
  ea(mode, reg, sz) {
    switch (mode) {
      case 0: this.eaK = 0; this.eaR = reg; return;
      case 1: this.eaK = 1; this.eaR = reg; return;
      case 2: this.eaK = 2; this.eaA = this.a[reg]; return;
      case 3: this.eaK = 2; this.eaA = this.a[reg]; this.a[reg] = (this.a[reg] + (sz === 1 && reg === 7 ? 2 : sz)) >>> 0; return;
      case 4: this.a[reg] = (this.a[reg] - (sz === 1 && reg === 7 ? 2 : sz)) >>> 0; this.eaK = 2; this.eaA = this.a[reg]; this.cycles += 2; return;
      case 5: { const d = sx16(this.fetch16()); this.eaK = 2; this.eaA = (this.a[reg] + d) >>> 0; return; }
      case 6: this.eaK = 2; this.eaA = this.index(this.a[reg]); return;
      default:
        if (reg === 0) { this.eaK = 2; this.eaA = sx16(this.fetch16()) >>> 0; return; }
        if (reg === 1) { this.eaK = 2; this.eaA = this.fetch32(); return; }
        if (reg === 2) { const base = this.pc; const d = sx16(this.fetch16()); this.eaK = 2; this.eaA = (base + d) >>> 0; return; }
        if (reg === 3) { const base = this.pc; this.eaK = 2; this.eaA = this.index(base, true); return; }
        if (reg === 4) { this.eaK = 3; this.eaV = sz === 4 ? this.fetch32() : (sz === 2 ? this.fetch16() : this.fetch16() & 0xFF); return; }
        this.illegal();
    }
  }
  index(base) {
    const e = this.fetch16(); const r = (e >> 12) & 7;
    let ix = (e & 0x8000) ? this.a[r] : this.d[r];
    if (!(e & 0x800)) ix = sx16(ix & 0xFFFF);
    this.cycles += 2;
    return (base + sx8(e & 0xFF) + (ix | 0)) >>> 0;
  }
  // read current ea
  get(sz) {
    switch (this.eaK) {
      case 0: return U(this.d[this.eaR], sz);
      case 1: return U(this.a[this.eaR], sz);
      case 2: return this.rd(this.eaA, sz);
      default: return this.eaV;
    }
  }
  put(sz, v) {
    switch (this.eaK) {
      case 0: {
        const r = this.eaR;
        if (sz === 1) this.d[r] = (this.d[r] & 0xFFFFFF00) | (v & 0xFF);
        else if (sz === 2) this.d[r] = (this.d[r] & 0xFFFF0000) | (v & 0xFFFF);
        else this.d[r] = v >>> 0;
        return;
      }
      case 1: this.a[this.eaR] = sz === 2 ? sx16(v & 0xFFFF) >>> 0 : v >>> 0; return;
      case 2: this.wr(this.eaA, sz, v); return;
      default: this.illegal();
    }
  }
  // ---- exceptions
  exception(vec, pcOverride) {
    const sr = this.sr;
    if (!this.S) { this.usp = this.a[7]; this.a[7] = this.ssp; }
    this.S = 1; this.T = 0;
    this.push32(pcOverride === undefined ? this.pc : pcOverride); this.push16(sr);
    this.pc = this.r32(vec * 4);
    this.cycles += 34;
    if (this.onException) this.onException(vec, this.lastPc);
  }
  illegal() { this.exception(4, this.lastPc); }
  setIRQ(level) { if (level > this.irq) this.irq = level; }
  // ---- condition codes
  cond(c) {
    switch (c) {
      case 0: return true; case 1: return false;
      case 2: return !this.C && !this.Z; case 3: return !!(this.C | this.Z);
      case 4: return !this.C; case 5: return !!this.C;
      case 6: return !this.Z; case 7: return !!this.Z;
      case 8: return !this.V; case 9: return !!this.V;
      case 10: return !this.N; case 11: return !!this.N;
      case 12: return this.N === this.V; case 13: return this.N !== this.V;
      case 14: return !this.Z && this.N === this.V; default: return !!this.Z || this.N !== this.V;
    }
  }
  // ---- ALU helpers (values unsigned, masked)
  nz(sz, r) { this.N = (r & MSB[sz]) ? 1 : 0; this.Z = r === 0 ? 1 : 0; }
  logic(sz, r) { this.nz(sz, r); this.V = 0; this.C = 0; return r; }
  add(sz, s, d, x, keepZ) {
    const m = MASK[sz]; const t = s + d + x; const r = (t & m) >>> 0;
    this.C = this.X = t > m ? 1 : 0;
    this.V = ((s ^ r) & (d ^ r) & MSB[sz]) ? 1 : 0;
    this.N = (r & MSB[sz]) ? 1 : 0;
    if (keepZ) { if (r) this.Z = 0; } else this.Z = r === 0 ? 1 : 0;
    return r;
  }
  sub(sz, s, d, x, keepZ, noX) {   // d - s - x
    const m = MASK[sz]; const r = ((d - s - x) & m) >>> 0;
    const c = d < s + x ? 1 : 0; this.C = c; if (!noX) this.X = c;
    this.V = ((s ^ d) & (d ^ r) & MSB[sz]) ? 1 : 0;
    this.N = (r & MSB[sz]) ? 1 : 0;
    if (keepZ) { if (r) this.Z = 0; } else this.Z = r === 0 ? 1 : 0;
    return r;
  }
  shift(type, left, sz, v, cnt) {
    const m = MASK[sz], msb = MSB[sz], bits = sz * 8;
    let r = (v & m) >>> 0; let c = 0, vflag = 0;
    if (cnt === 0) {
      this.C = type === 2 ? this.X : 0; this.V = 0; this.nz(sz, r); return r;
    }
    for (let i = 0; i < cnt; i++) {
      switch (type) {
        case 0:   // AS
          if (left) { c = (r & msb) ? 1 : 0; const n = (r << 1) & m; if (((n ^ r) & msb) !== 0) vflag = 1; r = n >>> 0; }
          else { c = r & 1; r = ((r & msb) | (r >>> 1)) >>> 0; }
          break;
        case 1:   // LS
          if (left) { c = (r & msb) ? 1 : 0; r = ((r << 1) & m) >>> 0; } else { c = r & 1; r = r >>> 1; }
          break;
        case 2: { // ROX
          if (left) { c = (r & msb) ? 1 : 0; r = (((r << 1) & m) | this.X) >>> 0; } else { c = r & 1; r = ((r >>> 1) | (this.X ? msb : 0)) >>> 0; }
          this.X = c; break;
        }
        default:  // RO
          if (left) { c = (r & msb) ? 1 : 0; r = (((r << 1) & m) | c) >>> 0; } else { c = r & 1; r = ((r >>> 1) | (c ? msb : 0)) >>> 0; }
      }
    }
    this.C = c; if (type !== 3) this.X = c; this.V = type === 0 && left ? vflag : 0; this.nz(sz, r);
    this.cycles += 2 * cnt;
    return r;
  }
  // ---- main step
  step() {
    if (this.irq && (this.irq > this.I || this.irq === 7)) {
      const lvl = this.irq; this.irq = 0; this.stopped = false;
      const sr = this.sr; if (!this.S) { this.usp = this.a[7]; this.a[7] = this.ssp; }
      this.S = 1; this.T = 0; this.I = lvl;
      this.push32(this.pc); this.push16(sr); this.pc = this.r32((24 + lvl) * 4); this.cycles += 44;
      if (this.onException) this.onException(24 + lvl, this.pc);
    }
    if (this.stopped) { this.cycles += 4; return; }
    this.lastPc = this.pc;
    const op = this.fetch16(); this.op = op;
    const md = (op >> 3) & 7, er = op & 7, rg = (op >> 9) & 7, sz2 = (op >> 6) & 3;
    switch (op >>> 12) {
      case 0: this.g0(op, md, er, rg, sz2); break;
      case 1: case 2: case 3: {
        const sz = op >>> 12 === 1 ? 1 : op >>> 12 === 3 ? 2 : 4;
        this.ea(md, er, sz); const v = this.get(sz);
        const dm = (op >> 6) & 7;
        if (dm === 1) { this.a[rg] = sz === 2 ? sx16(v) >>> 0 : v; break; }
        this.ea(dm, rg, sz); this.put(sz, v); this.logic(sz, v); break;
      }
      case 4: this.g4(op, md, er, rg, sz2); break;
      case 5: {
        if (sz2 === 3) {
          const c = (op >> 8) & 15;
          if (md === 1) {
            const base = this.pc; const d = sx16(this.fetch16());
            if (!this.cond(c)) {
              const n = (this.d[er] - 1) & 0xFFFF; this.d[er] = (this.d[er] & 0xFFFF0000) | n;
              if (n !== 0xFFFF) this.pc = (base + d) >>> 0;
            } else this.pc = (this.pc) >>> 0;
          } else { this.ea(md, er, 1); this.put(1, this.cond(c) ? 0xFF : 0); }
        } else {
          const sz = SZ[sz2]; const q = rg || 8;
          this.ea(md, er, sz);
          if (this.eaK === 1) { this.a[er] = (op & 0x100) ? (this.a[er] - q) >>> 0 : (this.a[er] + q) >>> 0; break; }
          const d = this.get(sz);
          this.put(sz, (op & 0x100) ? this.sub(sz, q, d, 0) : this.add(sz, q, d, 0));
        }
        break;
      }
      case 6: {
        const c = (op >> 8) & 15; const base = this.pc; let d = op & 0xFF;
        if (d === 0) d = sx16(this.fetch16()); else d = sx8(d);
        const t = (base + d) >>> 0;
        if (c === 1) { this.push32(this.pc); this.pc = t; }
        else if (this.cond(c)) this.pc = t;
        break;
      }
      case 7: { const v = sx8(op & 0xFF) >>> 0; this.d[rg] = v; this.logic(4, v); break; }
      case 8: case 12: this.g8c(op, md, er, rg, sz2); break;
      case 9: case 13: this.g9d(op, md, er, rg, sz2); break;
      case 11: {
        if (sz2 === 3) { const sz = (op & 0x100) ? 4 : 2; this.ea(md, er, sz); let s = this.get(sz); if (sz === 2) s = sx16(s) >>> 0; this.sub(4, s, this.a[rg], 0, false, true); break; }
        const sz = SZ[sz2];
        if (op & 0x100) {
          if (md === 1) { this.ea(3, er, sz); const s = this.get(sz); this.ea(3, rg, sz); const d = this.get(sz); this.sub(sz, s, d, 0, false, true); }
          else { this.ea(md, er, sz); const d = this.get(sz); this.put(sz, this.logic(sz, U(d ^ this.d[rg], sz))); }
        } else { this.ea(md, er, sz); const s = this.get(sz); this.sub(sz, s, U(this.d[rg], sz), 0, false, true); }
        break;
      }
      case 14: {
        if (sz2 === 3) { this.ea(md, er, 2); const v = this.get(2); this.put(2, this.shift((op >> 9) & 3, !!(op & 0x100), 2, v, 1)); break; }
        const sz = SZ[sz2]; const type = (op >> 3) & 3;
        const cnt = (op & 0x20) ? this.d[rg] & 63 : (rg || 8);
        const v = U(this.d[er], sz);
        const r = this.shift(type, !!(op & 0x100), sz, v, cnt);
        this.ea(0, er, sz); this.put(sz, r); break;
      }
      case 10: this.exception(10, this.lastPc); break;
      default: this.exception(11, this.lastPc); break;
    }
  }
  g0(op, md, er, rg, sz2) {
    if (op & 0x100) {
      if (md === 1) {   // movep
        const d = sx16(this.fetch16()); const ad = (this.a[er] + d) >>> 0; const dr = rg;
        if (op & 0x80) {  // reg -> mem
          const v = this.d[dr];
          if (op & 0x40) { this.w8(ad, v >>> 24); this.w8(ad + 2, v >>> 16); this.w8(ad + 4, v >>> 8); this.w8(ad + 6, v); }
          else { this.w8(ad, v >>> 8); this.w8(ad + 2, v); }
        } else {
          if (op & 0x40) this.d[dr] = ((this.r8(ad) << 24) | (this.r8(ad + 2) << 16) | (this.r8(ad + 4) << 8) | this.r8(ad + 6)) >>> 0;
          else this.d[dr] = (this.d[dr] & 0xFFFF0000) | (this.r8(ad) << 8) | this.r8(ad + 2);
        }
        return;
      }
      this.bitop(sz2, md, er, this.d[rg]); return;
    }
    if (rg === 4) { const n = this.fetch16() & 0xFF; this.bitop(sz2, md, er, n); return; }
    const kind = rg;   // 0 ori,1 andi,2 subi,3 addi,5 eori,6 cmpi
    if ((op & 0xFF) === 0x3C || (op & 0xFF) === 0x7C) {
      const imm = this.fetch16(); const toSR = (op & 0xFF) === 0x7C;
      const cur = toSR ? this.sr : (this.sr & 0xFF);
      const mask = toSR ? 0xFFFF : 0xFF;
      const v = kind === 0 ? cur | imm : kind === 1 ? cur & imm : cur ^ imm;
      if (toSR) this.setSR(v & mask); else this.setCCR(v); return;
    }
    if (sz2 === 3 || kind === 4 || kind === 7) { this.illegal(); return; }
    const sz = SZ[sz2];
    const s = sz === 4 ? this.fetch32() : sz === 2 ? this.fetch16() : this.fetch16() & 0xFF;
    this.ea(md, er, sz); const d = this.get(sz);
    switch (kind) {
      case 0: this.put(sz, this.logic(sz, (d | s) >>> 0)); break;
      case 1: this.put(sz, this.logic(sz, (d & s) >>> 0)); break;
      case 5: this.put(sz, this.logic(sz, (d ^ s) >>> 0)); break;
      case 2: this.put(sz, this.sub(sz, s, d, 0)); break;
      case 3: this.put(sz, this.add(sz, s, d, 0)); break;
      case 6: this.sub(sz, s, d, 0, false, true); break;
    }
  }
  bitop(t, md, er, n) {
    if (md === 0) {
      const bit = n & 31; const v = this.d[er]; this.Z = (v >>> bit) & 1 ? 0 : 1;
      if (t === 1) this.d[er] = (v ^ (1 << bit)) >>> 0; else if (t === 2) this.d[er] = (v & ~(1 << bit)) >>> 0; else if (t === 3) this.d[er] = (v | (1 << bit)) >>> 0;
      return;
    }
    const bit = n & 7; this.ea(md, er, 1); const v = this.get(1); this.Z = (v >> bit) & 1 ? 0 : 1;
    if (t === 0) return;
    this.put(1, t === 1 ? v ^ (1 << bit) : t === 2 ? v & ~(1 << bit) : v | (1 << bit));
  }
  g4(op, md, er, rg, sz2) {
    if (op >= 0x4E40 && op <= 0x4E7F || op === 0x4AFC || op === 0x4E70) {
      // fallthrough to special handling below
    }
    if ((op & 0xF1C0) === 0x41C0) { if (md < 2 || md === 3 || md === 4) return this.illegal(); this.ea(md, er, 4); this.a[rg] = this.eaA; return; }
    if ((op & 0xF1C0) === 0x4180) {   // chk
      this.ea(md, er, 2); const b = sx16(this.get(2)); const v = sx16(this.d[rg] & 0xFFFF);
      if (v < 0) { this.N = 1; this.exception(6); } else if (v > b) { this.N = 0; this.exception(6); } return;
    }
    switch (op & 0xFFC0) {
      case 0x40C0: this.ea(md, er, 2); this.put(2, this.sr); return;
      case 0x42C0: this.ea(md, er, 2); this.put(2, this.sr & 0xFF); return;
      case 0x44C0: this.ea(md, er, 2); this.setCCR(this.get(2)); return;
      case 0x46C0: this.ea(md, er, 2); this.setSR(this.get(2)); return;
      case 0x4800: { this.ea(md, er, 1); const d = this.get(1); this.put(1, this.bcdSub(0, d)); return; }
      case 0x4840:
        if (md === 0) { const v = this.d[er]; const r = ((v << 16) | (v >>> 16)) >>> 0; this.d[er] = r; this.logic(4, r); return; }
        this.ea(md, er, 4); this.push32(this.eaA); return;
      case 0x4AC0: { this.ea(md, er, 1); const v = this.get(1); this.nz(1, v); this.V = 0; this.C = 0; this.put(1, v | 0x80); return; }
      case 0x4E80: this.ea(md, er, 4); this.push32(this.pc); this.pc = this.eaA; return;
      case 0x4EC0: this.ea(md, er, 4); this.pc = this.eaA; return;
    }
    if ((op & 0xFB80) === 0x4880 && md !== 0) return this.movem(op, md, er);
    if ((op & 0xFFB8) === 0x4880) {   // ext
      if (op & 0x40) { const r = sx16(this.d[er] & 0xFFFF) >>> 0; this.d[er] = r; this.logic(4, r); }
      else { const r = sx8(this.d[er] & 0xFF) & 0xFFFF; this.d[er] = (this.d[er] & 0xFFFF0000) | r; this.logic(2, r); } return;
    }
    switch (op & 0xFF00) {
      case 0x4000: case 0x4200: case 0x4400: case 0x4600: case 0x4A00: {
        if (sz2 === 3) return this.illegal();
        const sz = SZ[sz2]; this.ea(md, er, sz);
        switch (op & 0xFF00) {
          case 0x4200: this.put(sz, 0); this.N = 0; this.Z = 1; this.V = 0; this.C = 0; return;
          case 0x4A00: { const v = this.get(sz); this.logic(sz, v); return; }
          case 0x4600: { const v = this.get(sz); this.put(sz, this.logic(sz, U(~v, sz))); return; }
          case 0x4400: { const v = this.get(sz); this.put(sz, this.sub(sz, v, 0, 0)); return; }
          default: { const v = this.get(sz); this.put(sz, this.sub(sz, v, 0, this.X, true)); return; }
        }
      }
    }
    if ((op & 0xFFF0) === 0x4E40) { this.exception(32 + (op & 15)); return; }
    switch (op) {
      case 0x4E70: return;
      case 0x4E71: return;
      case 0x4E72: { const v = this.fetch16(); this.setSR(v); this.stopped = true; return; }
      case 0x4E73: { const sr = this.pop16(); this.pc = this.pop32(); this.setSR(sr); return; }
      case 0x4E75: this.pc = this.pop32(); return;
      case 0x4E76: if (this.V) this.exception(7); return;
      case 0x4E77: { this.setCCR(this.pop16()); this.pc = this.pop32(); return; }
      case 0x4AFC: return this.illegal();
    }
    if ((op & 0xFFF8) === 0x4E50) { const d = sx16(this.fetch16()); this.push32(this.a[er]); this.a[er] = this.a[7]; this.a[7] = (this.a[7] + d) >>> 0; return; }
    if ((op & 0xFFF8) === 0x4E58) { this.a[7] = this.a[er]; this.a[er] = this.pop32(); return; }
    if ((op & 0xFFF8) === 0x4E60) { this.usp = this.a[er]; if (!this.S) this.a[7] = this.usp; return; }
    if ((op & 0xFFF8) === 0x4E68) { this.a[er] = this.S ? this.usp : this.a[7]; return; }
    this.illegal();
  }
  movem(op, md, er) {
    const sz = (op & 0x40) ? 4 : 2; const mask = this.fetch16();
    if (op & 0x400) {   // mem -> reg
      this.ea(md, er, sz); let ad = this.eaA;
      for (let i = 0; i < 16; i++) if (mask & (1 << i)) {
        let v = this.rd(ad, sz); if (sz === 2) v = sx16(v) >>> 0;
        if (i < 8) this.d[i] = v; else this.a[i - 8] = v; ad = (ad + sz) >>> 0;
      }
      if (md === 3) this.a[er] = ad;
    } else {
      if (md === 4) {
        const init = this.a[er]; let ad = init;
        for (let i = 0; i < 16; i++) if (mask & (1 << i)) {
          const r = 15 - i; const v = r < 8 ? this.d[r] : (r - 8 === er ? init : this.a[r - 8]);
          ad = (ad - sz) >>> 0; this.wr(ad, sz, v);
        }
        this.a[er] = ad;
      } else {
        this.ea(md, er, sz); let ad = this.eaA;
        for (let i = 0; i < 16; i++) if (mask & (1 << i)) { this.wr(ad, sz, i < 8 ? this.d[i] : this.a[i - 8]); ad = (ad + sz) >>> 0; }
      }
    }
  }
  bcdAdd(s, d) {
    let res = (s & 0xF) + (d & 0xF) + this.X; if (res > 9) res += 6;
    res += (s & 0xF0) + (d & 0xF0); this.X = this.C = res > 0x9F ? 1 : 0; if (this.C) res -= 0xA0;
    res &= 0xFF; if (res) this.Z = 0; this.N = (res & 0x80) ? 1 : 0; return res;
  }
  bcdSub(s, d) {
    let res = (d & 0xF) - (s & 0xF) - this.X; if (res > 9 || res < 0) res -= 6;
    res += (d & 0xF0) - (s & 0xF0); this.X = this.C = (res > 0x99 || res < 0) ? 1 : 0; if (this.C) res += 0xA0;
    res &= 0xFF; if (res) this.Z = 0; this.N = (res & 0x80) ? 1 : 0; return res;
  }
  g8c(op, md, er, rg, sz2) {
    const isC = (op >>> 12) === 12;
    if (sz2 === 3) {
      this.ea(md, er, 2); const s = this.get(2);
      if (isC) {
        const r = ((op & 0x100) ? (sx16(s) * sx16(this.d[rg] & 0xFFFF)) : ((s & 0xFFFF) * (this.d[rg] & 0xFFFF))) >>> 0;
        this.d[rg] = r; this.logic(4, r); this.cycles += 34; return;
      }
      this.cycles += 100;
      if (s === 0) { this.exception(5); return; }
      if (op & 0x100) {
        const dv = this.d[rg] | 0, ds = sx16(s); const q = Math.trunc(dv / ds);
        if (q > 32767 || q < -32768) { this.V = 1; this.C = 0; this.N = 1; return; }
        const r = dv - q * ds; this.d[rg] = (((r & 0xFFFF) << 16) | (q & 0xFFFF)) >>> 0; this.nz(2, q & 0xFFFF); this.V = 0; this.C = 0;
      } else {
        const dv = this.d[rg]; const q = Math.floor(dv / s);
        if (q > 0xFFFF) { this.V = 1; this.C = 0; this.N = 1; return; }
        const r = dv - q * s; this.d[rg] = ((r << 16) | q) >>> 0; this.nz(2, q); this.V = 0; this.C = 0;
      }
      return;
    }
    if ((op & 0x1F0) === 0x100) {   // sbcd/abcd
      if (md & 1) { this.ea(4, er, 1); const s = this.get(1); this.ea(4, rg, 1); const d = this.get(1); this.put(1, isC ? this.bcdAdd(s, d) : this.bcdSub(s, d)); }
      else { const s = this.d[er] & 0xFF, d = this.d[rg] & 0xFF; const r = isC ? this.bcdAdd(s, d) : this.bcdSub(s, d); this.d[rg] = (this.d[rg] & 0xFFFFFF00) | r; }
      return;
    }
    if (isC && (op & 0x100)) {
      const m = op & 0xF8;
      if (m === 0x40) { const t = this.d[rg]; this.d[rg] = this.d[er]; this.d[er] = t; return; }
      if (m === 0x48) { const t = this.a[rg]; this.a[rg] = this.a[er]; this.a[er] = t; return; }
      if (m === 0x88) { const t = this.d[rg]; this.d[rg] = this.a[er]; this.a[er] = t; return; }
    }
    const sz = SZ[sz2];
    if (op & 0x100) {
      this.ea(md, er, sz); const d = this.get(sz); const s = U(this.d[rg], sz);
      this.put(sz, this.logic(sz, (isC ? s & d : s | d) >>> 0));
    } else {
      this.ea(md, er, sz); const s = this.get(sz); const d = U(this.d[rg], sz); const r = this.logic(sz, (isC ? s & d : s | d) >>> 0);
      this.ea(0, rg, sz); this.put(sz, r);
    }
  }
  g9d(op, md, er, rg, sz2) {
    const isAdd = (op >>> 12) === 13;
    if (sz2 === 3) {   // adda / suba
      const sz = (op & 0x100) ? 4 : 2; this.ea(md, er, sz); let s = this.get(sz); if (sz === 2) s = sx16(s) >>> 0;
      this.a[rg] = isAdd ? (this.a[rg] + s) >>> 0 : (this.a[rg] - s) >>> 0; return;
    }
    const sz = SZ[sz2];
    if ((op & 0x100) && md <= 1) {   // addx / subx
      let s, d;
      if (md) { this.ea(4, er, sz); s = this.get(sz); this.ea(4, rg, sz); d = this.get(sz); }
      else { s = U(this.d[er], sz); d = U(this.d[rg], sz); this.ea(0, rg, sz); }
      const r = isAdd ? this.add(sz, s, d, this.X, true) : this.sub(sz, s, d, this.X, true);
      this.put(sz, r); return;
    }
    if (op & 0x100) {
      this.ea(md, er, sz); const d = this.get(sz); const s = U(this.d[rg], sz);
      this.put(sz, isAdd ? this.add(sz, s, d, 0) : this.sub(sz, s, d, 0));
    } else {
      this.ea(md, er, sz); const s = this.get(sz); const d = U(this.d[rg], sz);
      const r = isAdd ? this.add(sz, s, d, 0) : this.sub(sz, s, d, 0);
      this.ea(0, rg, sz); this.put(sz, r);
    }
  }
  // Reference loop (default). In fast mode (this.fast) busy-wait loops of the
  // form  tst.b (abs).l ; beq/bne.s -8  on RAM/ROM are fast-forwarded: once one
  // full iteration has run, the remaining whole iterations before t are skipped
  // by adding their exact cycle cost (state after the skip is identical).
  // true when pc sits on a wait loop:  tst.b (abs).l ; beq/bne.s -8  (RAM/ROM only)
  idleLoop() {
    const bus = this.bus, pc = this.pc;
    if (this.irq || this.stopped || !(pc < 0x400000 || pc >= 0xE00000) || bus.read16(pc) !== 0x4A39) return false;
    const br = bus.read16(pc + 6);
    if (br !== 0x67F8 && br !== 0x66F8) return false;
    const a = bus.read32(pc + 2);
    return a < 0x400000 || a >= 0xE00000;
  }
  runUntil(t) {
    if (!this.fast) { while (this.cycles < t) this.step(); return; }
    while (this.cycles < t) {
      const pc = this.pc;
      if (this.idleLoop()) {
        const c0 = this.cycles;
        this.step();
        if (this.cycles < t) this.step();
        if (this.pc === pc && !this.irq && this.cycles < t) {
          const d = this.cycles - c0, k = Math.floor((t - this.cycles - 1) / d);
          if (k > 0) this.cycles += k * d;
        }
        continue;
      }
      this.step();
    }
  }
  run(cycles) {
    const end = this.cycles + cycles;
    while (this.cycles < end) this.step();
  }
}
MD.M68K = M68K;

});
