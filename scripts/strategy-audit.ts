import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {readConfig} from '../src/config.js';
import type {ScanRecord} from '../src/scan-archive.js';

// Read-only snapshot of retained evaluations. Rechecks overwrite the last report;
// this is a coverage/funnel audit, never a reconstruction of historical decisions.
const config=readConfig(process.env),now=new Date();
const db=new DatabaseSync(config.dashboard.archivePath,{readOnly:true});
const rows=db.prepare('SELECT record FROM scan_summaries').all().map(r=>JSON.parse(String(r.record)) as ScanRecord);
const key=(r:{chain:string;address:string})=>`${r.chain}:${r.address}`;
const live=rows.filter(r=>r.mode==='live'&&r.status==='completed').sort((a,b)=>(a.evaluatedAt??'').localeCompare(b.evaluatedAt??'')||a.id.localeCompare(b.id));
const latest=[...new Map(live.map(r=>[key(r),r])).values()];
const eligible=[...new Map([...live].filter(r=>r.performance).sort((a,b)=>b.performance!.eligibleAt.localeCompare(a.performance!.eligibleAt)).map(r=>[key(r),r])).values()];
const knownBlock=['SIGNAL_STALE','SIGNAL_TIME_IN_FUTURE','LAUNCHPAD_MODE_NOT_SUPPORTED','NARRATIVE_TOKEN_IDENTITY_CONFLICT','WALLET_SETUP_SUPPORT_WITHDRAWN'];
const onlyWallet=(r:ScanRecord)=>r.checks.provenance.status==='pass'&&r.checks.safety.status==='pass'&&
  r.checks.flow.status!=='pass'&&!r.reasons.some(v=>knownBlock.includes(v));
const count=(items:ScanRecord[],value:(r:ScanRecord)=>string)=>Object.fromEntries([...items.reduce((m,r)=>{
  const k=value(r);m.set(k,(m.get(k)??0)+1);return m;
},new Map<string,number>())].sort((a,b)=>b[1]-a[1]));
const summarize=(items:ScanRecord[])=>({tokens:items.length,policyVersions:count(items,r=>r.policyVersion??'legacy_unrecorded'),latestArchivedDecisions:count(items,r=>r.decision??'PENDING'),
  currentEligible:items.filter(r=>r.buyEligible&&Date.parse(r.validUntil??'')>now.getTime()).length,
  onlyWalletSupportMissing:items.filter(onlyWallet).length,
  qualifiedGroupsWhenOnlyWalletMissing:count(items.filter(onlyWallet),r=>String(r.wallets?.summary.qualifiedSmartFundingClusterCount??'unknown')),
  modeUnsupported:items.filter(r=>r.reasons.includes('LAUNCHPAD_MODE_NOT_SUPPORTED')).length,
  checks:Object.fromEntries(['provenance','safety','flow'].map(k=>[k,count(items,r=>r.checks[k as 'provenance'].status)]))});
const oneGroup=latest.filter(r=>onlyWallet(r)&&r.checks.wallets.status==='pass'&&
  r.wallets?.summary.qualifiedSmartFundingClusterCount===1&&r.wallets.summary.hasRecentAccumulation===true);
let fixedHorizon:unknown={available:false};
if(existsSync(config.exitShadow.database)) {
  const shadow=new DatabaseSync(config.exitShadow.database,{readOnly:true});
  try {
    const positions=shadow.prepare('SELECT id,chain,address,eligible_at FROM exit_shadow_positions ORDER BY eligible_at').all();
    const first=[...new Map([...positions].reverse().map(r=>[`${r.chain}:${r.address}`,r])).values()];
    fixedHorizon={available:true,uniqueTokens:first.length,horizons:[3600,21600,86400].map(seconds=>{
      const returns:number[]=[],gaps:number[]=[];let matured=0,lateOrMissing=0;
      for(const p of first) {
        const eligibleAt=Date.parse(String(p.eligible_at)),end=eligibleAt+seconds*1000;
        if(end>now.getTime())continue;matured++;
        const prices=shadow.prepare('SELECT at,price FROM exit_shadow_samples WHERE position_id=? AND at<=? ORDER BY at')
          .all(p.id,new Date(end+600000).toISOString());
        const base=prices[0],last=prices.find(r=>Date.parse(String(r.at))>=end);
        if(!base||!last||Date.parse(String(base.at))-eligibleAt>600000||Number(base.price)<=0){lateOrMissing++;continue;}
        const selected=prices.filter(r=>String(r.at)<=String(last.at));
        gaps.push(Math.max(0,...selected.slice(1).map((r,i)=>(Date.parse(String(r.at))-Date.parse(String(selected[i].at)))/1000)));
        returns.push((Number(last.price)/Number(base.price)-1)*100);
      }
      returns.sort((a,b)=>a-b);const middle=Math.floor(returns.length/2);
      return {seconds,matured,covered:returns.length,lateOrMissing,
        medianSampleGainPct:returns.length?(returns[middle]+returns[Math.floor((returns.length-1)/2)])/2:null,
        positive:returns.filter(x=>x>0).length,largestSampleGapSec:gaps.length?Math.max(...gaps):null};
    })};
  }finally{shadow.close();}
}
const output={asOf:now.toISOString(),timezone:'Asia/Shanghai',scope:'retained_latest_evaluations_per_chain_and_ca',
  limitations:['Duplicate scans are not independent samples.','Watch rechecks overwrite prior report snapshots.',
    'Historical price tracking covers eligible tokens only; missing controls prevent profitability claims about relaxed gates.',
    'Observed peaks and horizon quotes exclude execution costs and are not realized returns.'],
  records:rows.length,uniqueTokens:new Set(rows.map(key)).size,everEligibleTokens:eligible.length,
  latest:summarize(latest),last24hLatest:summarize(latest.filter(r=>Date.parse(r.evaluatedAt??'')>=now.getTime()-86400000)),
  chains:Object.fromEntries(['bsc','solana','robinhood'].map(chain=>[chain,summarize(latest.filter(r=>r.chain===chain))])),
  counterfactualCoverageOnly:{oneGroupKeepingOtherGuards:oneGroup.length,minNetBuyUsd:[0,25,50,100,200,500].map(usd=>({usd,
    tokens:oneGroup.filter(r=>usd===0||r.wallets?.summary.recentNetBuyUsd!=null&&Number(r.wallets.summary.recentNetBuyUsd)>=usd).length}))},
  eligibleSamplePeaks:{tokens:eligible.length,atLeast100Pct:eligible.filter(r=>(r.performance?.maxGainPct??0)>=100).length,
    latestNegative:eligible.filter(r=>(r.performance?.currentGainPct??0)<0).length},fixedHorizon};
db.close();console.log(JSON.stringify(output,null,2));
