import {readConfig} from '../src/config.js';
import {buildDailyReview,readDailyReviewInput,reviewDatabasePath,reviewSamplingPath,reviewWindow,reviewRunId,shanghaiDate} from '../src/daily-review.js';
import {DailyReviewStore} from '../src/daily-review-store.js';
import {buildReviewSamplingPlan,writeReviewSamplingPlan} from '../src/review-sampling.js';
import {fetchDebotSignalPage} from '../src/providers/debot-signals.js';
import {fetchAveSignalPage} from '../src/providers/ave-signals.js';
import {DebotSessionClient} from '../src/providers/debot-session.js';
import {AveSessionClient} from '../src/providers/ave-session.js';
import {readExitQualityReview} from '../src/exit-quality.js';
import {buildShadowPolicyCandidates,readMatureFollowupSamples} from '../src/shadow-policy-candidate.js';
import {buildNotificationTriggerCandidates} from '../src/notification-trigger-candidate.js';
import {ShadowPolicyCandidateStore} from '../src/shadow-policy-candidate-store.js';

const args=process.argv.slice(2),dateIndex=args.indexOf('--date');
for(let i=0;i<args.length;i++){if(args[i]==='--date'){if(i!==dateIndex||!args[i+1])throw new Error('DAILY_REVIEW_ARGUMENT_INVALID');reviewWindow(args[++i]);}
  else if(args[i]!=='--offline')throw new Error('DAILY_REVIEW_ARGUMENT_INVALID');}
const config=readConfig(),path=reviewDatabasePath(config.dashboard.archivePath),store=new DailyReviewStore(path);
try {
  const vendorRefresh:{source:string;status:string;snapshots:number}[]=[];
  // Bounded retrospective reads only. No notification dispatch, evaluation, wallet or order action.
  if(!args.includes('--offline')){
    const debot=new DebotSessionClient({path:config.debotSessionPath});
    for(const chain of config.scannerChains.filter(c=>['bsc','solana','robinhood'].includes(c))){
      try{const page=await fetchDebotSignalPage(chain,{fetcher:debot.fetcher});let snapshots=0;
        for(const observation of page.observations)if(store.recordVendor(observation))snapshots++;
        vendorRefresh.push({source:`debot:${chain}`,status:page.reason?'unavailable':'refreshed',snapshots});
      }catch{vendorRefresh.push({source:`debot:${chain}`,status:'unavailable',snapshots:0});}
    }
    if(config.ave?.enabled&&config.ave.email){
      try{const ave=new AveSessionClient({path:config.ave.sessionPath,email:config.ave.email,readOnly:true});
        const page=await fetchAveSignalPage(config.scannerChains,{fetcher:ave.fetcher});let snapshots=0;
        for(const observation of page.observations)if(store.recordVendor(observation))snapshots++;
        vendorRefresh.push({source:'ave',status:page.reason?'unavailable':'refreshed',snapshots});
      }catch{vendorRefresh.push({source:'ave',status:'unavailable',snapshots:0});}
    }
  }
  const now=new Date(),asOf=now.toISOString(),today=reviewWindow(shanghaiDate(now));
  if(config.exitShadow.enabled&&!store.hasExitQuality(shanghaiDate(now))){
    try{
      const quality=readExitQualityReview(config.exitShadow.database,{asOf,sinceAt:new Date(now.getTime()-7*86400_000).toISOString()});
      store.saveExitQuality(quality);
      console.log(JSON.stringify({exitQuality:{asOf,reviewed:quality.reviewed,total:quality.total,summary:quality.summary}}));
    }catch{
      // This independent audit must not prevent signal review or coverage planning.
      store.exitQualityFailure(asOf);console.error('EXIT_QUALITY_REVIEW_FAILED');process.exitCode=1;
    }
  }
  const dates=dateIndex>=0?[args[dateIndex+1]]:[1,2,3].map(days=>shanghaiDate(new Date(Date.parse(today.start)-days*86400_000)));
  for(const [index,date] of dates.entries()){
    const id=reviewRunId(date,asOf);
    if(store.exists(id)){console.log(JSON.stringify({date,id,status:'already_completed'}));continue;}
    const input=readDailyReviewInput(config,date,asOf,path);
    if(vendorRefresh.some(v=>v.status==='unavailable'))input.limitations.push('部分平台本轮榜单补读不可用；保留既有带时间的快照，不替换为零。');
    if(args.includes('--offline'))input.limitations.push('本轮只读本地留存数据，没有刷新平台回溯榜单。');
    const report=buildDailyReview(input);
    if(store.exists(report.id)){console.log(JSON.stringify({date,id:report.id,status:'already_completed'}));continue;}
    let publishPlan:(()=>void)|undefined;
    // Only yesterday's full denominator changes future collection. Backfill revisions never overwrite today's plan.
    if(index===0&&report.datasetComplete&&report.counts.tokens>0&&date===shanghaiDate(new Date(Date.parse(today.start)-86400_000))){
      const plan=buildReviewSamplingPlan({asOf,windowEndAt:report.windowEndAt,cohorts:report.learning.priorities.map(({chain,source,total,covered})=>({chain,source,total,covered}))});
      publishPlan=()=>writeReviewSamplingPlan(reviewSamplingPath(config.dashboard.archivePath),plan);
      report.learning.status='research_plan_applied';report.learning.planId=plan.id;
      report.learning.notes.push(`已发布 ${plan.policyVersion}：从 ${asOf} 起生效，48 小时未续更则自动回退；采样总预算不增加。`);
    }else if(!report.datasetComplete){report.learning.status='unavailable';report.learning.notes.push('本轮信号分母或行情读取不完整，暂停发布新的采样优先级。');}
    else report.learning.notes.push('本报告用于回补对照或样本仍不足，不覆盖最新前向采样计划。');
    store.save(report,publishPlan);
    console.log(JSON.stringify({date,id:report.id,status:'completed',counts:report.counts,learning:report.learning.status,datasetComplete:report.datasetComplete}));
  }
  const shadowStore=new ShadowPolicyCandidateStore(path);
  try{
    const featureCandidates=buildShadowPolicyCandidates({asOf,samples:readMatureFollowupSamples(config.dashboard.archivePath,asOf)});
    const triggerCandidates=buildNotificationTriggerCandidates({asOf,outcomes:store.notificationOutcomes()});
    const saved=shadowStore.saveAll([...featureCandidates,...triggerCandidates]);
    shadowStore.prune(now);
    console.log(JSON.stringify({shadowCandidates:{generated:featureCandidates.length+triggerCandidates.length,saved,
      ready:[...featureCandidates,...triggerCandidates].filter(candidate=>candidate.status==='shadow_ready').length}}));
  }catch{
    // Candidate research is independent and can never block or mutate the saved daily report.
    shadowStore.failure(asOf);console.error('SHADOW_POLICY_CANDIDATE_FAILED');
  }finally{shadowStore.close();}
  store.prune(now);store.markRunSucceeded(new Date().toISOString());console.log(JSON.stringify({vendorRefresh}));
}catch{store.failure(new Date().toISOString());console.error('DAILY_REVIEW_FAILED');process.exitCode=1;}
finally{store.close();}
