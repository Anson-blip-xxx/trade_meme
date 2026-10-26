import {DatabaseSync} from 'node:sqlite';
import {chainAddress} from './chain-stream-store.js';
import type {MemeAssessment,MemeMarketSample} from './meme-assessment.js';
import type {MemeCatalystSnapshot} from './meme-catalyst.js';
import type {MemePage} from './meme-observer.js';
import type {SourceCorroborationAssessment} from './source-corroboration.js';
import type {Chain,Signal} from './types.js';
import {ReviewSamplingPlanReader,type ReviewSamplingSource} from './review-sampling.js';

type Token=Signal['token'];
type Row=Record<string,any>;
const parse=<T>(value:unknown):T|undefined=>{try{return value?JSON.parse(String(value)) as T:undefined;}catch{return;}};
const millis=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)?Date.parse(value):NaN;
const iso=(value:number)=>new Date(value).toISOString();
const key=(token:Token)=>`${token.chain}:${token.address}`;
function token(input:Token):Token|undefined {
  if(!input||!['bsc','solana','robinhood'].includes(input.chain))return;
  const address=chainAddress(input.chain,input.address);
  if(!address||/^0x0{40}$/.test(address)||address==='11111111111111111111111111111111')return;
  return {chain:input.chain,address};
}

export interface MemeDashboardReaderOptions {
  database:string;maxActive:number;activeWindowSec:number;allowedChains:Chain[];
  samplingPlanPath?:string;
  corroboration?:(token:Token,now:Date)=>SourceCorroborationAssessment;
}

/** Read-only projection used by the dashboard worker. Its SQL and response
 * shape intentionally mirror MemeObserver.list/detail without running schema,
 * retention, sampling or market collection work. */
export class MemeDashboardReader {
  private readonly db:DatabaseSync;
  private readonly windowMs:number;
  private readonly sampling:ReviewSamplingPlanReader;
  constructor(private readonly options:MemeDashboardReaderOptions){
    this.windowMs=options.activeWindowSec*1000;this.sampling=new ReviewSamplingPlanReader(options.samplingPlanPath);
    this.db=new DatabaseSync(options.database,{readOnly:true});
    this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
  }
  close():void {this.db.close();}
  private page(options:MemePage,now:Date){
    const {limit=20,offset=0,asOf=now.toISOString(),chain}=options;
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||
      !Number.isFinite(millis(asOf))||iso(millis(asOf))!==asOf||chain&&!['bsc','solana','robinhood'].includes(chain))throw new Error('INVALID_FILTER');
    return {limit,offset,asOf,chain};
  }
  private activeRows(now:Date):Row[] {
    if(!this.options.allowedChains.length)return [];
    const cutoff=iso(now.getTime()-this.windowMs),marks=this.options.allowedChains.map(()=>'?').join(','),
      fields="chain,address,last_signal_at,first_seen_at,market_attempt_at,last_sample_at,json_extract(signal,'$.source') AS sampling_source",
      where=`last_signal_at>=? AND chain IN (${marks})`,plan=this.sampling.read().plan;
    if(!plan)return this.db.prepare(`SELECT ${fields},catalyst FROM meme_tokens WHERE ${where} ORDER BY last_signal_at DESC,chain,address LIMIT ?`)
      .all(cutoff,...this.options.allowedChains,this.options.maxActive);
    const order="MAX(COALESCE(market_attempt_at,''),COALESCE(last_sample_at,'')),first_seen_at,chain,address",
      fair=this.db.prepare(`SELECT ${fields} FROM meme_tokens WHERE ${where} ORDER BY ${order} LIMIT 600`).all(cutoff,...this.options.allowedChains),
      cohorts=plan.cohorts.filter(item=>item.weight===2).map(item=>({cohort:item,deficit:item.missing/item.total})),
      priority=cohorts.length?this.db.prepare(`SELECT ${fields} FROM meme_tokens WHERE ${where} ORDER BY CASE ${cohorts.map(()=>
        "WHEN chain=? AND json_extract(signal,'$.source')=? THEN ?").join(' ')} ELSE 0 END DESC,${order} LIMIT 600`)
        .all(cutoff,...this.options.allowedChains,...cohorts.flatMap(({cohort,deficit})=>[cohort.chain,cohort.source,deficit])):[],
      selected:Row[]=[],seen=new Set<string>(),source=(row:Row):ReviewSamplingSource|undefined=>row.sampling_source,
      deficit=(row:Row)=>{const item=plan.cohorts.find(value=>value.chain===row.chain&&value.source===source(row));return item?.total?item.missing/item.total:0;},
      add=(row:Row)=>{const value=`${row.chain}:${row.address}`;if(seen.has(value)||selected.length>=this.options.maxActive)return;seen.add(value);selected.push(row);};
    fair.slice(0,Math.ceil(this.options.maxActive/2)).forEach(add);priority.filter(row=>deficit(row)>0).forEach(add);fair.forEach(add);
    if(!selected.length)return selected;
    const details=new Map(this.db.prepare(`SELECT chain,address,catalyst FROM meme_tokens WHERE (chain,address) IN (VALUES ${selected.map(()=>'(?,?)').join(',')})`)
      .all(...selected.flatMap(row=>[row.chain,row.address])).map(row=>[`${row.chain}:${row.address}`,row]));
    return selected.map(row=>({...row,...details.get(`${row.chain}:${row.address}`)}));
  }
  private active(now:Date):Set<string> {return new Set(this.activeRows(now).map(row=>`${row.chain}:${row.address}`));}
  status(now:Date,base:Record<string,unknown>={},rows=this.activeRows(now)){
    const cutoff=iso(now.getTime()-this.windowMs),marks=this.options.allowedChains.map(()=>'?').join(','),
      recent=this.options.allowedChains.length?Number(this.db.prepare(`SELECT count(*) AS n FROM meme_tokens WHERE last_signal_at>=? AND chain IN (${marks})`)
        .get(cutoff,...this.options.allowedChains)!.n):0,fresh=rows.filter(row=>row.last_sample_at&&now.getTime()-millis(row.last_sample_at)<=120000).length,
      catalysts=rows.map(row=>parse<MemeCatalystSnapshot>(row.catalyst)),
      catalystFresh=catalysts.filter(value=>value&&value.status!=='unknown'&&millis(value.expiresAt)>now.getTime()).length,
      catalystPending=catalysts.filter(value=>!value).length,catalystUnknown=catalysts.filter(value=>value?.status==='unknown').length,sampling=this.sampling.read();
    return {...base,active:rows.length,waiting:Math.max(0,recent-rows.length),fresh,stale:rows.length-fresh,
      samplingPlan:{status:sampling.status,reason:sampling.reason,scope:'research_sampling_only',candidateLimit:1200,
        ...(sampling.plan?{id:sampling.plan.id,policyVersion:sampling.plan.policyVersion,effectiveAt:sampling.plan.effectiveAt,
          expiresAt:sampling.plan.expiresAt,fairShare:sampling.plan.fairShare,cohorts:sampling.plan.cohorts}:{})},
      catalystFresh,catalystPending,catalystUnknown,catalystStale:rows.length-catalystFresh-catalystPending-catalystUnknown};
  }
  private corroboration(value:Token,now:Date):SourceCorroborationAssessment|undefined {
    try{return this.options.corroboration?.(value,now);}catch{return;}
  }
  private project(row:Row,active:Set<string>,now:Date,full=false){
    const value={chain:row.chain as Chain,address:String(row.address)},catalyst=parse<MemeCatalystSnapshot>(row.catalyst);
    const corroboration=this.corroboration(value,now);
    return {...value,name:row.name??undefined,symbol:row.symbol??undefined,firstSeenAt:row.first_seen_at,lastSignalAt:row.last_signal_at,
      corroboration,lastSampleAt:row.last_sample_at??undefined,nextSampleAt:row.market_attempt_at?iso(millis(row.market_attempt_at)+30000):undefined,
      observationState:millis(row.last_signal_at)<now.getTime()-this.windowMs?'expired':active.has(key(value))?'active':'waiting',
      sampleCount:Number(row.sample_count),stale:!row.last_sample_at||now.getTime()-millis(row.last_sample_at)>120000,
      assessment:parse<MemeAssessment>(row.assessment),market:parse<MemeMarketSample>(row.market),gate:parse(row.gate),
      ...(full?{catalyst}:catalyst?{catalyst:{status:catalyst.status,observedAt:catalyst.observedAt,expiresAt:catalyst.expiresAt,reasons:catalyst.reasons,
        supplier:catalyst.supplier?{provider:catalyst.supplier.provider,summary:catalyst.supplier.summary,fresh:catalyst.supplier.fresh,generatedAt:catalyst.supplier.generatedAt}:undefined,
        diffusion:catalyst.diffusion,celebrities:catalyst.celebrities,sourceTweetCount:catalyst.sourceTweetCount,
        evidence:{requestedPostCount:catalyst.evidence.requestedPostCount,retrievedPostCount:catalyst.evidence.retrievedPostCount}}}:{}),error:row.error??undefined};
  }
  list(options:MemePage={},context:{now:string;status:unknown}){
    const now=new Date(context.now),{limit,offset,asOf,chain}=this.page(options,now),args=[asOf,...(chain?[chain]:[])],
      where='first_seen_at<=?'+(chain?' AND chain=?':'');
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM meme_tokens WHERE ${where}`).get(...args)!.n);
    const rows=this.db.prepare(`SELECT * FROM meme_tokens WHERE ${where} ORDER BY first_seen_at DESC,chain,address LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const activeRows=this.activeRows(now),active=new Set(activeRows.map(row=>`${row.chain}:${row.address}`));
    const base=context.status&&typeof context.status==='object'&&!Array.isArray(context.status)?context.status as Record<string,unknown>:{};
    return {now:context.now,asOf,total,limit,offset,hasMore:offset+rows.length<total,status:this.status(now,base,activeRows),items:rows.map(row=>this.project(row,active,now))};
  }
  detail(input:Token,options:MemePage={},context:{now:string}){
    const value=token(input);if(!value)throw new Error('INVALID_FILTER');
    const now=new Date(context.now),{limit,offset,asOf}=this.page(options,now),row=this.db.prepare('SELECT * FROM meme_tokens WHERE chain=? AND address=?').get(value.chain,value.address);
    const total=Number(this.db.prepare(`SELECT count(*) AS n FROM meme_snapshots WHERE chain=? AND address=? AND observed_at<=? AND json_extract(assessment,'$.assessedAt')<=?`)
      .get(value.chain,value.address,asOf,asOf)!.n);
    const rows=this.db.prepare(`SELECT * FROM meme_snapshots WHERE chain=? AND address=? AND observed_at<=? AND json_extract(assessment,'$.assessedAt')<=?
      ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?`).all(value.chain,value.address,asOf,asOf,limit,offset);
    const active=this.active(now);
    return {token:row?this.project(row,active,now,true):{...value,observationState:'waiting',sampleCount:0},asOf,total,limit,offset,
      hasMore:offset+rows.length<total,items:rows.map(item=>({id:item.id,observedAt:item.observed_at,source:item.source,
        market:parse(item.market),assessment:parse(item.assessment),corroboration:parse<SourceCorroborationAssessment>(item.corroboration),outcomes:this.outcomes(item,asOf)})),
      catalystHistory:this.db.prepare('SELECT observed_at,data FROM meme_catalysts WHERE chain=? AND address=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 6')
        .all(value.chain,value.address,asOf).map(item=>({observedAt:item.observed_at,snapshot:parse(item.data)})),
      samplingAudit:this.db.prepare(`SELECT plan_id,channel,source,reason,first_selected_at,last_selected_at,selections,signal_observed_at
        FROM meme_sampling_selections WHERE chain=? AND address=? AND first_selected_at<=? ORDER BY first_selected_at DESC,plan_id,channel,reason LIMIT 12`)
        .all(value.chain,value.address,asOf).map(item=>({planId:item.plan_id,channel:item.channel,source:item.source,reason:item.reason,
          firstSelectedAt:item.first_selected_at,signalObservedAt:item.signal_observed_at,
          ...(String(item.last_selected_at)<=asOf?{lastSelectedAt:item.last_selected_at,selections:item.selections}:{})}))};
  }
  private outcomes(row:Row,asOf:string){
    const market=parse<MemeMarketSample>(row.market),result:{horizonSec:number;returnPct:number|null;observedAt?:string}[]=[];
    for(const seconds of [300,900,3600]){
      const target=millis(parse<MemeAssessment>(row.assessment)?.assessedAt??row.observed_at)+seconds*1000;
      const future=this.db.prepare(`SELECT observed_at,market FROM meme_snapshots WHERE chain=? AND address=? AND source=? AND observed_at>=? AND observed_at<=?
        AND observed_at<=? AND json_extract(assessment,'$.assessedAt')<=? ORDER BY observed_at LIMIT 1`)
        .get(row.chain,row.address,row.source,iso(target),iso(target+120000),asOf,asOf),sample=parse<MemeMarketSample>(future?.market);
      const pct=sample&&market?.priceUsd&&sample.priceUsd&&!!market.poolAddress&&sample.poolAddress===market.poolAddress?(sample.priceUsd/market.priceUsd-1)*100:null;
      result.push({horizonSec:seconds,returnPct:pct!==null&&Number.isFinite(pct)?pct:null,...(pct!==null?{observedAt:String(future!.observed_at)}:{})});
    }
    return {scope:'subsequent_observed_prices',notTradingReturn:true,items:result};
  }
}
