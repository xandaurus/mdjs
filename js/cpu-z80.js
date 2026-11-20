/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Процессор Zilog Z80 (звуковой процессор)
 * Автор: Alexander Orel
 */
MD.define('cpu-z80', function (MD) {
"use strict";
// Zilog Z80 interpreter (documented + common undocumented behaviour). bus: read(a), write(a,v), in(p), out(p,v)
const S = 0x80, Z = 0x40, Y = 0x20, H = 0x10, X = 0x08, PV = 0x04, N = 0x02, CF = 0x01;
const PAR = new Uint8Array(256); for (let i = 0; i < 256; i++) { let p = 1, v = i; while (v) { p ^= v & 1; v >>= 1; } PAR[i] = p ? PV : 0; }

class Z80 {
  constructor(bus) {
    this.bus = bus; this.r = new Uint8Array(8); this.f = 0;   // r: B C D E H L - A
    this.ar = new Uint8Array(8); this.af_ = 0;                 // shadow regs (B' C' D' E' H' L' - A') and F'
    this.ix = 0; this.iy = 0; this.sp = 0xFFFF; this.pc = 0; this.i = 0; this.rr = 0;
    this.iff1 = 0; this.iff2 = 0; this.im = 0; this.halted = false; this.cycles = 0; this.irqLine = false; this.eiPending = false;
  }
  reset() { this.r.fill(0); this.ar.fill(0); this.f = 0; this.af_ = 0; this.ix = this.iy = 0; this.sp = 0xFFFF; this.pc = 0; this.i = 0; this.rr = 0; this.iff1 = this.iff2 = 0; this.im = 0; this.halted = false; this.irqLine = false; this.eiPending = false; }
  get bc() { return (this.r[0] << 8) | this.r[1]; } set bc(v) { this.r[0] = v >> 8; this.r[1] = v; }
  get de() { return (this.r[2] << 8) | this.r[3]; } set de(v) { this.r[2] = v >> 8; this.r[3] = v; }
  get hl() { return (this.r[4] << 8) | this.r[5]; } set hl(v) { this.r[4] = v >> 8; this.r[5] = v; }
  get af() { return (this.r[7] << 8) | this.f; } set af(v) { this.r[7] = v >> 8; this.f = v & 0xFF; }
  rb(a) { return this.bus.read(a & 0xFFFF); }
  wb(a, v) { this.bus.write(a & 0xFFFF, v & 0xFF); }
  rw(a) { return this.rb(a) | (this.rb(a + 1) << 8); }
  ww(a, v) { this.wb(a, v); this.wb(a + 1, v >> 8); }
  fetch() { const v = this.rb(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const l = this.fetch(); return l | (this.fetch() << 8); }
  push(v) { this.sp = (this.sp - 2) & 0xFFFF; this.ww(this.sp, v); }
  pop() { const v = this.rw(this.sp); this.sp = (this.sp + 2) & 0xFFFF; return v; }
  rp(i) { return i === 0 ? this.bc : i === 1 ? this.de : i === 2 ? this.hl : this.sp; }
  setrp(i, v) { v &= 0xFFFF; if (i === 0) this.bc = v; else if (i === 1) this.de = v; else if (i === 2) this.hl = v; else this.sp = v; }
  getr(i, idx, d) {   // 8-bit operand; idx: ix/iy prefix mode ('ix' | 'iy' | null), d = displacement
    if (i === 6) return this.rb(idx ? this.xy(idx) + d : this.hl);
    if (idx && (i === 4 || i === 5)) { const v = idx === 'ix' ? this.ix : this.iy; return i === 4 ? v >> 8 : v & 0xFF; }
    return this.r[i];
  }
  setr(i, v, idx, d) {
    v &= 0xFF;
    if (i === 6) { this.wb(idx ? this.xy(idx) + d : this.hl, v); return; }
    if (idx && (i === 4 || i === 5)) { let o = idx === 'ix' ? this.ix : this.iy; o = i === 4 ? (o & 0xFF) | (v << 8) : (o & 0xFF00) | v; if (idx === 'ix') this.ix = o; else this.iy = o; return; }
    this.r[i] = v;
  }
  xy(idx) { return idx === 'ix' ? this.ix : this.iy; }
  cc(i) { const f = this.f; switch (i) { case 0: return !(f & Z); case 1: return !!(f & Z); case 2: return !(f & CF); case 3: return !!(f & CF); case 4: return !(f & PV); case 5: return !!(f & PV); case 6: return !(f & S); default: return !!(f & S); } }
  // ---- ALU
  alu(op, b) {
    const a = this.r[7]; let r, f;
    switch (op) {
      case 0: case 1: { const c = op === 1 && (this.f & CF) ? 1 : 0; r = a + b + c; f = ((r & 0xFF) & (S | Y | X)) | (((a ^ b ^ r) & H)) | ((((a ^ r) & (b ^ r)) & 0x80) ? PV : 0) | (r > 0xFF ? CF : 0); break; }
      case 2: case 3: case 7: { const c = op === 3 && (this.f & CF) ? 1 : 0; r = a - b - c; f = ((r & 0xFF) & (S | Y | X)) | (((a ^ b ^ r) & H)) | ((((a ^ b) & (a ^ r)) & 0x80) ? PV : 0) | N | (r < 0 ? CF : 0); if (op === 7) f = (f & ~(Y | X)) | (b & (Y | X)); break; }
      case 4: r = a & b; f = (r & (S | Y | X)) | H | PAR[r & 0xFF]; break;
      case 5: r = a ^ b; f = (r & (S | Y | X)) | PAR[r & 0xFF]; break;
      default: r = a | b; f = (r & (S | Y | X)) | PAR[r & 0xFF];
    }
    r &= 0xFF; if (r === 0 && op !== 7) f |= Z; if (op === 7) { if (((a - b) & 0xFF) === 0) f |= Z; } else if (r === 0) f |= Z;
    if (op === 7) { f &= ~(S); if (((a - b) & 0x80)) f |= S; } else { f = (f & ~S) | (r & S); }
    this.f = f; if (op !== 7) this.r[7] = r;
  }
  inc8(v) { const r = (v + 1) & 0xFF; this.f = (this.f & CF) | (r & (S | Y | X)) | (r === 0 ? Z : 0) | ((v & 0xF) === 0xF ? H : 0) | (v === 0x7F ? PV : 0); return r; }
  dec8(v) { const r = (v - 1) & 0xFF; this.f = (this.f & CF) | (r & (S | Y | X)) | (r === 0 ? Z : 0) | ((v & 0xF) === 0 ? H : 0) | (v === 0x80 ? PV : 0) | N; return r; }
  add16(a, b) { const r = a + b; this.f = (this.f & (S | Z | PV)) | ((r >> 8) & (Y | X)) | (((a ^ b ^ r) >> 8) & H) | (r > 0xFFFF ? CF : 0); return r & 0xFFFF; }
  adc16(a, b) { const c = this.f & CF; const r = a + b + c; this.f = ((r >> 8) & (S | Y | X)) | ((r & 0xFFFF) === 0 ? Z : 0) | (((a ^ b ^ r) >> 8) & H) | ((((a ^ r) & (b ^ r)) & 0x8000) ? PV : 0) | (r > 0xFFFF ? CF : 0); return r & 0xFFFF; }
  sbc16(a, b) { const c = this.f & CF; const r = a - b - c; this.f = ((r >> 8) & (S | Y | X)) | ((r & 0xFFFF) === 0 ? Z : 0) | (((a ^ b ^ r) >> 8) & H) | ((((a ^ b) & (a ^ r)) & 0x8000) ? PV : 0) | N | (r < 0 ? CF : 0); return r & 0xFFFF; }
  rot(t, v) {   // CB rotates/shifts: 0 RLC 1 RRC 2 RL 3 RR 4 SLA 5 SRA 6 SLL 7 SRL
    let c, r; const cin = this.f & CF;
    switch (t) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xFF; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = ((v << 1) | cin) & 0xFF; break;
      case 3: c = v & 1; r = (v >> 1) | (cin << 7); break;
      case 4: c = v >> 7; r = (v << 1) & 0xFF; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
      case 6: c = v >> 7; r = ((v << 1) | 1) & 0xFF; break;
      default: c = v & 1; r = v >> 1;
    }
    this.f = (r & (S | Y | X)) | (r === 0 ? Z : 0) | PAR[r] | c; return r;
  }
  daa() {
    let a = this.r[7], c = this.f & CF, add = 0;
    if ((this.f & H) || (a & 0xF) > 9) add |= 6;
    if (c || a > 0x99) { add |= 0x60; c = CF; }
    const r = (this.f & N) ? (a - add) & 0xFF : (a + add) & 0xFF;
    const h = (this.f & N) ? ((this.f & H) && (a & 0xF) < 6 ? H : 0) : ((a & 0xF) > 9 ? H : 0);
    this.f = (r & (S | Y | X)) | (r === 0 ? Z : 0) | h | PAR[r] | (this.f & N) | c; this.r[7] = r;
  }
  // ---- interrupts
  interrupt() {
    this.halted = false; this.iff1 = this.iff2 = 0;
    this.push(this.pc);
    if (this.im === 2) { this.pc = this.rw((this.i << 8) | 0xFF); this.cycles += 19; } else { this.pc = 0x38; this.cycles += 13; }
  }
  step() {
    if (this.irqLine && this.iff1 && !this.eiPending) { this.interrupt(); return; }
    this.eiPending = false;
    if (this.halted) { this.cycles += 4; return; }
    this.rr = (this.rr + 1) & 0x7F;
    let op = this.fetch(), idx = null;
    if (op === 0xDD || op === 0xFD) { idx = op === 0xDD ? 'ix' : 'iy'; op = this.fetch(); this.cycles += 4; if (op === 0xDD || op === 0xFD) { this.pc = (this.pc - 1) & 0xFFFF; return; } }
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (op === 0xED) { this.ed(); return; }
    if (op === 0xCB) { this.cb(idx); return; }
    let d = 0;
    const needD = () => { if (idx) d = (this.fetch() << 24) >> 24; };
    switch (x) {
      case 0:
        switch (z) {
          case 0:
            if (y === 0) { this.cycles += 4; }
            else if (y === 1) { const t = (this.r[7] << 8) | this.f; this.r[7] = this.af_ >> 8; this.f = this.af_ & 0xFF; this.af_ = t; this.cycles += 4; }
            else if (y === 2) { const e = (this.fetch() << 24) >> 24; this.cycles += 8; this.r[0]--; if (this.r[0] !== 0) { this.pc = (this.pc + e) & 0xFFFF; this.cycles += 5; } }
            else if (y === 3) { const e = (this.fetch() << 24) >> 24; this.pc = (this.pc + e) & 0xFFFF; this.cycles += 12; }
            else { const e = (this.fetch() << 24) >> 24; this.cycles += 7; if (this.cc(y - 4)) { this.pc = (this.pc + e) & 0xFFFF; this.cycles += 5; } }
            break;
          case 1:
            if (!q) { const v = this.fetch16(); if (p === 2 && idx) { if (idx === 'ix') this.ix = v; else this.iy = v; } else this.setrp(p, v); this.cycles += 10; }
            else { const a = p === 2 && idx ? this.xy(idx) : this.rp(p === 2 ? 2 : p); const b = p === 2 ? a : this.rp(p); const hlv = idx ? this.xy(idx) : this.hl; const r = this.add16(hlv, p === 2 ? hlv : this.rp(p)); if (idx) { if (idx === 'ix') this.ix = r; else this.iy = r; } else this.hl = r; this.cycles += 11; }
            break;
          case 2:
            if (p === 0) { if (!q) this.wb(this.bc, this.r[7]); else this.r[7] = this.rb(this.bc); this.cycles += 7; }
            else if (p === 1) { if (!q) this.wb(this.de, this.r[7]); else this.r[7] = this.rb(this.de); this.cycles += 7; }
            else if (p === 2) { const a = this.fetch16(); if (!q) this.ww(a, idx ? this.xy(idx) : this.hl); else { const v = this.rw(a); if (idx) { if (idx === 'ix') this.ix = v; else this.iy = v; } else this.hl = v; } this.cycles += 16; }
            else { const a = this.fetch16(); if (!q) this.wb(a, this.r[7]); else this.r[7] = this.rb(a); this.cycles += 13; }
            break;
          case 3: {
            if (p === 2 && idx) { const v = (this.xy(idx) + (q ? -1 : 1)) & 0xFFFF; if (idx === 'ix') this.ix = v; else this.iy = v; }
            else this.setrp(p, this.rp(p) + (q ? -1 : 1));
            this.cycles += 6; break;
          }
          case 4: { needD(); const v = this.getr(y, idx, d); this.setr(y, this.inc8(v), idx, d); this.cycles += y === 6 ? (idx ? 19 : 11) : 4; break; }
          case 5: { needD(); const v = this.getr(y, idx, d); this.setr(y, this.dec8(v), idx, d); this.cycles += y === 6 ? (idx ? 19 : 11) : 4; break; }
          case 6: { needD(); const n = this.fetch(); this.setr(y, n, idx, d); this.cycles += y === 6 ? (idx ? 15 : 10) : 7; break; }
          default: {
            const a = this.r[7]; let c; this.cycles += 4;
            switch (y) {
              case 0: c = a >> 7; this.r[7] = ((a << 1) | c) & 0xFF; this.f = (this.f & (S | Z | PV)) | (this.r[7] & (Y | X)) | c; break;
              case 1: c = a & 1; this.r[7] = (a >> 1) | (c << 7); this.f = (this.f & (S | Z | PV)) | (this.r[7] & (Y | X)) | c; break;
              case 2: c = a >> 7; this.r[7] = ((a << 1) | (this.f & CF)) & 0xFF; this.f = (this.f & (S | Z | PV)) | (this.r[7] & (Y | X)) | c; break;
              case 3: c = a & 1; this.r[7] = (a >> 1) | ((this.f & CF) << 7); this.f = (this.f & (S | Z | PV)) | (this.r[7] & (Y | X)) | c; break;
              case 4: this.daa(); break;
              case 5: this.r[7] = a ^ 0xFF; this.f = (this.f & (S | Z | PV | CF)) | (this.r[7] & (Y | X)) | H | N; break;
              case 6: this.f = (this.f & (S | Z | PV)) | (a & (Y | X)) | CF; break;
              default: this.f = (this.f & (S | Z | PV)) | (a & (Y | X)) | ((this.f & CF) ? H : 0) | ((this.f & CF) ? 0 : CF); break;
            }
          }
        }
        break;
      case 1:
        if (y === 6 && z === 6) { this.halted = true; this.cycles += 4; break; }
        needD();
        if (y === 6) { this.setr(6, this.r[z], idx, d); this.cycles += idx ? 19 : 7; }
        else if (z === 6) { this.r[y] = this.getr(6, idx, d); this.cycles += idx ? 19 : 7; }
        else { this.setr(y, this.getr(z, idx, d), idx, d); this.cycles += 4; }
        break;
      case 2: needD(); this.alu(y, this.getr(z, idx, d)); this.cycles += z === 6 ? (idx ? 19 : 7) : 4; break;
      default:
        switch (z) {
          case 0: this.cycles += 5; if (this.cc(y)) { this.pc = this.pop(); this.cycles += 6; } break;
          case 1:
            if (!q) { const v = this.pop(); if (p === 3) this.af = v; else if (p === 2 && idx) { if (idx === 'ix') this.ix = v; else this.iy = v; } else this.setrp(p, v); this.cycles += 10; }
            else if (p === 0) { this.pc = this.pop(); this.cycles += 10; }
            else if (p === 1) { for (let i = 0; i < 6; i++) { const t = this.r[i]; this.r[i] = this.ar[i]; this.ar[i] = t; } this.cycles += 4; }
            else if (p === 2) { this.pc = idx ? this.xy(idx) : this.hl; this.cycles += 4; }
            else { this.sp = idx ? this.xy(idx) : this.hl; this.cycles += 6; }
            break;
          case 2: { const a = this.fetch16(); if (this.cc(y)) this.pc = a; this.cycles += 10; break; }
          case 3:
            if (y === 0) { this.pc = this.fetch16(); this.cycles += 10; }
            else if (y === 2) { const n = this.fetch(); this.bus.out((this.r[7] << 8) | n, this.r[7]); this.cycles += 11; }
            else if (y === 3) { const n = this.fetch(); this.r[7] = this.bus.in((this.r[7] << 8) | n); this.cycles += 11; }
            else if (y === 4) { const v = this.rw(this.sp); const hv = idx ? this.xy(idx) : this.hl; this.ww(this.sp, hv); if (idx) { if (idx === 'ix') this.ix = v; else this.iy = v; } else this.hl = v; this.cycles += 19; }
            else if (y === 5) { const t = this.de; this.de = this.hl; this.hl = t; this.cycles += 4; }
            else if (y === 6) { this.iff1 = this.iff2 = 0; this.cycles += 4; }
            else { this.iff1 = this.iff2 = 1; this.eiPending = true; this.cycles += 4; }
            break;
          case 4: { const a = this.fetch16(); this.cycles += 10; if (this.cc(y)) { this.push(this.pc); this.pc = a; this.cycles += 7; } break; }
          case 5:
            if (!q) { this.push(p === 3 ? this.af : p === 2 && idx ? this.xy(idx) : this.rp(p)); this.cycles += 11; }
            else { const a = this.fetch16(); this.push(this.pc); this.pc = a; this.cycles += 17; }
            break;
          case 6: this.alu(y, this.fetch()); this.cycles += 7; break;
          default: this.push(this.pc); this.pc = y * 8; this.cycles += 11;
        }
    }
  }
  cb(idx) {
    let d = 0; if (idx) d = (this.fetch() << 24) >> 24;
    const op = this.fetch(); const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const mem = idx || z === 6; const v = idx ? this.rb(this.xy(idx) + d) : this.getr(z);
    let r;
    if (x === 0) { r = this.rot(y, v); }
    else if (x === 1) {
      const b = v & (1 << y); this.f = (this.f & CF) | H | (b ? 0 : (Z | PV)) | (y === 7 && b ? S : 0) | ((mem ? (idx ? (this.xy(idx) + d) >> 8 : this.hl >> 8) : v) & (Y | X));
      this.cycles += mem ? (idx ? 20 : 12) : 8; return;
    } else if (x === 2) r = v & ~(1 << y); else r = v | (1 << y);
    if (idx) { this.wb(this.xy(idx) + d, r); if (z !== 6) this.r[z] = r; this.cycles += 23; }
    else if (z === 6) { this.wb(this.hl, r); this.cycles += 15; } else { this.r[z] = r; this.cycles += 8; }
  }
  ed() {
    const op = this.fetch(); const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 1) {
      switch (z) {
        case 0: { const v = this.bus.in(this.bc); if (y !== 6) this.r[y] = v; this.f = (this.f & CF) | (v & (S | Y | X)) | (v === 0 ? Z : 0) | PAR[v]; this.cycles += 12; break; }
        case 1: this.bus.out(this.bc, y === 6 ? 0 : this.r[y]); this.cycles += 12; break;
        case 2: this.hl = q ? this.adc16(this.hl, this.rp(p)) : this.sbc16(this.hl, this.rp(p)); this.cycles += 15; break;
        case 3: { const a = this.fetch16(); if (!q) this.ww(a, this.rp(p)); else this.setrp(p, this.rw(a)); this.cycles += 20; break; }
        case 4: { const a = this.r[7]; this.r[7] = 0; this.f = 0; this.alu(2, a); this.cycles += 4; break; }
        case 5: this.pc = this.pop(); this.iff1 = this.iff2; this.cycles += 14; break;
        case 6: this.im = [0, 0, 1, 2, 0, 0, 1, 2][y]; this.cycles += 8; break;
        default:
          switch (y) {
            case 0: this.i = this.r[7]; this.cycles += 9; break;
            case 1: this.rr = this.r[7]; this.cycles += 9; break;
            case 2: this.r[7] = this.i; this.f = (this.f & CF) | (this.r[7] & (S | Y | X)) | (this.r[7] === 0 ? Z : 0) | (this.iff2 ? PV : 0); this.cycles += 9; break;
            case 3: this.r[7] = this.rr; this.f = (this.f & CF) | (this.r[7] & (S | Y | X)) | (this.r[7] === 0 ? Z : 0) | (this.iff2 ? PV : 0); this.cycles += 9; break;
            case 4: { const a = this.r[7], m = this.rb(this.hl); this.r[7] = (a & 0xF0) | (m & 0xF); this.wb(this.hl, ((m >> 4) & 0xF) | ((a & 0xF) << 4)); this.f = (this.f & CF) | (this.r[7] & (S | Y | X)) | (this.r[7] === 0 ? Z : 0) | PAR[this.r[7]]; this.cycles += 18; break; }
            case 5: { const a = this.r[7], m = this.rb(this.hl); this.r[7] = (a & 0xF0) | ((m >> 4) & 0xF); this.wb(this.hl, ((m << 4) & 0xF0) | (a & 0xF)); this.f = (this.f & CF) | (this.r[7] & (S | Y | X)) | (this.r[7] === 0 ? Z : 0) | PAR[this.r[7]]; this.cycles += 18; break; }
            default: this.cycles += 8;
          }
      }
      return;
    }
    if (x === 2 && y >= 4 && z < 4) { this.block(y - 4, z); return; }
    this.cycles += 8;
  }
  block(k, z) {   // k: 0 inc,1 dec,2 inc+repeat,3 dec+repeat ; z 0 LD 1 CP 2 IN 3 OUT
    const dec = k & 1, rep = k >> 1; const dlt = dec ? -1 : 1;
    if (z === 0) {
      const v = this.rb(this.hl); this.wb(this.de, v); this.hl = this.hl + dlt; this.de = this.de + dlt; const bc = (this.bc - 1) & 0xFFFF; this.bc = bc;
      const n = (v + this.r[7]) & 0xFF; this.f = (this.f & (S | Z | CF)) | (n & X) | ((n & 2) ? Y : 0) | (bc ? PV : 0);
      this.cycles += 16; if (rep && bc) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 5; }
    } else if (z === 1) {
      const v = this.rb(this.hl); const a = this.r[7]; const r = (a - v) & 0xFF; this.hl = this.hl + dlt; const bc = (this.bc - 1) & 0xFFFF; this.bc = bc;
      const h = ((a ^ v ^ r) & H) ? 1 : 0; const n = r - h;
      this.f = (this.f & CF) | (r & S) | (r === 0 ? Z : 0) | (h ? H : 0) | (bc ? PV : 0) | N | (n & X) | ((n & 2) ? Y : 0);
      this.cycles += 16; if (rep && bc && r !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 5; }
    } else if (z === 2) {
      const v = this.bus.in(this.bc); this.wb(this.hl, v); this.hl = this.hl + dlt; this.r[0] = (this.r[0] - 1) & 0xFF;
      this.f = (this.f & CF) | (this.r[0] === 0 ? Z : 0) | N; this.cycles += 16; if (rep && this.r[0]) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 5; }
    } else {
      const v = this.rb(this.hl); this.r[0] = (this.r[0] - 1) & 0xFF; this.bus.out(this.bc, v); this.hl = this.hl + dlt;
      this.f = (this.f & CF) | (this.r[0] === 0 ? Z : 0) | N; this.cycles += 16; if (rep && this.r[0]) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 5; }
    }
  }
  runUntil(t) { while (this.cycles < t) this.step(); }
}
MD.Z80 = Z80;

});
