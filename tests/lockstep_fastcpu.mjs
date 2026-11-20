import fs from 'fs'; import vm from 'vm';
const dir='/home/claude/mdjs-emulator/js/';
const ctx={console,performance,Math,Uint8Array,Int16Array,Int32Array,Uint32Array,Uint16Array,Float32Array,Float64Array,Array,Map,Set,Date,Object,Number,String,JSON,Error,Symbol,Promise,setTimeout};
ctx.window=ctx; vm.createContext(ctx);
for(const f of ['util','cpu-m68k','cpu-z80','vdp','ym2612','psg','sound','genesis']) vm.runInContext(fs.readFileSync(dir+f+'.js','utf8'),ctx,{filename:f});
const MD=ctx.MD; const rom=new Uint8Array(fs.readFileSync(process.env.ROM));
const N=+process.argv[2]||600, mode=process.argv[3]||'lock';
function mk(fast){const g=new MD.Genesis(rom,{render:true}); new MD.Sound(g); g.cpu.fast=fast; return g;}
const inp=f=>f<900?(((f%150)<6?0x80:0)|(((f+75)%150)<6?0x20:0)):8|((f%60)<10?0x40:0);
if(mode==='bench'){for(const fast of [false,true,false,true]){const g=mk(fast);const t=performance.now();for(let f=1;f<=N;f++){g.pad[0]=inp(f);g.runFrame();}console.log(fast?'fast':'ref ',((performance.now()-t)/N).toFixed(3),'ms/frame');}process.exit();}
const a=mk(false),b=mk(true);
const sig=g=>{const c=g.cpu;return [c.pc,c.sr,c.cycles,...c.d,...c.a,c.lastPc,c.op].join(',')};
const hash=u=>{let h=0;for(let i=0;i<u.length;i++)h=(h*31+u[i])|0;return h};
for(let f=1;f<=N;f++){a.pad[0]=b.pad[0]=inp(f);a.runFrame();b.runFrame();
 const s1=sig(a),s2=sig(b);
 if(s1!==s2||hash(a.ram)!==hash(b.ram)||hash(a.fb)!==hash(b.fb)||hash(a.vram)!==hash(b.vram)||hash(a.sound.ym.buf||a.sound.buf||[])!==hash(b.sound.ym.buf||b.sound.buf||[])){console.log('MISMATCH frame',f,'\n',s1,'\n',s2);process.exit(1);}}
console.log('LOCKSTEP OK',N,'frames');
