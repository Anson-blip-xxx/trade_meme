export type Fetcher = typeof fetch;
// No signal-controlled URL reaches this function. Providers use fixed hosts or operator-configured RPCs.
export async function jsonRequest(url:string, init:RequestInit={}, fetcher:Fetcher=fetch, timeout=12000):Promise<any> {
  const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(timeout)});
  if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
  const text=await response.text();
  if (text.length>4_000_000) throw new Error('UPSTREAM_TOO_LARGE');
  return JSON.parse(text);
}
export async function rpc(url:string,method:string,params:unknown[],fetcher:Fetcher=fetch):Promise<any> {
  const body=await jsonRequest(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},fetcher);
  if (body.error || !Object.hasOwn(body,'result')) throw new Error('RPC_ERROR');
  return body.result;
}
