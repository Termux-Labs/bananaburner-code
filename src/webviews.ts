function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
//
export function getConsoleHtml(deploymentName: string): string {
  const name = escapeHtml(deploymentName);
  return `<!doctype html>
<html><head><meta charset="UTF-8"><style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:#1e1e1e;color:#d4d4d4;font:13px monospace}
#toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #333;font:12px var(--vscode-font-family,system-ui)}
#server{margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:#e5e510}.connected{background:#23d18b}.disconnected{background:#f14c4c}
button,input{font:inherit}button{border:1px solid #555;border-radius:3px;padding:4px 8px;background:#303030;color:#ddd;cursor:pointer}button:hover{background:#3d3d3d}button:disabled{opacity:.5;cursor:default}
#log{flex:1;overflow:auto;padding:8px;white-space:pre-wrap;word-break:break-word}.line{padding:1px 0}.info{color:#569cd6}.error{color:#f44747}
#composer{display:flex;gap:6px;padding:6px;border-top:1px solid #333}#command{flex:1;min-width:0;background:#2d2d2d;color:#ddd;border:1px solid #555;border-radius:3px;padding:6px 8px}#command:focus{outline:1px solid #007acc}
</style></head><body>
<div id="toolbar"><span id="server">${name ? name + " &middot; " : ""}<span id="state"><span class="dot"></span>Connecting</span></span><button id="pause">Pause</button><button id="follow">Follow</button><button id="clear">Clear</button><button id="copy">Copy</button></div>
<div id="log"><div class="line info">${name ? "Connecting to " + name + " console..." : "Select a deployment to open its console."}</div></div>
<div id="composer"><input id="command" autocomplete="off" placeholder="Type a command and press Enter"><button id="send">Send</button></div>
<script>
(function(){
  const vscode=acquireVsCodeApi();
  const log=document.getElementById('log');
  const command=document.getElementById('command');
  const send=document.getElementById('send');
  const state=document.getElementById('state');
  let paused=false,follow=true,history=[],historyIndex=0,localCommands=[];
  function line(text,kind){const el=document.createElement('div');el.className='line '+(kind||'');el.textContent=String(text);log.appendChild(el);if(follow)log.scrollTop=log.scrollHeight;}
  function render(lines){const atBottom=log.scrollTop+log.clientHeight>=log.scrollHeight-8;log.innerHTML='';(lines||[]).forEach(function(x){line(x);});localCommands.forEach(function(x){line('> '+x,'info');});if(atBottom&&follow)log.scrollTop=log.scrollHeight;}
  function setState(value){const text=value==='connected'?'Connected':value==='disconnected'?'Disconnected':'Reconnecting...';state.textContent='';const dot=document.createElement('span');dot.className='dot '+value;state.appendChild(dot);state.appendChild(document.createTextNode(text));}
  window.addEventListener('message',function(event){const m=event.data||{};
    if(m.type==='logs'&&!paused)render(m.lines);
    if(m.type==='connectionState')setState(m.state||'disconnected');
    if(m.type==='logError')line('Error: '+m.error,'error');
    if(m.type==='cmdSending'){send.disabled=true;command.disabled=true;line('Sending command...','info');}
    if(m.type==='cmdAccepted')line(m.message||'Command accepted by the server. Waiting for output...','info');
    if(m.type==='cmdSent'){send.disabled=false;command.disabled=false;command.focus();line('Command sent. Refreshing output...','info');}
    if(m.type==='cmdError'){send.disabled=false;command.disabled=false;line('Error: '+m.error,'error');}
    if(m.type==='authError'){send.disabled=false;command.disabled=false;line('Authentication expired. Reconnect from the sidebar.','error');}
  });
  document.getElementById('pause').onclick=function(){paused=!paused;this.textContent=paused?'Resume':'Pause';};
  document.getElementById('follow').onclick=function(){follow=!follow;this.textContent=follow?'Following':'Follow';};
  document.getElementById('clear').onclick=function(){log.innerHTML='';};
  document.getElementById('copy').onclick=function(){navigator.clipboard.writeText(Array.from(log.children).map(function(x){return x.textContent||'';}).join('\\n'));};
  function submit(){const value=command.value.trim();if(!value||send.disabled)return;history.push(value);historyIndex=history.length;localCommands.push(value);if(localCommands.length>50)localCommands.shift();line('> '+value,'info');command.value='';send.disabled=true;command.disabled=true;vscode.postMessage({type:'sendCommand',command:value});}
  send.onclick=submit;command.onkeydown=function(event){if(event.key==='Enter'){event.preventDefault();submit();}else if(event.key==='ArrowUp'&&history.length){event.preventDefault();historyIndex=Math.max(0,historyIndex-1);command.value=history[historyIndex];}else if(event.key==='ArrowDown'){event.preventDefault();historyIndex=Math.min(history.length,historyIndex+1);command.value=history[historyIndex]||'';}};
  vscode.postMessage({type:'ready'});
})();
</script></body></html>`;
}

export function getResourceHtml(deploymentName: string): string {
  const name = escapeHtml(deploymentName);
  return `<!doctype html>
<html><head><meta charset="UTF-8"><style>
:root{color-scheme:dark}body{margin:0;padding:16px;background:#1e1e1e;color:#d4d4d4;font:13px var(--vscode-font-family,system-ui);overflow:auto}
h2{margin:0 0 4px;font-size:22px}#meta{color:#999;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{background:#252526;border:1px solid #383838;border-radius:6px;padding:16px;min-width:0}.card h3{margin:0 0 8px;color:#999;font-size:12px;letter-spacing:.5px}.value{font-size:24px;font-weight:700;margin:4px 0}.sub{color:#999;font-size:12px}.bar{height:8px;margin-top:6px;background:#171717;border-radius:4px;overflow:hidden}.fill{height:100%;width:0;transition:width .3s;background:#007acc}.row{display:flex;align-items:center;gap:8px;margin:16px 0}button,input{font:inherit}button{border:0;border-radius:3px;padding:8px 12px;background:#3a3d41;color:#fff;cursor:pointer}button:hover{background:#50545a}button:disabled{opacity:.45;cursor:default}#start{background:#16825d}#restart{background:#0969aa}#stop{background:#b42318}input{box-sizing:border-box;width:100%;padding:8px;background:#181818;color:#ddd;border:1px solid #444;border-radius:3px;margin-top:5px}.stack{display:grid;gap:9px}.message{color:#aaa;min-height:18px}.domain a{color:#4daafc;display:block;margin:4px 0}.hidden{display:none!important}@media(max-width:650px){.grid{grid-template-columns:1fr}}
</style></head><body>
<h2>${name}</h2><div id="meta">Loading deployment details...</div>
<div class="grid"><section class="card"><h3>CPU</h3><div id="cpu" class="value">--</div><div class="bar"><div id="cpuFill" class="fill"></div></div><div id="cpuSub" class="sub"></div></section><section class="card"><h3>MEMORY</h3><div id="memory" class="value">--</div><div class="bar"><div id="memoryFill" class="fill"></div></div><div id="memorySub" class="sub"></div></section><section class="card"><h3>DISK</h3><div id="disk" class="value">--</div><div class="bar"><div id="diskFill" class="fill"></div></div><div id="diskSub" class="sub"></div></section><section class="card"><h3>NETWORK</h3><div id="network" class="value">--</div><div id="networkSub" class="sub"></div></section></div>
<div class="row"><button id="start">Start</button><button id="restart">Restart</button><button id="stop">Stop</button><span id="message" class="message"></span></div>
<div class="grid"><section class="card"><h3>ALLOCATION</h3><div class="sub">Changes apply the RAM, CPU, and storage allocation together.</div><div class="stack"><label>RAM (MiB)<input id="ram" type="number" min="1" step="1"></label><label>CPU (%)<input id="cpuLimit" type="number" min="1" step="1"></label><label>Storage (MiB)<input id="storage" type="number" min="1" step="1"></label><button id="saveAllocation">Save allocation</button></div></section><section class="card"><h3>GIT AUTO-PULL</h3><div id="git" class="sub">Loading Git settings...</div><label id="autoPullRow" class="hidden"><input id="autoPull" type="checkbox" style="width:auto"> Pull the linked repository automatically</label><button id="saveAutoPull" class="hidden">Save Git setting</button></section></div>
<div class="grid" style="margin-top:12px"><section class="card"><h3>DEPLOYMENT</h3><div class="stack"><label>Name<input id="name" placeholder="Deployment name"></label><label>Description<input id="description" placeholder="Description"></label><button id="saveDeployment">Save details</button></div></section><section class="card"><h3>DOMAINS</h3><div id="domains" class="domain sub">Loading domains...</div><button id="enableDomains">Enable hosting domain</button></section></div>
<script>
(function(){
  const vscode=acquireVsCodeApi();const $=function(id){return document.getElementById(id);};let currentState='unknown';
  function fmt(value){value=Number(value)||0;if(value<1024)return value+' B';if(value<1048576)return (value/1024).toFixed(1)+' KB';if(value<1073741824)return (value/1048576).toFixed(1)+' MB';return (value/1073741824).toFixed(2)+' GB';}
  function setMessage(text){$('message').textContent=text||'';}
  function setPower(state){currentState=String(state||'unknown').toLowerCase();$('meta').dataset.state=currentState;$('meta').textContent='State: '+currentState;$('start').disabled=currentState==='running'||currentState==='starting';$('restart').disabled=currentState==='offline'||currentState==='stopping';$('stop').disabled=currentState==='offline'||currentState==='stopping';}
  function fill(id,percent){$(id).style.width=Math.max(0,Math.min(100,Number(percent)||0))+'%';}
  function formatUptime(ms){let seconds=Math.max(0,Math.floor((Number(ms)||0)/1000));const days=Math.floor(seconds/86400);seconds%=86400;const hours=Math.floor(seconds/3600);seconds%=3600;const minutes=Math.floor(seconds/60);seconds%=60;const parts=[];if(days)parts.push(days+'d');if(hours||days)parts.push(hours+'h');if(minutes||hours||days)parts.push(minutes+'m');parts.push(seconds+'s');return parts.join(' ');}
  function resources(d){d=d||{};const cpu=d.cpu||{},memory=d.memory||{},disk=d.disk||{},network=d.network||{};const cpuPct=Number(cpu.limitPercent)>0?Number(cpu.usedPercent)/Number(cpu.limitPercent)*100:0;const memPct=Number(memory.limitBytes)>0?Number(memory.usedBytes)/Number(memory.limitBytes)*100:0;const diskPct=Number(disk.limitBytes)>0?Number(disk.usedBytes)/Number(disk.limitBytes)*100:0;$('cpu').textContent=(Number(cpu.usedPercent)||0)+'% / '+(Number(cpu.limitPercent)||0)+'%';$('memory').textContent=fmt(memory.usedBytes)+' / '+fmt(memory.limitBytes);$('disk').textContent=fmt(disk.usedBytes)+' / '+fmt(disk.limitBytes);$('network').textContent='RX '+fmt(network.rxBytes)+' / TX '+fmt(network.txBytes);$('cpuSub').textContent=Math.round(cpuPct)+'% of allocation';$('memorySub').textContent=Math.round(memPct)+'% of allocation';$('diskSub').textContent=Math.round(diskPct)+'% of allocation';$('networkSub').textContent='Uptime: '+formatUptime(d.uptimeMs);fill('cpuFill',cpuPct);fill('memoryFill',memPct);fill('diskFill',diskPct);if(d.state)setPower(d.state);}
  function deployment(d){d=d||{};setPower(d.state);$('meta').textContent='State: '+(d.state||'unknown')+(d.status?' · '+d.status:'')+(d.node&&d.node.name?' · Node: '+d.node.name:'')+(d.port?' · Port: '+d.port:'');const a=d.resources||{};$('ram').value=a.ramMB||'';$('cpuLimit').value=a.cpuPercent||'';$('storage').value=a.storageMB||'';$('name').value=d.name||'';$('description').value=d.description||'';const domains=d.domains||{};$('domains').textContent='';const hosts=[domains.subdomain,domains.slug,domains.custom].filter(function(x,i,a){return x&&a.indexOf(x)===i;});if(!hosts.length)$('domains').textContent='No domain assigned';hosts.forEach(function(host){const link=document.createElement('a');link.href=/^https?:\\/\\//.test(host)?host:'https://'+host;link.target='_blank';link.rel='noopener';link.textContent=host;$('domains').appendChild(link);});$('enableDomains').classList.toggle('hidden',!!domains.subdomain);}
  function git(d){const linked=!!(d&&d.linked);$('git').textContent=linked?(d.repo||'Linked repository')+(d.branch?' · '+d.branch:''):'No Git repository linked';$('autoPullRow').classList.toggle('hidden',!linked);$('saveAutoPull').classList.toggle('hidden',!linked);$('autoPull').checked=linked&&!!d.autoPull;}
  window.addEventListener('message',function(event){const m=event.data||{};try{if(m.type==='resources')resources(m.data);if(m.type==='deployment')deployment(m.data);if(m.type==='git')git(m.data);if(m.type==='powerResult'){setMessage(m.message);if(m.state)setPower(m.state);}if(m.type==='deploymentError')$('meta').textContent='Error: '+m.error;}catch(error){$('meta').textContent='View error: '+error.message;}});
  ['start','restart','stop'].forEach(function(action){$(action).onclick=function(){setMessage('Sending '+action+'...');vscode.postMessage({type:'power',action:action});};});
  $('saveAllocation').onclick=function(){const ram=Number($('ram').value),cpu=Number($('cpuLimit').value),storage=Number($('storage').value);if(!Number.isInteger(ram)||ram<1||!Number.isInteger(cpu)||cpu<1||!Number.isInteger(storage)||storage<1){setMessage('RAM, CPU, and storage must be positive whole numbers.');return;}setMessage('Saving allocation...');vscode.postMessage({type:'resize',ramMB:ram,cpuPct:cpu,storageMB:storage});};
  $('saveAutoPull').onclick=function(){setMessage('Saving Git setting...');vscode.postMessage({type:'autoPull',autoPull:$('autoPull').checked});};$('saveDeployment').onclick=function(){vscode.postMessage({type:'deploymentUpdate',name:$('name').value.trim(),description:$('description').value.trim()});};$('enableDomains').onclick=function(){setMessage('Enabling hosting domain...');vscode.postMessage({type:'enableDomains'});};
  vscode.postMessage({type:'ready'});
})();
</script></body></html>`;
}
