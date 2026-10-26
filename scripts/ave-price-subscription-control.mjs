/** One public socket, 60 seconds, read-only A -> B incremental -> A+B full-set control. */
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
const db=new DatabaseSync('data/ave-signals.sqlite',{readOnly:true});
const tokens=db.prepare("SELECT address,max(observed_at) latest FROM ave_signals WHERE chain='solana' GROUP BY address ORDER BY latest DESC LIMIT 20").all();db.close();
if(tokens.length!==20)throw Error('INSUFFICIENT_TOKENS');
const a=tokens.slice(0,10).map(t=>t.address),b=tokens.slice(10).map(t=>t.address),groups=new Map([...a.map(t=>[t,'A']),...b.map(t=>[t,'B'])]);
const report={startedAt:new Date().toISOString(),readOnly:true,endpoint:'wss://yiyulu.com/ws',purpose:'Test whether a second pricev2 subscribe replaces or adds topics; no HTTP/login/trade.',groups:{A:a,B:b},phases:[],errors:[],frames:0};
let stage,finished=false,aborted=false;
const socket=new WebSocket(report.endpoint);
socket.addEventListener('error',()=>{report.errors.push('WS_ERROR');aborted=true;});
socket.addEventListener('close',()=>{if(!finished){report.errors.push('WS_UNEXPECTED_CLOSE');aborted=true;}});
socket.addEventListener('message',event=>{
  if(typeof event.data!=='string'||event.data.length>2e6){report.errors.push('FRAME_INVALID');aborted=true;return;}
  if(event.data==='pong')return;
  let value;try{value=JSON.parse(event.data);}catch{return;}
  if(value.error){report.errors.push('RPC_ERROR');aborted=true;return;}
  if(!stage||value?.result?.status!=='ok'||value?.result?.data?.event!=='pricev2'||!Array.isArray(value.result.data.prices))return;
  const now=Date.now();report.frames++;stage.frames++;
  for(const row of value.result.data.prices){
    if(row.chain!=='solana'||row.target_token!==row.token||row.is_main_pair!==true||!groups.has(row.token)||
      !Number.isSafeInteger(row.time)||row.time*1000>now||now-row.time*1000>=30000||!Number.isFinite(row.uprice)||row.uprice<=0)continue;
    const old=stage.tokens[row.token];if(old&&row.time<=old.lastProviderTime)continue;
    stage.tokens[row.token]={group:groups.get(row.token),updates:(old?.updates??0)+1,lastProviderTime:row.time,
      firstReceivedAt:old?.firstReceivedAt??new Date(now).toISOString(),lastReceivedAt:new Date(now).toISOString()};
  }
});
try{
  await Promise.race([new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('CONNECT_FAILED')),{once:true});}),new Promise((_,reject)=>setTimeout(()=>reject(Error('CONNECT_TIMEOUT')),15000))]);
  for(const [i,phase] of [{name:'A full baseline',topics:a},{name:'B only incremental',topics:b},{name:'A+B full replacement control',topics:[...a,...b]}].entries()){
    if(aborted)break;
    stage={name:phase.name,startedAt:new Date().toISOString(),topicsSent:phase.topics.length,frames:0,tokens:{}};
    socket.send(JSON.stringify({jsonrpc:'2.0',method:'subscribe',params:['pricev2',phase.topics.map(t=>`${t}-solana`)],id:200+i}));
    const began=Date.now();while(!aborted&&Date.now()-began<20000)await new Promise(resolve=>setTimeout(resolve,250));
    stage.endedAt=new Date().toISOString();
    stage.coverage={A:Object.values(stage.tokens).filter(t=>t.group==='A').length,B:Object.values(stage.tokens).filter(t=>t.group==='B').length};
    stage.newUpdates={A:Object.values(stage.tokens).filter(t=>t.group==='A').reduce((n,t)=>n+t.updates,0),B:Object.values(stage.tokens).filter(t=>t.group==='B').reduce((n,t)=>n+t.updates,0)};
    report.phases.push(stage);console.log(JSON.stringify({...stage,tokens:undefined}));stage=undefined;
    socket.send('{"jsonrpc":"2.0","method":"ping","id":1}');
  }
}catch(e){report.errors.push(e instanceof Error?e.message:'FAILED');}
finally{finished=true;stage=undefined;socket.close(1000,'read-only control completed');report.finishedAt=new Date().toISOString();writeFileSync('reports/ave-price-subscription-control-20261026.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({finishedAt:report.finishedAt,errors:report.errors}));}
