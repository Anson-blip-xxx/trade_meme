type RiskStatus='pass'|'fail'|'unknown';
type RiskKey='safety'|'provenance'|'market'|'wallets';

export interface DebotRiskScoreInput {
  state:string;
  checks:unknown;
  decision?:string;
  validUntil?:string;
  reasons?:string[];
}
export interface DebotRiskScore {
  value:number;
  max:100;
  version:'risk-evidence-v1';
  components:{key:RiskKey;label:string;weight:number;earned:number;status:RiskStatus}[];
  blocked:boolean;
  provisional:boolean;
  stale:boolean;
  reasons:string[];
}

const components:readonly {key:RiskKey;label:string;weight:number;hard:boolean}[]=[
  {key:'safety',label:'合约安全',weight:30,hard:true},
  {key:'provenance',label:'发行来源',weight:15,hard:true},
  {key:'market',label:'市场数据',weight:15,hard:true},
  {key:'wallets',label:'钱包行为',weight:40,hard:false},
];
const isObject=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:unknown,key:string):unknown=>
  isObject(value)&&Object.hasOwn(value,key)?value[key]:undefined;

function timestamp(value:unknown):number {
  // These fields are server timestamps, never arbitrary date-like strings or numbers.
  if(typeof value!=='string'||value.length>40)return NaN;
  const parts=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts)return NaN;
  // Date.parse normalizes e.g. February 30; reject impossible calendar fields first.
  const calendar=Date.parse(`${parts[1]}Z`);
  if(!Number.isFinite(calendar)||new Date(calendar).toISOString().slice(0,19)!==parts[1])return NaN;
  return Date.parse(value);
}

function safeReasons(value:unknown):string[] {
  if(!Array.isArray(value))return [];
  // Do not publish upstream prose, response bodies, credentials or arbitrary object keys.
  return value.slice(0,32).filter((reason):reason is string=>
    typeof reason==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(reason));
}

/**
 * Display-only weighted evidence score, not a win probability or an entry decision.
 * Stale passing evidence keeps its historical score and is explicitly marked stale.
 * An unknown check earns nothing; narrative ratings never affect this score.
 */
export function scoreDebotRisk(input:DebotRiskScoreInput,now:Date):DebotRiskScore {
  const state=own(input,'state'),checks=own(input,'checks');
  const completed=state==='completed',nowMs=now instanceof Date?now.getTime():NaN;
  const generated=new Set<string>();
  const sourceReasons=safeReasons(own(input,'reasons'));
  let blocked=own(input,'decision')==='REJECT';
  let provisional=!completed,stale=!Number.isFinite(nowMs);
  if(blocked)generated.add('RISK_SCORE_REJECTED');
  if(!completed)generated.add('RISK_SCORE_PENDING');
  if(stale)generated.add('RISK_SCORE_CLOCK_INVALID');

  const scored=components.map(component=>{
    const check=own(checks,component.key),rawStatus=own(check,'status');
    const status:RiskStatus=rawStatus==='pass'||rawStatus==='fail'?rawStatus:'unknown';
    if(status==='unknown'){
      provisional=true;
      generated.add('RISK_SCORE_INCOMPLETE');
    }
    if(component.hard&&status==='fail'){
      blocked=true;
      generated.add(`RISK_SCORE_${component.key.toUpperCase()}_FAILED`);
    }
    sourceReasons.push(...safeReasons(own(check,'reasons')));
    // A not-yet-returned stage has no timestamp to expire. Completed missing stages do.
    if(isObject(check)||completed){
      const checkedAt=timestamp(own(check,'checkedAt'));
      if(!Number.isFinite(checkedAt)){
        stale=true;
        generated.add('RISK_SCORE_INVALID_CHECK_TIME');
      }else if(Number.isFinite(nowMs)){
        if(nowMs-checkedAt>=120_000){
          stale=true;
          generated.add('RISK_SCORE_STALE_CHECK');
        }
        if(checkedAt>nowMs+30_000){
          stale=true;
          generated.add('RISK_SCORE_FUTURE_CHECK_TIME');
        }
      }
    }
    return {key:component.key,label:component.label,weight:component.weight,
      earned:status==='pass'?component.weight:0,status};
  });

  const rawValidUntil=own(input,'validUntil');
  if(rawValidUntil!==undefined||completed){
    const validUntil=timestamp(rawValidUntil);
    if(!Number.isFinite(validUntil)){
      stale=true;
      generated.add('RISK_SCORE_INVALID_VALIDITY');
    }else if(Number.isFinite(nowMs)&&validUntil<=nowMs){
      stale=true;
      generated.add('RISK_SCORE_EXPIRED');
    }
  }
  return {value:blocked?0:scored.reduce((sum,component)=>sum+component.earned,0),max:100,
    version:'risk-evidence-v1',components:scored,blocked,provisional,stale,
    reasons:[...new Set([...generated,...sourceReasons])].slice(0,32)};
}
