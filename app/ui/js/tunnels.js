"use strict";
/* Тунелі глобальні для вікна; сервер у формі не змінюється від перемикання режимів. */
const tunnelUI = {poll:null,flight:null,unknown:false,pending:new Map(),stopping:new Set(),signature:"",shelfSignature:"",busy:false,revision:0};
function tunnelRows() {
  const rows=[...S.forwards];
  for(const row of tunnelUI.pending.values())if(!rows.some(f=>f.conn===row.conn&&f.remote_host===row.remote_host&&f.remote_port===row.remote_port))rows.push(row);
  return rows;
}
function tunnelSummary() {
  const rows=tunnelRows(), active=rows.filter(f=>f.status==="active").length, starting=rows.filter(f=>f.status==="starting").length, failed=rows.filter(f=>f.status==="failed").length;
  return {active,starting,failed,state:tunnelUI.unknown?"unknown":failed?"failed":starting?"starting":active?"active":"idle"};
}
function renderTunnelStatus() {
  const s=tunnelSummary(), badge=$("fwd-badge");if(!badge)return;
  badge.dataset.state=s.state;
  $("fwd-count").textContent=tunnelUI.unknown?"?":String(s.active);
  $("fwd-state").textContent=tunnelUI.unknown?t("tun.unknown"):s.failed?t("tun.failureCount",{n:s.failed}):s.starting?t("tun.connectingCount",{n:s.starting}):t(s.active?"tun.enabled":"tun.off");
  badge.title=t("tun.title")+" · "+t("tun."+s.state)+(s.active?" · "+s.active:"");
  badge.setAttribute("aria-label",badge.title);
  renderTunnelShelf();
  renderContainerTunnelControls();
  renderTunnelList();
}
function containerTunnel(conn,port) {
  return tunnelRows().find(f=>f.conn===conn&&f.remote_host==="127.0.0.1"&&f.remote_port===port);
}
async function stopTunnel(key) {
  if(tunnelUI.stopping.has(key))return;
  tunnelUI.stopping.add(key);renderTunnelStatus();
  try{await invoke("forward_stop",{key});tunnelUI.revision++;S.forwards=S.forwards.filter(f=>f.key!==key);}
  finally{tunnelUI.stopping.delete(key);renderTunnelStatus();await refreshForwards();}
}
function renderTunnelShelf() {
  const shelf=$("tunnel-shelf");if(!shelf)return;
  const rows=tunnelRows().filter(f=>["active","starting","failed"].includes(f.status));
  shelf.hidden=!rows.length;
  const sig=JSON.stringify([rows,LANG,tunnelUI.unknown,[...tunnelUI.stopping]]);if(sig===tunnelUI.shelfSignature)return;tunnelUI.shelfSignature=sig;
  $("tun-live").innerHTML=rows.map(f=>{
    const state=tunnelUI.unknown?"unknown":f.status,known=S.forwards.some(x=>x.key===f.key);
    return `<div class="tun-live-item" data-state="${esc(state)}"><button class="tun-live-label" data-tunnel="${esc(f.key)}" data-action="manage" title="${esc(f.remote)}">${ic("plug")}<span><strong>${esc(f.label)}</strong><small>${esc(f.server_name||targetName(f.conn))} · ${f.local_port?"127.0.0.1:"+f.local_port:esc(t("tun.starting"))} · ${esc(t("tun."+state))}</small></span></button><button class="tun-stop" data-tunnel="${esc(f.key)}" data-action="stop" aria-label="${esc(t("tun.stopTunnel")+": "+f.label)}" ${!known||tunnelUI.stopping.has(f.key)?"disabled":""}>${ic("stop")} ${esc(t(f.status==="failed"?"tun.remove":"tun.turnOff"))}</button></div>`;
  }).join("");
}
function renderContainerTunnelControls() {
  if(S.view!=="container"||!S.selected)return;
  const box=$("container-tunnels");if(!box)return;
  const c=S.selected,conn=S.activeConn;
  if(profileById(conn)?.kind!=="ssh"||c.state!=="running")return;
  const ports=portsOf(c),sig=JSON.stringify([conn,ports,tunnelRows(),LANG,tunnelUI.unknown,[...tunnelUI.stopping]]);
  if(box.dataset.sig===sig)return;box.dataset.sig=sig;
  box.innerHTML=ports.map(p=>{
    const f=containerTunnel(conn,parseInt(p)),state=tunnelUI.unknown&&f?"unknown":f?.status||"idle",running=["active","starting"].includes(f?.status),known=f&&S.forwards.some(x=>x.key===f.key);
    return `<span class="container-tunnel" data-state="${esc(state)}"><button type="button" data-port="${esc(p)}" title="${esc(t("tun.configure"))}">${ic("plug")} ${esc(t("tun.single"))} :${parseInt(p)}${f?` · ${esc(t("tun."+state))}`:""}</button>${running?`<button type="button" class="tun-stop" data-stop="${esc(f.key)}" aria-label="${esc(t("tun.stopTunnel")+" :"+parseInt(p))}" ${!known||tunnelUI.stopping.has(f.key)?"disabled":""}>${ic("stop")} ${esc(t("tun.turnOff"))}</button>`:""}</span>`;
  }).join("");
  box.onclick=e=>{
    const stop=e.target.closest("button[data-stop]");
    if(stop){stopTunnel(stop.dataset.stop).catch(e=>toast(String(e),"warn",6000));return;}
    const button=e.target.closest("button[data-port]");if(button)openTunnelManager({conn,remoteHost:"127.0.0.1",remotePort:parseInt(button.dataset.port),label:c.name+":"+parseInt(button.dataset.port)});
  };
}
async function refreshForwards() {
  if(tunnelUI.flight)return tunnelUI.flight;
  const revision=tunnelUI.revision;
  tunnelUI.flight=(async()=>{
    try {
      const rows=await invoke("forward_list");
      if(revision!==tunnelUI.revision)return;
      const lost=rows.some(f=>f.status==="failed"&&S.forwards.some(old=>old.key===f.key&&old.status==="active"));
      S.forwards=rows;tunnelUI.unknown=false;
      if(lost)toast(t("tun.lost"),"warn",6500);
    }catch{if(revision===tunnelUI.revision)tunnelUI.unknown=true;}
    finally{renderTunnelStatus();}
  })();
  try{await tunnelUI.flight;}finally{tunnelUI.flight=null;}
}
function wireTunnels() {
  $("fwd-badge").onclick=()=>openTunnelManager();
  $("tun-shelf-title").onclick=()=>openTunnelManager();
  $("tun-live").onclick=e=>{
    const button=e.target.closest("button[data-tunnel]");if(!button)return;
    if(button.dataset.action==="stop")stopTunnel(button.dataset.tunnel).catch(e=>toast(String(e),"warn",6000));
    else openTunnelManager();
  };
  $("tun-refresh").onclick=refreshForwards;
  $("tun-form").onsubmit=e=>{e.preventDefault();submitTunnel();};
  $("tun-save").onclick=saveTunnelPreset;
  $("tun-close-all").onclick=()=>stopAllForwards().catch(e=>{$("tun-error").textContent=String(e);});
  $("tun-presets").onclick=e=>{
    const button=e.target.closest("button[data-preset]");if(!button)return;
    const p=S.tunnelPresets.find(p=>p.id===button.dataset.preset);if(!p)return;
    if(button.dataset.action==="delete"){S.tunnelPresets=S.tunnelPresets.filter(x=>x!==p);persist();renderTunnelPresets();return;}
    fillTunnelForm(p);
    if(button.dataset.action==="start"){
      if(p.endpoint!==tunnelEndpoint(profileById(p.conn))){$("tun-error").textContent=t("tun.profileChanged");return;}
      submitTunnel();
    }
  };
  $("tun-list").onclick=async e=>{
    const button=e.target.closest("button[data-tunnel]");if(!button)return;
    const row=S.forwards.find(f=>f.key===button.dataset.tunnel);if(!row)return;
    button.disabled=true;
    try{
      if(button.dataset.action==="stop")await stopTunnel(row.key);
      if(button.dataset.action==="copy")await copyText("127.0.0.1:"+row.local_port);
      if(button.dataset.action==="command")await copyText(row.ssh_command);
      if(button.dataset.action==="open")await invoke("open_url",{url:row.url});
      if(button.dataset.action==="restart")await startTunnel({conn:row.conn,remoteHost:row.remote_host,remotePort:row.remote_port,localPort:row.local_port,label:row.label});
    }catch(e){$("tun-error").textContent=String(e);}finally{button.disabled=false;}
  };
  renderTunnelStatus();refreshForwards();
  tunnelUI.poll=setInterval(refreshForwards,3000);
}
function tunnelEndpoint(p) {return p?JSON.stringify([p.kind,p.host,p.port,p.user,p.key_path||""]):"";}
function fillTunnelServers(selected) {
  $("tun-server").innerHTML=`<option value="">${esc(t("tun.chooseServer"))}</option>`+S.profiles.filter(p=>p.kind==="ssh").map(p=>`<option value="${esc(p.id)}">${esc(p.name+" · "+p.host)}</option>`).join("");
  $("tun-server").value=selected||"";
}
function openTunnelManager(prefill=null) {
  const modal=$("tunnel-modal");
  if(!modal.classList.contains("open")){
    const previous=$("tun-server").value;
    fillTunnelServers(profileById(previous)?.kind==="ssh"?previous:activeProfile()?.kind==="ssh"?S.activeConn:"");
    $("tun-error").textContent="";
    if(!$("tun-host").value)$("tun-host").value="127.0.0.1";
  }
  if(prefill)fillTunnelForm(prefill);
  $("tun-create").open=!!prefill||!tunnelRows().length;
  modal.classList.add("open");renderTunnelPresets();tunnelUI.signature="";renderTunnelStatus();refreshForwards();
  if(prefill)$("tun-server").focus();else modal.querySelector?.("[data-close]")?.focus();
}
function fillTunnelForm(p) {
  $("tun-create").open=true;
  fillTunnelServers(p.conn);$("tun-name").value=p.label||"";$("tun-host").value=p.remoteHost||"127.0.0.1";$("tun-remote").value=p.remotePort||"";$("tun-local").value=p.localPort||"";
  $("tun-error").textContent="";
}
function tunnelFormRequest() {
  const conn=$("tun-server").value,p=profileById(conn),host=$("tun-host").value.trim(),remote=Number($("tun-remote").value),local=$("tun-local").value.trim();
  if(!p||p.kind!=="ssh")throw Error(t("tun.chooseServer"));
  if(!host||host.length>253||/[\s\[\]\/\\@]/.test(host)||!Number.isInteger(remote)||remote<1||remote>65535||local&&(!/^\d+$/.test(local)||Number(local)<1||Number(local)>65535))throw Error(t("tun.invalid"));
  return {conn,remoteHost:host,remotePort:remote,localPort:local?Number(local):null,label:$("tun-name").value.trim()||host+":"+remote};
}
function tunnelFormBusy(busy) {
  tunnelUI.busy=busy;$("tun-form").querySelectorAll("input,select,button").forEach(e=>e.disabled=busy);
}
async function submitTunnel() {
  if(tunnelUI.busy)return;
  let request;try{request=tunnelFormRequest();}catch(e){$("tun-error").textContent=String(e);return;}
  $("tun-error").textContent="";tunnelFormBusy(true);
  try{await startTunnel(request);}catch(e){$("tun-error").textContent=String(e);}finally{tunnelFormBusy(false);}
}
async function startTunnel(request) {
  const id=JSON.stringify([request.conn,request.remoteHost,request.remotePort]);
  if(tunnelUI.pending.has(id))throw Error(t("tun.starting"));
  tunnelUI.pending.set(id,{key:id,conn:request.conn,server_name:targetName(request.conn),remote_host:request.remoteHost,remote_port:request.remotePort,local_port:request.localPort||0,label:request.label,status:"starting",remote:request.remoteHost+":"+request.remotePort});renderTunnelStatus();
  try {
    const row=await invoke("forward_start",request);
    tunnelUI.revision++;tunnelUI.unknown=false;
    S.forwards=[...S.forwards.filter(f=>f.key!==row.key),row];
    return row;
  } finally {tunnelUI.pending.delete(id);renderTunnelStatus();await refreshForwards();}
}
async function stopAllForwards() {
  await refreshForwards();
  if(!S.forwards.length)return;
  if(!await ask({title:t("tun.stopAll"),text:esc(t("tun.stopAllConfirm")),okLabel:t("tun.stop")}))return;
  for(const row of [...S.forwards]){await invoke("forward_stop",{key:row.key});tunnelUI.revision++;S.forwards=S.forwards.filter(f=>f.key!==row.key);}
  await refreshForwards();
}
function saveTunnelPreset() {
  try{
    const p=tunnelFormRequest(),endpoint=tunnelEndpoint(profileById(p.conn));
    const old=S.tunnelPresets.find(x=>x.conn===p.conn&&x.remoteHost===p.remoteHost&&x.remotePort===p.remotePort);
    S.tunnelPresets=[{...p,id:old?.id||crypto.randomUUID(),endpoint},...S.tunnelPresets.filter(x=>x!==old)].slice(0,50);
    persist();renderTunnelPresets();$("tun-error").textContent="";toast(t("tun.saved"),"ok",2500);
  }catch(e){$("tun-error").textContent=String(e);}
}
function renderTunnelPresets() {
  $("tun-presets").innerHTML=S.tunnelPresets.length?`<h3>${esc(t("tun.presets"))}</h3>`+S.tunnelPresets.map(p=>`<div class="tun-preset"><span><strong>${esc(p.label)}</strong><small>${esc(targetName(p.conn)+" · "+p.remoteHost+":"+p.remotePort)}</small></span><button data-preset="${esc(p.id)}" data-action="start">${esc(t("tun.start"))}</button><button data-preset="${esc(p.id)}" data-action="edit">${esc(t("tun.edit"))}</button><button data-preset="${esc(p.id)}" data-action="delete" aria-label="${esc(t("common.delete")+": "+p.label)}">${ic("trash")}</button></div>`).join(""):"";
}
function renderTunnelList() {
  if(!$("tunnel-modal")?.classList.contains("open"))return;
  const rows=tunnelRows().sort((a,b)=>(["active","starting"].includes(b.status)?1:0)-(["active","starting"].includes(a.status)?1:0)),sig=JSON.stringify([rows,LANG,tunnelUI.unknown,[...tunnelUI.stopping]]);if(sig===tunnelUI.signature)return;tunnelUI.signature=sig;
  $("tun-list-status").textContent=tunnelUI.unknown?t("tun.checkFailed"):"";
  $("tun-close-all").disabled=!S.forwards.length;
  $("tun-list").innerHTML=rows.length?rows.map(f=>{
    const active=f.status==="active"&&!tunnelUI.unknown,known=S.forwards.some(x=>x.key===f.key),state=tunnelUI.unknown?"unknown":f.status;
    return `<article class="tun-card" data-state="${esc(state)}"><div class="tun-card-head"><strong>${ic("plug")} ${esc(f.label)}</strong><span class="tun-state" data-state="${esc(state)}">${esc(t("tun."+state))}</span><button class="tun-stop" data-tunnel="${esc(f.key)}" data-action="stop" ${known&&!tunnelUI.stopping.has(f.key)?"":"disabled"}>${ic("stop")} ${esc(t(["starting","active"].includes(f.status)?"tun.turnOff":"tun.remove"))}</button></div><small>${esc((f.server_name||targetName(f.conn))+" · "+f.remote)}</small><div class="tun-address">${esc(f.local_port?"127.0.0.1:"+f.local_port:t("tun.auto"))} → ${esc(f.remote)}</div>${f.error?`<p class="tun-error">${esc(f.error)}</p>`:""}<div class="tun-actions"><button data-tunnel="${esc(f.key)}" data-action="open" ${active?"":"disabled"}>${esc(t("tun.open"))}</button><button data-tunnel="${esc(f.key)}" data-action="copy" ${active?"":"disabled"}>${esc(t("tun.copyAddress"))}</button><button data-tunnel="${esc(f.key)}" data-action="command" ${f.ssh_command?"":"disabled"}>${esc(t("tun.copyCommand"))}</button>${["failed","stopped"].includes(f.status)?`<button data-tunnel="${esc(f.key)}" data-action="restart" ${tunnelUI.unknown?"disabled":""}>${esc(t("tun.reconnect"))}</button>`:""}</div></article>`;
  }).join(""):`<p class="hint">${esc(t("tun.empty"))}</p>`;
}
function translateTunnels() {
  renderTunnelStatus();
  if($("tunnel-modal")?.classList.contains("open")){const selected=$("tun-server").value;fillTunnelServers(selected);renderTunnelPresets();}
}
