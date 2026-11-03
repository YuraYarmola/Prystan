const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function harness(handler=async name=>name==='forward_list'?[]:null){
 const els=new Map(),calls=[],toasts=[],writes=[];
 const el=id=>{if(!els.has(id)){const classes=new Set();els.set(id,{style:{},dataset:{},value:'',disabled:false,textContent:'',innerHTML:'',setAttribute(k,v){this[k]=v},focus(){},classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k)},querySelectorAll:()=>[]});}return els.get(id)};
 const ctx={console,TextEncoder,TextDecoder,crypto:require('node:crypto').webcrypto,setInterval:()=>1,clearInterval(){},setTimeout,document:{getElementById:el,addEventListener(){}},window:{addEventListener(){},__TAURI__:{core:{invoke:async(name,args)=>{calls.push({name,args});return handler(name,args)}},event:{listen(){}}}},localStorage:{setItem:(k,v)=>writes.push([k,v])}};
 vm.createContext(ctx);for(const file of ['i18n','core','conn','tunnels'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/ui/js',file+'.js'),'utf8'),ctx);
 ctx.recordToast=(...x)=>toasts.push(x);vm.runInContext(`toast=recordToast;ic=()=>'';S.activeConn='a';S.profiles=[{id:'a',name:'Prod',kind:'ssh',host:'192.0.2.1',user:'demo',port:22,readonly:true},{id:'b',name:'Dev',kind:'ssh',host:'192.0.2.2',user:'demo',port:22},{id:'local',kind:'local'}];`,ctx);
 return {run:x=>vm.runInContext(x,ctx),el,calls,toasts,writes};
}
const row={key:'a|127.0.0.1|8081',conn:'a',remote_host:'127.0.0.1',remote_port:8081,local_port:18081,remote:'127.0.0.1:8081',status:'active',label:'Adminer',url:'http://127.0.0.1:18081'};
const request=`{conn:'a',remoteHost:'127.0.0.1',remotePort:8081,localPort:18081,label:'Adminer'}`;
test('header remains visible at zero and marks a failed poll unknown instead of green',async()=>{
 const h=harness(async()=>{throw Error('offline')});h.run('renderTunnelStatus()');assert.equal(h.el('fwd-badge').dataset.state,'idle');assert.equal(h.el('fwd-count').textContent,'0');h.run(`S.forwards=[${JSON.stringify(row)}]`);await h.run('refreshForwards()');assert.equal(h.el('fwd-badge').dataset.state,'unknown');assert.equal(h.el('fwd-count').textContent,'?');
});
test('child exit changes header and raises one notification',async()=>{
 const h=harness(async()=>[{...row,status:'failed'}]);h.run(`S.forwards=[${JSON.stringify(row)}]`);await h.run('refreshForwards()');assert.equal(h.el('fwd-badge').dataset.state,'failed');assert.equal(h.el('fwd-count').textContent,'0');await h.run('refreshForwards()');assert.equal(h.toasts.length,1);
});
test('starting a tunnel captures original server and exposes connecting state immediately',async()=>{
 let resolve;const h=harness(name=>name==='forward_start'?new Promise(r=>resolve=r):[row]);const work=h.run(`startTunnel(${request})`);assert.equal(h.el('fwd-badge').dataset.state,'starting');h.run(`S.activeConn='b'`);resolve(row);await work;assert.equal(h.calls[0].args.conn,'a');assert.equal(h.el('fwd-badge').dataset.state,'active');
});
test('duplicate clicks cannot launch two SSH processes',async()=>{
 let resolve;const h=harness(name=>name==='forward_start'?new Promise(r=>resolve=r):[row]);const work=h.run(`startTunnel(${request})`);await assert.rejects(h.run(`startTunnel(${request})`));assert.equal(h.calls.length,1);resolve(row);await work;
});
test('a stale list cannot replace a newly connected tunnel',async()=>{
 let resolve;const h=harness(name=>name==='forward_list'?new Promise(r=>resolve=r):row);const poll=h.run('refreshForwards()');const start=h.run(`startTunnel(${request})`);await new Promise(setImmediate);resolve([]);await Promise.all([poll,start]);assert.equal(h.run('S.forwards.length'),1);assert.equal(h.el('fwd-badge').dataset.state,'active');
});
test('read-only SSH profiles can tunnel; invalid inputs never invoke backend',async()=>{
 const h=harness();h.el('tun-server').value='a';h.el('tun-host').value='127.0.0.1';h.el('tun-remote').value='8081';h.el('tun-local').value='18081';assert.equal(h.run('tunnelFormRequest().conn'),'a');h.el('tun-local').value='65536';await h.run('submitTunnel()');assert.equal(h.calls.length,0);assert.match(h.el('tun-error').textContent,/65535/);
});
test('presets save metadata only, do not start a tunnel and preserve selected server',()=>{
 const h=harness();h.el('tun-server').value='a';h.el('tun-host').value='127.0.0.1';h.el('tun-remote').value='8081';h.el('tun-name').value='Adminer';h.run('saveTunnelPreset()');assert.equal(h.calls.length,0);assert.equal(h.run('S.tunnelPresets.length'),1);const saved=JSON.parse(h.writes[0][1]);assert.equal(saved.tunnelPresets[0].conn,'a');assert(!JSON.stringify(saved.tunnelPresets[0]).includes('password'));h.run(`S.profiles[0].host='192.0.2.99'`);assert.equal(h.run('S.tunnelPresets[0].endpoint===tunnelEndpoint(S.profiles[0])'),false);
});
test('opening local container ports does not create a fictional SSH tunnel',async()=>{
 const h=harness();h.run(`S.activeConn='local'`);await h.run(`openContainerPort({name:'adminer'},'8081:8080')`);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'open_url');assert.equal(h.calls[0].args.url,'http://127.0.0.1:8081');
});

test('opening a remote container port only prepares the manual form and never starts SSH',async()=>{
 const h=harness();await h.run(`openContainerPort({name:'adminer'},'8081:8080')`);assert.equal(h.calls.filter(c=>c.name==='forward_start'||c.name==='open_url').length,0);assert.equal(h.el('tun-server').value,'a');assert.equal(h.el('tun-remote').value,8081);assert.equal(h.el('tun-create').open,true);assert(h.el('tunnel-modal').classList.contains('open'));
});

test('browser action reuses an active SSH tunnel without creating one; unknown status cannot open it',async()=>{
 const h=harness();h.run(`S.forwards=[${JSON.stringify(row)}]`);await h.run(`openContainerPort({name:'adminer'},'8081:8080')`);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'open_url');h.run('tunnelUI.unknown=true');await h.run(`openContainerPort({name:'adminer'},'8081:8080')`);assert.equal(h.calls.filter(c=>c.name==='open_url').length,1);assert.equal(h.calls.filter(c=>c.name==='forward_start').length,0);
});

test('manual preparation retains the captured container server after a server switch',async()=>{
 const h=harness();h.run(`S.activeConn='b'`);await h.run(`openContainerPort({name:'adminer'},'8081:8080','a')`);assert.equal(h.el('tun-server').value,'a');assert.equal(h.calls.filter(c=>c.name==='forward_start').length,0);
});

test('global shelf includes tunnels on every server with an adjacent off button and truthful styling',()=>{
 const h=harness();h.run(`S.forwards=[${JSON.stringify(row)},${JSON.stringify({...row,key:'b|127.0.0.1|5432',conn:'b',remote_port:5432,label:'PostgreSQL',local_port:15432})}];renderTunnelStatus()`);assert.equal(h.el('tunnel-shelf').hidden,false);assert.match(h.el('tun-live').innerHTML,/Adminer/);assert.match(h.el('tun-live').innerHTML,/PostgreSQL/);assert.equal((h.el('tun-live').innerHTML.match(/data-action="stop"/g)||[]).length,2);assert.match(h.el('tun-live').innerHTML,/data-state="active"/);h.run(`tunnelUI.unknown=true;renderTunnelStatus()`);assert(!h.el('tun-live').innerHTML.includes('data-state="active"'));assert.match(h.el('tun-live').innerHTML,/data-state="unknown"/);
});

test('turning off one tunnel preserves others and duplicate clicks issue one stop',async()=>{
 let resolve;const other={...row,key:'b|127.0.0.1|5432',conn:'b',remote_port:5432};const h=harness(name=>name==='forward_stop'?new Promise(r=>resolve=r):[other]);h.run(`S.forwards=[${JSON.stringify(row)},${JSON.stringify(other)}]`);const pending=h.run(`stopTunnel(${JSON.stringify(row.key)})`);await h.run(`stopTunnel(${JSON.stringify(row.key)})`);assert.equal(h.calls.filter(c=>c.name==='forward_stop').length,1);resolve();await pending;assert.equal(h.run('S.forwards.length'),1);assert.equal(h.run('S.forwards[0].conn'),'b');
});

test('a failed stop retains the tunnel rather than showing a false disabled state',async()=>{
 const h=harness(name=>name==='forward_stop'?Promise.reject(Error('IPC error')):[row]);h.run(`S.forwards=[${JSON.stringify(row)}]`);await assert.rejects(h.run(`stopTunnel(${JSON.stringify(row.key)})`));assert.equal(h.run('S.forwards.length'),1);assert.equal(h.el('fwd-badge').dataset.state,'active');assert.equal(h.run('tunnelUI.stopping.size'),0);
});
test('stop all requires confirmation and never stops tunnels when cancelled',async()=>{
 const h=harness(async()=>[row]);h.run('ask=async()=>false');await h.run('stopAllForwards()');assert.equal(h.calls.filter(c=>c.name==='forward_stop').length,0);
});
test('tunnel messages have all three translations',()=>{
 const h=harness();for(const lang of ['uk','ru','en']){h.run(`LANG='${lang}'`);for(const key of ['title','server','starting','active','failed','unknown','hint','lifecycle','checkFailed','copyCommand','profileChanged'])assert.notEqual(h.run(`t('tun.${key}')`),'tun.'+key);}
});

test('reopening the manager preserves the explicitly selected SSH server with its ports',()=>{
 const h=harness();h.el('tun-server').value='a';h.el('tun-host').value='db.internal';h.el('tun-remote').value='5432';h.run(`S.activeConn='b';openTunnelManager()`);assert.equal(h.el('tun-server').value,'a');assert.equal(h.el('tun-host').value,'db.internal');assert.equal(h.el('tun-remote').value,'5432');
});

test('tunnel status polling starts before potentially slow profile and server connections',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../app/ui/js/app.js'),'utf8');const boot=app.slice(app.lastIndexOf('(async () => {'));assert(boot.indexOf('wireTunnels()')<boot.indexOf('await loadProfiles()'));assert.equal((boot.match(/wireTunnels\(\)/g)||[]).length,1);
});

test('every tunnel label referenced in UI code and markup has a direct translation',()=>{
 const h=harness(),root=path.join(__dirname,'../app/ui');const sources=['js/tunnels.js','js/app.js','js/conn.js','index.html'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');const keys=new Set([...sources.matchAll(/tun\.[A-Za-z]+/g)].map(m=>m[0]));for(const lang of ['uk','ru','en'])for(const key of keys)assert.equal(h.run(`typeof I18N[${JSON.stringify(lang)}][${JSON.stringify(key)}]`),'string',lang+': '+key);
});
