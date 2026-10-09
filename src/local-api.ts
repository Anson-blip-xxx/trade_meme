import type {Config} from './config.js';

export async function localRequest(config:Config,path:string,method='GET'):Promise<Response> {
  if(!config.ingestToken) throw new Error('INGEST_TOKEN_MISSING');
  const host=['0.0.0.0','::'].includes(config.host)?'127.0.0.1':config.host;
  try {
    const response=await fetch(`http://${host.includes(':')?`[${host}]`:host}:${config.port}${path}`,{
      method,redirect:'error',headers:{authorization:`Bearer ${config.ingestToken}`},signal:AbortSignal.timeout(180000)});
    if(!response.ok) throw new Error(`LOCAL_HTTP_${response.status}`);
    return response;
  } catch(error) {
    if(error instanceof Error&&/^LOCAL_HTTP_\d+$/.test(error.message)) throw error;
    throw new Error('LOCAL_SERVICE_UNAVAILABLE_START_NPM_RUN_DEV');
  }
}
