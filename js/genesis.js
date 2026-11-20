/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Консоль Mega Drive: память, ввод-вывод, DMA, кадр, регионы PAL/NTSC
 * Автор: Alexander Orel
 */
MD.define('genesis', function (MD) {
"use strict";
// Sega Mega Drive machine (stage 6a): memory map, I/O, Z80 bus handshake, VDP state/DMA (no rendering yet), frame scheduler.
const { M68K } = MD;
const { renderLine } = MD;

class Genesis {
  constructor(rom, opts = {}) {
    this.rom = rom instanceof Uint8Array ? rom : new Uint8Array(rom);
    this.ram = new Uint8Array(0x10000);
    const reg = opts.pal !== undefined ? (opts.pal ? 'pal' : 'ntsc') : (opts.region || 'auto');
    const det = Genesis.detectRegion(this.rom);                   // {pal, japan}
    this.pal = reg === 'auto' ? det.pal : reg === 'pal';
    this.version = this.pal ? 0xE0 : (reg === 'auto' && det.japan ? 0x20 : 0xA0);   // bit7 overseas, bit6 PAL, bit5 no expansion
    this.zram = new Uint8Array(0x2000); this.z80busReq = 0; this.z80reset = 0; this.sound = null;
    // pads: bit set = pressed. bits: 0 U,1 D,2 L,3 R,4 B,5 C,6 A,7 START
    this.pad = [0, 0];
    this.ioData = [0x7F, 0x7F, 0x7F]; this.ioCtrl = [0, 0, 0];
    // VDP
    this.vram = new Uint8Array(0x10000); this.cram = new Uint16Array(64); this.vsram = new Uint16Array(40);
    this.vreg = new Uint8Array(32); this.vcode = 0; this.vaddr = 0; this.vpending = false; this.vfirst = 0;
    this.dmaFill = false; this.vread = 0;
    this.vblank = false; this.hblank = false; this.vint = false; this.line = 0; this.frame = 0; this.odd = 0;
    this.hcount = 0; this.dmaLog = 0; this.stats = { vdpWrites: 0, dmaTransfers: 0, z80Writes: 0, ymWrites: 0, psgWrites: 0 };
    this.fb = new Uint32Array(320 * 240); this.pal32 = new Uint32Array(64); this.fbW = 320; this.render = opts.render !== false; this.spriteOverflow = false;
    this.cpu = new M68K(this);
    this.cpu.reset();
    this.ymWrite = null; this.psgWrite = null;   // hooks for stage 6c
  }
  static detectRegion(rom) {   // header region field at $1F0: J / U / E (or hex digit bitmask)
    let t = ''; for (let i = 0x1F0; i < 0x1F3; i++) t += String.fromCharCode(rom[i] || 32);
    t = t.toUpperCase(); const hasE = t.includes('E'), hasU = t.includes('U'), hasJ = t.includes('J');
    if (hasE && !hasU && !hasJ) return { pal: true, japan: false };
    if (hasU) return { pal: false, japan: false };
    if (hasJ) return { pal: false, japan: true };
    return { pal: hasE, japan: false };
  }
  get activeLines() { return (this.pal && (this.vreg[1] & 8)) ? 240 : 224; }
  // ---------------- bus
  read8(a) {
    if (a < 0x400000) return this.rom[a] === undefined ? 0 : this.rom[a];
    if (a >= 0xE00000) return this.ram[a & 0xFFFF];
    if (a >= 0xA00000 && a < 0xA10000) { if (a < 0xA02000) return this.zram[a & 0x1FFF]; if (a >= 0xA04000 && a < 0xA04004 && this.sound) { this.sound.syncYM(); return this.sound.ym.read(); } return 0; }
    if (a >= 0xA10000 && a < 0xA10020) return this.ioRead(a);
    if (a === 0xA11100) return this.z80busReq ? 0 : 1;   // bit8: 0 = bus granted to 68k
    if (a === 0xA11101) return 0;
    if (a >= 0xC00000 && a < 0xC00020) { const w = this.vdpRead(a & 0x1E); return (a & 1) ? w & 0xFF : w >> 8; }
    return 0;
  }
  read16(a) {
    if (a < 0x400000) return (this.rom[a] << 8 | this.rom[a + 1]) & 0xFFFF;
    if (a >= 0xE00000) return (this.ram[a & 0xFFFF] << 8) | this.ram[(a + 1) & 0xFFFF];
    if (a >= 0xC00000 && a < 0xC00020) return this.vdpRead(a & 0x1E);
    return (this.read8(a) << 8) | this.read8(a + 1);
  }
  read32(a) { return ((this.read16(a) << 16) | this.read16(a + 2)) >>> 0; }
  write8(a, v) {
    if (a >= 0xE00000) { this.ram[a & 0xFFFF] = v; return; }
    if (a >= 0xA00000 && a < 0xA10000) {
      if (a < 0xA02000) { this.zram[a & 0x1FFF] = v; this.stats.z80Writes++; }
      else if (a >= 0xA04000 && a < 0xA04004) { this.stats.ymWrites++; if (this.sound) { this.sound.syncYM(); this.sound.ym.write(a & 3, v); } if (this.ymWrite) this.ymWrite(a & 3, v); }
      return;
    }
    if (a >= 0xA10000 && a < 0xA10020) { this.ioWrite(a, v); return; }
    if (a === 0xA11100) { this.z80busReq = (v & 1); return; }
    if (a === 0xA11200) { this.z80reset = v & 1; return; }
    if (a >= 0xC00000 && a < 0xC00020) {
      const p = a & 0x1E;
      if (p === 0x10 || p === 0x12 || p === 0x14 || p === 0x16) { if (a & 1) { this.stats.psgWrites++; if (this.sound) { this.sound.syncYM(); this.sound.psg.write(v); } if (this.psgWrite) this.psgWrite(v); } return; }
      this.vdpWrite(p, ((v & 0xFF) << 8) | (v & 0xFF), true); return;
    }
  }
  write16(a, v) {
    if (a >= 0xE00000) { this.ram[a & 0xFFFF] = v >> 8; this.ram[(a + 1) & 0xFFFF] = v; return; }
    if (a >= 0xC00000 && a < 0xC00020) { this.vdpWrite(a & 0x1E, v, false); return; }
    if (a === 0xA11100) { this.z80busReq = (v >> 8) & 1; return; }
    if (a === 0xA11200) { this.z80reset = (v >> 8) & 1; return; }
    this.write8(a, v >> 8); this.write8(a + 1, v & 0xFF);
  }
  write32(a, v) { this.write16(a, v >>> 16); this.write16(a + 2, v & 0xFFFF); }
  // ---------------- I/O (3-button pads)
  ioRead(a) {
    const r = a & 0x1F;
    if (r === 1) return this.version;
    if (r >= 3 && r <= 7 && (r & 1)) {
      const i = (r - 3) >> 1;
      if (i > 1) return this.ioData[2] | 0x80;
      const th = (this.ioData[i] & 0x40) ? 1 : 0; const p = this.pad[i];
      let v;
      if (th) v = 0x40 | (((p & 0x20) ? 0 : 1) << 5) | (((p & 0x10) ? 0 : 1) << 4) | ((~p >> 3 & 1) << 3) | ((~p >> 2 & 1) << 2) | ((~p >> 1 & 1) << 1) | (~p & 1);
      else v = (((p & 0x80) ? 0 : 1) << 5) | (((p & 0x40) ? 0 : 1) << 4) | ((~p >> 1 & 1) << 1) | (~p & 1);
      const c = this.ioCtrl[i];
      return ((this.ioData[i] & c) | (v & ~c)) & 0xFF;
    }
    if (r >= 9 && r <= 0xD && (r & 1)) return this.ioCtrl[(r - 9) >> 1];
    return 0;
  }
  ioWrite(a, v) {
    const r = a & 0x1F;
    if (r >= 3 && r <= 7 && (r & 1)) this.ioData[(r - 3) >> 1] = v & 0xFF;
    else if (r >= 9 && r <= 0xD && (r & 1)) this.ioCtrl[(r - 9) >> 1] = v & 0xFF;
  }
  // ---------------- VDP (state + DMA; rendering is stage 6b)
  vdpRead(p) {
    if (p < 4) {   // data port
      this.vpending = false; let v;
      switch (this.vcode & 0xF) {
        case 0: v = (this.vram[this.vaddr & 0xFFFF] << 8) | this.vram[(this.vaddr + 1) & 0xFFFF]; break;
        case 8: v = this.cram[(this.vaddr >> 1) & 63]; break;
        case 4: v = this.vsram[(this.vaddr >> 1) % 40]; break;
        default: v = 0;
      }
      this.vaddr = (this.vaddr + this.vreg[15]) & 0xFFFF; return v;
    }
    if (p < 8) {   // status
      this.vpending = false;
      let s = 0x3600 | (this.pal ? 1 : 0) | (this.hblank ? 4 : 0) | (this.vblank ? 8 : 0) | (this.odd ? 0x10 : 0) | (this.vint ? 0x80 : 0);
      this.vint = false; return s;
    }
    if (p < 0x10) { const v = this.vcounter(); return (v << 8) | (this.hcount & 0xFF); }
    return 0;
  }
  vcounter() { const h40 = this.vreg[1] & 8 ? 240 : 224; let l = this.line; if (l > 0xEA) l = (l - (this.pal ? 56 : 6)) & 0xFF; return l & 0xFF; }
  vdpWrite(p, v, byte) {
    this.stats.vdpWrites++;
    if (p < 4) { this.vdpData(v, byte); return; }
    if (p < 8) {
      if (this.vpending) {
        this.vpending = false;
        this.vcode = (this.vcode & 3) | ((v >> 2) & 0x3C);
        this.vaddr = (this.vfirst & 0x3FFF) | ((v & 3) << 14);
        if ((this.vcode & 0x20) && (this.vreg[1] & 0x10)) this.dma();
      } else if ((v & 0xE000) === 0x8000) {
        this.vreg[(v >> 8) & 31] = v & 0xFF;
      } else { this.vpending = true; this.vfirst = v; this.vcode = (v >> 14) & 3; }
      return;
    }
  }
  vdpData(v, byte) {
    this.vpending = false;
    const inc = this.vreg[15];
    switch (this.vcode & 0xF) {
      case 1: {
        let w = v; let a = this.vaddr & 0xFFFF; if (a & 1) w = ((w >> 8) | (w << 8)) & 0xFFFF;
        this.vram[a & 0xFFFE] = w >> 8; this.vram[(a & 0xFFFE) + 1] = w & 0xFF; break;
      }
      case 3: this.cram[(this.vaddr >> 1) & 63] = v & 0xFFFF; break;
      case 5: this.vsram[(this.vaddr >> 1) % 40] = v & 0xFFFF; break;
    }
    this.vaddr = (this.vaddr + inc) & 0xFFFF;
    if (this.dmaFill) {
      this.dmaFill = false;
      let len = this.vreg[19] | (this.vreg[20] << 8); if (len === 0) len = 0x10000;
      const b = (v >> 8) & 0xFF;
      for (let i = 0; i < len; i++) { this.vram[(this.vaddr ^ 1) & 0xFFFF] = b; this.vaddr = (this.vaddr + inc) & 0xFFFF; }
      this.stats.dmaTransfers++;
    }
  }
  dma() {
    const r = this.vreg; let len = r[19] | (r[20] << 8); if (len === 0) len = 0x10000;
    const mode = r[23] >> 6; const inc = r[15];
    if (mode === 2) { this.dmaFill = true; return; }   // VRAM fill: waits for data write
    if (mode === 3) {   // VRAM copy
      let src = r[21] | (r[22] << 8);
      for (let i = 0; i < len; i++) { this.vram[this.vaddr & 0xFFFF] = this.vram[src & 0xFFFF]; src = (src + 1) & 0xFFFF; this.vaddr = (this.vaddr + inc) & 0xFFFF; }
      this.stats.dmaTransfers++; return;
    }
    let src = (((r[23] & 0x7F) << 16) | (r[22] << 8) | r[21]) * 2;
    for (let i = 0; i < len; i++) {
      const w = this.read16(src & 0xFFFFFE); src += 2; this.vdpData(w, false);
    }
    this.stats.dmaTransfers++;
    this.cpu.cycles += len * 4;   // approximate bus stall
  }
  // ---------------- frame scheduler
  get lines() { return this.pal ? 313 : 262; }
  runFrame() {
    const active = this.activeLines; const cpu = this.cpu;
    if (this.t === undefined) this.t = cpu.cycles;
    if (this.hint === undefined) this.hint = this.vreg[10];
    for (this.line = 0; this.line < this.lines; this.line++) {
      this.hblank = false; this.hcount = 0;
      if (this.line === 0) { this.vblank = false; this.odd ^= 1; this.hint = this.vreg[10]; }
      if (this.line === active) { this.vblank = true; this.vint = true; if (this.vreg[1] & 0x20) cpu.setIRQ(6); }
      this.t += 488;
      if (this.sound) { if (this.line === active) this.sound.irq(true); else if (this.line === active + 1) this.sound.irq(false); this.slice(this.t - 88); } else
      cpu.runUntil(this.t - 88);
      if (this.render && this.line < active) renderLine(this, this.line);
      this.hblank = true;
      if (this.line < active) {   // H-int counter: decrements at end of each active line
        if (this.hint === 0) { this.hint = this.vreg[10]; if (this.vreg[0] & 0x10) cpu.setIRQ(4); } else this.hint--;
      } else this.hint = this.vreg[10];
      if (this.sound) this.slice(this.t); else cpu.runUntil(this.t);
    }
    this.frame++;
  }
  slice(end) {   // interleave 68k and Z80 in short slices
    const cpu = this.cpu, s = this.sound;
    while (cpu.cycles < end) {
      const nxt = cpu.fast && cpu.idleLoop() ? end : Math.min(end, cpu.cycles + 96); cpu.runUntil(nxt); s.run(Math.max(nxt, cpu.cycles));
    }
  }
}
MD.Genesis = Genesis;

});
