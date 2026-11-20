/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Видеочип VDP: построчный рендер
 * Автор: Alexander Orel
 */
MD.define('vdp', function (MD) {
"use strict";
// Software scanline renderer for the Mega Drive VDP (stage 6b). Output: RGBA into g.fb (Uint32Array, 0xAABBGGRR little-endian).
const C3 = [0, 36, 73, 109, 146, 182, 219, 255];
function buildPalette(cram, out) {   // out: Uint32Array(64) of 0xFFBBGGRR
  for (let i = 0; i < 64; i++) { const c = cram[i]; out[i] = 0xFF000000 | (C3[(c >> 9) & 7] << 16) | (C3[(c >> 5) & 7] << 8) | C3[(c >> 1) & 7]; }
}
const lineA = new Uint16Array(512), lineB = new Uint16Array(512), lineS = new Uint16Array(512);
const spriteLine = new Int16Array(80);

function planeLine(g, base, pw, ph, hs, vsFor, y, W, out, isPlaneA) {
  const vram = g.vram; const pwPx = pw * 8, phPx = ph * 8;
  let lastCell = -1, ent = 0, tx = 0;
  for (let x = 0; x < W; x++) {
    const sx = (x - hs) & (pwPx - 1);
    const sy = (y + vsFor(x)) & (phPx - 1);
    const cell = ((sy >> 3) * pw + (sx >> 3));
    const key = (cell << 3) | 0;   // cell index; recompute per row inside cell via sy
    if (cell !== lastCell) { const a = (base + cell * 2) & 0xFFFF; ent = (vram[a] << 8) | vram[a + 1]; lastCell = cell; }
    let px = sx & 7, py = sy & 7;
    if (ent & 0x800) px = 7 - px; if (ent & 0x1000) py = 7 - py;
    const b = vram[(((ent & 0x7FF) << 5) + (py << 2) + (px >> 1)) & 0xFFFF];
    const idx = (px & 1) ? b & 15 : b >> 4;
    out[x] = idx ? (0x100 | ((ent & 0x8000) ? 0x40 : 0) | (((ent >> 13) & 3) << 4) | idx) : 0;
  }
}

function renderLine(g, y) {
  const r = g.vreg, vram = g.vram;
  const h40 = (r[12] & 0x81) !== 0; const W = h40 ? 320 : 256; g.fbW = W;
  const fb = g.fb; const pal = g.pal32; buildPalette(g.cram, pal);
  const row = y * 320;
  const bd = pal[r[7] & 0x3F];
  if (!(r[1] & 0x40)) { for (let x = 0; x < W; x++) fb[row + x] = bd; return; }
  const pwT = [32, 64, 32, 128][r[16] & 3], phT = [32, 64, 32, 128][(r[16] >> 4) & 3];
  // horizontal scroll
  const hsBase = (r[13] & 0x3F) << 10; const hm = r[11] & 3;
  let hoff = hm === 3 ? y * 4 : hm === 2 ? (y & ~7) * 4 : 0;
  const hsA = ((vram[(hsBase + hoff) & 0xFFFF] << 8 | vram[(hsBase + hoff + 1) & 0xFFFF]) & 0x3FF);
  const hsB = ((vram[(hsBase + hoff + 2) & 0xFFFF] << 8 | vram[(hsBase + hoff + 3) & 0xFFFF]) & 0x3FF);
  const vs2 = (r[11] & 4) !== 0; const vsram = g.vsram;
  const vsA = vs2 ? (x => vsram[(x >> 4) * 2] & 0x3FF) : (() => vsram[0] & 0x3FF);
  const vsB = vs2 ? (x => vsram[(x >> 4) * 2 + 1] & 0x3FF) : (() => vsram[1] & 0x3FF);
  const baseA = (r[2] & 0x38) << 10, baseB = (r[4] & 7) << 13;
  planeLine(g, baseB, pwT, phT, hsB, vsB, y, W, lineB, false);
  planeLine(g, baseA, pwT, phT, hsA, vsA, y, W, lineA, true);
  // window (replaces plane A)
  const wh = r[17] & 0x1F, wRight = (r[17] & 0x80) !== 0, wv = r[18] & 0x1F, wDown = (r[18] & 0x80) !== 0;
  const inV = wDown ? y >= wv * 8 : y < wv * 8;
  if (inV || wh || wRight) {
    const wBase = (r[3] & (h40 ? 0x3C : 0x3E)) << 10, wW = h40 ? 64 : 32;
    for (let x = 0; x < W; x++) {
      const inH = wRight ? x >= wh * 16 : x < wh * 16;
      if (!(inV || inH)) continue;
      const cell = (y >> 3) * wW + (x >> 3); const a = (wBase + cell * 2) & 0xFFFF; const ent = (vram[a] << 8) | vram[a + 1];
      let px = x & 7, py = y & 7; if (ent & 0x800) px = 7 - px; if (ent & 0x1000) py = 7 - py;
      const b = vram[(((ent & 0x7FF) << 5) + (py << 2) + (px >> 1)) & 0xFFFF]; const idx = (px & 1) ? b & 15 : b >> 4;
      lineA[x] = idx ? (0x100 | ((ent & 0x8000) ? 0x40 : 0) | (((ent >> 13) & 3) << 4) | idx) : 0;
    }
  }
  // sprites
  lineS.fill(0, 0, W);
  const sBase = (r[5] & (h40 ? 0x7E : 0x7F)) << 9; const maxSpr = h40 ? 80 : 64, maxLine = h40 ? 20 : 16;
  let n = 0, cnt = 0, link = 0, guard = 0; const list = spriteLine;
  while (guard++ < maxSpr) {
    const a = (sBase + link * 8) & 0xFFFF;
    const sy = ((vram[a] << 8 | vram[a + 1]) & 0x3FF) - 128; const sz = vram[a + 2]; const hc = (sz & 3) + 1;
    if (y >= sy && y < sy + hc * 8) { if (cnt < maxLine) list[cnt++] = link; else { g.spriteOverflow = true; break; } }
    link = vram[a + 3] & 0x7F; if (link === 0 || link >= maxSpr) break;
  }
  for (let i = 0; i < cnt; i++) {
    const a = (sBase + list[i] * 8) & 0xFFFF;
    const sy = ((vram[a] << 8 | vram[a + 1]) & 0x3FF) - 128; const sz = vram[a + 2]; const wc = ((sz >> 2) & 3) + 1, hc = (sz & 3) + 1;
    const ti = (vram[a + 4] << 8) | vram[a + 5]; const sx = ((vram[a + 6] << 8 | vram[a + 7]) & 0x1FF) - 128;
    const wpx = wc * 8, hpx = hc * 8; let yy = y - sy; if (ti & 0x1000) yy = hpx - 1 - yy;
    const cellRow = yy >> 3, py = yy & 7; const tbase = ti & 0x7FF; const palb = ((ti >> 13) & 3) << 4; const pri = (ti & 0x8000) ? 0x40 : 0;
    for (let k = 0; k < wpx; k++) {
      const x = sx + k; if (x < 0 || x >= W) continue;
      if (lineS[x]) continue;
      let xx = (ti & 0x800) ? wpx - 1 - k : k; const cellCol = xx >> 3, px = xx & 7;
      const tile = (tbase + cellCol * hc + cellRow) & 0x7FF;
      const b = vram[((tile << 5) + (py << 2) + (px >> 1)) & 0xFFFF]; const idx = (px & 1) ? b & 15 : b >> 4;
      if (idx) lineS[x] = 0x100 | pri | palb | idx;
    }
  }
  // compose
  const bdci = r[7] & 0x3F;
  for (let x = 0; x < W; x++) {
    const b = lineB[x], a = lineA[x], s = lineS[x]; let ci = bdci;
    if ((b & 0x140) === 0x100) ci = b & 63;
    if ((a & 0x140) === 0x100) ci = a & 63;
    if ((s & 0x140) === 0x100) ci = s & 63;
    if ((b & 0x140) === 0x140) ci = b & 63;
    if ((a & 0x140) === 0x140) ci = a & 63;
    if ((s & 0x140) === 0x140) ci = s & 63;
    fb[row + x] = pal[ci];
  }
}
MD.buildPalette = buildPalette;
MD.renderLine = renderLine;

});
