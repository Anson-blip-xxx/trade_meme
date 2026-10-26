import https from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';

const MAX_RESPONSE_BYTES=256*1024;

/**
 * Telegram-only transport. This host's IPv6/Happy-Eyeballs path may time out while
 * IPv4 remains reachable; never change global DNS/network settings for providers.
 * Not a general fetch replacement: only the notifier/control adapter's explicit
 * HTTPS JSON methods are accepted. Redirects cannot receive the bot token.
 */
export const telegramIpv4Fetch:typeof globalThis.fetch=async(input,init)=>{
  let url:URL;
  try {url=new URL(input instanceof Request?input.url:String(input));}
  catch {throw new Error('TELEGRAM_TRANSPORT_REQUEST_INVALID');}
  if(url.origin!=='https://api.telegram.org'||url.username||url.password||url.search||url.hash||
    !/^\/bot[0-9]+:[A-Za-z0-9_-]+\/(?:sendMessage|getUpdates|answerCallbackQuery)$/.test(url.pathname)||
    init?.method!=='POST'||typeof init.body!=='string')throw new Error('TELEGRAM_TRANSPORT_REQUEST_INVALID');
  const body=init.body,signal=init.signal;
  if(signal?.aborted)throw new Error('TELEGRAM_TRANSPORT_ABORTED');
  return new Promise<Response>((resolve,reject)=>{
    let request:ClientRequest|undefined,response:IncomingMessage|undefined,settled=false;
    const finish=(error?:Error,result?:Response)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',abort);
      if(error){request?.destroy();response?.destroy();reject(error);}else resolve(result!);
    };
    const fail=()=>finish(new Error('TELEGRAM_TRANSPORT_FAILED'));
    const abort=()=>finish(new Error('TELEGRAM_TRANSPORT_ABORTED'));
    signal?.addEventListener('abort',abort,{once:true});
    try {
      request=https.request({protocol:'https:',hostname:'api.telegram.org',port:443,path:url.pathname,
        method:'POST',family:4,rejectUnauthorized:true,agent:false,
        headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},incoming=>{
        response=incoming;incoming.on('error',fail);incoming.on('aborted',fail);
        incoming.on('close',()=>{if(!incoming.complete)fail();});
        const status=incoming.statusCode??0;
        if(status<200||status>599||status>=300&&status<400) {fail();return;}
        const announced=Number(incoming.headers['content-length']);
        if(Number.isFinite(announced)&&announced>MAX_RESPONSE_BYTES){fail();return;}
        const chunks:Buffer[]=[];let bytes=0;
        incoming.on('data',(chunk:Buffer|string)=>{
          if(settled)return;const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.length;
          if(bytes>MAX_RESPONSE_BYTES){fail();return;}chunks.push(data);
        });
        incoming.on('end',()=>{
          if(settled)return;
          try {
            const headers=new Headers();
            // Delivery only needs these headers. Never retain cookies or other metadata.
            for(const key of ['content-type','retry-after']) {
              const value=incoming.headers[key];if(typeof value==='string')headers.set(key,value);
            }
            finish(undefined,new Response(status===204||status===205?null:Buffer.concat(chunks).toString('utf8'),{status,headers}));
          }catch{fail();}
        });
      });
      request.on('error',fail);
      if(settled)request.destroy();else request.end(body);
    }catch{fail();}
  });
};
