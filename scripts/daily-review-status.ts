import {pathToFileURL} from 'node:url';
import {readConfig} from '../src/config.js';
import {reviewDatabasePath} from '../src/daily-review.js';
import {DailyReviewStore} from '../src/daily-review-store.js';

/** ExecStopPost also runs when V8 aborts or systemd kills the review process. */
export function recordDailyReviewServiceResult(options:{result:string|undefined;path:string;now?:()=>Date}):void {
  if(options.result==='success')return;
  const store=new DailyReviewStore(options.path);
  try {store.failure((options.now?.()??new Date()).toISOString());}
  finally {store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.env.SERVICE_RESULT!=='success') {
      const config=readConfig();
      recordDailyReviewServiceResult({result:process.env.SERVICE_RESULT,path:reviewDatabasePath(config.dashboard.archivePath)});
    }
  }catch {
    console.error('DAILY_REVIEW_STATUS_FAILED');process.exitCode=1;
  }
}
