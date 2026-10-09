const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function harness(handler = async () => null) {
  const elements = new Map(), events = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, value: '', checked: true, disabled: false, textContent: '', innerHTML: '', focus(){}, classList: { add(){}, remove(){}, toggle(){} } });
    return elements.get(id);
  };
  const sandbox = { TextEncoder, TextDecoder, console, setTimeout, crypto: { randomUUID }, btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'),
    document: { getElementById: element, addEventListener(){} },
    window: { addEventListener(){}, __TAURI__: { core: { invoke: async (name,args) => { calls.push({name,args}); return handler(name,args); } }, event: { listen: (name, cb) => events.set(name,cb) } } } };
  vm.createContext(sandbox);
  for (const file of ['i18n','core','files','resources']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/ui/js',file+'.js'),'utf8'),sandbox);
  const run = code => vm.runInContext(code,sandbox);
  run(`toast = () => {}; ic = () => ''; refreshAll = () => {}; tgAlert = () => {}; ask = async () => true;
    S.profiles = [{id:'prod',name:'Production',kind:'ssh',readonly:true},{id:'dev',name:'Development',kind:'ssh',readonly:false},{id:'local',readonly:true,kind:'local'}];
    S.activeConn = 'dev'; S.view = 'images';`);
  return { run, calls, events, element, sandbox };
}

function editor(h, conn = 'dev') {
  h.run(`S.editorCtx = {conn:${JSON.stringify(conn)},target:'host',path:'/app/config',truncated:false}; S.editorDirty=true; S.editor={getValue:()=> 'new content'};`);
  h.element('editor-backup').checked = false;
}

test('read-only follows the actual target after changing server', async () => {
  const h = harness(); editor(h,'prod');
  assert.equal(h.run(`isReadonly('prod')`),true);
  assert.equal(h.run(`isReadonly('dev')`),false);
  await h.run('saveEditor()');
  assert.equal(h.calls.length,0);
});
test('sidebar creation captures the original server and blocks read-only targets', async()=>{
  const h=harness(); h.run(`S.conns.dev={up:true,dockerOk:true}; wireCreate(); openCreateModal(); S.activeConn='prod';`);
  h.element('cr-image').value='redis:7-alpine';
  await h.element('cr-go').onclick();
  assert.equal(h.calls[0].name,'create_container'); assert.equal(h.calls[0].args.conn,'dev');
  h.run(`S.conns.prod={up:true,dockerOk:true}; openCreateModal();`);
  await h.element('cr-go').onclick(); assert.equal(h.calls.length,1);
});

test('writable editor still saves to original server when current server is read-only', async () => {
  const h = harness(); editor(h); h.run(`S.activeConn='prod'`);
  await h.run('saveEditor()');
  assert.equal(h.calls[0].args.conn,'dev');
  assert.equal(h.run('S.editorDirty'),false);
});

test('local project files stay editable while its Docker profile is read-only', async () => {
  const h = harness(); editor(h,'local'); h.run(`S.view='project'; S.project={remote:false}`);
  assert.equal(h.run('isReadonly()'),false);
  assert.equal(h.run(`isReadonly('local')`),true);
  await h.run('saveEditor()');
  assert.equal(h.calls[0].name,'host_fs_write');
});

test('backup failure leaves the original untouched and editor dirty', async () => {
  const h = harness(async name => { if(name==='host_fs_read')return {content_b64:'b2xk'}; throw new Error('backup permission denied'); });
  editor(h); h.element('editor-backup').checked=true;
  await h.run('saveEditor()');
  assert.deepEqual(h.calls.map(c=>c.args.path),['/app/config','/app/config.bak']);
  assert.equal(h.run('S.editorDirty'),true);
  assert.equal(h.run('S.editorSaving'),false);
});

test('truncated backup is never written or used to overwrite the original', async () => {
  const h = harness(async () => ({truncated:true,content_b64:'cGFydA=='}));
  editor(h); h.element('editor-backup').checked=true;
  await h.run('saveEditor()'); assert.equal(h.calls.length,1);
  assert.equal(h.run('S.editorDirty'),true);
});

test('changes while saving remain dirty and duplicate saves are prevented', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish=resolve; }));
  editor(h); const saving=h.run('saveEditor()');
  await h.run('saveEditor()'); assert.equal(h.calls.length,1);
  h.run(`S.editor.getValue = () => 'newer edit'`); finish(); await saving;
  assert.equal(h.run('S.editorDirty'),true);
});

function compose(h) {
  h.run(`S.selectedStack={project:'shop',rows:[{workdir:'/app',config_file:'/app/compose.yml,/app/override file.yml'}]}; openComposePane();`);
}

test('Compose uses every config file and captures executor before invocation', async () => {
  const h=harness(); compose(h);
  await h.run(`composeRun('pull')`);
  const call={ name:h.calls[0].name, args:h.calls[0].args.request };
  assert.equal(call.name,'compose_cmd'); assert.equal(call.args.conn,'dev');
  assert.deepEqual(Array.from(call.args.configs),['/app/compose.yml','/app/override file.yml']);
  assert.equal(call.args.project,'shop'); assert.equal(call.args.action,'pull');
  assert.equal(h.element('cm-up').disabled,true);
});

test('Compose jobs keep output across navigation and ignore unrelated events', async () => {
  const h=harness(); compose(h); await h.run(`composeRun('validate')`);
  const job=h.calls[0].args.request.job;
  h.run(`S.composeCtx={conn:'prod',project:'other',label:'other',workdir:'/other',configs:['/other/compose.yml'],kind:'ssh'}; renderComposeContext()`);
  h.events.get('compose-output')({payload:{conn:'dev',project:'shop',job,line:'validated',done:true}});
  assert.equal(h.element('cm-output').textContent,'');
  compose(h);
  assert.equal(h.element('cm-output').textContent,'validated\n');
  assert.equal(h.element('cm-up').disabled,false);
});

test('read-only Compose exposes validation and blocks deployment', async () => {
  const h=harness(); h.run(`S.activeConn='prod'`); compose(h);
  assert.equal(h.element('cm-up').disabled,true);
  assert.equal(h.element('cm-validate').disabled,false);
  await h.run(`composeRun('up')`); assert.equal(h.calls.length,0);
  await h.run(`composeRun('validate')`); assert.equal(h.calls[0].args.request.action,'validate');
});

test('new UI messages are translated in every supported language', () => {
  const h=harness();
  for(const lang of ['uk','ru','en']) {
    h.run(`LANG=${JSON.stringify(lang)}`);
    for(const key of ['context.local','context.readonly','compose.explain','compose.effect.pull','compose.validate','term.readonly','editor.backupIncomplete','insp.composeEnvWarning']) {
      assert.notEqual(h.run(`t(${JSON.stringify(key)})`),key);
    }
    assert.ok(!h.run(`t('compose.pull')`).includes('+'));
  }
});
