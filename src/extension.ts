import * as vscode from "vscode";
import { AuthManager } from "./auth";
import { ApiError, BotHostingApi, Deployment, FileEntry, StartupConfig, RuntimeInfo } from "./api";
import { ServerTreeProvider, FileItem, EnvItem, SectionItem, PackageItem, BackupItem, ServerItem } from "./treeView";
import { RemoteFileSystemProvider } from "./remoteFileSystemProvider";
import { getConsoleHtml as getRebuiltConsoleHtml, getResourceHtml as getRebuiltResourceHtml } from "./webviews";

let api: BotHostingApi;
let treeProvider: ServerTreeProvider;
let fsProvider: RemoteFileSystemProvider;
let auth: AuthManager;
let resourcePanels: Map<string, vscode.WebviewPanel> = new Map();
let startupPanel: vscode.WebviewPanel | undefined;
let backupsInProgress: Set<string> = new Set();
let consoleBottomView: vscode.WebviewView | undefined;
let activeConsoleDeploymentId: string | undefined;
let activeConsoleName = "BananaBurner";
let consoleFontPreference: { auto: boolean; fontSize: number } = { auto: true, fontSize: 13 };
let selectedDeploymentId: string | undefined;
const MAX_TEXT_UPLOAD_BYTES = 50 * 1024 * 1024;
let automaticManagePanel: vscode.WebviewPanel | undefined;
//
function actionErrorMessage(err: any): string {
  var message = err?.message || String(err || "Unknown error");
  if (message === "Forbidden - insufficient permissions") {
    return "Permission denied. Your API key or OAuth token may lack required scopes. The API returned no additional details.";
  }
  return message;
}

async function pickDeployment(): Promise<Deployment | undefined> {
  var deps = treeProvider.getDeploymentList();
  if (!deps || deps.length === 0) { vscode.window.showWarningMessage("No deployments loaded."); return undefined; }
  var picked = await vscode.window.showQuickPick(deps.map(function (d) { return { label: d.name, description: d.state, _dep: d }; }), { placeHolder: "Select deployment" });
  return picked ? picked._dep : undefined;
}

async function inferPackageManager(deploymentId: string): Promise<"npm" | "pip" | undefined> {
  try {
    var startup = await api.getStartup(deploymentId);
    var runtime = (startup.runtime + " " + startup.entryFile + " " + startup.startCommand).toLowerCase();
    if (/(^|[^a-z])python|\bpy\b|\.py\b/.test(runtime)) return "pip";
    if (/node|javascript|typescript|bun|deno|\.m?[jt]sx?\b/.test(runtime)) return "npm";
  } catch (_e) {
  }
  return undefined;
}

function preferredFileViewColumn(): vscode.ViewColumn | undefined {
  var groups = vscode.window.tabGroups.all;
  var remoteFileGroup = groups.find(function (group) {
    return group.tabs.some(function (tab) {
      return tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "bh";
    });
  });
  var textFileGroup = remoteFileGroup || groups.find(function (group) {
    return group.tabs.some(function (tab) { return tab.input instanceof vscode.TabInputText; });
  });
  return textFileGroup?.viewColumn;
}

function preferredToolViewColumn(viewType: string): vscode.ViewColumn | undefined {
  var group = vscode.window.tabGroups.all.find(function (candidate) {
    return candidate.tabs.some(function (tab) {
      return tab.input instanceof vscode.TabInputWebview && tab.input.viewType === viewType;
    });
  });
  return group?.viewColumn;
}

async function updateConnectedContext(): Promise<void> {
  var connected = await auth.isAuthenticated();
  vscode.commands.executeCommand("setContext", "bb:connected", connected);
}

function debounce<F extends (...args: any[]) => any>(fn: F, ms: number): F {
  var timer: ReturnType<typeof setTimeout>;
  var Debounced = function () {
    var args: any[] = [];
    for (var i = 0; i < arguments.length; i++) { args[i] = arguments[i]; }
    clearTimeout(timer);
    timer = setTimeout(function () { fn.apply(undefined, args); }, ms);
  };
  return Debounced as unknown as F;
}

async function getAllFilesRecursive(apiClient: BotHostingApi, deploymentId: string, rootPath: string): Promise<{ deploymentId: string; path: string; name: string }[]> {
  var results: { deploymentId: string; path: string; name: string }[] = [];
  try {
    var res = await apiClient.listFiles(deploymentId, rootPath);
    var entries = res.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var fullPath = rootPath === "/" ? "/" + entry.name : rootPath + "/" + entry.name;
      if (entry.type === "directory") {
        var sub = await getAllFilesRecursive(apiClient, deploymentId, fullPath);
        results = results.concat(sub);
      } else {
        results.push({ deploymentId: deploymentId, path: fullPath, name: entry.name });
      }
    }
  } catch (_e) { }
  return results;
}


function getConsoleHtml(deploymentName: string): string {
  var connected = !!deploymentName;
  var initialMessage = connected ? "Connecting to " + deploymentName + " console..." : "Select a deployment in the BananaBurner sidebar, then choose Open Console.";
  var initialFontPreference = JSON.stringify(consoleFontPreference);
  return "<!DOCTYPE html><html><head><style>" +
    "body{margin:0;padding:0;background:#1e1e1e;color:#d4d4d4;font-family:monospace;font-size:clamp(10px,1.15vw,14px);display:flex;flex-direction:column;height:100vh}" +
    "#server-info{display:flex;align-items:center;gap:6px;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-family:var(--vscode-font-family,system-ui)}.server-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}.server-dot.connected{background:#23d18b}.server-dot.disconnected{background:#f14c4c}.server-dot.reconnecting{background:#e5e510;animation:pulse 1s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}#toolbar{display:flex;justify-content:flex-end;align-items:center;gap:5px;padding:6px 8px;border-bottom:1px solid #333;font-family:var(--vscode-font-family,system-ui);font-size:12px}.font-button{background:var(--vscode-toolbar-hoverBackground,#2d2d2d);color:var(--vscode-foreground,#ccc);border:1px solid transparent;border-radius:3px;padding:3px 7px;cursor:pointer}.font-button:hover{border-color:var(--vscode-focusBorder,#007acc)}.font-button:disabled{opacity:.45;cursor:default}#search{background:var(--vscode-input-background,#252526);color:var(--vscode-input-foreground,#ddd);border:1px solid var(--vscode-input-border,#555);border-radius:3px;padding:3px 6px}#search:focus{outline:1px solid var(--vscode-focusBorder,#007acc)}#font-label{min-width:34px;text-align:center;color:#aaa}.hl{background:rgba(229,192,123,.25);border-radius:2px;padding:0 1px}#match-count{color:#888;font-size:11px;min-width:30px;text-align:center}" +
    "#log{flex:1;overflow-y:auto;padding:8px;white-space:pre-wrap;word-break:break-all}" +
    "#input-bar{display:flex;border-top:1px solid #333;padding:4px}" +
    "#cmd{flex:1;background:#2d2d2d;color:#d4d4d4;border:1px solid #444;padding:4px 8px;font-family:monospace;font-size:inherit}" +
    "#cmd:focus{outline:none;border-color:#007acc}" +
    "#send{background:#007acc;color:#fff;border:none;padding:4px 12px;cursor:pointer;font-size:13px}#send:disabled,#cmd:disabled{opacity:.55;cursor:default}" +
    "#send:hover{background:#005fa3}" +
    ".line{padding:1px 0}.err{color:#f44747}.info{color:#569cd6}" +
    "</style></head><body>" +
    "<div id='toolbar'><span id='server-info'></span><button class='font-button' id='pause'>Pause</button><button class='font-button' id='follow'>Follow</button><button class='font-button' id='clear'>Clear</button><button class='font-button' id='copy'>Copy</button><input id='search' placeholder='Find' style='width:90px'><span id='match-count'></span><button class='font-button' id='smaller' title='Smaller text'>A−</button><button class='font-button' id='auto' title='Automatic text size'>Auto</button><button class='font-button' id='larger' title='Larger text'>A+</button><span id='font-label'></span></div><div id='log'><div class='info'>" + initialMessage + "</div></div>" +
    "<div id='input-bar'><input id='cmd' placeholder='Type command and press Enter…' autofocus><button id='send'>Send</button></div>" +
    "<script>" +
    "var vscode=acquireVsCodeApi(),log=document.getElementById('log'),cmd=document.getElementById('cmd'),send=document.getElementById('send'),fontLabel=document.getElementById('font-label'),fontState=" + initialFontPreference + ",paused=false,follow=true,history=[],historyIndex=0,localCommands=[],rapidPollTimer=null,waitingForOutput=false;" +
    "function applyFont(){document.body.style.fontSize=fontState.auto?'':fontState.fontSize+'px';fontLabel.textContent=fontState.auto?'Auto':fontState.fontSize+'px';vscode.setState(fontState);vscode.postMessage({type:'fontSettings',settings:{auto:!!fontState.auto,fontSize:fontState.fontSize}});}function manual(delta){fontState.auto=false;fontState.fontSize=Math.max(10,Math.min(22,(fontState.fontSize||13)+delta));applyFont();}document.getElementById('smaller').onclick=function(){manual(-1);};document.getElementById('larger').onclick=function(){manual(1);};document.getElementById('auto').onclick=function(){fontState.auto=true;applyFont();};applyFont();var serverInfo=document.getElementById('server-info');function setConnectionState(name,state){if(!serverInfo)return;var cls='connected',label='Connected';if(state==='disconnected'){cls='disconnected';label='Disconnected';}else if(state==='reconnecting'){cls='reconnecting';label='Reconnecting...';}serverInfo.innerHTML=(name?name+' \u00b7 ':'')+'<span class=\"server-dot '+cls+'\">'+label;}" +
    "function addLine(t,c){var d=document.createElement('div');d.className='line'+(c?' '+c:'');d.dataset.raw=String(t);var state={fg:'',bg:'',bold:false,dim:false,underline:false};var p8={30:'#3b8eea',31:'#f14c4c',32:'#23d18b',33:'#e5e510',34:'#569cd6',35:'#bc3fbc',36:'#29b8db',37:'#e5e5e5',90:'#666',91:'#f14c4c',92:'#23d18b',93:'#e5e510',94:'#569cd6',95:'#d670d6',96:'#29b8db',97:'#fff'};var pBg={40:'#1e1e1e',41:'#b42318',42:'#16825d',43:'#9e6a03',44:'#1158c7',45:'#6e40c9',46:'#116383',47:'#bbb'};function ansi256(n){if(n<8)return['#3b8eea','#f14c4c','#23d18b','#e5e510','#569cd6','#bc3fbc','#29b8db','#e5e5e5'][n];if(n<16)return['#666','#f14c4c','#23d18b','#e5e510','#569cd6','#d670d6','#29b8db','#fff'][n-8];var i=n-16,r=Math.floor(i/36),g=Math.floor((i%36)/6),b=i%6;return'rgb('+(r?r*40+55:0)+','+(g?g*40+55:0)+','+(b?b*40+55:0)+')';}function text(v){if(!v)return;var s=document.createElement('span');s.textContent=v;if(state.fg)s.style.color=state.fg;if(state.bg)s.style.backgroundColor=state.bg;if(state.bold)s.style.fontWeight='bold';if(state.dim)s.style.opacity='0.6';if(state.underline)s.style.textDecoration='underline';d.appendChild(s);}var re=new RegExp(String.fromCharCode(27)+String.fromCharCode(92)+String.fromCharCode(91)+'([0-9;]*)m','g'),last=0,m,value=String(t);while((m=re.exec(value))!==null){text(value.slice(last,m.index));var params=(m[1]||'0').split(';').map(Number);var i=0;while(i<params.length){var p=params[i];if(p===0){state.fg='';state.bg='';state.bold=false;state.dim=false;state.underline=false;}else if(p===1){state.bold=true;}else if(p===2){state.dim=true;}else if(p===4){state.underline=true;}else if(p===22){state.bold=false;state.dim=false;}else if(p===24){state.underline=false;}else if(p===39){state.fg='';}else if(p===49){state.bg='';}else if(p8[p]){state.fg=p8[p];}else if(pBg[p]){state.bg=pBg[p];}else if(p===38&&params[i+1]===5&&params[i+2]!==undefined){state.fg=ansi256(params[i+2]);i+=2;}else if(p===48&&params[i+1]===5&&params[i+2]!==undefined){state.bg=ansi256(params[i+2]);i+=2;}else if(p===38&&params[i+1]===2&&params[i+4]!==undefined){state.fg='rgb('+params[i+2]+','+params[i+3]+','+params[i+4]+')';i+=4;}else if(p===48&&params[i+1]===2&&params[i+4]!==undefined){state.bg='rgb('+params[i+2]+','+params[i+3]+','+params[i+4]+')';i+=4;}i++;}last=re.lastIndex;}text(value.slice(last));log.appendChild(d);if(follow)log.scrollTop=log.scrollHeight;}" +
    "function renderLogs(lines){var wasAtBottom=log.scrollTop+log.clientHeight>=log.scrollHeight-4;log.innerHTML='';(lines||[]).forEach(function(line){addLine(line);});localCommands.forEach(function(line){addLine('> '+line,'info');});if(waitingForOutput){addLine('⏳ Waiting for command output...','info');}if(wasAtBottom&&follow)log.scrollTop=log.scrollHeight;}" +
    "function startRapidPoll(){if(rapidPollTimer)return;waitingForOutput=true;var remaining=10;rapidPollTimer=setInterval(function(){vscode.postMessage({type:'pollLogs'});remaining--;if(remaining<=0){clearInterval(rapidPollTimer);rapidPollTimer=null;waitingForOutput=false;}},2000);}" +
    "window.addEventListener('message',function(e){" +
    "  var m=e.data;" +
    "  if(m.type==='logs'&&!paused){renderLogs(m.lines);}" +
    "  if(m.type==='logError'){addLine('Error: '+m.error,'err');}" +
    "  if(m.type==='cmdSending'){addLine('Sending command…','info');}" +
    "  if(m.type==='cmdAccepted'){addLine(m.message||'Command accepted by the server.','info');}" +
    "  if(m.type==='cmdSent'){send.disabled=false;cmd.disabled=false;cmd.focus();addLine('✓ Command sent successfully. Polling for output…','info');startRapidPoll();}" +
    "  if(m.type==='cmdError'){send.disabled=false;cmd.disabled=false;addLine('Error: '+m.error,'err');}" +
    "  if(m.type==='authError'){send.disabled=false;cmd.disabled=false;addLine('Auth expired. Reconnect from sidebar.','err');}\n  if(m.type==='connectionState'){setConnectionState(m.name||'',m.state||'disconnected');}" +
    "});" +
    "document.getElementById('pause').onclick=function(){paused=!paused;this.textContent=paused?'Resume':'Pause';};document.getElementById('follow').onclick=function(){follow=!follow;this.textContent=follow?'Following':'Follow';};document.getElementById('clear').onclick=function(){log.innerHTML='';};document.getElementById('copy').onclick=function(){navigator.clipboard.writeText(Array.from(log.children).map(function(x){return x.dataset.raw||x.textContent;}).join('\\n'));};document.getElementById('search').oninput=function(){var q=this.value,ql=q.toLowerCase(),mc=document.getElementById('match-count');if(!q){Array.from(log.children).forEach(function(x){x.style.display='';x.querySelectorAll('.hl').forEach(function(h){var p=h.parentNode;p.replaceChild(document.createTextNode(h.textContent),h);p.normalize();});});mc.textContent='';return;}var total=0,first=null;Array.from(log.children).forEach(function(x){var raw=String(x.dataset.raw||'');if(raw.toLowerCase().indexOf(ql)===-1){x.style.display='none';x.querySelectorAll('.hl').forEach(function(h){var p=h.parentNode;p.replaceChild(document.createTextNode(h.textContent),h);p.normalize();});return;}x.style.display='';total++;x.querySelectorAll('.hl').forEach(function(h){var p=h.parentNode;p.replaceChild(document.createTextNode(h.textContent),h);p.normalize();});var lc=x.textContent,lower=lc.toLowerCase(),start=lower.indexOf(ql);if(start!==-1){var frag=document.createDocumentFragment();frag.appendChild(document.createTextNode(lc.slice(0,start)));var mark=document.createElement('span');mark.className='hl';mark.textContent=lc.slice(start,start+q.length);frag.appendChild(mark);frag.appendChild(document.createTextNode(lc.slice(start+q.length)));x.textContent='';x.appendChild(frag);if(!first)first=x;}});mc.textContent=total>0?total+' match'+(total>1?'es':''):'';if(first)first.scrollIntoView({block:'center',behavior:'smooth'});};" +
    "send.onclick=function(){var v=cmd.value.trim();if(!v||send.disabled)return;history.push(v);historyIndex=history.length;localCommands.push(v);if(localCommands.length>25)localCommands.shift();addLine('> '+v,'info');cmd.value='';send.disabled=true;cmd.disabled=true;" +
    "vscode.postMessage({type:'sendCommand',command:v});};" +
    "cmd.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();send.click();return;}if(e.key==='ArrowUp'&&history.length){e.preventDefault();historyIndex=Math.max(0,historyIndex-1);cmd.value=history[historyIndex];}if(e.key==='ArrowDown'){e.preventDefault();historyIndex=Math.min(history.length,historyIndex+1);cmd.value=history[historyIndex]||'';}};" +
    "vscode.postMessage({type:'ready'});" +
    "</script></body></html>";
}

function getResourceHtml(deploymentName: string): string {
  return "<!DOCTYPE html><html><head><style>" +
    "body{margin:0;padding:16px;background:#1e1e1e;color:#d4d4d4;font-family:system-ui}" +
    ".grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}" +
    ".card{background:var(--vscode-editorWidget-background,#2d2d2d);border-radius:6px;padding:16px;border:1px solid var(--vscode-widget-border,#333)}" +
    ".card h3{margin:0 0 8px 0;font-size:12px;color:#888;text-transform:uppercase}" +
    ".bar-bg{background:#1a1a1a;border-radius:4px;height:8px;margin-top:4px}" +
    ".bar{height:8px;border-radius:4px;transition:width 0.5s ease}" +
    ".val{font-size:24px;font-weight:bold;margin:4px 0}" +
    ".sub{font-size:11px;color:#888}" +
    "#uptime{font-size:14px;color:#569cd6;margin-top:12px}" +
    "input{font:inherit;background:var(--vscode-input-background,#252526);color:var(--vscode-input-foreground,#ddd);border:1px solid var(--vscode-input-border,#555);border-radius:3px;padding:7px 8px}input:focus{outline:1px solid var(--vscode-focusBorder,#007acc)}button{font:inherit;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#fff);border:0;border-radius:3px;padding:7px 10px;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground,#50545a)}.power{display:flex;align-items:center;gap:8px;margin-top:18px}.power button{color:#fff}#start{background:var(--vscode-testing-iconPassed,#16825d)}#restart{background:var(--vscode-button-background,#0969aa)}#stop{background:var(--vscode-testing-iconFailed,#b42318)}#power-status{font-size:12px;color:#aaa}.power button:disabled{opacity:.4;cursor:not-allowed;pointer-events:none}" +
    "</style></head><body>" +
    "<h2 style='margin:0 0 4px 0'>" + deploymentName + "</h2><div class='sub' id='deployment-meta'>Loading deployment details…</div>" +
    "<div class='grid'>" +
    "<div class='card'><h3>CPU</h3><div class='val' id='cpu'>--</div><div class='bar-bg'><div class='bar' id='cpu-bar' style='width:0;background:#007acc'></div></div><div class='sub' id='cpu-sub'></div></div>" +
    "<div class='card'><h3>Memory</h3><div class='val' id='mem'>--</div><div class='bar-bg'><div class='bar' id='mem-bar' style='width:0;background:#4ec9b0'></div></div><div class='sub' id='mem-sub'></div></div>" +
    "<div class='card'><h3>Disk</h3><div class='val' id='disk'>--</div><div class='bar-bg'><div class='bar' id='disk-bar' style='width:0;background:#dcdcaa'></div></div><div class='sub' id='disk-sub'></div></div>" +
    "<div class='card'><h3>Network</h3><div class='val' id='net'>--</div><div class='sub' id='net-sub'></div></div>" +
    "</div><div id='uptime'></div><div class='power'><button id='start'>Start</button><button id='restart'>Restart</button><button id='stop'>Stop</button><span id='power-status'></span></div><hr style='border:0;border-top:1px solid #333;margin:20px 0'><div class='grid'><div class='card'><h3>Allocation</h3><div class='sub' style='margin-bottom:8px'>Changes apply the RAM, CPU, and storage allocation together.</div><label class='sub'>RAM (MiB)</label><input id='ram-mb' type='number' min='1' step='1' style='width:100%;box-sizing:border-box'><label class='sub' style='display:block;margin-top:8px'>CPU (%)</label><input id='cpu-pct' type='number' min='1' step='1' style='width:100%;box-sizing:border-box'><label class='sub' style='display:block;margin-top:8px'>Storage (MiB)</label><input id='storage-mb' type='number' min='1' step='1' style='width:100%;box-sizing:border-box'><button id='save-allocation' style='margin-top:10px'>Save allocation</button></div><div class='card'><h3>Git auto-pull</h3><div id='git-status' class='sub'>Loading Git settings…</div><label id='auto-pull-row' style='display:none;align-items:center;gap:8px;margin-top:12px;font-size:13px;font-weight:normal'><input id='auto-pull' type='checkbox'> Pull the linked repository automatically</label><button id='save-auto-pull' style='display:none;margin-top:10px'>Save Git setting</button></div></div><hr style='border:0;border-top:1px solid #333;margin:20px 0'><div class='grid'><div class='card'><h3>Deployment</h3><input id='name' placeholder='Deployment name'><input id='description' placeholder='Description' style='margin-top:8px;width:100%;box-sizing:border-box'><button id='save-deployment' style='margin-top:8px'>Save details</button></div><div class='card'><h3>Domains</h3><div id='domains' class='sub'>Loading…</div><button id='enable-domains' style='margin-top:8px'>Enable hosting domain</button><div id='alias-controls'><input id='slug' placeholder='Alias (your-name)' style='margin-top:8px;width:100%;box-sizing:border-box'><div class='sub'>Creates your-name.apps.bot-hosting.cloud</div><button id='save-slug' style='margin-top:8px'>Save alias</button><button id='remove-slug' style='margin-top:8px'>Remove alias</button></div><div id='custom-controls'><input id='custom-domain' placeholder='Custom domain (bot.example.com)' style='margin-top:12px;width:100%;box-sizing:border-box'><button id='save-custom' style='margin-top:8px'>Set custom domain</button><button id='verify-custom' style='margin-top:8px'>Verify DNS</button><button id='remove-custom' style='margin-top:8px'>Remove custom domain</button></div></div></div>" +
    "<script>" +
    "var vscode=acquireVsCodeApi();function fmt(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(2)+' GB';}" +
    "function fmtMs(ms){var s=Math.floor(ms/1000);var m=Math.floor(s/60);var h=Math.floor(m/60);var d=Math.floor(h/24);return d+'d '+h%24+'h '+m%60+'m '+s%60+'s';}" +
    "var currentResourceState='unknown';" +
    "function updatePowerButtons(s){currentResourceState=(s||'unknown').toLowerCase();var btns={start:currentResourceState==='running'||currentResourceState==='starting',stop:currentResourceState==='offline'||currentResourceState==='stopping',restart:currentResourceState==='offline'||currentResourceState==='stopping'};Object.keys(btns).forEach(function(k){var b=document.getElementById(k);if(b){b.disabled=btns[k];}});document.getElementById('power-status').textContent='State: '+currentResourceState;}" +
    "function update(d){" +
    "d=d||{};d.cpu=d.cpu||{usedPercent:0,limitPercent:0};d.memory=d.memory||{usedBytes:0,limitBytes:0};d.disk=d.disk||{usedBytes:0,limitBytes:0};d.network=d.network||{rxBytes:0,txBytes:0};if(d.state)updatePowerButtons(d.state);" +
    "var cpuPct=d.cpu.limitPercent>0?Math.round(d.cpu.usedPercent/d.cpu.limitPercent*100):0;document.getElementById('cpu').textContent=d.cpu.usedPercent+'% / '+d.cpu.limitPercent+'%';" +
    "document.getElementById('cpu-bar').style.width=cpuPct>0?Math.max(2,Math.min(100,cpuPct))+'%':'0%';" +
    "document.getElementById('cpu-bar').style.background=cpuPct>80?'#f44747':'#007acc';" +
    "document.getElementById('cpu-sub').textContent=cpuPct+'% of allocation';" +
    "var memPct=d.memory.limitBytes>0?Math.round(d.memory.usedBytes/d.memory.limitBytes*100):0;" +
    "document.getElementById('mem').textContent=fmt(d.memory.usedBytes)+' / '+fmt(d.memory.limitBytes);" +
    "document.getElementById('mem-bar').style.width=memPct+'%';" +
    "document.getElementById('mem-bar').style.background=memPct>80?'#f44747':'#4ec9b0';" +
    "var diskPct=d.disk.limitBytes>0?Math.round(d.disk.usedBytes/d.disk.limitBytes*100):0;" +
    "document.getElementById('disk').textContent=fmt(d.disk.usedBytes)+' / '+fmt(d.disk.limitBytes);" +
    "document.getElementById('disk-bar').style.width=diskPct+'%';" +
    "document.getElementById('net').textContent='RX: '+fmt(d.network.rxBytes)+' / TX: '+fmt(d.network.txBytes);" +
    "document.getElementById('uptime').textContent='Uptime: '+fmtMs(d.uptimeMs);" +
    "}" +
    "function deployment(d){if(d.state)updatePowerButtons(d.state);document.getElementById('name').value=d.name||'';document.getElementById('description').value=d.description||'';var allocation=d.resources||{};document.getElementById('ram-mb').value=allocation.ramMB||'';document.getElementById('cpu-pct').value=allocation.cpuPercent||'';document.getElementById('storage-mb').value=allocation.storageMB||'';var domains=d.domains||{},hasHosting=!!domains.subdomain,hasAlias=!!domains.slug,hasCustom=!!domains.custom;document.getElementById('enable-domains').style.display=hasHosting?'none':'';document.getElementById('alias-controls').style.display=hasHosting?'':'none';document.getElementById('custom-controls').style.display='';document.getElementById('slug').value=domains.slug||'';document.getElementById('remove-slug').style.display=hasAlias?'':'none';document.getElementById('save-slug').textContent=hasAlias?'Update alias':'Set alias';document.getElementById('custom-domain').value=domains.custom||'';document.getElementById('custom-domain').style.display=hasCustom?'none':'';document.getElementById('save-custom').style.display=hasCustom?'none':'';document.getElementById('verify-custom').style.display=hasCustom?'':'none';document.getElementById('remove-custom').style.display=hasCustom?'':'none';var box=document.getElementById('domains'),hosts=[];function hostingHost(alias){return alias.endsWith('.apps.bot-hosting.cloud')?alias:alias+'.apps.bot-hosting.cloud';}if(domains.subdomain)hosts.push(hostingHost(domains.subdomain));if(domains.slug&&domains.slug!==domains.subdomain)hosts.push(hostingHost(domains.slug));if(domains.custom)hosts.push(domains.custom);box.innerHTML='';hosts.forEach(function(host,i){var a=document.createElement('a');a.href='https://'+host;a.textContent=host;a.target='_blank';a.rel='noopener';box.appendChild(a);if(i<hosts.length-1)box.appendChild(document.createElement('br'));});if(!hosts.length)box.textContent='No domain assigned';document.getElementById('deployment-meta').textContent=(d.state||'unknown')+' · '+(d.node&&d.node.region||'no node');}" +
    "function git(g){var linked=!!(g&&g.linked),row=document.getElementById('auto-pull-row'),button=document.getElementById('save-auto-pull');document.getElementById('git-status').textContent=linked?(g.repo+(g.branch?' · '+g.branch:''):'Linked repository'):'No Git repository linked';row.style.display=linked?'flex':'none';button.style.display=linked?'':'none';document.getElementById('auto-pull').checked=linked&&!!g.autoPull;}" +
    "window.addEventListener('message',function(e){" +
    "  if(e.data.type==='resources'&&e.data.data)update(e.data.data);" +
    "  if(e.data.type==='deployment'&&e.data.data){var dep=e.data.data;deployment(dep);document.getElementById('deployment-meta').textContent='State: '+(dep.state||'unknown')+' · '+(dep.status||'No status')+(dep.node&&dep.node.name?' · Node: '+dep.node.name:'')+(dep.port?' · Port: '+dep.port:'');}" +
    "  if(e.data.type==='git')git(e.data.data);" +
    "  if(e.data.type==='authError'){document.getElementById('uptime').textContent='Auth expired. Reconnect from sidebar.';}" +
    "  if(e.data.type==='deploymentError'){document.getElementById('deployment-meta').textContent='Error: '+e.data.error;}" +
    "  if(e.data.type==='powerResult'){document.getElementById('power-status').textContent=e.data.message;if(e.data.state)updatePowerButtons(e.data.state);}" +
    "});" +
    "['start','restart','stop'].forEach(function(action){document.getElementById(action).onclick=function(){if(document.getElementById(action).disabled)return;document.getElementById('power-status').textContent='Sending '+action+'…';vscode.postMessage({type:'power',action:action});};});" +
    "document.getElementById('save-allocation').onclick=function(){var ram=Number(document.getElementById('ram-mb').value),cpu=Number(document.getElementById('cpu-pct').value),storage=Number(document.getElementById('storage-mb').value);if(!Number.isInteger(ram)||ram<1||!Number.isInteger(cpu)||cpu<1||!Number.isInteger(storage)||storage<1){document.getElementById('power-status').textContent='RAM, CPU, and storage must be positive whole numbers.';return;}document.getElementById('power-status').textContent='Saving allocation…';vscode.postMessage({type:'resize',ramMB:ram,cpuPct:cpu,storageMB:storage});};document.getElementById('save-auto-pull').onclick=function(){document.getElementById('power-status').textContent='Saving Git setting…';vscode.postMessage({type:'autoPull',autoPull:document.getElementById('auto-pull').checked});};document.getElementById('save-deployment').onclick=function(){vscode.postMessage({type:'deploymentUpdate',name:document.getElementById('name').value.trim(),description:document.getElementById('description').value.trim()});};document.getElementById('enable-domains').onclick=function(){vscode.postMessage({type:'enableDomains'});};document.getElementById('save-slug').onclick=function(){vscode.postMessage({type:'slugUpdate',slug:document.getElementById('slug').value.trim()});};document.getElementById('remove-slug').onclick=function(){vscode.postMessage({type:'slugUpdate',slug:''});};document.getElementById('save-custom').onclick=function(){vscode.postMessage({type:'customDomain',domain:document.getElementById('custom-domain').value.trim()});};document.getElementById('verify-custom').onclick=function(){vscode.postMessage({type:'verifyCustomDomain'});};document.getElementById('remove-custom').onclick=function(){vscode.postMessage({type:'removeCustomDomain'});};" +
    "vscode.postMessage({type:'ready'});" +
    "</script></body></html>";
}

function getStartupHtml(session: { id: string; name: string; config: StartupConfig; catalogs: { runtimes: RuntimeInfo[]; services: RuntimeInfo[]; databases: { id: string; label: string; versions: string[]; defaultVersion: string; defaultEntry?: string }[] } }): string {
  var data = JSON.stringify(session).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:780px;margin:0 auto;padding:28px}
    h1{font-size:20px;margin:18px 0 6px}.intro{color:var(--vscode-descriptionForeground);margin:0 0 24px;line-height:1.5}.tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:6px}.tab{background:transparent;color:var(--vscode-foreground);border:0;border-radius:4px 4px 0 0;padding:7px 10px;cursor:pointer;white-space:nowrap}.tab:hover{background:var(--vscode-list-hoverBackground)}.tab.active{background:var(--vscode-tab-activeBackground);border-bottom:2px solid var(--vscode-focusBorder)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.full{grid-column:1/-1}
    label{display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:600}input,select{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:8px}input:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}
    .hint{font-size:12px;color:var(--vscode-descriptionForeground);font-weight:400}.footer{display:flex;align-items:center;gap:12px;margin-top:24px}.save{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:9px 15px;cursor:pointer;font:inherit}.save:hover{background:var(--vscode-button-hoverBackground)}#status{font-size:12px;color:var(--vscode-descriptionForeground)}.warning{margin-top:18px;padding:10px;border-left:3px solid var(--vscode-editorWarning-foreground);background:var(--vscode-textBlockQuote-background);font-size:12px}
    @media(max-width:560px){.grid{grid-template-columns:1fr}.full{grid-column:auto}}
  </style></head><body>
    <div class="tabs" id="tabs" role="tablist"></div><h1>Startup configuration</h1><p class="intro" id="deployment"></p>
    <form id="form"><div class="grid">
      <label>Configuration type<select id="kind"></select><span class="hint">Runtime, service, database, or manual configuration.</span></label>
      <label>Runtime / service<select id="runtime"></select><span class="hint">Available options come from your hosting account.</span></label>
      <label>Runtime version<select id="runtimeVersion"></select></label>
      <label>Engine<input id="engine" placeholder="Optional engine"></label>
      <label class="full">Entry file<input id="entryFile" placeholder="index.js"></label>
      <label class="full">Start command<input id="startCommand" placeholder="node index.js"><span class="hint">Changing this configuration queues a rebuild.</span></label>
    </div><div class="warning">Saving changes rebuilds this deployment. Review the command before saving.</div><div class="footer"><button class="save" type="submit">Save startup configuration</button><span id="status"></span></div></form>
    <script>const vscode=acquireVsCodeApi(),initial=${data},sessions={},$=id=>document.getElementById(id),kind=$('kind'),runtime=$('runtime'),version=$('runtimeVersion'),entry=$('entryFile'),engine=$('engine'),command=$('startCommand'),status=$('status');let data=initial,active=initial.id;sessions[active]=initial;
      function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.appendChild(o)}
      function selectedGroup(){const groups={runtime:data.catalogs.runtimes||[],service:data.catalogs.services||[],database:data.catalogs.databases||[]};return groups[kind.value]||groups.runtime}
      function fillRuntime(){const old=runtime.value||data.config.runtime;runtime.innerHTML='';const items=selectedGroup();items.forEach(x=>option(runtime,x.id,x.label+' ('+x.id+')'));if(!items.some(x=>x.id===old))option(runtime,old,old+' (current)');runtime.value=old;fillVersions()}
      function fillVersions(){const old=version.value||data.config.runtimeVersion;const chosen=selectedGroup().find(x=>x.id===runtime.value);version.innerHTML='';(chosen&&chosen.versions||[]).forEach(v=>option(version,v,v));if(!Array.from(version.options).some(x=>x.value===old))option(version,old,old+' (current)');version.value=old;if(chosen&&chosen.defaultEntry&&!entry.value)entry.value=chosen.defaultEntry}
      function saveDraft(){data.config={kind:kind.value,runtime:runtime.value,runtimeVersion:version.value,entryFile:entry.value.trim(),startCommand:command.value.trim(),engine:engine.value.trim()}}
      function renderTabs(){const tabs=$('tabs');tabs.innerHTML='';Object.keys(sessions).forEach(id=>{const b=document.createElement('button');b.className='tab'+(id===active?' active':'');b.textContent=sessions[id].name;b.onclick=()=>open(id);tabs.appendChild(b)})}
      function render(){kind.innerHTML='';['runtime','service','database','manual'].forEach(x=>option(kind,x,x[0].toUpperCase()+x.slice(1)));if(!Array.from(kind.options).some(x=>x.value===data.config.kind))option(kind,data.config.kind,data.config.kind+' (current)');kind.value=data.config.kind||'runtime';entry.value=data.config.entryFile||'';engine.value=data.config.engine||'';command.value=data.config.startCommand||'';version.innerHTML='';runtime.innerHTML='';fillRuntime();$('deployment').textContent=data.name;status.textContent='';renderTabs()}
      function open(id){if(active)saveDraft();active=id;data=sessions[id];render()}kind.onchange=fillRuntime;runtime.onchange=fillVersions;render();
      $('form').onsubmit=e=>{e.preventDefault();saveDraft();status.textContent='Saving…';vscode.postMessage({type:'save',deploymentId:active,config:data.config})};
      window.addEventListener('message',e=>{const m=e.data;if(m.type==='open'){sessions[m.session.id]=m.session;open(m.session.id)}if(m.type==='saved'&&m.deploymentId===active){status.textContent='Saved - rebuild queued.'}if(m.type==='error'&&m.deploymentId===active){status.textContent='Error: '+m.error}});
    </script></body></html>`;
}

export function activate(context: vscode.ExtensionContext) {
  auth = new AuthManager(context.secrets, context.extensionPath);
  api = new BotHostingApi(function () { return auth.getToken(); });
  var savedConsoleFont = context.globalState.get<{ auto?: unknown; fontSize?: unknown }>("bb.consoleFontPreference");
  if (savedConsoleFont && typeof savedConsoleFont.auto === "boolean" && typeof savedConsoleFont.fontSize === "number" && Number.isFinite(savedConsoleFont.fontSize)) {
    consoleFontPreference = { auto: savedConsoleFont.auto, fontSize: Math.max(10, Math.min(22, Math.round(savedConsoleFont.fontSize))) };
  }

  fsProvider = new RemoteFileSystemProvider(api);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider("bh", fsProvider, { isCaseSensitive: true }));

  treeProvider = new ServerTreeProvider(api);
  var treeView = vscode.window.createTreeView("bbServers", { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);
  var remoteFileStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(remoteFileStatus);
  var updateRemoteFileStatus = function (editor: vscode.TextEditor | undefined) {
    if (!editor || editor.document.uri.scheme !== "bh") { remoteFileStatus.hide(); return; }
    var id = editor.document.uri.authority;
    var dep = treeProvider.getDeployment(id);
    remoteFileStatus.text = "$(server) " + (dep?.name || id);
    remoteFileStatus.tooltip = "This file belongs to the " + (dep?.name || id) + " deployment. Click to manage it.";
    remoteFileStatus.command = { command: "bb.openResources", title: "Manage deployment", arguments: [id] };
    remoteFileStatus.show();
  };
  updateRemoteFileStatus(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateRemoteFileStatus));
  context.subscriptions.push(treeView.onDidChangeVisibility(function (event) {
    vscode.commands.executeCommand("setContext", "bb:sidebarVisible", event.visible);
  }));
  context.subscriptions.push(treeView.onDidExpandElement(function (event) {
    if (event.element instanceof ServerItem) {
      console.log("[BB] onDidExpandElement: deployment=", event.element.deployment.id, event.element.deployment.name);
      vscode.commands.executeCommand("bb.openResources", { deploymentId: event.element.deployment.id, automatic: true });
      vscode.commands.executeCommand("bb.openConsole", event.element.deployment.id);
    }
  }));
  context.subscriptions.push(treeView.onDidChangeSelection(function (event) {
    var selected = event.selection[0] as any;
    var deploymentId = selected instanceof ServerItem ? selected.deployment.id : selected?.deploymentId;
    selectedDeploymentId = deploymentId;
    if (deploymentId) { context.globalState.update("bb.preferredDeployment", deploymentId); }
    vscode.commands.executeCommand("setContext", "bb:activeDeployment", !!deploymentId);
    if (deploymentId && !activeConsoleDeploymentId) { vscode.commands.executeCommand("bb.openConsole", deploymentId); }
  }));
  vscode.commands.executeCommand("setContext", "bb:sidebarVisible", treeView.visible);
  vscode.commands.executeCommand("setContext", "bb:activeDeployment", false);

  context.subscriptions.push(vscode.window.registerWebviewViewProvider("bbConsolePanel", {
    resolveWebviewView: function (view) {
      consoleBottomView = view;
      view.title = activeConsoleDeploymentId ? activeConsoleName + " (Console)" : "Console";
      view.webview.options = { enableScripts: true };
      var timer: ReturnType<typeof setInterval> | undefined;
      var polling = false;
      var render = function () {
        view.webview.html = getRebuiltConsoleHtml(activeConsoleDeploymentId ? activeConsoleName : "");
      };
      var poll = async function (force?: boolean) {
        if (!activeConsoleDeploymentId || polling) return;
        if (!force && !view.visible) return;
        polling = true;
        try { var logs = await api.getLogs(activeConsoleDeploymentId, 500); view.webview.postMessage({ type: "logs", lines: logs.lines }); view.webview.postMessage({ type: "connectionState", name: activeConsoleName, state: "connected" }); }
        catch (err: any) { view.webview.postMessage({ type: "logError", error: err.message }); view.webview.postMessage({ type: "connectionState", name: activeConsoleName, state: "disconnected" }); }
        finally { polling = false; }
      };
      view.webview.onDidReceiveMessage(async function (msg) {
        console.log("[BB] Console webview msg:", msg.type, msg.type === "sendCommand" ? "command=" + msg.command : "");
        if (msg.type === "ready") {
          console.log("[BB] Console ready, activeConsoleDeploymentId=", activeConsoleDeploymentId, "activeConsoleName=", activeConsoleName);
          poll(true);
          view.webview.postMessage({ type: "connectionState", name: activeConsoleName, state: "reconnecting" });
        }
        if (msg.type === "pollLogs") {
          poll();
        }
        if (msg.type === "fontSettings") {
          var setting = msg.settings;
          if (setting && typeof setting.auto === "boolean" && typeof setting.fontSize === "number" && Number.isFinite(setting.fontSize)) {
            consoleFontPreference = { auto: setting.auto, fontSize: Math.max(10, Math.min(22, Math.round(setting.fontSize))) };
            void context.globalState.update("bb.consoleFontPreference", consoleFontPreference);
          }
        }
        if (msg.type === "sendCommand") {
          var command = typeof msg.command === "string" ? msg.command.trim() : "";
          var commandDeploymentId = activeConsoleDeploymentId;
          console.log("[BB] sendCommand: deploymentId=", commandDeploymentId, "command=", command);
          if (!commandDeploymentId) { console.log("[BB] sendCommand BLOCKED: no activeConsoleDeploymentId"); view.webview.postMessage({ type: "cmdError", error: "Select a deployment before sending a command." }); return; }
          if (!command) { console.log("[BB] sendCommand BLOCKED: empty command"); view.webview.postMessage({ type: "cmdError", error: "Enter a command." }); return; }
          view.webview.postMessage({ type: "cmdSending" });
          try {
            console.log("[BB] sendCommand calling api.sendCommand...");
            await api.sendCommand(commandDeploymentId, command);
            console.log("[BB] sendCommand SUCCESS");
            view.webview.postMessage({ type: "cmdAccepted", message: "Command accepted by the server. Waiting for output…" });
            view.webview.postMessage({ type: "cmdSent" });
            view.webview.postMessage({ type: "connectionState", name: activeConsoleName, state: "connected" });
            [1000, 2000, 3500, 5000, 7500, 10000].forEach(function (delay) {
              setTimeout(function () {
                if (activeConsoleDeploymentId === commandDeploymentId) poll(true);
              }, delay);
            });
          } catch (err: any) {
            console.log("[BB] sendCommand ERROR:", err.message);
            view.webview.postMessage({ type: "cmdError", error: err.message });
            view.webview.postMessage({ type: "connectionState", name: activeConsoleName, state: "disconnected" });
          }
        }
      });
      render();
      timer = setInterval(poll, 10000);
      view.onDidChangeVisibility(function () { if (view.visible) poll(true); });
      view.onDidDispose(function () { if (timer) clearInterval(timer); if (consoleBottomView === view) consoleBottomView = undefined; });
      (view as any).bbRender = render;
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.connect", async function () {
    try { await auth.loginOAuth(); await updateConnectedContext(); vscode.window.showInformationMessage("Connected via OAuth!"); treeProvider.refresh(); }
    catch (err: any) { vscode.window.showErrorMessage("Connection failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.connectApiKey", async function () {
    try { await auth.loginApiKey(); await updateConnectedContext(); vscode.window.showInformationMessage("Connected via API key!"); treeProvider.refresh(); }
    catch (err: any) { vscode.window.showErrorMessage("Connection failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.manageConnection", async function () {
    var method = await auth.getAuthMethod();
    var options: string[] = [];
    if (method === "oauth") { options = ["Revoke & Reconnect (OAuth)", "Switch to API Key", "Disconnect"]; }
    else if (method === "apikey") { options = ["Replace API Key", "Switch to OAuth", "Disconnect"]; }
    else { options = ["Connect via OAuth", "Connect via API Key"]; }
    var picked = await vscode.window.showQuickPick(options, { placeHolder: "Manage connection (" + (method || "not connected") + ")" });
    if (!picked) return;
    try {
      if (picked.indexOf("Revoke") !== -1 || picked.indexOf("Switch to OAuth") !== -1 || picked.indexOf("Connect via OAuth") !== -1) { await auth.logout(); await auth.loginOAuth(); }
      else if (picked.indexOf("Switch to API") !== -1 || picked.indexOf("Replace") !== -1 || picked.indexOf("Connect via API") !== -1) { await auth.logout(); await auth.loginApiKey(); }
      else if (picked === "Disconnect") { await auth.logout(); }
      await updateConnectedContext(); treeProvider.refresh(); vscode.window.showInformationMessage("Connection updated.");
    } catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.disconnect", async function () {
    await auth.logout(); await updateConnectedContext(); treeProvider.refresh(); vscode.window.showInformationMessage("Disconnected.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.reAuthenticate", async function () {
    var choice = await vscode.window.showWarningMessage("Session expired. Re-authenticate?", "Yes", "Cancel");
    if (choice !== "Yes") return;
    try { var method = await auth.getAuthMethod(); if (method === "oauth") { await auth.loginOAuth(); } else { await auth.loginApiKey(); } await updateConnectedContext(); treeProvider.refresh(); }
    catch (err: any) { vscode.window.showErrorMessage("Re-auth failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.refresh", function () { treeProvider.refresh(); }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.touchRefresh", function () { vscode.commands.executeCommand("bb.refresh"); }));
  context.subscriptions.push(vscode.commands.registerCommand("bb.touchSearch", function () { vscode.commands.executeCommand("bb.searchFiles"); }));
  context.subscriptions.push(vscode.commands.registerCommand("bb.touchStart", function () { if (selectedDeploymentId) vscode.commands.executeCommand("bb.powerStart", selectedDeploymentId); }));
  context.subscriptions.push(vscode.commands.registerCommand("bb.touchStop", function () { if (selectedDeploymentId) vscode.commands.executeCommand("bb.powerStop", selectedDeploymentId); }));
  context.subscriptions.push(vscode.commands.registerCommand("bb.touchRestart", function () { if (selectedDeploymentId) vscode.commands.executeCommand("bb.powerRestart", selectedDeploymentId); }));
  context.subscriptions.push(vscode.commands.registerCommand("bb.touchConsole", async function () {
    var dep = selectedDeploymentId ? treeProvider.getDeployment(selectedDeploymentId) : await pickDeployment(); if (!dep) return;
    vscode.commands.executeCommand("bb.openConsole", dep.id);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("bb.touchResources", async function () {
    var dep = selectedDeploymentId ? treeProvider.getDeployment(selectedDeploymentId) : await pickDeployment(); if (!dep) return;
    vscode.commands.executeCommand("bb.openResources", dep.id);
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.openFile", async function (item: FileItem) {
    if (!item || item.file.type !== "file") return;
    var path = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name;
    var uri = vscode.Uri.parse("bh://" + item.deploymentId + path);
    try { var doc = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(doc, { preview: false, viewColumn: preferredFileViewColumn() }); }
    catch (err: any) { vscode.window.showErrorMessage("Failed to open: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.renameFile", async function (item: FileItem) {
    if (!item) return;
    var newName = await vscode.window.showInputBox({ prompt: "Rename " + item.file.name, value: item.file.name, validateInput: function (value) { return !value || value.includes("/") ? "Enter a name without /" : null; } });
    if (!newName || newName === item.file.name) return;
    try { await api.renameFile(item.deploymentId, item.parentPath, item.file.name, newName); treeProvider.refresh(); vscode.window.showInformationMessage("Renamed to " + newName); }
    catch (err: any) { vscode.window.showErrorMessage("Rename failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.duplicateFile", async function (item: FileItem) {
    if (!item || item.file.type !== "file") return;
    var location = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name;
    try { await api.copyFile(item.deploymentId, location); treeProvider.refresh(); vscode.window.showInformationMessage("Created a copy of " + item.file.name); }
    catch (err: any) { vscode.window.showErrorMessage("Duplicate failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.uploadFile", async function (item?: any) {
    var deploymentId: string | undefined;
    var parentPath = "/";
    if (item instanceof SectionItem && item.sectionName === "Files") { deploymentId = item.deploymentId; }
    else if (item instanceof FileItem && item.file.type === "directory") { deploymentId = item.deploymentId; parentPath = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name; }
    else if (item?.deployment?.id) { deploymentId = item.deployment.id; }
    if (!deploymentId) { var dep = await pickDeployment(); deploymentId = dep?.id; }
    if (!deploymentId) return;
    var selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, title: "Upload text file to deployment" });
    if (!selected?.[0]) return;
    try {
      var bytes = await vscode.workspace.fs.readFile(selected[0]);
      if (bytes.byteLength > MAX_TEXT_UPLOAD_BYTES) {
        throw new Error("This file is " + Math.ceil(bytes.byteLength / (1024 * 1024)) + " MiB. Uploads are limited to 50 MiB.");
      }
      var content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      var target = parentPath === "/" ? "/" + selected[0].path.split("/").pop() : parentPath + "/" + selected[0].path.split("/").pop();
      await api.writeFile(deploymentId, target, content);
      treeProvider.refresh();
      vscode.window.showInformationMessage("Uploaded " + target);
    } catch (err: any) {
      vscode.window.showErrorMessage(err instanceof TypeError ? "Only UTF-8 text files can be uploaded; this API does not expose binary upload." : "Upload failed: " + err.message);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.downloadFile", async function (item: FileItem) {
    if (!item || item.file.type !== "file") return;
    var path = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name;
    try { var result = await api.getDownloadUrl(item.deploymentId, path); await vscode.env.openExternal(vscode.Uri.parse(result.url)); }
    catch (err: any) { vscode.window.showErrorMessage("Download failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.saveFile", async function () {
    var editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.uri.scheme.startsWith("bh")) { vscode.window.showWarningMessage("No remote file active."); return; }
    await editor.document.save(); vscode.window.showInformationMessage("Saved to server.");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.deleteFile", async function (item: FileItem) {
    if (!item) return;
    var confirm = await vscode.window.showWarningMessage("Delete \"" + item.file.name + "\"?", "Delete", "Cancel");
    if (confirm !== "Delete") return;
    try { await api.deleteFile(item.deploymentId, item.parentPath, [item.file.name]); treeProvider.refresh(); vscode.window.showInformationMessage("Deleted " + item.file.name); }
    catch (err: any) { vscode.window.showErrorMessage("Delete failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.createFile", async function (item?: any) {
    var deploymentId: string; var parentPath: string;
    if (item instanceof SectionItem && item.sectionName === "Files") { deploymentId = item.deploymentId; parentPath = "/"; }
    else if (item instanceof FileItem && item.file.type === "directory") { deploymentId = item.deploymentId; parentPath = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name; }
    else if (item && item.deployment) { deploymentId = item.deployment.id; parentPath = "/"; }
    else { vscode.window.showWarningMessage("Select a server or directory."); return; }
    var name = await vscode.window.showInputBox({ prompt: "File name", placeHolder: "index.js" });
    if (!name) return;
    try { await api.writeFile(deploymentId, parentPath === "/" ? "/" + name : parentPath + "/" + name, ""); treeProvider.refresh(); vscode.window.showInformationMessage("Created: " + name); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.createFolder", async function (item?: any) {
    var deploymentId: string; var parentPath: string;
    if (item instanceof SectionItem && item.sectionName === "Files") { deploymentId = item.deploymentId; parentPath = "/"; }
    else if (item instanceof FileItem && item.file.type === "directory") { deploymentId = item.deploymentId; parentPath = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name; }
    else if (item && item.deployment) { deploymentId = item.deployment.id; parentPath = "/"; }
    else { vscode.window.showWarningMessage("Select a server or directory."); return; }
    var name = await vscode.window.showInputBox({ prompt: "Folder name", placeHolder: "new-folder" });
    if (!name) return;
    try { await api.createFolder(deploymentId, parentPath, name); treeProvider.refresh(); vscode.window.showInformationMessage("Created: " + name); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.compressFiles", async function (item: any) {
    if (!item?.deployment) return;
    try { var result = await api.compressFiles(item.deployment.id, "/", []); vscode.window.showInformationMessage("Archive: " + result.archive); treeProvider.refresh(); }
    catch (err: any) { vscode.window.showErrorMessage("Compress failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.decompressFile", async function (item: FileItem) {
    if (!item) return;
    var path = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name;
    try { await api.decompressFile(item.deploymentId, item.parentPath, item.file.name); treeProvider.refresh(); vscode.window.showInformationMessage("Decompressed " + item.file.name); }
    catch (err: any) { vscode.window.showErrorMessage("Decompress failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.powerAction", async function (item: any) {
    if (!item?.deployment) return;
    var action = await vscode.window.showQuickPick(["start", "stop", "restart", "kill"], { placeHolder: "Select action" });
    if (!action) return;
    try { await api.powerAction(item.deployment.id, action as any); vscode.window.showInformationMessage("Sent: " + action); setTimeout(function () { treeProvider.refresh(); }, 2000); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.powerStart", async function (deploymentId?: string) {
    var dep = deploymentId ? treeProvider.getDeployment(deploymentId) : await pickDeployment(); if (!dep) return;
    try { await api.powerAction(dep.id, "start"); vscode.window.showInformationMessage("Starting " + dep.name); setTimeout(function () { treeProvider.refresh(); }, 2000); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.powerStop", async function (deploymentId?: string) {
    var dep = deploymentId ? treeProvider.getDeployment(deploymentId) : await pickDeployment(); if (!dep) return;
    try { await api.powerAction(dep.id, "stop"); vscode.window.showInformationMessage("Stopping " + dep.name); setTimeout(function () { treeProvider.refresh(); }, 2000); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.powerRestart", async function (deploymentId?: string) {
    var dep = deploymentId ? treeProvider.getDeployment(deploymentId) : await pickDeployment(); if (!dep) return;
    try { await api.powerAction(dep.id, "restart"); vscode.window.showInformationMessage("Restarting " + dep.name); setTimeout(function () { treeProvider.refresh(); }, 2000); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.editEnv", async function (item: EnvItem) {
    if (!item) return;
    var newVal = await vscode.window.showInputBox({ prompt: "Edit " + item.envVar.key, value: item.envVar.secret ? "" : item.envVar.value, password: item.envVar.secret });
    if (newVal === undefined) return;
    try { await api.updateEnv(item.deploymentId, item.envVar.key, undefined, newVal); treeProvider.refresh(); vscode.window.showInformationMessage("Updated " + item.envVar.key); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.addEnv", async function (item?: any) {
    var deploymentId: string;
    if (item instanceof SectionItem) { deploymentId = item.deploymentId; }
    else if (item && item.deployment) { deploymentId = item.deployment.id; }
    else { vscode.window.showWarningMessage("Select a server."); return; }
    var key = await vscode.window.showInputBox({ prompt: "Variable name", placeHolder: "MY_VAR" });
    if (!key) return;
    var val = await vscode.window.showInputBox({ prompt: "Value for " + key });
    if (val === undefined) return;
    var secretPick = await vscode.window.showQuickPick(["No", "Yes"], { placeHolder: "Secret?" });
    try { await api.setEnv(deploymentId, key, val, secretPick === "Yes"); treeProvider.refresh(); vscode.window.showInformationMessage("Added " + key); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.deleteEnv", async function (item: EnvItem) {
    if (!item || item.envVar.system) { vscode.window.showWarningMessage("Cannot delete system variables."); return; }
    var confirm = await vscode.window.showWarningMessage("Delete \"" + item.envVar.key + "\"?", "Delete", "Cancel");
    if (confirm !== "Delete") return;
    try { await api.deleteEnv(item.deploymentId, item.envVar.key); treeProvider.refresh(); vscode.window.showInformationMessage("Deleted " + item.envVar.key); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.editStartup", async function (item: any) {
    var deploymentId = item?.deploymentId || item?.deployment?.id;
    if (!deploymentId) return;
    try {
      var config = await api.getStartup(deploymentId);
      var catalogs;
      try { catalogs = await api.listRuntimes(); }
      catch (_e) { catalogs = { runtimes: [], services: [], databases: [] }; }
      var dep = treeProvider.getDeployment(deploymentId);
      var session = { id: deploymentId, name: dep?.name || deploymentId, config: config, catalogs: catalogs };
      if (startupPanel) {
        startupPanel.reveal();
        startupPanel.webview.postMessage({ type: "open", session: session });
        return;
      }
      var panel = vscode.window.createWebviewPanel("bbStartup", "Startup Configurations", preferredToolViewColumn("bbStartup") || vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
      startupPanel = panel;
      panel.webview.html = getStartupHtml(session);
      panel.webview.onDidReceiveMessage(async function (message) {
        if (message.type !== "save" || !message.config) return;
        try {
          var next = message.config as StartupConfig;
          if (!next.runtime || !next.runtimeVersion) throw new Error("Runtime and version are required.");
          await api.updateStartup(message.deploymentId, next);
          treeProvider.refresh();
          panel.webview.postMessage({ type: "saved", deploymentId: message.deploymentId });
        } catch (err: any) {
          panel.webview.postMessage({ type: "error", deploymentId: message.deploymentId, error: err.message || "Could not save startup configuration." });
        }
      });
      panel.onDidDispose(function () { startupPanel = undefined; });
    } catch (err: any) { vscode.window.showErrorMessage("Could not load startup configuration: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.addPackage", async function (arg: any) {
    var deploymentId: string;
    if (typeof arg === "string") { deploymentId = arg; }
    else if (arg && typeof arg === "object" && arg.deploymentId) { deploymentId = arg.deploymentId; }
    else if (arg && typeof arg === "object" && arg.deployment) { deploymentId = arg.deployment.id; }
    else { var dep = await pickDeployment(); if (!dep) return; deploymentId = dep.id; }
    var manager = await inferPackageManager(deploymentId);
    if (!manager) {
      manager = await vscode.window.showQuickPick(["npm", "pip"], { placeHolder: "Could not detect the server runtime" }) as "npm" | "pip" | undefined;
      if (!manager) return;
    }
    var name = await vscode.window.showInputBox({ prompt: "Package name", placeHolder: manager === "pip" ? "discord.py" : "discord.js" });
    if (!name) return;
    var spec = await vscode.window.showInputBox({ prompt: "Version spec (optional)", placeHolder: "latest" });
    try { await api.addPackage(deploymentId, manager, name, spec || undefined); treeProvider.refresh(); vscode.window.showInformationMessage("Added " + name); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.removePackage", async function (item: PackageItem) {
    if (!item) return;
    var confirm = await vscode.window.showWarningMessage("Remove " + item.pkg.name + "?", "Remove", "Cancel");
    if (confirm !== "Remove") return;
    try { await api.removePackage(item.deploymentId, item.manager, item.pkg.name); treeProvider.refresh(); vscode.window.showInformationMessage("Removed " + item.pkg.name); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.createBackup", async function (arg: any) {
    var deploymentId: string;
    if (typeof arg === "string") { deploymentId = arg; }
    else if (arg && typeof arg === "object" && arg.deploymentId) { deploymentId = arg.deploymentId; }
    else if (arg && typeof arg === "object" && arg.deployment) { deploymentId = arg.deployment.id; }
    else { var dep = await pickDeployment(); if (!dep) return; deploymentId = dep.id; }
    if (backupsInProgress.has(deploymentId)) {
      vscode.window.showInformationMessage("A backup is already being created for this deployment.");
      return;
    }
    backupsInProgress.add(deploymentId);
    treeProvider.setBackupCreating(deploymentId, true);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Creating backup", cancellable: true }, async function (progress, cancellation) {
        progress.report({ message: "Requesting backup…" });
        var result = await api.createBackup(deploymentId);
        treeProvider.refresh();
        progress.report({ message: "Backup queued (" + result.backupId + ")" });
        var backup;
        for (var attempt = 0; attempt < 100 && !cancellation.isCancellationRequested; attempt++) {
          await new Promise(function (resolve) { setTimeout(resolve, 3000); });
          try { backup = await api.getBackup(result.backupId); }
          catch (_e) { continue; }
          var status = (backup.status || "").toLowerCase();
          progress.report({ message: "Status: " + (backup.status || "processing") });
          if (status === "active" || status === "completed") {
            vscode.window.showInformationMessage("Backup ready: " + backup.label + " (" + result.backupId + ")");
            return;
          }
          if (status === "failed" || status === "error" || status === "cancelled") {
            throw new Error("Backup " + (backup.status || "failed") + ".");
          }
        }
        if (cancellation.isCancellationRequested) { vscode.window.showInformationMessage("Backup is still running; its status remains visible in Backups."); }
        else { vscode.window.showWarningMessage("Backup is still processing. Check the Backups section for its status."); }
      });
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 502 || err.status === 503 || err.status === 504)) {
        vscode.window.showWarningMessage("The backup request timed out at Bot-Hosting. It may still have been acceptedrefresh Backups before trying again to avoid duplicates.");
      } else {
        vscode.window.showErrorMessage("Backup failed: " + err.message);
      }
    }
    finally {
      backupsInProgress.delete(deploymentId);
      treeProvider.setBackupCreating(deploymentId, false);
      treeProvider.refresh();
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.restoreBackup", async function (item: BackupItem) {
    if (!item) return;
    var backup = item.backup;
    var details = "Restore “" + (backup.label || backup.id) + "” (" + backup.fileCount + " files, " + backup.sizeBytes + " bytes, created " + backup.createdAt + ")? This permanently overwrites the deployment’s current files and starts it afterward.";
    var confirm = await vscode.window.showWarningMessage(details, { modal: true }, "Restore", "Cancel");
    if (confirm !== "Restore") return;
    try { await api.restoreBackup(item.backup.id, item.backup.deploymentId, true); vscode.window.showInformationMessage("Restore started."); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.deleteBackup", async function (item: BackupItem) {
    if (!item) return;
    var confirm = await vscode.window.showWarningMessage("Delete backup?", "Delete", "Cancel");
    if (confirm !== "Delete") return;
    try { await api.deleteBackup(item.backup.id); treeProvider.refresh(); vscode.window.showInformationMessage("Deleted."); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.openConsole", async function (arg: string | { deploymentId: string } | any) {
    var deploymentId: string;
    if (typeof arg === "string") { deploymentId = arg; }
    else if (arg && typeof arg === "object" && arg.deploymentId) { deploymentId = arg.deploymentId; }
    else if (arg && typeof arg === "object" && arg.deployment) { deploymentId = arg.deployment.id; }
    else { var dep = await pickDeployment(); if (!dep) return; deploymentId = dep.id; }
    var dep = treeProvider.getDeployment(deploymentId);
    var name = dep ? dep.name : deploymentId;
    console.log("[BB] openConsole: deploymentId=", deploymentId, "name=", name, "consoleBottomView exists?", !!consoleBottomView);
    activeConsoleDeploymentId = deploymentId;
    activeConsoleName = name;
    await vscode.commands.executeCommand("workbench.view.extension.bbPanel");
    if (consoleBottomView) {
      console.log("[BB] openConsole: rendering console view");
      consoleBottomView.title = name + " (Console)";
      consoleBottomView.show();
      (consoleBottomView as any).bbRender();
    } else {
      console.log("[BB] openConsole: consoleBottomView not ready, scheduling fallback");
      setTimeout(function () {
        if (consoleBottomView) { console.log("[BB] openConsole: fallback render"); consoleBottomView.title = name + " (Console)"; consoleBottomView.show(); (consoleBottomView as any).bbRender(); }
        else { console.log("[BB] openConsole: fallback FAILED - consoleBottomView still null"); }
      }, 250);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("bb.sendCommand", async function (arg: any) {
    var deploymentId: string;
    if (typeof arg === "string") { deploymentId = arg; }
    else if (arg && typeof arg === "object" && arg.deploymentId) { deploymentId = arg.deploymentId; }
    else if (arg && typeof arg === "object" && arg.deployment) { deploymentId = arg.deployment.id; }
    else { var dep = await pickDeployment(); if (!dep) return; deploymentId = dep.id; }
    var cmd = await vscode.window.showInputBox({ prompt: "Command to send" });
    if (!cmd) return;
    try { await api.sendCommand(deploymentId, cmd); vscode.window.showInformationMessage("Command sent."); }
    catch (err: any) { vscode.window.showErrorMessage("Failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.openResources", async function (arg: any) {
    var automatic = !!arg?.automatic;
    var deploymentId: string;
    if (typeof arg === "string") { deploymentId = arg; }
    else if (arg && typeof arg === "object" && arg.deploymentId) { deploymentId = arg.deploymentId; }
    else if (arg && typeof arg === "object" && arg.deployment) { deploymentId = arg.deployment.id; }
    else { var dep = await pickDeployment(); if (!dep) return; deploymentId = dep.id; }
    var dep = treeProvider.getDeployment(deploymentId);
    var name = dep ? dep.name : deploymentId;
    console.log("[BB] openResources: deploymentId=", deploymentId, "name=", name, "automatic=", automatic);
    if (automatic && automaticManagePanel) {
      if ((automaticManagePanel as any).bbDeploymentId === deploymentId) { automaticManagePanel.reveal(); return; }
      automaticManagePanel.dispose();
    }
    if (!automatic && resourcePanels.has(deploymentId)) {
      var existing = resourcePanels.get(deploymentId)!;
      if (existing !== automaticManagePanel) { existing.reveal(); return; }
      existing.dispose();
    }
    var panel = vscode.window.createWebviewPanel("bbResources", "Manage: " + name, preferredToolViewColumn("bbResources") || vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    (panel as any).bbDeploymentId = deploymentId;
    if (automatic) automaticManagePanel = panel;
    panel.webview.html = getRebuiltResourceHtml(name);
    var pollTimer: ReturnType<typeof setInterval> | undefined;
    var polling = false;
    var ready = false;
    panel.webview.onDidReceiveMessage(async function (msg) {
      console.log("[BB] Resource panel msg:", msg.type, "deploymentId=", deploymentId);
      if (msg.type === "ready") {
        if (ready) { console.log("[BB] Resource panel ready SKIPPED (already ready)"); return; }
        ready = true;
        console.log("[BB] Resource panel ready - hydrating deployment/resources/git");
        pollResources();
        hydratePanel();
        pollTimer = setInterval(pollResources, 10000);
      }
      if (msg.type === "power") {
        try {
          await api.powerAction(deploymentId, msg.action);
          var stateLabel = msg.action === "start" ? "starting" : msg.action === "stop" ? "stopping" : "starting";
          panel.webview.postMessage({ type: "powerResult", message: "Sent " + msg.action + ".", state: stateLabel });
          setTimeout(async function () {
            try {
              var fresh = await api.getResources(deploymentId);
              panel.webview.postMessage({ type: "powerResult", message: "Sent " + msg.action + ".", state: fresh.state });
            } catch (refreshErr: any) {
              panel.webview.postMessage({ type: "powerResult", message: "Power action sent, but status refresh failed: " + actionErrorMessage(refreshErr) });
            }
            pollResources();
          }, 2000);
        } catch (err: any) {
          panel.webview.postMessage({ type: "powerResult", message: "Error: " + actionErrorMessage(err) });
        }
      }
      if (msg.type === "deploymentUpdate") {
        try { var updated = await api.updateDeployment(deploymentId, msg.name || undefined, msg.description || undefined); panel.webview.postMessage({ type: "deployment", data: updated }); treeProvider.refresh(); panel.webview.postMessage({ type: "powerResult", message: "Deployment details saved." }); }
        catch (err: any) { panel.webview.postMessage({ type: "powerResult", message: "Error: " + err.message }); }
      }
      if (msg.type === "resize") {
        var ramMB = Number(msg.ramMB), cpuPct = Number(msg.cpuPct), storageMB = Number(msg.storageMB);
        if (!Number.isInteger(ramMB) || ramMB < 1 || !Number.isInteger(cpuPct) || cpuPct < 1 || !Number.isInteger(storageMB) || storageMB < 1) {
          panel.webview.postMessage({ type: "powerResult", message: "Error: RAM, CPU, and storage must be positive whole numbers." });
          return;
        }
        try {
          var resized = await api.resize(deploymentId, ramMB, cpuPct, storageMB);
          panel.webview.postMessage({ type: "deployment", data: resized });
          panel.webview.postMessage({ type: "powerResult", message: "Allocation updated." });
          treeProvider.refresh();
          setTimeout(pollResources, 1000);
        } catch (err: any) { panel.webview.postMessage({ type: "powerResult", message: "Error: " + err.message }); }
      }
      if (msg.type === "autoPull") {
        if (typeof msg.autoPull !== "boolean") { panel.webview.postMessage({ type: "powerResult", message: "Error: Invalid Git auto-pull setting." }); return; }
        try {
          var git = await api.setAutoPull(deploymentId, msg.autoPull);
          panel.webview.postMessage({ type: "git", data: git });
          panel.webview.postMessage({ type: "powerResult", message: "Git auto-pull " + (git.autoPull ? "enabled." : "disabled.") });
        } catch (err: any) { panel.webview.postMessage({ type: "powerResult", message: "Error: " + err.message }); }
      }
      if (msg.type === "slugUpdate") {
        try {
          if (msg.slug) await api.setSlug(deploymentId, msg.slug);
          else await api.removeSlug(deploymentId);
          var updated = await api.getDeployment(deploymentId);
          panel.webview.postMessage({ type: "deployment", data: updated }); treeProvider.refresh(); panel.webview.postMessage({ type: "powerResult", message: "Domain alias updated." });
        } catch (err: any) { panel.webview.postMessage({ type: "powerResult", message: "Error: " + err.message }); }
      }
      if (msg.type === "enableDomains" || msg.type === "customDomain" || msg.type === "verifyCustomDomain" || msg.type === "removeCustomDomain") {
        try {
          var message = "";
          if (msg.type === "enableDomains") { var enabled = await api.enableDomains(deploymentId); message = "Hosting domain enabled: " + enabled.subdomain; }
          if (msg.type === "customDomain") { if (!msg.domain) throw new Error("Enter a custom domain first."); var custom = await api.setCustomDomain(deploymentId, msg.domain); message = "Custom domain set. Add the DNS token: " + custom.token; }
          if (msg.type === "verifyCustomDomain") { var verify = await api.verifyCustomDomain(deploymentId); message = verify.verified ? "Custom domain verified." : "Not verified" + (verify.reason ? ": " + verify.reason : "."); }
          if (msg.type === "removeCustomDomain") { await api.removeCustomDomain(deploymentId); message = "Custom domain removed."; }
          var refreshed = await api.getDeployment(deploymentId);
          panel.webview.postMessage({ type: "deployment", data: refreshed });
          panel.webview.postMessage({ type: "powerResult", message: message });
          treeProvider.refresh();
        } catch (err: any) { panel.webview.postMessage({ type: "powerResult", message: "Error: " + err.message }); }
      }
    });
    var authFailed = false;
    async function pollResources() {
      if (polling) { console.log("[BB] pollResources SKIPPED: request already in flight"); return; }
      polling = true;
      console.log("[BB] pollResources: fetching for", deploymentId);
      try {
        var data = await api.getResources(deploymentId);
        console.log("[BB] pollResources SUCCESS: state=", data.state);
        panel.webview.postMessage({ type: "resources", data: data });
        if (authFailed) {
          authFailed = false;
          if (!pollTimer) { pollTimer = setInterval(pollResources, 10000); }
        }
      } catch (err: any) {
        console.log("[BB] pollResources ERROR:", err.message);
        panel.webview.postMessage({ type: "powerResult", message: "Resource error: " + err.message });
        if (err.message && err.message.indexOf("expired") !== -1) {
          panel.webview.postMessage({ type: "authError" });
          authFailed = true;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
        }
      } finally { polling = false; }
    }
    async function hydratePanel() {
      console.log("[BB] hydratePanel: fetching deployment/resources/git for", deploymentId);
      var results = await Promise.allSettled([
        api.getDeployment(deploymentId),
        api.getResources(deploymentId),
        api.getGit(deploymentId),
      ]);
      var details = results[0];
      var resources = results[1];
      var git = results[2];
      if (details.status === "fulfilled") panel.webview.postMessage({ type: "deployment", data: details.value });
      else panel.webview.postMessage({ type: "deploymentError", error: details.reason?.message || "Deployment details unavailable" });
      if (resources.status === "fulfilled") panel.webview.postMessage({ type: "resources", data: resources.value });
      else panel.webview.postMessage({ type: "powerResult", message: "Resource error: " + (resources.reason?.message || "Unavailable") });
      if (git.status === "fulfilled") panel.webview.postMessage({ type: "git", data: git.value });
      else panel.webview.postMessage({ type: "powerResult", message: "Git settings unavailable: " + (git.reason?.message || "Unavailable") });
    }

    async function loadDetails() {
      console.log("[BB] loadDetails: starting for", deploymentId);
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          console.log("[BB] loadDetails: getDeployment attempt", attempt + 1);
          var details = await api.getDeployment(deploymentId);
          console.log("[BB] loadDetails: getDeployment SUCCESS, name=", details.name, "state=", details.state);
          panel.webview.postMessage({ type: "deployment", data: details });
          break;
        } catch (err: any) {
          console.log("[BB] loadDetails: getDeployment attempt", attempt + 1, "FAILED:", err.message);
          if (attempt === 2) {
            panel.webview.postMessage({ type: "deploymentError", error: err.message });
          } else {
            await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
          }
        }
      }
      for (var gitAttempt = 0; gitAttempt < 2; gitAttempt++) {
        try {
          console.log("[BB] loadDetails: getGit attempt", gitAttempt + 1);
          var git = await api.getGit(deploymentId);
          console.log("[BB] loadDetails: getGit SUCCESS");
          panel.webview.postMessage({ type: "git", data: git });
          break;
        } catch (err: any) {
          console.log("[BB] loadDetails: getGit attempt", gitAttempt + 1, "FAILED:", err.message);
          if (gitAttempt === 1) {
            panel.webview.postMessage({ type: "powerResult", message: "Git settings unavailable: " + err.message });
          } else {
            await new Promise(function (r) { setTimeout(r, 1500); });
          }
        }
      }
    }
    panel.onDidDispose(function () {
      if (resourcePanels.get(deploymentId) === panel) resourcePanels.delete(deploymentId);
      if (automaticManagePanel === panel) automaticManagePanel = undefined;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    });
    panel.onDidChangeViewState(function (event) {
      if (event.webviewPanel.visible) {
        pollResources();
        if (!pollTimer) { pollTimer = setInterval(pollResources, 10000); }
      }
    });
    resourcePanels.set(deploymentId, panel);
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.syncDeployment", async function (item: any) {
    var deploymentId = item?.deploymentId || item?.deployment?.id;
    if (!deploymentId) return;
    try { var result = await api.syncDeployment(deploymentId); vscode.window.showInformationMessage("Synced. Commit: " + result.commit); treeProvider.refresh(); }
    catch (err: any) { vscode.window.showErrorMessage("Sync failed: " + err.message); }
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.searchFiles", async function () {
    var deployments = treeProvider.getDeploymentList();
    if (!deployments || deployments.length === 0) { vscode.window.showWarningMessage("No deployments loaded."); return; }
    var owned = deployments.filter(function (d) { return d.owned; });
    var shared = deployments.filter(function (d) { return !d.owned; });
    var scopeItems: { label: string; description: string; _deps: typeof deployments }[] = [];
    if (owned.length > 0) { scopeItems.push({ label: "$(globe) All owned (" + owned.length + ")", description: "Search your deployments", _deps: owned }); }
    if (shared.length > 0) { scopeItems.push({ label: "$(organization) All shared (" + shared.length + ")", description: "Search shared with you", _deps: shared }); }
    scopeItems.push({ label: "$(layers) All (" + deployments.length + ")", description: "Search everything", _deps: deployments });
    for (var i = 0; i < deployments.length; i++) {
      scopeItems.push({ label: "$(server) " + deployments[i].name, description: deployments[i].owned ? "owned" : "shared", _deps: [deployments[i]] });
    }
    var scopePick = await vscode.window.showQuickPick(scopeItems.map(function (s) { return { label: s.label, description: s.description }; }), { placeHolder: "Search scope" });
    if (!scopePick) return;
    var matched = scopeItems.find(function (s) { return s.label === scopePick!.label; });
    var targetDeployments = matched ? matched._deps : deployments;
    var allFiles: { deploymentId: string; deploymentName: string; path: string; name: string }[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Loading file list…", cancellable: true }, async function (progress, cancellation) {
      for (var i = 0; i < targetDeployments.length; i++) {
        if (cancellation.isCancellationRequested) break;
        progress.report({ message: targetDeployments[i].name });
        try {
          var files = await getAllFilesRecursive(api, targetDeployments[i].id, "/");
          for (var f = 0; f < files.length; f++) {
            allFiles.push({ deploymentId: targetDeployments[i].id, deploymentName: targetDeployments[i].name, path: files[f].path, name: files[f].name });
          }
        } catch (_e) { }
      }
    });
    if (allFiles.length === 0) { vscode.window.showWarningMessage("No files found in selected scope."); return; }
    var qp = vscode.window.createQuickPick();
    qp.placeholder = "Type to search files by name…";
    function filterFiles(query: string) {
      var q = query.toLowerCase();
      if (!q) { qp.items = []; return; }
      var matches = allFiles.filter(function (f) { return f.name.toLowerCase().indexOf(q) !== -1 || f.path.toLowerCase().indexOf(q) !== -1; });
      matches.sort(function (a, b) {
        var aExact = a.name.toLowerCase() === q ? 0 : 1;
        var bExact = b.name.toLowerCase() === q ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        var aStart = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bStart = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        if (aStart !== bStart) return aStart - bStart;
        return a.path.localeCompare(b.path);
      });
      var items: vscode.QuickPickItem[] = matches.slice(0, 100).map(function (f) {
        return { label: "$(file) " + f.path, description: f.deploymentName, _file: f };
      });
      if (matches.length > 100) { items.push({ label: "… and " + (matches.length - 100) + " more" }); }
      qp.items = items;
    }
    qp.onDidChangeValue(function (value) { filterFiles(value); });
    qp.onDidAccept(async function () {
      var selected = qp.selectedItems[0] as any;
      if (selected && selected._file) {
        var f = selected._file;
        var uri = vscode.Uri.parse("bh://" + f.deploymentId + f.path);
        try {
          var doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false, viewColumn: preferredFileViewColumn() });
        } catch (err: any) { vscode.window.showErrorMessage("Failed to open file: " + err.message); }
      }
      qp.dispose();
    });
    qp.show();
  }));


  context.subscriptions.push(vscode.commands.registerCommand("bb.diffFile", async function (item: FileItem) {
    if (!item || item.file.type !== "file") return;
    var path = item.parentPath === "/" ? "/" + item.file.name : item.parentPath + "/" + item.file.name;
    try {
      var remote = await api.readFile(item.deploymentId, path);
      var remoteUri = vscode.Uri.parse("bh://" + item.deploymentId + path);
      var localContent = "";
      try { localContent = (await vscode.workspace.fs.readFile(remoteUri)).toString(); } catch (_e) { }
      var tempFile = vscode.Uri.file("/tmp/bb-diff-" + item.file.name);
      await vscode.workspace.fs.writeFile(tempFile, Buffer.from(remote.content));
      await vscode.commands.executeCommand("vscode.diff", tempFile, remoteUri, "Local vs Remote: " + item.file.name);
    } catch (err: any) { vscode.window.showErrorMessage("Diff failed: " + err.message); }
  }));


  auth.isAuthenticated().then(async function (yes) { await updateConnectedContext(); if (yes) { treeProvider.refresh(); } });
}

export function deactivate() { }
