/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Звуковая подсистема: Z80 + YM2612 + PSG
 * Автор: Alexander Orel
 */
MD.define('sound', function (MD) {
"use strict";
// Sound subsystem glue (stage 6c): Z80 + YM2612 + PSG, synchronized to 68k master clock (68k cycles).
const { Z80 } = MD;
const { YM2612 } = MD;
const { PSG } = MD;
class Sound {
  constructor(g, opts = {}) {
    this.g = g; this.ym = new YM2612(); this.psg = new PSG(); this.bank = 0;
    this.ymClk = g.pal ? 7600489 : 7670454; this.rate = this.ymClk / 144;
    this.RING = 1 << 16; this.buf = new Int16Array(this.RING * 2); this.wpos = 0;   // frames written (monotonic)
    this.z = new Z80({ read: a => this.zr(a), write: (a, v) => this.zw(a, v), in: () => 0xFF, out: () => {} });
    this.zt = 0;            // z80 time in 68k cycles (fractional ok)
    this.ymSamples = 0;     // samples generated so far
    this.psgTps = (144 * 7 / 15) / 16;   // PSG divide-16 ticks per YM sample
    this.nowOverride = -1; this.enabled = true; this.irqEnd = 0; this.wasHeld = true;
    g.sound = this;
  }
  now() { return this.nowOverride >= 0 ? this.nowOverride : this.g.cpu.cycles; }
  syncYM() {   // generate samples up to current 68k time
    const target = Math.floor(this.now() / 144);
    while (this.ymSamples < target) {
      this.ym.generate();
      const p = this.psg.sample(this.psgTps) * 8000;
      let l = this.ym.l + p, r = this.ym.r + p; if (l > 32767) l = 32767; else if (l < -32768) l = -32768; if (r > 32767) r = 32767; else if (r < -32768) r = -32768;
      const i = (this.wpos & (this.RING - 1)) * 2; this.buf[i] = l; this.buf[i + 1] = r; this.wpos++; this.ymSamples++;
    }
  }
  // ---- Z80 bus
  zr(a) {
    if (a < 0x4000) return this.g.zram[a & 0x1FFF];
    if (a < 0x6000) { this.syncZ(); this.syncYM(); return this.ym.read(); }
    if (a < 0x8000) return 0xFF;
    const ad = (this.bank << 15) | (a & 0x7FFF);
    return ad < 0x400000 ? (this.g.rom[ad] ?? 0) : (ad >= 0xE00000 ? this.g.ram[ad & 0xFFFF] : 0xFF);
  }
  zw(a, v) {
    if (a < 0x4000) { this.g.zram[a & 0x1FFF] = v; return; }
    if (a < 0x6000) { this.syncZ(); this.syncYM(); this.ym.write(a & 3, v); return; }
    if (a < 0x6100) { this.bank = ((this.bank >> 1) | ((v & 1) << 8)) & 0x1FF; return; }
    if (a === 0x7F11) { this.syncZ(); this.syncYM(); this.psg.write(v); }
  }
  // z80 time as 68k cycles = z.cycles*15/7 ; keep z80 within [zt target]
  syncZ() { /* set 68k-time context for YM accesses made from inside Z80 execution */ this._inZ = true; }
  // ---- run Z80 up to 68k time t (called from scheduler slices)
  run(t) {
    const g = this.g, z = this.z;
    const running = !g.z80busReq && g.z80reset;
    if (!running) {   // held: z80 time follows
      this.zt = t; z.cycles = Math.ceil(t * 7 / 15); if (this.heldReset === undefined) this.heldReset = false;
      if (!g.z80reset && !this.wasReset) { z.reset(); this.ym.reset && 0; }
      this.wasReset = !g.z80reset; return;
    }
    this.wasReset = false;
    const save = this.g.cpu.cycles;
    // Z80 executes in its own timeline; for YM/PSG accesses use z80 time as 'now'
    const tz = t * 7 / 15;
    this.curZ = true;
    while (z.cycles < tz) {
      this.nowOverride = Math.floor(z.cycles * 15 / 7);
      z.step();
    }
    this.nowOverride = -1;
  }
  irq(on) { this.z.irqLine = on; }
}
MD.Sound = Sound;

});
