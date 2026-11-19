import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {readScanArchiveStats} from './scan-archive-stats-query.js';

const options=workerData as {database:string;trackingMs:number},port=parentPort;
if(!port||!options.database||!Number.isFinite(options.trackingMs)||options.trackingMs<=0)
  throw new Error('SCAN_ARCHIVE_STATS_WORKER_CONFIG_INVALID');

const db=new DatabaseSync(options.database,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
let stopping=false;

port.on('message',message=>{
  if(message==='stop') {
    stopping=true;db.close();port.close();return;
  }
  if(stopping||message?.type!=='refresh'||typeof message.now!=='string')return;
  const now=new Date(message.now);
  if(!Number.isFinite(now.getTime())){port.postMessage({type:'failed',at:message.now});return;}
  try {
    db.exec('BEGIN');
    const values=readScanArchiveStats(db,now,options.trackingMs);
    db.exec('COMMIT');
    port.postMessage({type:'status',values,computedAt:now.toISOString()});
  } catch {
    try{db.exec('ROLLBACK');}catch{/* no active read transaction */}
    port.postMessage({type:'failed',at:now.toISOString()});
  }
});

port.postMessage({type:'ready'});
