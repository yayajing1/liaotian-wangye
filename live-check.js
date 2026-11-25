const { spawn, spawnSync } = require('child_process');
const fs=require('fs'), path=require('path'), os=require('os');
const WebSocket=require('ws');
const CDP_PORT=9341;
const EDGE='C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();this.ready=new Promise((res,rej)=>{this.ws.on('open',res);this.ws.on('error',rej);});this.ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
send(method,params){const id=++this.id;return new Promise((resolve,reject)=>{this.p.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params:params||{}}));});}
async evaluate(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
close(){try{this.ws.close();}catch{}}}
(async()=>{
  const url = process.argv[2];
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'edge-live-'));
  const proc=spawn(EDGE,['--headless=new',`--remote-debugging-port=${CDP_PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank'],{stdio:'ignore'});
  let cdp=null;
  try{
    let target=null;
    for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);const l=await r.json();target=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);if(target)break;}catch{}await sleep(250);}
    cdp=new CDP(target.webSocketDebuggerUrl); await cdp.ready;
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate',{url});
    let st=null;
    for(let i=0;i<60;i++){await sleep(250);
      st=await cdp.evaluate(`(function(){if(!window.ChatApp)return{ready:false};var m=document.getElementById('keyModal');return{ready:true,connected:!!window.ChatApp.state.self,modal:!!(m&&!m.hidden),conn:(document.getElementById('connText')||{}).textContent||'',name:window.ChatApp.state.self?window.ChatApp.state.self.name:''};})()`);
      if(st.ready&&(st.connected||st.modal))break;}
    console.log('页面状态:', JSON.stringify(st));
    console.log(st.connected&&!st.modal?'✅ 直接进房间，没有弹口令框':'❌ 仍然有问题');
  } finally { if(cdp)cdp.close(); try{spawnSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore'});}catch{} try{fs.rmSync(profile,{recursive:true,force:true});}catch{} }
})();
