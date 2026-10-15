export type Fetcher = typeof fetch;
const fetcherScopes=new WeakMap<Fetcher,AbortSignal>();
/** Cancellation also bounds mock/third-party transports that ignore AbortSignal. */
export function abortable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return work;
  if(signal.aborted){void work.catch(()=>{});return Promise.reject(signal.reason??new Error('REQUEST_ABORTED'));}
  return new Promise<T>((resolve,reject)=>{
    const aborted=()=>{cleanup();reject(signal.reason??new Error('REQUEST_ABORTED'));};
    const cleanup=()=>signal.removeEventListener('abort',aborted);
    signal.addEventListener('abort',aborted,{once:true});
    work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
/** Keep both the caller deadline and the individual request timeout. */
export function scopedFetcher(fetcher:Fetcher,signal?:AbortSignal):Fetcher {
  if(!signal)return fetcher;
  const scoped:Fetcher=(input,init)=>{
    if(signal.aborted)return Promise.reject(signal.reason??new Error('REQUEST_ABORTED'));
    const combined=init?.signal?AbortSignal.any([signal,init.signal]):signal;
    return abortable(fetcher(input,{...init,signal:combined}),combined);
  };
  fetcherScopes.set(scoped,signal);return scoped;
}
// No signal-controlled URL reaches this function. Providers use fixed hosts or operator-configured RPCs.
export async function jsonRequest(url:string, init:RequestInit={}, fetcher:Fetcher=fetch, timeout=12000):Promise<any> {
  const signals=[init.signal,fetcherScopes.get(fetcher),AbortSignal.timeout(timeout)].filter((value):value is AbortSignal=>!!value);
  const signal=signals.length===1?signals[0]:AbortSignal.any(signals);
  signal.throwIfAborted();
  const response=await abortable(fetcher(url,{...init,redirect:'error',signal}),signal);
  if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
  const text=await abortable(response.text(),signal);
  if (text.length>4_000_000) throw new Error('UPSTREAM_TOO_LARGE');
  return JSON.parse(text);
}
export async function rpc(url:string,method:string,params:unknown[],fetcher:Fetcher=fetch):Promise<any> {
  const body=await jsonRequest(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},fetcher);
  if (body.error || !Object.hasOwn(body,'result')) throw new Error('RPC_ERROR');
  return body.result;
}
