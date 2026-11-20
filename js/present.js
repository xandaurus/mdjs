/*
 * Эмулятор Mega Drive / Genesis (MDJS) — Вывод кадра на canvas
 * Автор: Alexander Orel
 */
(function (MD) {
"use strict";
// Browser helper: copy the VDP framebuffer to a <canvas> (not yet tested in a browser; stage 7a).
function makePresenter(canvas) {
  const ctx = canvas.getContext('2d'); let img = null, w = 0, h = 0;
  return function present(g) {
    const H = g.activeLines, W = g.fbW;
    if (!img || W !== w || H !== h) { w = W; h = H; canvas.width = W; canvas.height = H; img = ctx.createImageData(W, H); }
    const dst = new Uint32Array(img.data.buffer);
    for (let y = 0; y < H; y++) dst.set(g.fb.subarray(y * 320, y * 320 + W), y * W);
    ctx.putImageData(img, 0, 0);
  };
}
MD.makePresenter = makePresenter;
// ---- WebGL-вывод: кадр загружается текстурой целиком (без построчного копирования) и растягивается видеокартой.
// Внешний вид тот же: холст имеет размер кадра (W x H), масштабирует его CSS (image-rendering: pixelated).
const VS = 'attribute vec2 p;uniform vec2 s;varying vec2 t;void main(){t=vec2((p.x+1.0)*0.5*s.x,(1.0-(p.y+1.0)*0.5)*s.y);gl_Position=vec4(p,0.0,1.0);}';
const FS = 'precision mediump float;uniform sampler2D u;varying vec2 t;void main(){gl_FragColor=vec4(texture2D(u,t).rgb,1.0);}';
function glSetup(gl) {
  const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader'); return sh; };
  const pr = gl.createProgram(); gl.attachShader(pr, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link');
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 320, 240, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return { s: gl.getUniformLocation(pr, 's'), u: gl.getUniformLocation(pr, 'u') };
}
function makeGLPresenter(canvas) {
  if (window.MD_NO_GL) return null;
  try {   // проверка на временном холсте: если что-то не так, основной холст остаётся доступным для 2D
    const t = document.createElement('canvas'), g0 = t.getContext('webgl') || t.getContext('experimental-webgl'); if (!g0) return null; glSetup(g0);
  } catch (e) { return null; }
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  if (!gl) return null;
  let h = null, w = 0, hh = 0, lost = false;
  const init = () => { h = glSetup(gl); gl.uniform1i(h.u, 0); w = 0; hh = 0; };
  try { init(); } catch (e) { return null; }
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { try { init(); lost = false; } catch (e) {} });
  return function present(g) {
    if (lost) return;
    const H = g.activeLines, W = g.fbW;
    if (W !== w || H !== hh) { w = W; hh = H; canvas.width = W; canvas.height = H; gl.viewport(0, 0, W, H); gl.uniform2f(h.s, W / 320, H / 240); }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 320, 240, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(g.fb.buffer, g.fb.byteOffset, 320 * 240 * 4));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}
MD.makeGLPresenter = makeGLPresenter;
// Выбор вывода. По умолчанию — обычный 2D (в замерах он не медленнее). WebGL включается явно: адрес ...index.html?gl=1
// или window.MD_USE_GL = true; если WebGL недоступен, остаётся 2D. window.__renderer показывает, что выбрано.
MD.makeAutoPresenter = function (canvas) {
  const want = window.MD_USE_GL === true || /[?&]gl=1\b/.test(location.search);
  const gl = want ? makeGLPresenter(canvas) : null; window.__renderer = gl ? 'webgl' : '2d';
  return gl || makePresenter(canvas);
};


})(window.MD = window.MD || {});
