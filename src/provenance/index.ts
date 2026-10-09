import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {address,getProgramDerivedAddress} from '@solana/addresses';
import {decodeEventLog,parseAbiItem,toEventSelector} from 'viem';
import type {Config} from '../config.js';
import {unknown,type Signal,type Provenance,type Platform} from '../types.js';
import {rpc,jsonRequest,type Fetcher} from '../http.js';
import platformRegistry from '../../config/platforms.json' with {type:'json'};

export const registry=platformRegistry;
const events={
  four:parseAbiItem('event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)'),
  flap:parseAbiItem('event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)'),
};
const flapVersion=parseAbiItem('event TokenVersionSet(address token,uint8 version)');
const flapExtension=parseAbiItem('event TokenExtensionEnabled(address token,bytes32 extensionID,address extensionAddress,uint256 version)');
const flapTax=parseAbiItem('event FlapTokenTaxSet(address token,uint256 tax)');
const flapAsymmetricTax=parseAbiItem('event FlapTokenAsymmetricTaxSet(address token,uint256 buyTax,uint256 sellTax)');
const flapModeEvents=[flapVersion,flapExtension,flapTax,flapAsymmetricTax];
const flapModeTopics=new Set<string>(flapModeEvents.map(toEventSelector));
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hexQuantity=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]+$/i.test(v);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const discriminator=(name:string)=>createHash('sha256').update(`account:${name}`).digest().subarray(0,8);

export function verifyEvmReceipt(signal:Signal,receipt:any):Provenance {
  if(signal.token.chain==='solana') return unknown('NO_REVIEWED_LAUNCHPAD_ON_CHAIN');
  if(!receipt||receipt.status!=='0x1') return unknown('CREATION_RECEIPT_MISSING_OR_FAILED');
  if(!signal.creationTx || !same(receipt.transactionHash??'',signal.creationTx)) return unknown('CREATION_TX_MISMATCH');
  if(!Array.isArray(receipt.logs)||receipt.logs.some((log:any)=>!object(log))) return unknown('CREATION_RECEIPT_LOGS_INVALID');
  if(receipt.logs.some((log:any)=>(log.transactionHash!==undefined&&!same(log.transactionHash,receipt.transactionHash))||
    (log.blockHash!==undefined&&!same(log.blockHash,receipt.blockHash))||
    (log.blockNumber!==undefined&&!same(log.blockNumber,receipt.blockNumber)))) return unknown('CREATION_RECEIPT_LOG_MISMATCH');
  const supported:('four'|'flap')[]=signal.token.chain==='bsc'?['four','flap']:['flap'];
  const candidates=supported.filter(p=>!signal.claimedPlatform||signal.claimedPlatform===p);
  for(const platform of candidates) {
    const deployment=signal.token.chain==='robinhood'?registry.flapRobinhood:registry[platform];
    const trustedLogs=(receipt.logs??[]).filter((l:any)=>!l.removed&&same(l.address??'',deployment.factory));
    for(const log of trustedLogs) {
      try {
        const decoded=decodeEventLog({abi:[events[platform]],data:log.data,topics:log.topics,strict:true});
        const args=decoded.args as {token:string;creator:string};
        if(!same(args.token,signal.token.address)) continue;
        const facts:Record<string,unknown>={creationTx:receipt.transactionHash,blockNumber:receipt.blockNumber,
          factory:deployment.factory,creator:args.creator,source:deployment.source};
        if(platform==='flap') {
          let version=0,extension=false,metadataInvalid=false,taxEnabled=false;
          let observedVersion:number|undefined;
          for(const entry of trustedLogs) {
            const topic=typeof entry.topics?.[0]==='string'?entry.topics[0].toLowerCase():'';
            if(!flapModeTopics.has(topic)) continue;
            try {
              const d=decodeEventLog({abi:flapModeEvents,data:entry.data,topics:entry.topics,strict:true});
              if(!same(d.args.token,signal.token.address)) continue;
              if(d.eventName==='TokenVersionSet') {
                if(observedVersion!==undefined&&observedVersion!==d.args.version) metadataInvalid=true;
                version=d.args.version;observedVersion=version;
              } else if(d.eventName==='TokenExtensionEnabled') extension=true;
              else if(d.eventName==='FlapTokenTaxSet') {
                facts.taxRateBps=d.args.tax.toString();taxEnabled ||= d.args.tax>0n;
              } else if(d.eventName==='FlapTokenAsymmetricTaxSet') {
                facts.buyTaxBps=d.args.buyTax.toString();facts.sellTaxBps=d.args.sellTax.toString();
                taxEnabled ||= d.args.buyTax>0n||d.args.sellTax>0n;
              }
            } catch {metadataInvalid=true;}
          }
          // Creation proves origin, not mode safety. Tax versions 4/5/6, GoPlus
          // version 3, new V3 liquidity mode 7 and extensions need dedicated adapters.
          facts.tokenVersion=version;facts.modeSupported=[0,1,2].includes(version)&&!extension&&!metadataInvalid&&!taxEnabled;
          facts.extension=extension;facts.modeMetadataInvalid=metadataInvalid;
          facts.modeVersionSource='https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/token-version-specification';
          if(!facts.modeSupported) facts.modeUnsupportedReason=metadataInvalid?'FLAP_MODE_METADATA_INVALID':
            extension?'FLAP_EXTENSION_UNREVIEWED':taxEnabled||[4,5,6].includes(version)?'FLAP_TAX_MODE_UNSUPPORTED':'FLAP_VERSION_UNREVIEWED';
        }
        return {status:'pass',platform,method:'official_creation_receipt',reasons:['OFFICIAL_FACTORY_CREATION_VERIFIED'],facts,checkedAt:new Date().toISOString()};
      } catch { /* A copied event from a different emitter is never considered. */ }
    }
  }
  return { ...unknown('NO_MATCHING_OFFICIAL_CREATION'),facts:{creationTx:signal.creationTx,claimedPlatform:signal.claimedPlatform} };
}

export function verifyPumpAccount(mint:string,stateAddress:string,account:any):Provenance {
  if(!account||account.owner!==registry.pump.program) return unknown('PUMP_STATE_NOT_OWNED_BY_OFFICIAL_PROGRAM');
  const data=Buffer.from(account.data?.[0]??'','base64');
  if(data.length<49||!data.subarray(0,8).equals(discriminator('BondingCurve'))||data.readBigUInt64LE(40)===0n)
    return unknown('PUMP_STATE_LAYOUT_UNSUPPORTED');
  // Known layouts: legacy prefix; additional flags are retained as facts, not silently ignored.
  const modeSupported=[49,81].includes(data.length) ||
    (data.length===82 && data[81]===0) || (data.length===83 && data[81]===0 && data[82]===0) ||
    (data.length===166 && data[81]===0 && data[82]===0 && data[123]===0 && data[124]===0);
  return {status:'pass',platform:'pump',method:'program_owned_pda',reasons:['PUMP_BONDING_CURVE_VERIFIED'],
    checkedAt:new Date().toISOString(),facts:{mint,stateAddress,program:account.owner,complete:data[48]===1,
      modeSupported,mayhem:data.length>81?data[81]===1:false,cashback:data.length>82?data[82]===1:false,
      source:registry.pump.source,accountLength:data.length}};
}

export function verifyBonkAccount(mint:string,stateAddress:string,account:any):Provenance {
  if(!account||account.owner!==registry.bonk.program) return unknown('BONK_POOL_NOT_OWNED_BY_LAUNCHLAB');
  const data=Buffer.from(account.data?.[0]??'','base64');
  if(data.length!==429||!data.subarray(0,8).equals(discriminator('PoolState'))) return unknown('BONK_POOL_LAYOUT_UNSUPPORTED');
  const platform=bs58.encode(data.subarray(173,205)),base=bs58.encode(data.subarray(205,237)),quote=bs58.encode(data.subarray(237,269));
  if(platform!==registry.bonk.platformConfig||base!==mint||quote!==registry.bonk.quoteMint) return unknown('BONK_PLATFORM_OR_MINT_MISMATCH');
  return {status:'pass',platform:'bonk',method:'program_owned_pda_and_platform_config',reasons:['BONK_PLATFORM_CONFIG_VERIFIED'],
    checkedAt:new Date().toISOString(),facts:{mint,stateAddress,program:account.owner,platformConfig:platform,
      quoteMint:quote,modeSupported:data[365]===0,source:registry.bonk.source}};
}

// GMGN's creation timestamp is only a search hint. The final proof is an official emitter's
// event for this exact token, followed by receipt/confirmation/canonical-block verification.
export async function findCreationTransaction(signal:Signal,rpcUrl:string,info:any,fetcher:Fetcher=fetch):Promise<string|undefined> {
  if(signal.token.chain==='solana'||!object(info)||!same(info.address,signal.token.address)||
    (info.chain!==undefined&&info.chain!==signal.token.chain)) return;
  if(typeof info.creation_timestamp!=='number'&&
    !(typeof info.creation_timestamp==='string'&&/^\d{1,11}$/.test(info.creation_timestamp))) return;
  const target=Number(info.creation_timestamp);
  if(!Number.isSafeInteger(target)||target<=0) return;
  const headHex=await rpc(rpcUrl,'eth_blockNumber',[],fetcher);
  if(!hexQuantity(headHex)) throw new Error('BLOCK_HEIGHT_INVALID');
  const head=BigInt(headHex);
  const cache=new Map<bigint,number>();
  const time=async(n:bigint)=>{
    if(cache.has(n)) return cache.get(n)!;
    const block=await rpc(rpcUrl,'eth_getBlockByNumber',['0x'+n.toString(16),false],fetcher);
    if(!block||!hexQuantity(block.number)||BigInt(block.number)!==n||!hexQuantity(block.timestamp)) throw new Error('BLOCK_INVALID');
    const t=Number(BigInt(block.timestamp));if(!Number.isSafeInteger(t)) throw new Error('BLOCK_TIME_INVALID');
    cache.set(n,t);return t;
  };
  if(target>(await time(head))+30) return;
  // Bracket from the chain tip instead of immediately reading genesis and the
  // midpoint of the entire chain. Recent tokens must not depend on ancient
  // block bodies retained by an archive provider. All hints remain untrusted.
  let lo=head,hi=head,distance=4096n;
  while(lo>0n) {
    if(cache.size>=40) return;
    const candidate=head>distance?head-distance:0n;
    const timestamp=await time(candidate);
    if(timestamp<=target) {lo=candidate;break;}
    if(candidate===0n) return;
    hi=candidate;lo=candidate;distance*=2n;
  }
  while(lo<hi) {
    const mid=(lo+hi)/2n;
    if(!cache.has(mid)&&cache.size>=40) return;
    if(await time(mid)<target) lo=mid+1n;else hi=mid;
  }
  if(lo!==hi) return;
  // Bounded window, split for RPC providers with a small eth_getLogs block-range limit.
  const from=lo>128n?lo-128n:0n,to=lo+128n<head?lo+128n:head;
  const supported:('four'|'flap')[]=signal.token.chain==='bsc'?['four','flap']:['flap'];
  const platforms=supported.filter(platform=>!signal.claimedPlatform||signal.claimedPlatform===platform);
  if(platforms.length===0) return;
  const factories=platforms.map(platform=>signal.token.chain==='robinhood'?registry.flapRobinhood.factory:registry[platform].factory);
  const topics=[platforms.map(platform=>toEventSelector(events[platform]))];
  for(let start=from;start<=to;start+=64n) {
    const end=start+63n<to?start+63n:to;
    const logs=await rpc(rpcUrl,'eth_getLogs',[{address:factories,topics,fromBlock:'0x'+start.toString(16),toBlock:'0x'+end.toString(16)}],fetcher);
    if(!Array.isArray(logs)||logs.length>2000) throw new Error('LOGS_INVALID');
    for(const log of logs) {
      if(!object(log)||log.removed||!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash??'')||
        !hexQuantity(log.blockNumber)||BigInt(log.blockNumber)<start||BigInt(log.blockNumber)>end) continue;
      const receipt={status:'0x1',transactionHash:log.transactionHash,blockNumber:log.blockNumber,blockHash:log.blockHash,logs:[log]};
      if(verifyEvmReceipt({...signal,creationTx:log.transactionHash},receipt).status==='pass') return log.transactionHash;
    }
  }
}

export async function checkProvenance(signal:Signal,config:Config,fetcher:Fetcher=fetch,tokenInfo?:unknown):Promise<Provenance> {
  const url=config.rpc[signal.token.chain];
  if(!url) return unknown('CHAIN_RPC_NOT_CONFIGURED');
  try {
    if(signal.token.chain!=='solana') {
      const expected=signal.token.chain==='bsc'?56:4663;
      if(Number(BigInt(await rpc(url,'eth_chainId',[],fetcher)))!==expected) return unknown('RPC_CHAIN_MISMATCH');
      let creationTx=signal.creationTx;
      if(!creationTx && config.etherscanKey && signal.token.chain==='bsc') {
        try {
        const query=new URLSearchParams({chainid:String(expected),module:'contract',action:'getcontractcreation',
          contractaddresses:signal.token.address,apikey:config.etherscanKey});
        const response=await jsonRequest(`https://api.etherscan.io/v2/api?${query}`,{},fetcher);
        const entry=response.status==='1'&&Array.isArray(response.result)
          ?response.result.find((v:any)=>same(v.contractAddress??'',signal.token.address)):undefined;
        if(entry && /^0x[0-9a-fA-F]{64}$/.test(entry.txHash)) creationTx=entry.txHash;
        } catch { /* A failed optional explorer does not prevent the RPC-log lookup. */ }
      }
      if(!creationTx&&tokenInfo) creationTx=await findCreationTransaction(signal,url,tokenInfo,fetcher);
      if(!creationTx) return unknown('EVM_CREATION_TX_REQUIRED');
      const receipt=await rpc(url,'eth_getTransactionReceipt',[creationTx],fetcher);
      const result=verifyEvmReceipt({...signal,creationTx},receipt);
      if(result.status!=='pass') return result;
      if(!hexQuantity(receipt.blockNumber)) return unknown('CREATION_BLOCK_INVALID');
      const head=await rpc(url,'eth_blockNumber',[],fetcher);
      if(!hexQuantity(head)) return unknown('CREATION_BLOCK_INVALID');
      const height=BigInt(head);
      if(height-BigInt(receipt.blockNumber)<12n) return unknown('CREATION_NOT_SUFFICIENTLY_CONFIRMED');
      const canonical=await rpc(url,'eth_getBlockByNumber',[receipt.blockNumber,false],fetcher);
      if(!/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash??'')||!same(canonical?.hash,receipt.blockHash)||
        (canonical?.number!==undefined&&(!hexQuantity(canonical.number)||BigInt(canonical.number)!==BigInt(receipt.blockNumber))))
        return unknown('CREATION_BLOCK_NOT_CANONICAL');
      const code=await rpc(url,'eth_getCode',[signal.token.address,'latest'],fetcher);
      if(typeof code!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return unknown('TOKEN_CODE_MISSING');
      result.facts.runtimeCodeHash=createHash('sha256').update(code).digest('hex');
      return result;
    }
    const genesis=await rpc(url,'getGenesisHash',[],fetcher);
    if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') return unknown('RPC_CHAIN_MISMATCH');
    const platforms:('pump'|'bonk')[]=signal.claimedPlatform?(['pump','bonk'].includes(signal.claimedPlatform)?[signal.claimedPlatform as 'pump'|'bonk']:[]):['pump','bonk'];
    const findings:Provenance[]=[];
    for(const platform of platforms) {
      const seeds=platform==='pump'?[Buffer.from('bonding-curve'),bs58.decode(signal.token.address)]
        :[Buffer.from('pool'),bs58.decode(signal.token.address),bs58.decode(registry.bonk.quoteMint)];
      const [pda]=await getProgramDerivedAddress({programAddress:address(registry[platform].program),seeds});
      if(signal.platformState&&signal.platformState!==pda) { findings.push(unknown('PLATFORM_STATE_ADDRESS_MISMATCH'));continue; }
      const response=await rpc(url,'getAccountInfo',[pda,{encoding:'base64',commitment:'finalized'}],fetcher);
      const result=platform==='pump'?verifyPumpAccount(signal.token.address,pda,response?.value):verifyBonkAccount(signal.token.address,pda,response?.value);
      result.facts.slot=response?.context?.slot;
      if(result.status==='pass') return result;
      findings.push(result);
    }
    return unknown('LAUNCHPAD_SOURCE_UNVERIFIED',{attempts:findings});
  } catch { return unknown('PROVENANCE_RPC_UNAVAILABLE_OR_UNSUPPORTED'); }
}
