import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {readConfig} from '../src/config.js';
import {WalletActivityVerifier} from '../src/wallet-activity.js';
import {WalletActivityStore} from '../src/wallet-activity-store.js';
import {chainAddress} from '../src/chain-stream-store.js';
import type {FastWalletEvent} from '../src/wallet-fast.js';

// Bounded read-only historical verification. This script has no scanner, signal callback or order client.
const arg=process.argv.slice(2),limit=arg.length===1&&/^--limit=\d{1,3}$/.test(arg[0])?Number(arg[0].slice(8)):arg.length?NaN:20;
if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('USE_LIMIT_1_TO_100');
const config=readConfig(),path=config.walletFast?.database??'data/wallet-activity.sqlite';
if([config.database,config.chainStream.database,config.walletResearch.database,config.ordersDatabase].some(p=>resolve(p)===resolve(path)))throw new Error('ACTIVITY_DATABASE_CONFLICT');
const source=new DatabaseSync(config.chainStream.database,{readOnly:true});source.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=1000');
const rows=source.prepare('SELECT data FROM chain_events ORDER BY observed_at DESC LIMIT ?').all(limit*5);source.close();
const verifier=new WalletActivityVerifier(config.chainStream.endpoints),store=new WalletActivityStore(path,config.walletFast?.maxBytes),seen=new Set<string>(),counts:Record<string,number>={};let processed=0,persisted=0;
try{
  for(const row of rows){if(processed>=limit)break;let e:any;try{e=JSON.parse(String(row.data));}catch{continue;}
    if(!chainAddress(e.chain,e.wallet)||typeof e.txHash!=='string'||!Number.isFinite(Date.parse(e.observedAt)))continue;
    const key=[e.chain,e.wallet,e.txHash].join(':');if(seen.has(key))continue;seen.add(key);
    const event:FastWalletEvent={id:e.id,chain:e.chain,wallet:e.wallet,txHash:e.txHash,tokenAddress:e.tokenAddress,blockHash:e.blockHash,slot:e.slot,
      receivedAt:e.observedAt,judgedAt:e.observedAt,processingMs:0,kind:e.chain==='solana'?'wallet_mention':e.to===e.wallet?'token_inflow':'token_outflow',
      verdict:e.removed?'retracted':'review_activity',groups:[],profileFresh:false,cachedSafety:'unknown',commitment:e.chain==='solana'?'processed':'included',removed:e.removed===true,buyVerified:false,tradingEnabled:false};
    const r=await verifier.verify(event);processed++;if(store.record(r))persisted++;counts[r.classification]=(counts[r.classification]??0)+1;
    console.log(JSON.stringify({chain:r.chain,wallet:r.wallet,txHash:r.txHash,classification:r.classification,reasons:r.reasons}));
  }
  console.log(JSON.stringify({scope:'historical_classification_only',processed,persisted,counts,signalsDispatched:0,ordersSubmitted:0}));
}finally{verifier.stop();store.close();}
