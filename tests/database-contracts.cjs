const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function harness(handler=async()=>[]) {
  const elements=new Map(),calls=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',focus(){},dataset:{},classList:{toggle(){}},innerHTML:'',style:{},parentElement:{},querySelectorAll:()=>[]});return elements.get(id);};
  const ctx={console,Map,TextEncoder,TextDecoder,setTimeout,clearTimeout,document:{getElementById:element,addEventListener(){}},window:{addEventListener(){},__TAURI__:{core:{invoke:async(name,args)=>{calls.push({name,args});return handler(name,args);}},event:{listen(){}}}}};
  vm.createContext(ctx);
  for(const f of ['i18n','core','databases'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/ui/js',f+'.js'),'utf8'),ctx);
  const run=s=>vm.runInContext(s,ctx);
  run(`globalThis.renderDatabaseUI=renderDatabases;globalThis.ic=()=>"";renderDatabaseSidebar=()=>{};renderDatabases=()=>{};S.activeConn='a';S.view='databases';S.navMode='databases';S.conns={a:{up:true,dockerOk:true},b:{up:true,dockerOk:true}};S.profiles=[{id:'a',readonly:true},{id:'b'}];databaseSession().source={id:'docker:one',engine:'postgres',state:'running'};`);
  return {run,element,calls};
}
test('database requests capture original server and cannot repaint another server after delayed responses',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  const request=h.run(`databaseOperation('tables')`);
  h.run(`S.activeConn='b'; databaseSession().tables=[{name:'other'}]`);
  resolve([{name:'original'}]);await request;
  assert.equal(h.calls[0].args.conn,'a');assert.equal(h.run('databaseSession().tables[0].name'),'other');
  h.run(`S.activeConn='a'`);assert.equal(h.run('databaseSession().tables[0].name'),'original');
});
test('read-only profiles may browse and requests expose only a fixed read action',async()=>{
  const h=harness();await h.run(`databaseOperation('tables')`);
  assert.equal(h.calls[0].name,'database_browse');assert.equal(h.calls[0].args.request.action,'tables');assert.equal(h.calls[0].args.request.source_id,'docker:one');
  assert.equal(Object.hasOwn(h.calls[0].args.request,'sql'),false);
});
test('single-flight blocks duplicate queries and source changes until the read completes',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  const request=h.run(`databaseOperation('tables')`);await h.run(`databaseOperation('tables')`);
  h.run(`databaseSession().sources=[{id:'docker:two'}]; selectDatabaseSource('docker:two')`);
  assert.equal(h.calls.length,1);assert.equal(h.run('databaseSession().source.id'),'docker:one');
  resolve([]);await request;
});
test('disconnect forgets passwords and delayed results cannot recreate cleared sessions',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  h.run(`databaseSession().password='session-secret'`);const request=h.run(`databaseOperation('tables')`);
  h.run(`clearDatabaseSession('a');delete S.conns.a`);resolve([{name:'private'}]);await request;
  assert.equal(h.run(`databaseSessions.has('a')`),false);
});
test('closing a session between columns and rows prevents the second request',async()=>{
  const h=harness(async()=>{h.run(`clearDatabaseSession('a')`);return [{name:'id'}];});
  await h.run(`databaseOperation('preview',{},async read=>({columns:await read('columns'),rows:await read('rows')}))`);
  assert.equal(h.calls.length,1);
});
test('a failed read releases the controls and allows a retry',async()=>{
  let fail=true;const h=harness(async()=>{if(fail)throw Error('Access denied');return [];});
  await h.run(`databaseOperation('tables')`);assert.equal(h.run('databaseSession().busy'),false);assert.match(h.run('databaseSession().error'),/Access denied/);
  fail=false;await h.run(`databaseOperation('tables')`);assert.equal(h.run('databaseSession().error'),'');
});
test('Redis cursor remains server supplied and zero means completion without KEYS',async()=>{
  const h=harness(async()=>({cursor:'18446744073709551615',keys:['a']}));
  h.run(`databaseSession().source.engine='redis';databaseSession().database='0'`);await h.run(`databaseOperation('keys')`);
  assert.equal(h.run('databaseSession().nextCursor'),'18446744073709551615');assert.equal(h.calls[0].args.request.cursor,'0');
});
test('cell rendering escapes markup and distinguishes null from the string NULL',()=>{
  const h=harness();assert.equal(h.run(`databaseCell('<img src=x onerror=alert(1)>')`),'&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(h.run(`databaseCell('NULL')`),'NULL');assert.match(h.run('databaseCell(null)'),/db-null/);
});
test('database credentials and query results are not part of persisted app state',()=>{
  const h=harness();h.run(`databaseSession().password='session-secret';databaseSession().result={rows:['private-data']}`);
  assert.equal(h.run(`JSON.stringify(S).includes('session-secret')`),false);assert.equal(h.run(`JSON.stringify(S).includes('private-data')`),false);
});
test('every database UI message is translated directly in all supported languages',()=>{
  const h=harness();const source=fs.readFileSync(path.join(__dirname,'../app/ui/js/databases.js'),'utf8');
  const keys=[...source.matchAll(/t\("(db\.[^"]+)"/g)].map(m=>m[1]);
  for(const lang of ['uk','ru','en'])for(const key of keys)assert.equal(h.run(`typeof I18N['${lang}']['${key}']`),'string',lang+': '+key);
});


test('discovery scans only the captured server and auto-selects a single running host service',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));
  h.run('databaseSession().source=null');const pending=h.run('discoverDatabases()');
  h.run("S.activeConn='b'");resolve({sources:[{id:'host:clickhouse:9000',engine:'clickhouse',state:'running'}],warnings:[]});await pending;
  assert.equal(h.calls[0].args.conn,'a');assert.equal(h.run('databaseSession().source'),null);
  h.run("S.activeConn='a'");assert.equal(h.run('databaseSession().source.id'),'host:clickhouse:9000');
});
test('YAML import recognizes only ClickHouse accounts and preserves quoted passwords',()=>{
  const h=harness();
  const yaml = "ch_default_password: \"a#b: c\" # note\nch_admin_password: 'it''s secret'\nmia_proxy_token: ignore";
  const value=h.run('parseClickHouseSecrets('+JSON.stringify(yaml)+')');
  assert.equal(value.default,'a#b: c');assert.equal(value.admin,"it's secret");assert.equal(Object.keys(value).length,2);
});
test('unsupported YAML does not leak contents in errors',()=>{
  const h=harness();
  for(const value of ['ch_default_password: !tag private-value','ch_admin_password: *private-value','ch_default_password: |','unrelated: private-value','ch_default_password: null']) {
    assert.throws(()=>h.run('parseClickHouseSecrets('+JSON.stringify(value)+')'),e=>!e.message.includes('private-value'));
  }
});
test('import is local to the chosen server and forgetting clears imported credentials',async()=>{
  const h=harness();h.run("databaseSession().source.engine='clickhouse'");
  h.run(`globalThis.file={size:50,text:async()=> 'ch_default_password: demo-password'}`);
  await h.run('importClickHouseSecrets(file)');assert.equal(h.run('databaseSession().username'),'default');assert.equal(h.run('databaseSession().password'),'demo-password');assert.equal(h.calls.length,0);
  h.run("databaseSession().sources=[databaseSession().source];selectDatabaseSource('docker:one')");
  assert.equal(h.run('databaseSession().importedCredentials'),null);assert.equal(h.run('databaseSession().password'),'');
});
test('a file finishing after a server switch cannot populate another session',async()=>{
  const h=harness();let resolve;
  h.run("databaseSession().source.engine='clickhouse'");
  h.run('globalThis.file={size:50}');h.element('unused');
  // Inject a controlled asynchronous file reader without persisting its contents.
  h.run('globalThis.file.text=()=>new Promise(r=>globalThis.finishFile=r)');
  const pending=h.run('importClickHouseSecrets(file)');h.run("S.activeConn='b'; finishFile('ch_default_password: demo-password')");await pending;
  assert.equal(h.run('databaseSession().password'),'');h.run("S.activeConn='a'");assert.equal(h.run('databaseSession().password'),'');
});


test('bounded previews mark only server-reported truncated cells and escape their text',()=>{
 const h=harness();const html=h.run(`databaseGrid(['text','other'],[['<script>','NULL']],{truncated:[[0,0]],cell_limit:256})`);
 assert.match(html,/&lt;script&gt;/);assert.equal((html.match(/class="db-truncated"/g)||[]).length,1);
 assert.match(html,/256/);assert.equal(h.run(`databaseGrid(['text'],[['short']],{truncated:[],cell_limit:256}).includes('db-truncated')`),false);
});
test('adaptive pages advance by returned size and errors do not claim an empty table',async()=>{
 const h=harness(async(name,args)=>args.request.action==='columns'?[{name:'id'}]:{columns:['id'],rows:[['1']],page_size:24,more:true,truncated:[],cell_limit:256});
 h.run(`Object.assign(databaseSession(),{scanned:true,databases:['demo'],database:'demo',tables:[{schema:'demo',name:'wide'}],table:{schema:'demo',name:'wide'}})`);
 await h.run('loadDatabasePreview()');assert.equal(h.run('databaseSession().pageSize'),24);
 h.run('renderDatabaseUI()');assert.match(h.element('db-preview').innerHTML,/Наступні 24/);
 h.element('db-next').onclick();await new Promise(r=>setImmediate(r));
 assert.equal(h.calls.at(-1).args.request.offset,24);assert.equal(h.run('databaseSession().offset'),24);
 h.run(`databaseSession().result=null;databaseSession().error='read failed';databaseSession().errorAction='preview';renderDatabaseUI()`);
 assert.doesNotMatch(h.element('db-preview').innerHTML,/Рядків немає/);assert.match(h.element('db-preview').innerHTML,/db-retry/);
 assert.doesNotMatch(h.element('db-workspace').innerHTML,/<details class="db-auth-details" open>/);
 h.run(`databaseSession().tab='columns';renderDatabaseUI()`);assert.match(h.element('db-preview').innerHTML,/id/);
});

test('table selection resets query and paging while structure opens without fetching rows',async()=>{
 const h=harness(async()=>[{name:'id',type:'integer'}]);
 h.run(`Object.assign(databaseSession(),{tables:[{schema:'public',name:'users'}],offset:50,orderColumn:'old',queryFilter:{column:'old',op:'eq',value:'secret'}});selectDatabaseTable(0,'columns')`);
 await new Promise(r=>setImmediate(r));
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].args.request.action,'columns');
 assert.equal(h.run('databaseSession().offset'),0);assert.equal(h.run('databaseSession().orderColumn'),'');
 assert.equal(h.run('databaseSession().queryFilter.column'),'');assert.equal(h.run('databaseSession().columns[0].name'),'id');assert.equal(h.run('databaseSession().result'),null);
});
test('filters, numeric sorting and requested page size are sent to the captured server',async()=>{
 const h=harness(async()=>({rows:[],page_size:25,more:false}));
 h.run(`Object.assign(databaseSession(),{columns:[{name:'id'}],table:{schema:'public',name:'users'},requestedPageSize:25,queryFilter:{column:'name',op:'contains',value:"a'%_"},offset:100});sortDatabaseColumn('id')`);
 await new Promise(r=>setImmediate(r));
 const r=h.calls.at(-1).args.request;assert.equal(r.filter_value,"a'%_");assert.equal(r.order_column,'id');assert.equal(r.order_desc,false);assert.equal(r.offset,0);assert.equal(r.page_size,25);
 h.run(`sortDatabaseColumn('id')`);await new Promise(r=>setImmediate(r));assert.equal(h.calls.at(-1).args.request.order_desc,true);
});
test('database changes clear previous table query state and only fetch metadata',async()=>{
 const h=harness(async()=>[]);
 h.run(`Object.assign(databaseSession(),{orderColumn:'private',queryFilter:{column:'private',op:'eq',value:'secret'},offset:25,table:{name:'old'}})`);
 await h.run('loadDatabaseObjects()');assert.equal(h.calls[0].args.request.action,'tables');assert.equal(h.run('databaseSession().queryFilter.value'),'');assert.equal(h.run('databaseSession().table'),null);
});
test('page export contains visible preview with truncation metadata and excludes credentials',()=>{
 const h=harness();h.run(`Object.assign(databaseSession(),{password:'session-secret',username:'private-user',result:{rows:[['preview']],columns:['body'],truncated:[[0,0]],cell_limit:256}})`);
 const payload=h.run(`JSON.stringify(databasePageExport(databaseSession()))`);assert.match(payload,/preview/);assert.match(payload,/truncated/);assert.doesNotMatch(payload,/session-secret|private-user/);
});
test('row headers expose sort controls only for data grids and escape column names',()=>{
 const h=harness();assert.match(h.run(`databaseGrid(['<id>'],[['1']],{},true)`),/data-sort="0"/);assert.match(h.run(`databaseGrid(['<id>'],[['1']],{},true)`),/&lt;id&gt;/);assert.doesNotMatch(h.run(`databaseGrid(['name'],[],null)`),/data-sort/);
});

test('column structure remains available if the first row read fails',async()=>{
 const h=harness(async(name,args)=>{if(args.request.action==='columns')return [{name:'id',type:'integer'}];throw Error('Rows unavailable');});
 h.run(`databaseSession().table={schema:'public',name:'users'}`);await h.run('loadDatabasePreview()');
 assert.equal(h.run('databaseSession().columns[0].name'),'id');assert.equal(h.run('databaseSession().result'),null);assert.match(h.run('databaseSession().error'),/Rows unavailable/);
});

test('table statistics distinguish unknown from zero and preserve large row counts',()=>{
 const h=harness();
 assert.match(h.run(`databaseStat(null)`),/—/);assert.match(h.run(`databaseStat(-1)`),/—/);
 assert.doesNotMatch(h.run(`databaseStat('0',true)`),/—/);assert.match(h.run(`databaseStat('105',false,true)`),/≈/);
 assert.equal(h.run(`databaseStat('9007199254740993').replace(/[^0-9]/g,'')`),'90071992547409939007199254740993');
 assert.match(h.run(`databaseStat('<script>')`),/—/);
});
test('overview sorts statistics numerically at full precision and keeps unknown last',()=>{
 const h=harness();h.run(`Object.assign(databaseSession(),{overviewSort:'rows_count',overviewDesc:true,tables:[{name:'a',rows_count:'9007199254740992'},{name:'unknown',rows_count:null},{name:'b',rows_count:'9007199254740993'},{name:'empty',rows_count:'0'}]})`);
 assert.equal(h.run(`databaseOverviewRows(databaseSession()).map(r=>r.x.name).join(',')`),'b,a,empty,unknown');
 h.run(`databaseSession().overviewDesc=false`);assert.equal(h.run(`databaseOverviewRows(databaseSession()).map(r=>r.i).join(',')`),'3,0,2,1');
});
test('statistics refresh preserves the selected table and page results without reading data',async()=>{
 const h=harness(async()=>[{schema:'public',name:'users',rows_count:'200',total_bytes:'8192'}]);
 h.run(`Object.assign(databaseSession(),{table:{schema:'public',name:'users'},result:{rows:[{id:'1'}]},offset:25})`);
 await h.run('refreshDatabaseStats()');assert.equal(h.calls.length,1);assert.equal(h.calls[0].args.request.action,'tables');
 assert.equal(h.run('databaseSession().table.rows_count'),'200');assert.equal(h.run('databaseSession().offset'),25);assert.equal(h.run('databaseSession().result.rows[0].id'),'1');
});
test('overview and table description expose readable sizes and safe table comments',()=>{
 const h=harness();h.run(`Object.assign(databaseSession(),{scanned:true,databases:['demo'],database:'demo',tables:[{schema:'public',name:'users',kind:'InnoDB',rows_count:'12345',rows_estimated:true,data_bytes:'1048576',index_bytes:'0',total_bytes:'1048576',comment:'<img src=x>'}]});renderDatabaseUI()`);
 const overview=h.element('db-preview').innerHTML;assert.match(overview,/Індекси/);assert.match(overview,/data-stat-sort="total_bytes"/);assert.match(overview,/≈/);assert.match(overview,/&lt;img src=x&gt;/);assert.doesNotMatch(overview,/<img src=x>/);
 h.run(`databaseSession().table=databaseSession().tables[0];databaseSession().tab='columns';renderDatabaseUI()`);
 assert.match(h.element('db-preview').innerHTML,/db-table-info/);assert.match(h.element('db-preview').innerHTML,/db-refresh-stats/);
});

test('successful remembered login keeps only a vault reference in the UI',async()=>{
 const h=harness(async()=>({databases:['demo'],saved_profile:{id:'saved-reader',username:'reader',database:'demo',password_saved:true},save_error:null}));
 h.run(`databaseSession().password='typed-secret';databaseSession().username='reader'`);await h.run(`databaseOperation('databases')`);
 assert.equal(h.calls[0].args.request.remember,true);assert.equal(h.run('databaseSession().password'),'');assert.equal(h.run('databaseSession().savedProfileId'),'saved-reader');
 assert.doesNotMatch(h.run('JSON.stringify(databaseSession().savedProfiles)'),/typed-secret/);
});
test('saved connections are proposed automatically without receiving a password',async()=>{
 const h=harness(async()=>[{id:'saved-reader',username:'reader',database:'demo',password_saved:true}]);
 await h.run(`loadSavedDatabaseProfiles('a',databaseSession())`);
 assert.equal(h.run('databaseSession().savedProfileId'),'saved-reader');assert.equal(h.run('databaseSession().username'),'reader');assert.equal(h.run('databaseSession().password'),'');
 await h.run(`databaseOperation('columns')`);assert.equal(h.calls.at(-1).args.request.saved_profile_id,'saved-reader');assert.equal(h.calls.at(-1).args.request.password,'');
});
test('failed authentication does not create a profile and saving can be disabled',async()=>{
 const h=harness(async()=>{throw Error('Authentication failed');});await h.run(`databaseOperation('databases')`);assert.equal(h.run('databaseSession().savedProfiles.length'),0);
 h.run(`databaseSession().remember=false`);await h.run(`databaseOperation('databases')`);assert.equal(h.calls.at(-1).args.request.remember,false);
});
test('vault failure keeps the successful session usable and explains that saving failed',async()=>{
 const h=harness(async()=>({databases:['demo'],saved_profile:null,save_error:'System credential storage is unavailable'}));
 h.run(`databaseSession().password='session-secret'`);await h.run(`databaseOperation('databases')`);
 assert.equal(h.run('databaseSession().error'),'');assert.equal(h.run('databaseSession().database'),'demo');assert.match(h.run('databaseSession().saveWarning'),/не збережено/);assert.equal(h.run('databaseSession().password'),'session-secret');
});
test('late saved-profile responses cannot populate a different server or source',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));const pending=h.run(`loadSavedDatabaseProfiles('a',databaseSession())`);
 h.run(`S.activeConn='b'`);resolve([{id:'a-private',username:'reader',database:'private',password_saved:true}]);await pending;
 assert.equal(h.run('databaseSession().savedProfileId'),'');h.run(`S.activeConn='a'`);assert.equal(h.run('databaseSession().savedProfileId'),'a-private');
});
test('deleting a saved profile clears the current session and requests vault removal',async()=>{
 const h=harness(async()=>null);h.run(`Object.assign(databaseSession(),{savedProfileId:'saved-reader',savedProfiles:[{id:'saved-reader'}],databases:['demo'],result:{rows:['private']},password:'typed-secret'})`);
 await h.run('forgetSavedDatabaseProfile()');assert.equal(h.calls[0].name,'database_forget_profile');assert.equal(h.calls[0].args.id,'saved-reader');assert.equal(h.run('databaseSession().savedProfiles.length'),0);assert.equal(h.run('databaseSession().password'),'');assert.equal(h.run('databaseSession().result'),null);
});
test('editing credentials switches away from the saved password reference',()=>{
 const h=harness();h.run(`databaseSession().savedProfileId='old';editDatabaseCredentials(databaseSession())`);assert.equal(h.run('databaseSession().savedProfileId'),'');assert.equal(h.element('db-saved-profile').value,'');
});


test('switching saved accounts clears the previous account preview and keeps credentials open',()=>{
 const h=harness();h.run(`Object.assign(databaseSession(),{savedProfiles:[{id:'next',username:'reader',database:'nextdb'}],databases:['old'],tables:[{name:'private'}],result:{rows:['private']},table:{name:'private'},password:'old-secret'});useSavedDatabaseProfile(databaseSession(),'next')`);
 assert.equal(h.run('databaseSession().databases.length'),0);assert.equal(h.run('databaseSession().result'),null);assert.equal(h.run('databaseSession().table'),null);assert.equal(h.run('databaseSession().password'),'');assert.equal(h.run('databaseSession().database'),'nextdb');
});
