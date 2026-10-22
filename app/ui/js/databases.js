"use strict";
/* Результати й введені паролі — лише в памʼяті. Збережені секрети читає backend із системного vault. */
const databaseSessions = new Map();
const databaseEngines = {postgres:"PostgreSQL",mysql:"MySQL / MariaDB",clickhouse:"ClickHouse",redis:"Redis"};
function databaseSession() {
  const conn=S.activeConn;
  if (!databaseSessions.has(conn)) databaseSessions.set(conn,{sources:[],warnings:[],scanned:false,scanning:false,source:null,username:"",password:"",database:"",databases:[],tables:[],table:null,columns:[],result:null,tab:"rows",offset:0,pattern:"*",cursor:"0",nextCursor:"0",keys:[],key:null,value:null,busy:false,error:"",sequence:0,filter:"",queryFilter:{column:"",op:"contains",value:""},orderColumn:"",orderDesc:false,requestedPageSize:100,savedProfiles:[],savedProfileId:"",profilesLoading:false,remember:true,saveWarning:"",profileError:""});
  return databaseSessions.get(conn);
}
function clearDatabaseSession(conn) {const s=databaseSessions.get(conn);if(s){s.sequence++;s.password="";s.importedCredentials=null;}databaseSessions.delete(conn);if(S.activeConn===conn&&$("pane-databases"))$("pane-databases").innerHTML="";}
function databaseVisible(conn,s) {return S.activeConn===conn && S.view==="databases" && S.conns[conn]?.up && databaseSessions.get(conn)===s;}
function repaintDatabases(conn,s) {if(databaseVisible(conn,s)){renderDatabaseSidebar();renderDatabases();}}
async function discoverDatabases() {
  const conn=S.activeConn,s=databaseSession();if(s.scanning||s.busy||s.profilesLoading||!S.conns[conn]?.up)return;
  const sequence=++s.sequence;s.scanning=true;s.error="";repaintDatabases(conn,s);
  try {
    const result=await invoke("database_discover",{conn});
    if(sequence!==s.sequence||databaseSessions.get(conn)!==s)return;
    s.sources=result.sources;s.warnings=result.warnings;s.scanned=true;
    if(s.source&&!s.sources.some(x=>x.id===s.source.id)){s.source=null;s.password="";s.importedCredentials=null;s.result=null;s.tables=[];}
    else if(s.source)s.source=s.sources.find(x=>x.id===s.source.id);
    if(!s.source&&s.sources.filter(x=>x.state==="running").length===1)s.source=s.sources.find(x=>x.state==="running");
  } catch(e){if(sequence===s.sequence){s.error=String(e);s.scanned=true;}}
  finally {if(sequence===s.sequence){s.scanning=false;repaintDatabases(conn,s);if(s.source)loadSavedDatabaseProfiles(conn,s);}}
}
function selectDatabaseSource(id) {
  const s=databaseSession();if(s.busy||s.profilesLoading)return;
  s.sequence++;s.source=s.sources.find(x=>x.id===id);s.username="";s.password="";s.importedCredentials=null;s.database="";s.databases=[];s.tables=[];s.table=null;s.columns=[];s.result=null;s.keys=[];s.key=null;s.value=null;s.offset=0;s.pageSize=100;s.cursor="0";s.nextCursor="0";s.error="";s.savedProfiles=[];s.savedProfileId="";s.profilesLoading=false;s.saveWarning="";s.profileError="";s.tableFilter="";resetDatabaseQuery(s);
  renderDatabaseSidebar();renderDatabases();$("db-username")?.focus();loadSavedDatabaseProfiles(S.activeConn,s);
}
async function loadSavedDatabaseProfiles(conn,s) {
  if(!s.source||s.profilesLoading)return;
  const source=s.source.id,sequence=s.sequence;s.profilesLoading=true;s.profileError="";repaintDatabases(conn,s);
  try {
    const profiles=await invoke("database_saved_profiles",{conn,sourceId:source});
    if(databaseSessions.get(conn)!==s||s.source?.id!==source||s.sequence!==sequence)return;
    s.savedProfiles=profiles;
    if(!s.username&&!s.password&&!s.databases.length&&profiles.length)useSavedDatabaseProfile(s,profiles[0].id);
  }catch{if(databaseSessions.get(conn)===s&&s.source?.id===source&&s.sequence===sequence)s.profileError=t("db.savedLoadFailed");}
  finally{if(databaseSessions.get(conn)===s&&s.source?.id===source&&s.sequence===sequence){s.profilesLoading=false;repaintDatabases(conn,s);}}
}
function useSavedDatabaseProfile(s,id) {
  const profile=s.savedProfiles.find(p=>p.id===id);s.savedProfileId=profile?.id||"";s.username=profile?.username||"";s.database=profile?.database||"";s.password="";s.importedCredentials=null;s.saveWarning="";
  s.databases=[];s.tables=[];s.table=null;s.columns=[];s.result=null;s.keys=[];s.key=null;s.value=null;s.offset=0;s.cursor="0";s.nextCursor="0";s.error="";resetDatabaseQuery(s);
}
function editDatabaseCredentials(s) {
  s.savedProfileId="";if($("db-saved-profile"))$("db-saved-profile").value="";
  if($("db-password"))$("db-password").placeholder=t("db.sessionOnly");
}
async function forgetSavedDatabaseProfile() {
  const conn=S.activeConn,s=databaseSession(),source=s.source?.id,id=s.savedProfileId,sequence=s.sequence;
  if(!id||s.busy||s.profilesLoading)return;
  s.profilesLoading=true;s.profileError="";repaintDatabases(conn,s);
  try {
    await invoke("database_forget_profile",{conn,sourceId:source,id});
    if(databaseSessions.get(conn)!==s||s.sequence!==sequence||s.source?.id!==source)return;
    s.savedProfiles=s.savedProfiles.filter(p=>p.id!==id);s.savedProfileId="";s.password="";s.importedCredentials=null;
    s.databases=[];s.database="";s.tables=[];s.table=null;s.columns=[];s.result=null;s.keys=[];s.key=null;s.value=null;
  }catch{if(databaseSessions.get(conn)===s&&s.sequence===sequence)s.profileError=t("db.savedDeleteFailed");}
  finally{if(databaseSessions.get(conn)===s&&s.sequence===sequence){s.profilesLoading=false;repaintDatabases(conn,s);}}
}
function renderDatabaseSidebar() {
  if(S.navMode!=="databases")return;
  const tree=$("tree"),s=databaseSession(),scroll=tree.scrollTop;
  const signature=JSON.stringify([S.activeConn,LANG,s.sources,s.source?.id,s.scanning,s.busy,s.scanned,s.database,s.databases,s.tables,s.table,s.tab]);
  if(tree.dataset.dbSignature===signature&&(s.databases.length&&s.source?.engine!=="redis"?$("db-table-list"):$("db-source-filter")))return;
  tree.dataset.dbSignature=signature;
  if(s.databases.length&&s.source?.engine!=="redis") {
    tree.innerHTML=`<div class="db-explorer-head"><div class="db-explorer-connection"><select id="db-source-select" aria-label="${esc(t("db.connection"))}" ${s.busy?"disabled":""}>${s.sources.map(x=>`<option value="${esc(x.id)}" ${x.id===s.source.id?"selected":""}>${esc(x.name+" · "+databaseEngines[x.engine])}</option>`).join("")}</select><button id="db-rescan" ${s.busy||s.scanning?"disabled":""} aria-label="${esc(t("db.scan"))}" title="${esc(t("db.scan"))}">${ic("rotate")}</button></div><label>${esc(t("db.database"))}<select id="db-explorer-database" ${s.busy?"disabled":""}>${s.databases.map(d=>`<option ${d===s.database?"selected":""}>${esc(d)}</option>`).join("")}</select></label><button id="db-overview" ${s.busy?"disabled":""}>${esc(t("db.overview"))} (${s.tables.length})</button><label class="sr-only" for="db-table-search">${esc(t("db.tableSearch"))}</label><input id="db-table-search" type="search" placeholder="${esc(t("db.tableSearch"))}" value="${esc(s.tableFilter||"")}"></div><div id="db-table-list" class="db-table-list"></div>`;
    $("db-rescan").onclick=discoverDatabases;
    $("db-source-select").onchange=e=>selectDatabaseSource(e.target.value);
    $("db-explorer-database").onchange=e=>{s.database=e.target.value;s.tableFilter="";loadDatabaseObjects();};
    $("db-overview").onclick=()=>{s.table=null;s.result=null;renderDatabaseSidebar();renderDatabases();};
    $("db-table-search").oninput=e=>{s.tableFilter=e.target.value;renderDatabaseTableRows(s);};
    renderDatabaseTableRows(s);tree.scrollTop=scroll;return;
  }
  tree.innerHTML=`<div class="db-sidebar-bar"><label class="sr-only" for="db-source-filter">${esc(t("db.searchSources"))}</label><input id="db-source-filter" type="search" placeholder="${esc(t("db.searchSources"))}" value="${esc(s.filter)}"><button id="db-rescan" ${s.scanning||s.busy?"disabled":""} title="${esc(t("db.scan"))}">${ic("rotate")}</button></div><div id="db-sources"></div>`;
  $("db-source-filter").oninput=e=>{s.filter=e.target.value;renderDatabaseSourceRows(s);};
  $("db-rescan").onclick=discoverDatabases;renderDatabaseSourceRows(s);
}
function renderDatabaseSourceRows(s) {
  const rows=s.sources.filter(x=>(x.name+" "+databaseEngines[x.engine]+" "+x.source+" "+x.address).toLowerCase().includes(s.filter.toLowerCase()));
  $("count").textContent=String(s.sources.length);
  $("db-sources").innerHTML=s.scanning?`<p class="db-hint" role="status">${esc(t("db.scanning"))}</p>`:rows.map(x=>`<button class="db-source ${s.source?.id===x.id?"on":""}" data-source="${esc(x.id)}" ${s.busy?"disabled":""} aria-pressed="${s.source?.id===x.id}"><strong>${esc(x.name)}</strong><span>${esc(databaseEngines[x.engine])} · ${esc(x.source==="docker"?"Docker":t("db.host"))}</span><small>${esc(x.state==="running"?x.confirmed?t("db.detected"):t("db.candidate"):t("ct.notRunning"))} · ${esc(x.address)}</small></button>`).join("")||`<p class="db-hint">${esc(t(s.scanned?"db.noSources":"db.scanHint"))}</p>`;
  $("db-sources").querySelectorAll("button").forEach(b=>b.onclick=()=>selectDatabaseSource(b.dataset.source));
}
function resetDatabaseQuery(s) {
  s.filterOpen=false;s.queryFilter={column:"",op:"contains",value:""};s.orderColumn="";s.orderDesc=false;s.offset=0;
}
function selectDatabaseTable(index,tab="rows") {
  const s=databaseSession();if(s.busy||s.scanning)return;
  s.table=s.tables[index];if(!s.table)return;s.tableInfoOpen=false;
  resetDatabaseQuery(s);s.tab=tab;s.pageSize=100;s.columns=[];s.result=null;loadDatabasePreview();
}
function databaseStatInteger(value) {
  if(value===null||value===undefined||value===""||!/^\d+$/.test(String(value)))return null;
  try{return BigInt(value);}catch{return null;}
}
function databaseStat(value,bytes=false,estimated=false) {
  const n=databaseStatInteger(value);if(n===null)return `<span class="db-stat-unknown" title="${esc(t("db.statUnknown"))}">—</span>`;
  const exact=n.toLocaleString(({uk:"uk-UA",ru:"ru-RU",en:"en-US"})[LANG]);
  return `<span title="${esc((estimated?t("db.statEstimate")+": ":"")+exact+(bytes?" "+t("unit.b"):""))}">${estimated?"≈ ":""}${esc(bytes?fmtBytes(Number(n)):exact)}</span>`;
}
function databaseTableStats(table,compact=false) {
  return `<div class="db-table-stats ${compact?"db-table-stats-compact":""}"><span>${esc(t("db.rowCount"))}: ${databaseStat(table.rows_count,false,!!table.rows_estimated)}</span><span>${esc(t("db.totalSize"))}: ${databaseStat(table.total_bytes,true)}</span>${compact?"":`<span>${esc(t("db.dataSize"))}: ${databaseStat(table.data_bytes,true)}</span><span>${esc(t("db.indexSize"))}: ${databaseStat(table.index_bytes,true)}</span>`}</div>`;
}
function databaseOverviewRows(s) {
  const rows=s.tables.map((x,i)=>({x,i})),key=s.overviewSort;
  if(key)rows.sort((a,b)=>{const x=databaseStatInteger(a.x[key]),y=databaseStatInteger(b.x[key]);if(x===null)return y===null?0:1;if(y===null)return -1;return (x<y?-1:x>y?1:0)*(s.overviewDesc?-1:1);});
  return rows;
}
function renderDatabaseTableRows(s) {
  const rows=s.tables.map((x,i)=>({x,i})).filter(({x})=>(x.schema+"."+x.name).toLowerCase().includes((s.tableFilter||"").toLowerCase()));
  $("count").textContent=String(s.tables.length);
  $("db-table-list").innerHTML=rows.map(({x,i})=>`<button class="db-table-item ${s.table===x?"on":""}" data-table="${i}" ${s.busy?"disabled":""} aria-pressed="${s.table===x}"><strong>${esc(x.name)}</strong><small>${esc(x.schema+" · "+x.kind)}</small>${databaseTableStats(x,true)}</button>`).join("")||`<p class="db-hint">${esc(t("db.noTables"))}</p>`;
  $("db-table-list").querySelectorAll("[data-table]").forEach(b=>b.onclick=()=>selectDatabaseTable(Number(b.dataset.table)));
}
async function refreshDatabaseStats() {
  await databaseOperation("table_stats",{},read=>read("tables"));
}
function refreshDatabaseRows() {
  const s=databaseSession();if(s.busy)return;s.offset=0;s.result=null;loadDatabasePreview();
}
function sortDatabaseColumn(column) {
  const s=databaseSession();if(s.busy)return;s.orderDesc=s.orderColumn===column?!s.orderDesc:false;s.orderColumn=column;refreshDatabaseRows();
}
async function databaseOperation(action,extra={},task=null) {
  const conn=S.activeConn,s=databaseSession();if(s.busy||s.scanning||s.profilesLoading||!s.source||!S.conns[conn]?.up)return;
  const source=s.source,sequence=++s.sequence;
  s.busy=true;s.error="";s.errorAction="";repaintDatabases(conn,s);
  const read=(action,args={})=>{
    if(sequence!==s.sequence||databaseSessions.get(conn)!==s||!S.conns[conn]?.up)throw new Error("Database session closed");
    return invoke("database_browse",{conn,request:{source_id:source.id,action,username:s.username,password:s.password,saved_profile_id:s.savedProfileId||"",remember:action==="databases"&&s.remember!==false,database:s.database,schema:s.table?.schema||s.database,table:s.table?.name||"",offset:s.offset,key:s.key||"",pattern:s.pattern,cursor:s.cursor,filter_column:s.queryFilter?.column||"",filter_op:s.queryFilter?.op||"contains",filter_value:s.queryFilter?.value||"",order_column:s.orderColumn||"",order_desc:!!s.orderDesc,page_size:s.requestedPageSize||100,...args}});
  };
  try {
    const result=task?await task(read):await read(action,extra);
    if(sequence!==s.sequence||databaseSessions.get(conn)!==s)return;
    if(action==="databases"){
      const databases=Array.isArray(result)?result:result.databases;s.databases=databases;
      s.database=source.engine==="redis"?(s.database||"0"):databases.includes(s.database)?s.database:databases.includes("postgres")?"postgres":databases[0]||"";
      s.saveWarning=result.save_error?t("db.saveFailed")+" "+result.save_error:"";
      if(result.saved_profile){const p=result.saved_profile;s.savedProfiles=[p,...s.savedProfiles.filter(x=>x.id!==p.id)];s.savedProfileId=p.id;s.password="";s.importedCredentials=null;s.profileError="";}
    }
    if(action==="tables"){s.tables=result;s.table=null;s.columns=[];s.result=null;}
    if(action==="table_stats"){const previous=s.table;s.tables=result;s.table=result.find(x=>x.schema===previous?.schema&&x.name===previous?.name)||null;if(!s.table){s.columns=[];s.result=null;}}
    if(action==="preview"){s.columns=result.columns;s.result=result.rows;s.pageSize=result.rows?.page_size||s.requestedPageSize||100;}
    if(action==="keys"){s.keys=result.keys;s.nextCursor=result.cursor;s.key=null;s.value=null;}
    if(action==="value")s.value=result;
  }catch(e){if(sequence===s.sequence){s.error=String(e);s.errorAction=action;}}
  finally{if(sequence===s.sequence){s.busy=false;repaintDatabases(conn,s);}}
}
async function connectDatabase() {
  const s=databaseSession();if(s.busy||s.scanning||s.profilesLoading)return;s.username=$("db-username").value;s.password=$("db-password").value;if($("db-initial"))s.database=$("db-initial").value;
  s.table=null;s.tables=[];s.columns=[];s.result=null;s.keys=[];s.value=null;
  await databaseOperation("databases");
  if(!s.error&&s.database&&databaseSessions.get(S.activeConn)===s)await loadDatabaseObjects();
}
async function loadDatabaseObjects() {
  const s=databaseSession();resetDatabaseQuery(s);s.offset=0;s.pageSize=100;s.cursor="0";s.nextCursor="0";s.table=null;s.result=null;s.columns=[];s.keys=[];s.key=null;s.value=null;
  await databaseOperation(s.source.engine==="redis"?"keys":"tables");
}
async function loadDatabasePreview() {
  const s=databaseSession();
  await databaseOperation("preview",{},async read=>{const columns=s.columns.length?s.columns:await read("columns");s.columns=columns;return {columns,rows:s.tab==="columns"?null:await read("rows")};});
}
// Підтримуємо лише відомі скалярні ключі; YAML tags/aliases не виконуємо.
function parseClickHouseSecrets(text) {
  if(text.length>65536)throw new Error(t("db.importInvalid"));
  const result={};
  for(const line of text.replace(/^\uFEFF/,"").split(/\r?\n/)) {
    const m=line.match(/^(ch_default_password|ch_admin_password):[ \t]*(.*)$/);if(!m)continue;
    let value=m[2].trim();
    if(value.startsWith('"')) {
      const quoted=value.match(/^"(?:[^"\\]|\\.)*"(?=\s*(?:#.*)?$)/);
      if(!quoted)throw new Error(t("db.importInvalid"));
      try{value=JSON.parse(quoted[0]);}catch{throw new Error(t("db.importInvalid"));}
    } else if(value.startsWith("'")) {
      const quoted=value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
      if(!quoted)throw new Error(t("db.importInvalid"));value=quoted[1].replace(/''/g,"'");
    } else {
      if(/^[!&*|>{[\]#]/.test(value))throw new Error(t("db.importInvalid"));
      value=value.replace(/\s+#.*$/,"").trim();
      if(/^(?:null|~)$/i.test(value))value="";
    }
    if(!value||value.includes("\0")||value.length>4096)throw new Error(t("db.importInvalid"));
    const user=m[1]==="ch_default_password"?"default":"admin";
    if(Object.hasOwn(result,user))throw new Error(t("db.importInvalid"));result[user]=value;
  }
  if(!Object.keys(result).length)throw new Error(t("db.importInvalid"));
  return result;
}
async function importClickHouseSecrets(file) {
  const conn=S.activeConn,s=databaseSession(),sequence=s.sequence;
  if(!file||s.busy||s.source?.engine!=="clickhouse")return;
  try {
    if(file.size>65536)throw new Error(t("db.importInvalid"));
    const text=await file.text();
    if(s.sequence!==sequence||databaseSessions.get(conn)!==s||S.activeConn!==conn)return;
    const credentials=parseClickHouseSecrets(text);
    s.importedCredentials=credentials;s.username=Object.hasOwn(credentials,s.username)?s.username:Object.hasOwn(credentials,"default")?"default":Object.keys(credentials)[0];
    s.password=credentials[s.username];editDatabaseCredentials(s);s.error="";repaintDatabases(conn,s);
  } catch {if(s.sequence===sequence&&databaseSessions.get(conn)===s){s.error=t("db.importInvalid");repaintDatabases(conn,s);}}
}
function databaseCell(v) {return v===null?'<span class="db-null">NULL</span>':esc(typeof v==="object"?JSON.stringify(v):String(v));}
function databaseGrid(columns,rows,preview=null,sortable=false) {
  const truncated=new Set((preview?.truncated||[]).map(([row,col])=>row+":"+col));
  return `<div class="db-grid-wrap" tabindex="0" aria-label="${esc(t("db.preview"))}"><table class="db-grid"><thead><tr>${sortable?`<th>${esc(t("db.row"))}</th>`:""}${columns.map((c,i)=>`<th>${sortable?`<button class="db-sort" data-sort="${i}" title="${esc(t("db.sort"))}">${esc(c)} ${databaseSession().orderColumn===c?(databaseSession().orderDesc?"↓":"↑"):"↕"}</button>`:esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row,ri)=>`<tr>${sortable?`<td><button data-row="${ri}" title="${esc(t("db.rowDetails"))}">${ri+1+databaseSession().offset}</button></td>`:""}${columns.map((c,i)=>`<td>${databaseCell(Array.isArray(row)?row[i]:row[c])}${truncated.has(ri+":"+i)?`<small class="db-truncated" title="${esc(t("db.truncationHint",{n:preview.cell_limit}))}">… ${esc(t("db.truncated"))}</small>`:""}</td>`).join("")}</tr>`).join("")}</tbody></table>${!rows.length?`<p class="db-hint">${esc(t("db.empty"))}</p>`:""}</div>`;
}
function renderDatabases() {
  const box=$("pane-databases"),s=databaseSession(),p=activeProfile();
  if(!S.conns[S.activeConn]?.up){clearDatabaseSession(S.activeConn);box.innerHTML=`<div class="db-intro">${esc(t("tree.connectFirst"))}</div>`;return;}
  const source=s.source;
  box.classList.toggle("db-browser-active",!!s.databases.length);
  box.innerHTML=`<div class="db-header"><h2>${esc(s.table?s.table.schema+" / "+s.table.name:source?databaseEngines[source.engine]:t("db.title"))}</h2><span class="badge">${esc(t("context.readonly"))}</span></div><p class="db-hint">${esc(source?source.name+" · "+source.address:t("db.intro"))}</p><p class="db-hint db-scope">${esc(t("db.scope",{name:p?.name||""}))}</p>${s.warnings.length?`<details class="db-warnings"><summary>${esc(t("db.discoveryNotes"))} (${s.warnings.length})</summary>${s.warnings.map(w=>`<p>${esc(w)}</p>`).join("")}</details>`:""}<div id="db-feedback" aria-live="polite">${s.saveWarning?`<p class="db-save-warning" role="status">${esc(s.saveWarning)}</p>`:""}${s.profileError?`<p class="db-save-warning" role="status">${esc(s.profileError)}</p>`:""}${s.error?`<div class="db-error" role="alert">${esc(s.error)}<p>${esc(t(s.errorAction&&s.errorAction!=="databases"?"db.readErrorHint":"db.errorHint"))}</p></div>`:""}${s.busy||s.scanning?`<p role="status">${esc(t(s.scanning?"db.scanning":"db.loading"))}</p>`:""}</div><div id="db-workspace"></div>`;
  if(!s.scanned&&!s.scanning&&!s.error){discoverDatabases();return;}
  if(!source){$("db-workspace").innerHTML=`<div class="db-intro"><p>${esc(t("db.choose"))}</p><p class="db-hint">${esc(t("db.limitations"))}</p><button id="db-scan-main" ${s.scanning?"disabled":""}>${esc(t("db.scan"))}</button></div>`;$("db-scan-main").onclick=discoverDatabases;return;}
  const stopped=source.state!=="running",locked=s.busy||s.scanning||s.profilesLoading||stopped;
  $("db-workspace").innerHTML=`${stopped?`<p class="db-error">${esc(t("ct.notRunning"))}</p>`:""}<details class="db-auth-details" ${!s.databases.length?"open":""}><summary>${esc(t("db.credentials"))}</summary>${s.savedProfiles.length?`<div class="db-saved-profiles"><label>${esc(t("db.savedConnections"))}<select id="db-saved-profile" ${locked?"disabled":""}><option value="">${esc(t("db.newConnection"))}</option>${s.savedProfiles.map(p=>`<option value="${esc(p.id)}" ${s.savedProfileId===p.id?"selected":""}>${esc((p.username||t("db.auto"))+(p.database?" · "+p.database:"")+" · "+t(p.password_saved?"db.passwordStored":"db.auto"))}</option>`).join("")}</select></label><button id="db-delete-saved" type="button" ${locked||!s.savedProfileId?"disabled":""}>${esc(t("db.deleteSaved"))}</button></div>`:""}<form id="db-auth" class="db-auth"><label>${esc(t("db.username"))}<input id="db-username" autocomplete="off" value="${esc(s.username)}" placeholder="${esc(t("db.auto"))}" ${locked?"disabled":""}></label><label>${esc(t("db.password"))}<input id="db-password" type="password" autocomplete="off" value="${esc(s.password)}" placeholder="${esc(t(s.savedProfileId?"db.passwordStored":"db.sessionOnly"))}" ${locked?"disabled":""}></label>${source.engine==="clickhouse"?`<div class="db-secret-import"><button id="db-import" type="button" ${locked?"disabled":""}>${esc(t("db.import"))}</button><input id="db-secret-file" type="file" accept=".yml,.yaml" hidden>${s.importedCredentials?`<label>${esc(t("db.importAccount"))}<select id="db-import-account" ${locked?"disabled":""}>${Object.keys(s.importedCredentials).map(user=>`<option ${s.username===user?"selected":""}>${esc(user)}</option>`).join("")}</select></label>`:""}</div>`:""}${source.engine==="postgres"?`<label>${esc(t("db.initialDatabase"))}<input id="db-initial" value="${esc(s.database)}" placeholder="postgres" ${locked?"disabled":""}></label>`:""}<label class="db-remember"><input id="db-remember" type="checkbox" ${s.remember!==false?"checked":""} ${locked?"disabled":""}>${esc(t("db.rememberSuccess"))}</label><button class="primary" ${locked?"disabled":""}>${esc(t("db.open"))}</button><button id="db-forget" type="button" ${s.busy?"disabled":""}>${esc(t("db.forget"))}</button></form><p class="db-hint">${esc(t("db.credentialsHint"))}</p></details><div id="db-browser"></div>`;
  $("db-remember").onchange=e=>s.remember=e.target.checked;
  if($("db-saved-profile"))$("db-saved-profile").onchange=e=>{useSavedDatabaseProfile(s,e.target.value);renderDatabases();};
  if($("db-delete-saved"))$("db-delete-saved").onclick=forgetSavedDatabaseProfile;
  $("db-username").oninput=e=>{s.username=e.target.value;editDatabaseCredentials(s);};$("db-password").oninput=e=>{s.password=e.target.value;editDatabaseCredentials(s);};
  if($("db-import")) {
    $("db-import").onclick=()=>$("db-secret-file").click();
    $("db-secret-file").onchange=e=>importClickHouseSecrets(e.target.files[0]);
    if($("db-import-account"))$("db-import-account").onchange=e=>{s.username=e.target.value;s.password=s.importedCredentials[s.username];editDatabaseCredentials(s);$("db-username").value=s.username;$("db-password").value=s.password;};
  }
  $("db-auth").onsubmit=e=>{e.preventDefault();connectDatabase();};
  $("db-forget").onclick=()=>{selectDatabaseSource(source.id);};
  if(!s.databases.length)return;
  const redis=source.engine==="redis";
  $("db-browser").innerHTML=`<div class="db-browser-bar db-location"><span>${esc(source.name)} / <strong>${esc(s.database)}</strong></span>${redis?`<label>${esc(t("db.database"))}<input id="db-database" type="number" min="0" max="2147483647" value="${esc(s.database)}" ${locked?"disabled":""}></label>`:""}<button id="db-refresh" ${locked?"disabled":""}>${ic("rotate")} ${esc(t("common.refresh"))}</button></div><div id="db-objects"></div>`;
  if(redis){$("db-database").onchange=e=>{s.database=e.target.value;loadDatabaseObjects();};$("db-refresh").onclick=loadDatabaseObjects;renderRedisBrowser(s,locked);return;}
  $("db-refresh").onclick=()=>s.table?refreshDatabaseRows():loadDatabaseObjects();
  $("db-objects").innerHTML=`<div id="db-preview"></div>`;
  if(!s.table) {
    $("db-preview").innerHTML=`<h3>${esc(t("db.overview"))} · ${s.tables.length}</h3><p class="db-hint">${esc(t("db.explorerHint"))}</p><p class="db-hint db-stats-note">${esc(t("db.statsHint"))}</p><div class="db-grid-wrap db-overview-grid"><table class="db-grid"><thead><tr><th>${esc(t("db.table"))}</th>${[["rows_count","db.rowCount"],["total_bytes","db.totalSize"],["data_bytes","db.dataSize"],["index_bytes","db.indexSize"]].map(([key,label])=>`<th><button class="db-sort" data-stat-sort="${key}">${esc(t(label))} ${s.overviewSort===key?(s.overviewDesc?"↓":"↑"):"↕"}</button></th>`).join("")}<th>${esc(t("db.kind"))}</th><th>${esc(t("db.rows"))} / ${esc(t("db.columns"))}</th></tr></thead><tbody>${databaseOverviewRows(s).map(({x,i})=>`<tr><td><button class="db-table-link" data-open-table="${i}" ${locked?"disabled":""}>${esc(x.schema+"."+x.name)}</button>${x.comment?`<small class="db-table-comment">${esc(x.comment)}</small>`:""}</td><td class="db-stat-number">${databaseStat(x.rows_count,false,!!x.rows_estimated)}</td>${["total_bytes","data_bytes","index_bytes"].map(key=>`<td class="db-stat-number">${databaseStat(x[key],true)}</td>`).join("")}<td>${esc(x.kind)}</td><td><button data-open-table="${i}" ${locked?"disabled":""}>${esc(t("db.rows"))}</button> <button data-structure="${i}" ${locked?"disabled":""}>${esc(t("db.columns"))}</button></td></tr>`).join("")}</tbody></table>${!s.tables.length?`<p class="db-hint">${esc(t("db.noTables"))}</p>`:""}</div>`;
    $("db-preview").querySelectorAll("[data-stat-sort]").forEach(b=>b.onclick=()=>{const key=b.dataset.statSort;s.overviewDesc=s.overviewSort===key?!s.overviewDesc:true;s.overviewSort=key;renderDatabases();});
    $("db-preview").querySelectorAll("[data-open-table]").forEach(b=>b.onclick=()=>selectDatabaseTable(Number(b.dataset.openTable)));
    $("db-preview").querySelectorAll("[data-structure]").forEach(b=>b.onclick=()=>selectDatabaseTable(Number(b.dataset.structure),"columns"));return;
  }
  const columns=s.result?.columns||s.columns.map(c=>c.name),rows=s.result?.rows||[];
  $("db-preview").innerHTML=`<details id="db-table-info" class="db-table-info" ${s.tableInfoOpen?"open":""}><summary>${esc(t("db.tableInfo"))} · ${databaseStat(s.table.rows_count,false,!!s.table.rows_estimated)} ${esc(t("db.rowCount"))} · ${databaseStat(s.table.total_bytes,true)}</summary>${databaseTableStats(s.table)}<button id="db-refresh-stats" ${locked?"disabled":""}>${esc(t("db.refreshStats"))}</button>${s.table.comment?`<p class="db-hint">${esc(s.table.comment)}</p>`:""}<p class="db-hint">${esc(t("db.statsHint"))}</p></details><div class="db-browser-bar"><div class="seg"><button id="db-tab-rows" class="${s.tab==="rows"?"on":""}">${esc(t("db.rows"))}</button><button id="db-tab-columns" class="${s.tab==="columns"?"on":""}">${esc(t("db.columns"))}</button></div><label class="db-page-control" title="${esc(t("db.pageSizeHint",{n:s.pageSize||100}))}"><span>${esc(t("db.pageRows"))}</span><select id="db-page-size" aria-label="${esc(t("db.pageRows"))}" ${locked?"disabled":""}>${[25,50,100].map(n=>`<option ${n===(s.requestedPageSize||100)?"selected":""}>${n}</option>`).join("")}</select></label><button id="db-export-page" ${locked||!s.result||s.tab!=="rows"?"disabled":""}>${esc(t("db.exportPage"))}</button></div>${s.tab==="rows"?databaseQueryForm(s,locked):""}${s.tab==="columns"?databaseGrid(["name","type","nullable"],s.columns):s.result?databaseGrid(columns,rows,s.result,true):`<p class="db-hint" role="status">${esc(t(s.error?"db.readFailed":"db.loading"))}</p>${s.error?`<button id="db-retry" ${locked?"disabled":""}>${esc(t("db.retry"))}</button>`:""}`}${s.result?.truncated?.length?`<p class="db-hint">${esc(t("db.truncationHint",{n:s.result.cell_limit}))}</p>`:""}<div class="db-browser-bar db-pagination" style="${s.tab==="columns"?"display:none":""}"><button id="db-prev" ${locked||s.offset===0?"disabled":""}>${esc(t("db.prev",{n:s.pageSize||100}))}</button><span>${s.result?`${rows.length?s.offset+1:0}–${s.offset+rows.length}`:"—"}</span><button id="db-next" ${locked||!s.result?.more?"disabled":""}>${esc(t("db.next",{n:s.pageSize||100}))}</button></div>`;
  $("db-table-info").ontoggle=e=>{s.tableInfoOpen=e.target.open;};
  $("db-refresh-stats").onclick=refreshDatabaseStats;
  $("db-export-page").onclick=exportDatabasePage;
  $("db-preview").querySelectorAll("[data-row]").forEach(b=>b.onclick=()=>showDatabaseRow(Number(b.dataset.row)));
  $("db-page-size").onchange=e=>{s.requestedPageSize=Number(e.target.value);refreshDatabaseRows();};
  if(s.tab==="rows")bindDatabaseQuery(s);
  $("db-preview").querySelectorAll("[data-sort]").forEach(b=>{b.disabled=locked;b.onclick=()=>sortDatabaseColumn(columns[Number(b.dataset.sort)]);});
  if($("db-retry"))$("db-retry").onclick=loadDatabasePreview;
  for(const tab of ["rows","columns"])$("db-tab-"+tab).onclick=()=>{s.tab=tab;if(!s.result&&tab==="rows")loadDatabasePreview();else renderDatabases();};
  $("db-prev").onclick=()=>{s.offset=Math.max(0,s.offset-(s.pageSize||100));s.result=null;loadDatabasePreview();};$("db-next").onclick=()=>{s.offset+=(s.pageSize||100);s.result=null;loadDatabasePreview();};
}
function databasePageExport(s) {
  return {database:s.database,table:s.table,offset:s.offset,filter:s.queryFilter,order:{column:s.orderColumn,descending:s.orderDesc},columns:s.result?.columns||s.columns.map(c=>c.name),rows:s.result?.rows||[],truncated:s.result?.truncated||[],cell_limit:s.result?.cell_limit||null};
}
function exportDatabasePage() {
  const s=databaseSession();if(!s.result||s.busy)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(databasePageExport(s),null,2)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download=(s.table?.name||"table").replace(/[^\p{L}\p{N}_.-]/gu,"_")+"-page.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function showDatabaseRow(index) {
  const s=databaseSession(),row=s.result?.rows[index];if(!row)return;
  const columns=s.result.columns||s.columns.map(c=>c.name),truncated=new Set((s.result.truncated||[]).filter(x=>x[0]===index).map(x=>x[1]));
  $("db-row-dialog")?.remove();
  $("pane-databases").insertAdjacentHTML("beforeend",`<dialog id="db-row-dialog" class="db-row-dialog" aria-labelledby="db-row-title"><div class="db-browser-bar"><strong id="db-row-title">${esc(t("db.rowDetails"))} · ${index+1+s.offset}</strong><button id="db-row-close">${esc(t("db.close"))}</button></div><p class="db-hint">${esc(t("db.rowPreviewHint"))}</p><dl>${columns.map((c,i)=>`<dt>${esc(c)}</dt><dd><pre>${databaseCell(Array.isArray(row)?row[i]:row[c])}</pre>${truncated.has(i)?`<small class="db-truncated">${esc(t("db.truncationHint",{n:s.result.cell_limit}))}</small>`:""}</dd>`).join("")}</dl></dialog>`);
  const dialog=$("db-row-dialog");$("db-row-close").onclick=()=>dialog.close();dialog.addEventListener("close",()=>dialog.remove(),{once:true});dialog.showModal();
}
function databaseQueryForm(s,locked) {
  const f=s.queryFilter||{column:"",op:"contains",value:""},disabled=locked?"disabled":"";
  return `<details class="db-query-details" ${s.filterOpen||f.column?"open":""}><summary>${esc(t("db.filterRows"))}${f.column?` · ${esc(f.column)}`:""}</summary><form id="db-query" class="db-query"><label>${esc(t("db.filterColumn"))}<select id="db-filter-column" ${disabled}><option value="">${esc(t("db.allRows"))}</option>${s.columns.map(c=>`<option value="${esc(c.name)}" ${f.column===c.name?"selected":""}>${esc(c.name)}</option>`).join("")}</select></label><label>${esc(t("db.condition"))}<select id="db-filter-op" ${disabled}>${["contains","eq","is_null","not_null"].map(op=>`<option value="${op}" ${f.op===op?"selected":""}>${esc(t(({contains:"db.op.contains",eq:"db.op.eq",is_null:"db.op.is_null",not_null:"db.op.not_null"})[op]))}</option>`).join("")}</select></label><label class="db-filter-text">${esc(t("db.filterValue"))}<input id="db-filter-value" value="${esc(f.value)}" ${disabled||["is_null","not_null"].includes(f.op)?"disabled":""}></label><button ${disabled}>${esc(t("db.apply"))}</button><button id="db-filter-reset" type="button" ${disabled}>${esc(t("db.reset"))}</button></form></details>`;
}
function bindDatabaseQuery(s) {
  $("db-page-size").onchange=e=>{s.requestedPageSize=Number(e.target.value);refreshDatabaseRows();};
  $("db-query").parentElement.ontoggle=e=>{s.filterOpen=e.target.open;};
  $("db-filter-op").onchange=e=>{$("db-filter-value").disabled=["is_null","not_null"].includes(e.target.value);};
  $("db-query").onsubmit=e=>{e.preventDefault();s.queryFilter={column:$("db-filter-column").value,op:$("db-filter-op").value,value:$("db-filter-value").value};refreshDatabaseRows();};
  $("db-filter-reset").onclick=()=>{resetDatabaseQuery(s);refreshDatabaseRows();};
  $("db-page-size").onchange=e=>{s.requestedPageSize=Number(e.target.value);refreshDatabaseRows();};
}
function renderRedisBrowser(s,locked) {
  $("db-objects").innerHTML=`<form id="db-key-search" class="db-browser-bar"><label>${esc(t("db.keyPattern"))}<input id="db-pattern" value="${esc(s.pattern)}" ${locked?"disabled":""}></label><button ${locked?"disabled":""}>${ic("search")} ${esc(t("db.findKeys"))}</button><button id="db-more-keys" type="button" ${locked||s.nextCursor==="0"?"disabled":""}>${esc(t("db.nextScan"))}</button></form><p class="db-hint">${esc(t("db.redisHint"))}</p><div class="db-redis"><div class="db-keys">${s.keys.map((key,i)=>`<button data-key="${i}" class="${s.key===key?"on":""}" ${locked?"disabled":""}>${esc(key)}</button>`).join("")||`<p>${esc(t("db.noKeys"))}</p>`}</div><div class="db-value">${s.value?`<strong>${esc(s.key)} · ${esc(s.value.type)}</strong><pre>${esc(typeof s.value.value==="string"?s.value.value:JSON.stringify(s.value.value,null,2))}</pre>`:`<p>${esc(t("db.chooseKey"))}</p>`}</div></div>`;
  $("db-key-search").onsubmit=e=>{e.preventDefault();s.pattern=$("db-pattern").value;s.cursor="0";databaseOperation("keys");};
  $("db-more-keys").onclick=()=>{s.cursor=s.nextCursor;databaseOperation("keys");};
  $("db-objects").querySelectorAll("[data-key]").forEach(b=>b.onclick=()=>{s.key=s.keys[Number(b.dataset.key)];s.value=null;databaseOperation("value");});
}
