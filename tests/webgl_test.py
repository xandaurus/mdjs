# Автор: Alexander Orel. Проверка WebGL-вывода: пиксельное совпадение с 2D-выводом, автовыбор и фолбэк.
import os, sys
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')); URL = 'file://' + ROOT + '/index.html'
ok = True
def check(n, c, e=''):
    global ok; ok &= bool(c); print(('OK   ' if c else 'FAIL ') + n, e)
JS = """() => {
  const f = window.__lastFrame; const res = [];
  for (const [W, H] of [[320, 224], [320, 240], [256, 224], [256, 240]]) {
    const cg = document.createElement('canvas'), cd = document.createElement('canvas');
    const pg = MD.makeGLPresenter(cg); if (!pg) return { error: 'нет WebGL' }; const pd = MD.makePresenter(cd);
    const fb = new Uint32Array(f.fb); const g = { fb, fbW: W, activeLines: H }; pg(g); pd(g);
    const t = document.createElement('canvas'); t.width = W; t.height = H; const tc = t.getContext('2d'); tc.drawImage(cg, 0, 0);
    const a = tc.getImageData(0, 0, W, H).data, b = cd.getContext('2d').getImageData(0, 0, W, H).data; let diff = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
    res.push([W, H, cg.width, cg.height, diff]);
  }
  return { res };
}"""
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    p = b.new_page(viewport={'width': 600, 'height': 700}); errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
    p0 = b.new_page(); p0.goto(URL); p0.set_input_files('#file', os.environ['ROM']); p0.wait_for_timeout(2500); check('по умолчанию 2D', p0.evaluate('window.__renderer') == '2d'); p0.close()
    p.goto(URL + '?gl=1'); p.set_input_files('#file', os.environ['ROM']); p.wait_for_timeout(5000)
    r = p.evaluate('window.__renderer'); check('?gl=1 включает WebGL', r == 'webgl', r)
    d = p.evaluate(JS)
    if 'error' in d: print('WebGL недоступен в этом Chromium:', d['error'])
    else:
        for W, H, cw, ch, diff in d['res']: check('GL == 2D для %dx%d (холст %dx%d)' % (W, H, cw, ch), diff == 0 and (cw, ch) == (W, H), 'отличающихся пикселей: %d' % diff)
    check('игра идёт (кадры)', p.evaluate('window.__frames') > 100)
    # фолбэк: WebGL запрещён -> 2D
    p2 = b.new_page(); p2.add_init_script('window.MD_NO_GL = true'); p2.goto(URL + '?gl=1'); p2.set_input_files('#file', os.environ['ROM']); p2.wait_for_timeout(3000)
    check('фолбэк на 2D (MD_NO_GL)', p2.evaluate('window.__renderer') == '2d' and p2.evaluate('window.__frames') > 50, p2.evaluate('window.__renderer'))
    # фолбэк: getContext('webgl') возвращает null
    p3 = b.new_page(); p3.add_init_script("const o=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return (t==='webgl'||t==='experimental-webgl')?null:o.call(this,t,...a)}")
    p3.goto(URL + '?gl=1'); p3.set_input_files('#file', os.environ['ROM']); p3.wait_for_timeout(3000)
    check('фолбэк на 2D (нет WebGL)', p3.evaluate('window.__renderer') == '2d' and p3.evaluate('window.__frames') > 50)
    check('ошибок нет', not errs, errs); b.close()
print('ИТОГ:', 'ВСЁ OK' if ok else 'ЕСТЬ ОШИБКИ'); sys.exit(0 if ok else 1)
