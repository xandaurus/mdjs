# Автор: Alexander Orel. Проверка офлайн-версии в Chromium по file://. Запуск: ROM=путь/к/rom python3 tests/browser_test.py
import os, sys
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')); URL = 'file://' + ROOT + '/index.html'
rom = os.environ['ROM']; ok = True; MODE = sys.argv[1] if len(sys.argv) > 1 else 'worker'   # worker | main
def check(name, cond, extra=''):
    global ok; ok &= bool(cond); print(('OK   ' if cond else 'FAIL ') + name, extra)
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    c = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True); p = c.new_page(); errs = []
    p.on('pageerror', lambda e: errs.append(str(e))); p.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    if MODE == 'main': p.add_init_script('window.MD_NO_WORKER = true')
    p.goto(URL); p.set_input_files('#file', rom); p.wait_for_timeout(6000)
    fr = p.evaluate('window.__frames'); check('режим = ' + MODE, p.evaluate('window.__mode') == MODE, p.evaluate('window.__mode')); check('кадры идут', fr > 150, fr)
    check('звук: данные идут', p.evaluate('window.__audioFrames') > 100000)
    if MODE == 'worker': check('звук идёт из воркера напрямую в AudioWorklet', p.evaluate('window.__audioDirect') is True)
    # главный поток блокируем на 800 мс: воркер должен продолжить работу (кадры и звук накапливаются)
    a0, f0 = p.evaluate('window.__audioFrames'), p.evaluate('window.__frames'); p.evaluate('(()=>{const t=performance.now();while(performance.now()-t<800);})()'); p.wait_for_timeout(300)
    da, df = p.evaluate('window.__audioFrames') - a0, p.evaluate('window.__frames') - f0
    print('     блок главного потока 800 мс -> кадров за это время:', df, ', аудиокадров:', da)
    if MODE == 'worker': check('воркер не остановился при блокировке главного потока', df >= 45 and da >= 50000)
    check('worklet source есть', p.evaluate('typeof MD.workletUrl') == 'string')
    check('underruns', p.evaluate('window.__underruns || 0') == 0)
    # сенсор: скольжение
    cd = c.new_cdp_session(p); r = p.locator('.dp').bounding_box(); cx, cy, d = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2, r['width'] * 0.35
    t = lambda k, x, y: cd.send('Input.dispatchTouchEvent', {'type': k, 'touchPoints': [{'x': x, 'y': y, 'id': 1}] if k != 'touchEnd' else []})
    v = lambda: p.evaluate('MD.touch.v'); got = []
    t('touchStart', cx + d, cy); got.append(v())
    for x, y in ((cx - d, cy), (cx, cy - d), (cx, cy + d), (cx + d, cy - d), (cx, cy)): t('touchMove', x, y); p.wait_for_timeout(40); got.append(v())
    t('touchEnd', 0, 0); p.wait_for_timeout(40); got.append(v()); check('скользящая крестовина', got == [8, 4, 1, 2, 9, 0, 0], got)
    # полноэкранный режим + выход
    p.evaluate("document.getElementById('fs').click()"); p.wait_for_timeout(400); check('fullscreen вкл', p.evaluate("document.body.classList.contains('fs')"))
    bx = p.locator('#fsx').bounding_box(); p.touchscreen.tap(bx['x'] + 5, bx['y'] + 5); p.wait_for_timeout(300); check('fullscreen выкл тапом', not p.evaluate("document.body.classList.contains('fs')"))
    # меню копирования
    pr = p.evaluate("(()=>{const el=document.querySelector('[data-k=a]');let n=0;for(const t of ['contextmenu','selectstart']){const e=new Event(t,{bubbles:true,cancelable:true});el.dispatchEvent(e);if(e.defaultPrevented)n++}return n})()"); check('запрет меню копирования', pr == 2)
    # сохранение/загрузка, регион
    p.keyboard.press('F5'); p.wait_for_timeout(600); p.keyboard.press('F8'); p.wait_for_timeout(600); check('F5/F8', 'загружено' in p.text_content('#toast'), p.text_content('#toast'))
    p.select_option('#region', 'ntsc'); p.wait_for_timeout(500); f0 = p.evaluate('window.__frames'); p.wait_for_timeout(4000); check('NTSC ~60 fps', 50 < (p.evaluate('window.__frames') - f0) / 4 < 65)
    check('ошибок в консоли нет', not errs, errs); p.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot.png')); b.close()
print('ИТОГ:', 'ВСЁ OK' if ok else 'ЕСТЬ ОШИБКИ'); sys.exit(0 if ok else 1)
