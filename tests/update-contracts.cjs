const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function harness(handler=async()=>({current:'0.4.0',latest:'0.5.0',newer:true,url:'https://github.com/YuraYarmola/Prystan/releases/tag/v0.5.0'})){
 const els=new Map(),calls=[],timers=[],toasts=[];
 const el=id=>{if(!els.has(id))els.set(id,{style:{},hidden:true,textContent:'',title:''});return els.get(id)};
 const ctx={console,TextEncoder,TextDecoder,setTimeout:(fn,ms)=>timers.push({fn,ms}),clearTimeout(){},document:{getElementById:el,addEventListener(){}},window:{addEventListener(){},__TAURI__:{core:{invoke:async(name,args)=>{calls.push({name,args});return handler(name,args)}},event:{listen(){}}}}};
 vm.createContext(ctx);
 for(const file of ['i18n','core','app']){
  let src=fs.readFileSync(path.join(__dirname,'../app/ui/js',file+'.js'),'utf8');if(file==='app')src=src.split('/* ═══ старт ═══ */')[0];vm.runInContext(src,ctx);
 }
 ctx.recordToast=(...args)=>toasts.push(args);vm.runInContext('toast=recordToast',ctx);
 return {run:code=>vm.runInContext(code,ctx),calls,el,timers,toasts};
}
test('startup update check is scheduled before profiles and server connections',async()=>{
 const h=harness();h.run('scheduleUpdateCheck()');assert.equal(h.calls.length,0);assert.equal(h.timers[0].ms,4000);h.timers[0].fn();await new Promise(setImmediate);assert.equal(h.calls[0].name,'check_update');assert.equal(h.el('update-notice').hidden,false);
 const startup=fs.readFileSync(path.join(__dirname,'../app/ui/js/app.js'),'utf8').split('/* ═══ старт ═══ */')[1];assert(startup.indexOf('scheduleUpdateCheck()')<startup.indexOf('await loadProfiles()'));
});
test('disabled automatic checks do not send requests, including toggle during delay',()=>{
 const h=harness();h.run('S.cfg.checkUpdates=false;scheduleUpdateCheck()');assert.equal(h.timers.length,0);h.run('S.cfg.checkUpdates=true;scheduleUpdateCheck();S.cfg.checkUpdates=false');h.timers[0].fn();assert.equal(h.calls.length,0);
});
test('a new release offers download without opening a browser until clicked',async()=>{
 const h=harness();await h.run('checkUpdate(false)');assert.match(h.el('update-message').textContent,/0.5.0/);assert.equal(h.calls.length,1);await h.el('update-download').onclick();assert.equal(h.calls[1].name,'open_url');assert.equal(h.calls[1].args.url,'https://github.com/YuraYarmola/Prystan/releases/tag/v0.5.0');
});
test('Later hides prompt, keeps badge and badge can reopen it',async()=>{
 const h=harness();await h.run('checkUpdate()');h.el('update-later').onclick();assert.equal(h.el('update-notice').hidden,true);assert.equal(h.el('update-badge').style.display,'inline-flex');h.el('update-badge').onclick();assert.equal(h.el('update-notice').hidden,false);
});
test('latest version and failed background check remain quiet; manual check reports',async()=>{
 const h=harness(async()=>({current:'0.4.0',latest:'0.4.0',newer:false}));await h.run('checkUpdate()');assert.equal(h.el('update-notice').hidden,true);assert.equal(h.toasts.length,0);await h.run('checkUpdate(true)');assert.equal(h.toasts.length,1);
 const f=harness(async()=>{throw Error('offline')});await f.run('checkUpdate()');assert.equal(f.toasts.length,0);await f.run('checkUpdate(true)');assert.equal(f.toasts.length,1);assert.equal(f.calls.length,2);
});
test('overlapping manual and background checks share one request',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));const a=h.run('checkUpdate(false)'),b=h.run('checkUpdate(true)');assert.equal(h.calls.length,1);resolve({current:'0.4.0',latest:'0.5.0',newer:true});await Promise.all([a,b]);assert.equal(h.el('update-notice').hidden,false);
});
test('dismissed version stays hidden on repaint and a different release is offered',async()=>{
 const h=harness();await h.run('checkUpdate()');h.el('update-later').onclick();h.run('LANG="en";renderUpdateNotice()');assert.equal(h.el('update-notice').hidden,true);h.run('S.update.latest="0.6.0";renderUpdateNotice()');assert.equal(h.el('update-notice').hidden,false);assert.match(h.el('update-message').textContent,/Version 0.6.0/);
});
