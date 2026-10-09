const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function harness(handler=async()=>[]) {
  const elements=new Map(), calls=[];
  const el=id=>{
    if(!elements.has(id)) elements.set(id,{id,value:'',scrollTop:0,dataset:{},style:{},classList:{contains:()=>false},querySelectorAll:()=>[]});
    return elements.get(id);
  };
  const ctx={console,TextEncoder,TextDecoder,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},navigator:{language:'uk'},localStorage:{getItem:()=>null,setItem(){}},
    document:{getElementById:el,querySelector:()=>null,addEventListener(){},visibilityState:'visible'},
    window:{addEventListener(){},__TAURI__:{core:{invoke:(name,args)=>{calls.push({name,args});return handler(name,args);}},event:{listen(){}}}}};
  vm.createContext(ctx);
  for(const name of ['i18n','core','nav','conn','container-table','app']) {
    let src=fs.readFileSync(path.join(__dirname,'../app/ui/js/'+name+'.js'),'utf8');
    if(name==='app') src=src.split('/* ═══ старт ═══ */')[0];
    vm.runInContext(src,ctx);
  }
  const run=s=>vm.runInContext(s,ctx);
  run(`renderTree=()=>{}; renderDetail=()=>{}; renderConnBox=()=>{}; renderEngineLabel=()=>{}; refreshAll=()=>{}; renderContainerTable=()=>{}; persist=()=>{};
    S.profiles=[{id:'a',name:'A',kind:'ssh',readonly:true},{id:'b',name:'B',kind:'ssh'}];
    S.conns={a:{up:true,dockerOk:true},b:{up:true,dockerOk:true}}; S.activeConn='a'; S.view='containers';
    S.containers=[{id:'one',name:'api',state:'running',status:'Up 1 hour'}];`);
  return {run,el,ctx,calls};
}
const ids=result=>Array.from(result,c=>c.id);

test('CPU sorting is numeric in both directions, keeps unavailable rows last and ignores stopped statistics',()=>{
  const h=harness();
  h.run(`const rows=[{id:'a',name:'api-10',state:'running'},{id:'b',name:'api-2',state:'running'},{id:'c',name:'stopped',state:'exited'},{id:'d',name:'missing',state:'running'}];
    const stats=new Map([['a',{cpu_pct:100}],['b',{cpu_pct:9}],['c',{cpu_pct:500}]]); S.containerSort={key:'cpu',dir:-1};`);
  assert.deepEqual(ids(h.run('sortedContainerRows(rows,stats)')),['a','b','d','c']);
  h.run('S.containerSort.dir=1');
  assert.deepEqual(ids(h.run('sortedContainerRows(rows,stats)')),['b','a','d','c']);
  assert.equal(h.run('containerMetric(rows[2],"cpu",stats)'),null);
});
test('status sorting prioritizes failures and unhealthy containers while equal states use natural names',()=>{
  const h=harness();
  h.run(`const rows=[{id:'a',name:'worker-10',state:'running',status:'Up'},{id:'b',name:'worker-2',state:'running',status:'Up'},{id:'c',name:'db',state:'running',status:'Up (unhealthy)'},{id:'d',name:'job',state:'exited',status:'Exited (137)'}];`);
  assert.deepEqual(ids(h.run('sortedContainerRows(rows,new Map())')),['c','d','b','a']);
  assert.equal(h.run('rows[0].id'),'a');
});
test('RAM sorting rejects invalid values but preserves valid zero',()=>{
  const h=harness();
  h.run(`const rows=[{id:'a',name:'a',state:'running'},{id:'b',name:'b',state:'running'},{id:'c',name:'c',state:'running'}]; const stats=new Map([['a',{mem_usage:0}],['b',{mem_usage:NaN}],['c',{mem_usage:1048576}]]); S.containerSort={key:'ram',dir:-1};`);
  assert.deepEqual(ids(h.run('sortedContainerRows(rows,stats)')),['c','a','b']);
});
test('a slow statistics response from the previous server cannot populate the current table',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  const pending=h.run('refreshContainerTableStats()');
  h.run(`switchConn('b'); S.view='containers'`);
  resolve([{id:'foreign',cpu_pct:90}]);await pending;
  assert.equal(h.run('containerTableState().stats.size'),0);
  assert.equal(h.calls[0].args.conn,'a');
});
test('a late error cannot clear another server statistics',async()=>{
  let reject;const h=harness(()=>new Promise((_,r)=>reject=r));
  const pending=h.run('refreshContainerTableStats()');
  h.run(`switchConn('b'); S.view='containers'; containerTableState().stats.set('local',{cpu_pct:2})`);
  reject(new Error('transport closed'));await pending;
  assert.equal(h.run(`containerTableState().stats.get('local').cpu_pct`),2);
  assert.equal(h.run('containerTableState().error'),'');
});
test('statistics polling allows one in-flight request and works on read-only profiles',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  const first=h.run('refreshContainerTableStats()');await h.run('refreshContainerTableStats()');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'containers_stats_snapshot');
  resolve([{id:'one',cpu_pct:12}]);await first;
  assert.equal(h.run(`containerTableState().stats.get('one').cpu_pct`),12);
});
test('statistics failure clears stale readings while retaining container navigation',async()=>{
  const h=harness(async()=>{throw Error('failed snapshot');});
  h.run(`containerTableState().stats.set('one',{cpu_pct:20})`);
  await h.run('refreshContainerTableStats()');
  assert.equal(h.run('containerTableState().stats.size'),0);
  assert.equal(h.run('S.containers[0].id'),'one');
  assert.equal(h.run('containerTableState().error'),'Error: failed snapshot');
});
test('leaving the table cancels polling ownership and ignores its delayed response',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  const pending=h.run('refreshContainerTableStats()');
  h.run(`S.view='container'; syncContainerTable(); S.view='containers'`);
  resolve([{id:'one',cpu_pct:50}]);await pending;
  assert.equal(h.run('containerTableState().stats.size'),0);
});
test('opening table logs sets the tab before selecting the container',()=>{
  const h=harness();
  h.run(`let tabAtOpen; selectContainer=c=>{tabAtOpen=S.tab; S.selected=c;}; S.tab='files'; openTableContainer(S.containers[0],true)`);
  assert.equal(h.run('tabAtOpen'),'logs');
  assert.equal(h.run('S.selected.id'),'one');
});
test('table view and search survive a server round trip without using previous server rows',()=>{
  const h=harness();h.el('filter').value='api';
  h.run(`S.containerDisplay='table'; switchConn('b'); switchConn('a'); S.containers=[{id:'one',name:'api'}]; restorePendingNavigation('a')`);
  assert.equal(h.run('S.view'),'containers');
  assert.equal(h.el('filter').value,'api');
});
test('scroll positions are scoped to the displayed server, including during a switch',()=>{
  const h=harness();h.el('pane-containers').classList.contains=()=>true;h.el('ct-scroll').dataset.conn='a';h.el('ct-scroll').scrollTop=910;
  h.run('rememberContainerTableScroll(); S.activeConn="b"; rememberContainerTableScroll()');
  assert.equal(h.run(`containerTables.get('a').scroll`),910);
  assert.equal(h.run(`containerTables.get('b')?.scroll ?? 0`),0);
});
test('a temporary empty loading table cannot overwrite its saved scroll position',()=>{
  const h=harness();h.el('pane-containers').classList.contains=()=>true;h.el('ct-scroll').dataset.conn='a';h.el('ct-scroll').scrollTop=0;
  h.run('containerTableState().scroll=900; S.loading=true; rememberContainerTableScroll()');
  assert.equal(h.run('containerTableState().scroll'),900);
  h.run('S.loading=false; containerTableState().restoreScroll=true; rememberContainerTableScroll()');
  assert.equal(h.run('containerTableState().scroll'),900);
});
test('display and sort preferences restore safely and invalid sort preferences use the default',()=>{
  for(const sort of [{key:'ram',dir:1},{key:'bad',dir:1},{key:'cpu',dir:0}]) {
    const h=harness();h.ctx.localStorage.getItem=()=>JSON.stringify({containerDisplay:'table',containerSort:sort});
    h.run('setTheme=()=>{}; setLang=()=>{}; restore()');
    assert.equal(h.run('S.containerDisplay'),'table');
    assert.equal(h.run('S.containerSort.key'),sort.key==='ram'?'ram':'status');
  }
});
test('every table message has a direct translation in each supported language',()=>{
  const h=harness();
  const uk=Array.from(h.run(`Object.keys(I18N.uk).filter(k=>k.startsWith('ct.'))`));
  for(const lang of ['ru','en']) for(const key of uk) assert.equal(h.run(`typeof I18N.${lang}[${JSON.stringify(key)}]`),'string');
});
