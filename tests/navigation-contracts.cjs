const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(handler = async()=>{}) {
  const els = new Map(), handlers = {};
  const el = id => {
    if (!els.has(id)) els.set(id, {id, value:'', scrollTop:0, style:{}, dataset:{}, classList:{add(){},remove(){},toggle(){},contains(){return false;}}, querySelectorAll:()=>[]});
    return els.get(id);
  };
  class Element { constructor(id='',inside=false){this.id=id;this.tagName=id==='filter'?'INPUT':'DIV';this.inside=inside;} closest(s){return s==='#tree'&&this.inside?{}:null;} }
  const ctx = {console, Element, TextEncoder, TextDecoder, setTimeout, clearTimeout, document:{getElementById:el,querySelector:()=>null,addEventListener:(name,cb)=>handlers[name]=cb}, window:{addEventListener(){},__TAURI__:{core:{invoke:handler},event:{listen(){}}}}};
  vm.createContext(ctx);
  for (const name of ['i18n','core','nav','conn','container-table','app']) {
    const file=path.join(__dirname,'../app/ui/js',name+'.js');
    if (!fs.existsSync(file)) continue;
    let src=fs.readFileSync(file,'utf8');
    if(name==='app')src=src.split('/* ═══ старт ═══ */')[0];
    vm.runInContext(src,ctx);
  }
  const run = s=>vm.runInContext(s,ctx);
  run(`renderTree=()=>{}; renderDetail=()=>{}; renderConnBox=()=>{}; renderEngineLabel=()=>{}; refreshAll=()=>{}; persist=()=>{};
    S.profiles=[{id:'a',kind:'ssh'},{id:'b',kind:'ssh'}]; S.conns={a:{up:true,dockerOk:true},b:{up:true,dockerOk:true}};
    S.activeConn='a'; S.containers=[{id:'one',name:'api',project:'shop',state:'running'}];`);
  return {run,el,handlers,ctx};
}

test('selecting current server keeps the open container',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; switchConn('a')`);
  assert.equal(h.run('S.selected?.id'),'one');
});
test('server round trip restores selection only after fresh data, with filter and scroll',()=>{
  const h=harness(); h.el('filter').value='api'; h.el('tree').scrollTop=210;
  h.run(`S.selected=S.containers[0]; S.view='container'; S.tab='inspect'; S.quick='running'; switchConn('b'); switchConn('a');`);
  assert.equal(h.run('S.selected'),null);
  assert.equal(h.el('filter').value,'api');
  assert.equal(h.run('S.quick'),'running');
  h.run(`S.containers=[{id:'one',name:'api',project:'shop',state:'exited'}]; restorePendingNavigation('a');`);
  assert.equal(h.run('S.selected.state'),'exited');
  assert.equal(h.run('S.tab'),'inspect');
  assert.equal(h.run('navScrollRestore'),210);
});
test('identical compose names have independent expansion on each server',()=>{
  const h=harness(); h.run(`setGroupCollapsed('shop',true); S.activeConn='b'`);
  assert.equal(h.run(`isCollapsed('shop',[{state:'running'}])`),false);
  h.run(`S.activeConn='a'`); assert.equal(h.run(`isCollapsed('shop',[{state:'running'}])`),true);
});
test('offline profile selection never connects and cannot show old containers',()=>{
  const h=harness(); h.run(`let connected=0; connectProfile=()=>connected++; delete S.conns.b; switchConn('b')`);
  assert.equal(h.run('connected'),0); assert.equal(h.run('S.containers.length'),0);
  assert.equal(h.run('S.activeConn'),'b');
});
test('mode round trip restores container and detail tab',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; S.tab='files'; switchNavMode('server'); switchNavMode('containers');`);
  assert.equal(h.run('S.selected.id'),'one'); assert.equal(h.run('S.tab'),'files');
});
test('stale server response cannot restore a pending selection',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; switchConn('b'); switchConn('a');`);
  assert.equal(h.run(`restorePendingNavigation('b')`),false); assert.equal(h.run('S.selected'),null);
});
test('a late refresh failure cannot mark a newly selected server as disconnected',async()=>{
  let reject;
  const h=harness(()=>new Promise((_,r)=>reject=r));
  h.run(`let losses=0; connLost=()=>losses++;`);
  const refreshing=h.run('refreshContainers()'); h.run(`switchConn('b')`);
  reject(new Error('transport closed')); await refreshing;
  assert.equal(h.run('losses'),0); assert.equal(h.run('S.conns.b.up'),true);
});
test('missing container returns to welcome instead of restoring stale data',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; switchConn('b'); switchConn('a'); restorePendingNavigation('a');`);
  assert.equal(h.run('S.selected'),null); assert.equal(h.run('S.view'),'welcome');
});
test('a dropped connection preserves the latest selection for reconnect and hides stale data',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; S.tab='inspect'; markDown('a','lost');`);
  assert.equal(h.run('S.view'),'welcome'); assert.equal(h.run('S.containers.length'),0);
  h.run(`S.conns.a={up:true,dockerOk:true}; prepareNavigation('a'); S.containers=[{id:'one'}]; restorePendingNavigation('a');`);
  assert.equal(h.run('S.selected.id'),'one'); assert.equal(h.run('S.tab'),'inspect');
});
test('resource and dashboard detours preserve primary container mode selection',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; S.tab='inspect'; openNavView('images'); switchNavMode('containers');`);
  assert.equal(h.run('S.selected.id'),'one');
  h.run(`openNavView('dash'); switchNavMode('containers')`);
  assert.equal(h.run('S.selected.id'),'one'); assert.equal(h.run('S.tab'),'inspect');
});
test('rapid server switching preserves a selection waiting for data',()=>{
  const h=harness(); h.run(`S.selected=S.containers[0]; S.view='container'; switchConn('b'); switchConn('a'); switchConn('b'); switchConn('a'); S.containers=[{id:'one'}]; restorePendingNavigation('a');`);
  assert.equal(h.run('S.selected.id'),'one');
});
test('server round trip restores list position even without a selected container',()=>{
  const h=harness(); h.el('tree').scrollTop=1120;
  h.run(`switchConn('b'); switchConn('a'); restorePendingNavigation('a')`);
  assert.equal(h.run('navScrollRestore'),1120); assert.equal(h.run('S.view'),'welcome');
});
test('rapid server switching does not overwrite the saved scroll with a loading skeleton',()=>{
  const h=harness(); h.el('tree').scrollTop=1120;
  h.run(`switchConn('b'); switchConn('a');`); h.el('tree').scrollTop=0;
  h.run(`switchConn('b'); switchConn('a'); restorePendingNavigation('a')`);
  assert.equal(h.run('navScrollRestore'),1120);
});
test('search matches image, port and stack while quick filters retain their meaning',()=>{
  const h=harness(); h.run(`S.quick='unhealthy'; const c={id:'one',name:'api',image:'nginx',project:'shop',ports:'8080:80',state:'running',status:'Up (unhealthy)'};`);
  for(const query of ['nginx','8080','shop'])assert.equal(h.run(`matchesFilter(c,'${query}')`),true);
  assert.equal(h.run('passQuick(c)'),true);
  h.run(`S.quick='stopped'`); assert.equal(h.run('passQuick(c)'),false);
});
test('arrow navigation is confined to tree and search, and leaves Alt shortcuts alone',()=>{
  const h=harness(); h.run(`let moves=0; moveCursor=()=>moves++; wireTreeKeys();`);
  const send=(target,altKey=false)=>h.handlers.keydown({target,key:'ArrowDown',altKey,preventDefault(){}});
  send(new h.ctx.Element('logs')); assert.equal(h.run('moves'),0);
  send(new h.ctx.Element('row',true)); assert.equal(h.run('moves'),1);
  send(new h.ctx.Element('filter')); assert.equal(h.run('moves'),2);
  send(new h.ctx.Element('row',true),true); assert.equal(h.run('moves'),2);
  h.run(`S.navMode='server'`); send(new h.ctx.Element('row',true)); assert.equal(h.run('moves'),2);
});
test('server picker puts pinned profiles and recent choices before the rest without duplicates',()=>{
  const h=harness(); h.run(`S.profiles=[{id:'a',name:'Alpha',kind:'local'},{id:'b',name:'Beta',kind:'local'},{id:'c',name:'Gamma',kind:'local'}]; S.serverPins=['c']; S.serverRecent=['b','c','b','deleted'];`);
  assert.deepEqual(Array.from(h.run(`orderedServerProfiles('').map(p=>p.id)`)),['c','b','a']);
});
test('server search ranks exact names first and matches multiple words across name and address',()=>{
  const h=harness(); h.run(`S.profiles=[{id:'a',name:'Production EU',kind:'ssh',user:'deploy',host:'192.0.2.10',port:22},{id:'b',name:'Prod',kind:'local'}]; S.serverPins=['a'];`);
  assert.deepEqual(Array.from(h.run(`orderedServerProfiles('prod').map(p=>p.id)`)),['b','a']);
  assert.deepEqual(Array.from(h.run(`orderedServerProfiles('production 192.0.2').map(p=>p.id)`)),['a']);
});
test('recent server history stays bounded, unique and records offline selections without connecting',()=>{
  const h=harness(); h.run(`let connects=0; connectProfile=()=>connects++; S.profiles=Array.from({length:12},(_,i)=>({id:'s'+i})); S.serverRecent=[]; for(const p of S.profiles) recordServerVisit(p.id); recordServerVisit('s7');`);
  assert.equal(h.run('S.serverRecent.length'),8); assert.equal(h.run('S.serverRecent[0]'),'s7');
  assert.equal(h.run('new Set(S.serverRecent).size'),8);
  h.run("switchConn('s3')");
  assert.equal(h.run('S.serverRecent[0]'),'s3'); assert.equal(h.run('connects'),0);
});
