import os,time,sys
from playwright.sync_api import sync_playwright
out=sys.argv[1] if len(sys.argv)>1 else '/tmp/ab'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg=b.new_page(viewport={'width':900,'height':800})
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto('file://'+os.path.abspath(os.path.dirname(__file__)+'/../index.html')); pg.set_input_files('#file',os.environ['ROM']); time.sleep(3)
    pg.keyboard.press('Enter'); time.sleep(2)
    for name,on in [('off',[]),('sl',['sl']),('bl',['bl']),('vhs',['vhs']),('all',['sl','bl','vhs'])]:
        pg.evaluate("document.querySelector('#flt').open=true")
        for f in ['sl','bl','vhs']:
            pg.set_checked(f'#flt input[data-f={f}]', f in on)
        time.sleep(.6); pg.screenshot(path=f'{out}/flt_{name}.png',clip={'x':0,'y':0,'width':900,'height':720})
        print(name,pg.evaluate("document.body.className"),pg.evaluate("JSON.stringify(document.getElementById('fx').getBoundingClientRect())"))
    pg.reload(); time.sleep(1); print('persist',pg.evaluate("localStorage.getItem('mdjs_filters')"),'errors',errs); b.close()
