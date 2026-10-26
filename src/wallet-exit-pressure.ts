import type {DatabaseSync} from 'node:sqlite';
import type {WalletPressure,WalletPressureTrade,WalletTradeSource} from './adaptive-exit.js';
import {chainAddress} from './chain-stream-store.js';
import type {WalletHistoryToken,WalletTradeObservation} from './wallet-history.js';

const SOURCES=new Set(['gmgn_wallet_activity','gmgn_kol_feed','gmgn_smartmoney_feed',
  'gmgn_association_candidate_activity','gmgn_association_leader_activity','gmgn_association_wallet_activity']);
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&
  new Date(Date.parse(value)).toISOString()===value;

/** Read research-only wallet pressure at one immutable quote cutoff. */
export function readRecentExitPressure(db:DatabaseSync,value:WalletHistoryToken,sampleAt:string,now=Date.now()):WalletPressure|undefined {
  const address=chainAddress(value.chain,value.address);
  if(!address||!stamp(sampleAt)||Date.parse(sampleAt)>now)return;
  const start=new Date(Date.parse(sampleAt)-600_000).toISOString();
  const rows=db.prepare(`SELECT id,event_id,data FROM wh_observations INDEXED BY wh_exit_evidence
    WHERE chain=? AND token_address=? AND kind='trade' AND observed_at>=? AND observed_at<=?
    ORDER BY observed_at,id LIMIT 501`).all(value.chain,address,start,sampleAt);
  if(rows.length>500)return;
  const known=new Map<string,boolean>();
  type Evidence={trade:WalletPressureTrade;eventAt:string;amount:number;conflict:boolean};
  const groups=new Map<string,Map<string,Evidence>>();
  const publicWallet=db.prepare(`SELECT 1 FROM wh_observations WHERE chain=? AND wallet=? AND kind='trade'
    AND source IN ('gmgn_kol_feed','gmgn_smartmoney_feed') AND observed_at<=? LIMIT 1`);
  const relationship=db.prepare(`SELECT 1 FROM wh_assoc_relations WHERE chain=? AND candidate=? AND first_at<=?
    AND active_since<=? AND dirty=0 AND token_count>0 LIMIT 1`);
  for(const row of rows) {
    let raw:WalletTradeObservation;try{raw=JSON.parse(String(row.data)) as WalletTradeObservation;}catch{continue;}
    if(raw.chain!==value.chain||raw.tokenAddress!==address||!SOURCES.has(raw.source)||!['buy','sell'].includes(raw.side)||!raw.usd||
      !stamp(raw.eventAt)||raw.eventAt<start||raw.eventAt>sampleAt||!stamp(raw.observedAt)||raw.observedAt>sampleAt||raw.eventAt>raw.observedAt)continue;
    const usd=Number(raw.usd);if(!Number.isFinite(usd)||usd<=0||usd>1e12)continue;
    if(!known.has(raw.wallet))known.set(raw.wallet,!!publicWallet.get(value.chain,raw.wallet,sampleAt)||
      !!relationship.get(value.chain,raw.wallet,sampleAt,sampleAt));
    if(!known.get(raw.wallet))continue;
    const key=JSON.stringify([raw.txHash,raw.wallet,raw.side]);
    let group=groups.get(key);if(!group){group=new Map();groups.set(key,group);}
    const index=raw.eventIndex===undefined?'unindexed':String(raw.eventIndex),previous=group.get(index);
    if(previous){if(previous.eventAt!==raw.eventAt||previous.amount!==usd)previous.conflict=true;continue;}
    group.set(index,{eventAt:raw.eventAt,amount:usd,conflict:false,trade:{evidenceId:String(row.id),wallet:raw.wallet,
      side:raw.side as 'buy'|'sell',volumeUsd:usd,eventAt:raw.eventAt,observedAt:raw.observedAt,source:raw.source as WalletTradeSource}});
  }
  const trades:WalletPressureTrade[]=[];
  for(const group of groups.values()) {
    if([...group.values()].some(e=>e.conflict))continue;
    const unindexed=group.get('unindexed'),indexed=[...group.entries()].filter(([key])=>key!=='unindexed').map(([,item])=>item);
    if(unindexed&&indexed.length){if(indexed.length!==1||unindexed.amount!==indexed[0].amount||unindexed.eventAt!==indexed[0].eventAt)continue;trades.push(indexed[0].trade);}
    else trades.push(...[...group.values()].map(item=>item.trade));
  }
  if(!trades.length||trades.length>100)return;
  return {chain:value.chain,address,observedAt:sampleAt,windowStartAt:start,windowEndAt:sampleAt,trades};
}
