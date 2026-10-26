import {pathToFileURL} from 'node:url';
import {readConfig,type Config} from './config.js';
import {jsonRequest,rpc,type Fetcher} from './http.js';
import type {Chain} from './types.js';

export interface DoctorCheck {
  id:string;
  status:'pass'|'warn'|'fail';
  message:string;
}
export interface DoctorReport {
  readyForResearch:boolean;
  readyByChain:Record<Chain,boolean>;
  /** Configuration-only capability, not whether the user's live counting run is active. */
  executionDisabled:boolean;
  executionStatusSource:'configuration_only';
  configuredEntryMode:Config['entryMode'];
  configuredThirdSignalMode:Config['thirdSignalExecutionMode'];
  mode:'configuration'|'live';
  checks:DoctorCheck[];
}

// Network identities, not URLs supplied by signals:
// https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/
// https://docs.robinhood.com/chain/connecting/
// https://solana.com/docs/rpc/http/getgenesishash
// https://namespaces.chainagnostic.org/solana/caip2 (full hash, not its CAIP-2 prefix)
const SOLANA_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const RPC_ENV:Record<Chain,string>={bsc:'BSC_RPC_URL',solana:'SOLANA_RPC_URL',robinhood:'ROBINHOOD_RPC_URL'};
const CHAINS:Chain[]=['bsc','solana','robinhood'];
// Official v2 documentation uses this public post as its example.
// https://docs.fxembed.com/api/twitter/operations/2statusid/
const FX_POST_ID='20';
const present=(value:string|undefined):boolean=>typeof value==='string'&&value.trim().length>0;

function validRpc(value:string|undefined):boolean {
  if(!present(value)) return false;
  try {
    const url=new URL(value!);
    return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;
  } catch { return false; }
}

export async function runDoctor(config:Config,options:{live?:boolean;fetcher?:Fetcher}={}):Promise<DoctorReport> {
  const live=options.live===true,fetcher=options.fetcher??fetch;
  const checks:DoctorCheck[]=[];
  const add=(id:string,status:DoctorCheck['status'],message:string)=>checks.push({id,status,message});
  const nodeReady=Number(process.versions.node.split('.')[0])>=24;
  add('node',nodeReady?'pass':'fail',nodeReady?'Node 版本满足 >=24。':'需要 Node >=24；请升级后重新运行。');
  const ingestReady=present(config.ingestToken)&&config.ingestToken!.trim().length>=24;
  add('ingest',ingestReady?'pass':'fail',ingestReady?'INGEST_TOKEN 已配置且长度满足要求。':'设置至少 24 字符的 INGEST_TOKEN，服务端才能接收信号。');

  let evidenceReady=false;
  if(config.xDataProvider==='fxembed') {
    evidenceReady=true;
    add('x.provider','pass','已选择 FxEmbed，无需 X Key；返回第三方帖子副本，不等同于 X 原站核验。');
  } else if(config.xDataProvider==='x_official') {
    evidenceReady=present(config.xBearer);
    add('x.provider',evidenceReady?'pass':'fail',evidenceReady
      ?'已选择 X 官方接口且配置 X_BEARER_TOKEN；权限、额度及真实查询尚未测试。'
      :'已选择 X 官方接口；请设置 X_BEARER_TOKEN，或主动选择其他已支持渠道。');
  } else if(config.xDataProvider==='twitterapi_io') {
    evidenceReady=present(config.twitterApiIoKey);
    add('x.provider',evidenceReady?'pass':'fail',evidenceReady
      ?'已选择 TwitterAPI.io 且配置 TWITTERAPI_IO_KEY；权限、额度及真实查询尚未测试。'
      :'已选择 TwitterAPI.io；请设置其 TWITTERAPI_IO_KEY，X_BEARER_TOKEN 不能代替。');
  } else add('x.provider','fail','X_DATA_PROVIDER 无效；选择 fxembed、x_official 或 twitterapi_io。');

  const narrativeReady=config.narrativeProvider==='vendor'||(present(config.openaiKey)&&present(config.openaiModel));
  if(config.narrativeProvider==='vendor') {
    add('model','warn','使用 GMGN/DeBot 自带叙事，不需要 OPENAI_API_KEY 或 OPENAI_MODEL；BSC/Solana 缺少快照时自动按 CA 读取 DeBot 页面接口，当前预检未验证每个币的叙事可用性。评分和负面意见仅供参考。');
  } else add('model',narrativeReady?'pass':'fail',narrativeReady
    ?'已选择 OpenAI 叙事，OPENAI_API_KEY 和 OPENAI_MODEL 已配置；未调用模型，未验证权限、余额、模型可用性或 JSON Schema 支持。'
    :'已选择 OpenAI 叙事；同时设置 OPENAI_API_KEY 和支持 Responses JSON Schema 的 OPENAI_MODEL，或选择 vendor 使用供应商叙事；不会自动选择或付费测试模型。');

  const rpcReady:Record<Chain,boolean>={bsc:false,solana:false,robinhood:false};
  for(const chain of CHAINS) {
    rpcReady[chain]=validRpc(config.rpc[chain]);
    add(`rpc.${chain}`,rpcReady[chain]?'pass':present(config.rpc[chain])?'fail':'warn',rpcReady[chain]
      ?`${RPC_ENV[chain]} 已配置为 HTTP(S) 端点；${live?'将只读核验网络身份。':'尚未联网核验网络身份或权限。'}`
      :present(config.rpc[chain])?`${RPC_ENV[chain]} 格式无效；使用无 URL 用户名/密码的 HTTP(S) RPC 地址。`
        :`未设置 ${RPC_ENV[chain]}；仅在研究该链时需要，不阻断其他链。`);
  }
  const gmgnReady=present(config.gmgnApiKey)&&config.gmgnApiKey!.trim()!=='gmgn_solbscbaseethmonadtron';
  add('exits','warn',config.exitPolicy
    ?`已配置剩余持仓止盈止损：${config.exitPolicy.takeProfit.map(t=>`+${t.gainPct}%卖${t.sellPct}%`).join('、')}、-${config.exitPolicy.stopLoss.dropPct}%卖${config.exitPolicy.stopLoss.sellPct}%。实际买单需附挂GMGN条件单；网页预设无公开自动继承保证。子单活跃状态尚待真实响应核对，未验证保护时暂停新买入。`
    :'未配置退出策略；现有开单不会主动附挂止盈止损。');
  const entryMissing=CHAINS.filter(chain=>!config.entryWallets[chain]?.trim()||!config.entryInputTokens[chain]?.trim()||(config.entryBalanceBps?.[chain]===undefined&&!config.entryAmounts[chain]?.trim()));
  add('entry.configuration',entryMissing.length?'warn':'pass',entryMissing.length
    ?`以下链尚未配置完整的下单钱包、输入币和金额：${entryMissing.join('、')}；不会自动决定单笔金额。`
    :'各链已填写下单钱包、输入币和金额；仍需实际验证账户权限、报价和成交。');
  add('entry.sizing','pass',CHAINS.some(chain=>config.entryBalanceBps?.[chain]!==undefined)
    ?`按链原生币总余额比例：${CHAINS.filter(chain=>config.entryBalanceBps?.[chain]!==undefined).map(chain=>`${chain} ${(config.entryBalanceBps![chain]!/100).toFixed(2)}%`).join('、')}；本金按总余额乘比例向下取整，并受扣除手续费缓冲和未结算订单后的可用额度限制；提交前重新核验。`
    :config.entrySizing==='balance_cap'
    ?'按原生币余额与单笔本金上限动态计算金额，并扣除费用缓冲及尚未覆盖的订单占用；余额未知时不买入。'
    :'当前使用固定输入金额；未启用余额上限动态计算。');
  add('gmgn',gmgnReady?'pass':'warn',gmgnReady
    ?'个人 GMGN_API_KEY 已配置；尚未验证权限和额度。用于代币、安全、持仓、聪明钱包与资金关联分析。'
    :'未配置个人 GMGN_API_KEY；钱包研究和 GMGN 自动轮询不可用，公开测试 Key 不能用于正式运行。');
  add('wallets',!config.walletSupportRequired||gmgnReady?'pass':'warn',
    `聪明钱包支持${config.walletSupportRequired?'为必需条件':'未设为必需条件'}；标签和共同资金来源不证明真实身份，缺失或冲突不会算作已核实支持。`);
  const walletPolicyReady=!config.walletSupportRequired||config.walletMaxProfiles>=config.minSmartWalletGroups;
  add('wallets.policy',walletPolicyReady?'pass':'fail',walletPolicyReady
    ?`每个币最多深入研究 ${config.walletMaxProfiles} 个钱包，要求至少 ${config.minSmartWalletGroups} 组符合条件的资金来源。`
    :'WALLET_MAX_PROFILES 小于 MIN_SMART_WALLET_GROUPS，当前配置不可能满足钱包支持要求。');
  const creationLookupReady=present(config.etherscanKey)||gmgnReady;
  add('etherscan',creationLookupReady?'pass':'warn',creationLookupReady
    ?'BSC 创建交易可用 Etherscan（若配置）或 GMGN 创建时间提示加 RPC 官方工厂事件查找；仍需核验回执与规范区块，历史 RPC 能力尚待实测。'
    :'尚无自动创建时间/交易来源；EVM 信号需提供 creationTx，或配置个人 GMGN_API_KEY / BSC 的 ETHERSCAN_API_KEY。');
  add('goplus','warn',present(config.goPlusToken)
    ?'GoPlus Key 已配置，但安全接口、额度及每个代币的报告完整性尚未验证。'
    :'GoPlus 使用未认证公共访问；可选 GOPLUS_ACCESS_TOKEN，接口限流或缺失字段会使安全结论保持未知。');
  add('debot',config.debotScannerEnabled&&config.debotTransport==='authenticated_stream'?'pass':'warn',config.debotScannerEnabled
    ?config.debotTransport==='authenticated_stream'
      ?'DeBot 已配置认证长连接；需在控制台完成邮箱与验证器双码登录。是否已授权、信号延迟与会话失效以运行状态为准；钱包线索仍需独立核验。'
      :'DeBot 当前使用匿名诊断轮询；匿名告警有延迟，不能作为实时信号。'
    :'DeBot 叙事读取已接入；实时信号未启用，可配置 DEBOT_SCANNER_ENABLED、DEBOT_LOGIN_EMAIL 后在控制台登录。');
  add('scanner',config.scannerEnabled&&gmgnReady?'pass':'warn',config.scannerEnabled&&gmgnReady
    ?'服务启动后轮询 GMGN KOL/聪明钱买入事件；按交易原时间去重，数量有限，不等于全市场覆盖。'
    :'自动轮询尚未启用或缺少个人 GMGN Key；HTTP 导入仍可用。');
  add('robinhood.allowlist','pass','已登记 Flap 官方 Robinhood 主网 Portal；仍按实际创建事件核验，未知发行模式保持观察。');
  add('robinhood.narrative','warn','DeBot 自动叙事的 Robinhood 链范围尚未确认；可导入明确对应该链的快照，不能用同 EVM 地址推断链。');
  add('retention','pass',(config.dashboard.enabled?
    `开单明细持久化；扫描精简摘要保留 ${config.dashboard.retentionDays} 天，候选报价追踪 ${config.dashboard.trackingHours} 小时；原帖与供应商全文仅存于有限内存。`:
    '开单明细持久化；完整临时研究存于有上限的内存缓存，重启清空。')+
    (config.walletResearch.enabled?' 钱包买卖、持仓、资金关联与统计快照单独长期保存，不随扫描摘要过期删除。':''));
  if(config.walletResearch.enabled) add('wallet.history',gmgnReady?'pass':'warn',gmgnReady?
    '钱包研究已启用：归档已接收的买卖页与研究钱包样本，并定时探索涨幅榜、获利交易者；供应商采样不等于完整链上历史。':
    '钱包历史归档已启用，但缺个人 GMGN Key，额外发现任务不能联网采集。');
  add('execution',config.entryMode==='live'?'warn':'pass',config.entryMode==='off'
    ?'ENTRY_MODE=off：研究筛选的开单入口关闭；独立第三次通知策略的实盘能力与运行状态另行判断。'
    :config.entryMode==='paper'?'ENTRY_MODE=paper：研究筛选仅记录报价模拟开单；不代表独立第三次通知策略的模式。'
      :'ENTRY_MODE=live：研究筛选满足规则及配置后会提交真实开单；未在本次预检中交易或验证成交。');
  add('execution.third_signal',config.thirdSignalExecutionMode==='live'?'warn':'pass',config.thirdSignalExecutionMode==='live'
    ?'第三次通知策略配置为实盘：本人启动计数后，新的达标信号才进入实盘买入流程。本预检未读取当前运行批次，也未验证买卖成交或自动保护触发。'
    :'第三次通知策略配置为模拟，达标不会提交实盘买单。');

  if(live) {
    // At most one read-only identity call per configured chain; no fallback to a different RPC.
    const probed=await Promise.all(CHAINS.filter(chain=>rpcReady[chain]).map(async chain=>{
      try {
        const identity=await rpc(config.rpc[chain]!,chain==='solana'?'getGenesisHash':'eth_chainId',[],fetcher);
        const correct=chain==='solana'?identity===SOLANA_GENESIS
          :typeof identity==='string'&&/^0x[0-9a-f]+$/i.test(identity)&&BigInt(identity)===BigInt(chain==='bsc'?56:4663);
        return {chain,correct,reachable:true};
      } catch { return {chain,correct:false,reachable:false}; }
    }));
    for(const {chain,correct,reachable} of probed) {
      rpcReady[chain]=correct;
      add(`rpc.${chain}.live`,correct?'pass':'fail',correct
        ?`${chain} RPC 返回了预期主网身份；仅此只读请求通过，不代表其他方法、历史数据或代币检查成功。`
        :reachable?`${chain} RPC 网络身份不符或返回格式无效；检查 ${RPC_ENV[chain]} 是否为目标主网。`
          :`${chain} RPC 只读探测失败；检查端点权限、网络、限流后重试，未验证为可用。`);
    }
    if(config.xDataProvider==='fxembed') {
      let fxReady=false;
      try {
        const data=await jsonRequest(`https://api.fxtwitter.com/2/status/${FX_POST_ID}`,
          {headers:{'user-agent':'meme-signal-gate-doctor/0.1'}},fetcher);
        const post=data?.status;
        fxReady=data?.code===200&&post?.id===FX_POST_ID&&post?.type==='status'&&post?.provider==='twitter'
          &&typeof post.text==='string'&&post.text.trim().length>0&&typeof post.author?.id==='string'
          &&/^\d+$/.test(post.author.id)&&typeof post.created_at==='string'&&Number.isFinite(Date.parse(post.created_at));
      } catch { /* Never include upstream errors: they may contain credentials or entire RPC URLs. */ }
      evidenceReady=fxReady;
      add('x.fxembed.live',fxReady?'pass':'fail',fxReady
        ?'FxEmbed 公开示例帖读取通过；尚未测试搜索，也不保证任意目标帖可读，帖子内容不作为交易证据。'
        :'FxEmbed 示例帖读取失败或响应不完整；检查网络/限流后重试，本次未证明证据接口可用。');
    } else add('x.live','warn','未调用所选 X 渠道，避免产生第三方付费查询；当前只验证了配置存在。');
  } else add('network','warn','仅检查本地配置，未发出网络请求；加 --live 可只读探测已配置的 RPC 和所选 FxEmbed 渠道。');

  const commonReady=nodeReady&&ingestReady&&evidenceReady&&narrativeReady&&walletPolicyReady&&(!config.walletSupportRequired||gmgnReady);
  const readyByChain:Record<Chain,boolean>={bsc:commonReady&&rpcReady.bsc&&creationLookupReady,
    solana:commonReady&&rpcReady.solana,robinhood:false};
  for(const chain of CHAINS) add(`research.${chain}`,readyByChain[chain]?'pass':'warn',readyByChain[chain]
    ?`${chain} 的完整研究所需配置已齐；仍需用真实信号验证来源、安全及叙事结果，不是买入许可。`
    :`${chain} 尚未达到完整研究就绪条件；查看该链及共同依赖的诊断，不影响已就绪的其他链。`);
  return {readyForResearch:readyByChain.bsc||readyByChain.solana,readyByChain,
    executionDisabled:config.entryMode!=='live'&&config.thirdSignalExecutionMode!=='live',executionStatusSource:'configuration_only',
    configuredEntryMode:config.entryMode,configuredThirdSignalMode:config.thirdSignalExecutionMode,
    mode:live?'live':'configuration',checks};
}

async function main():Promise<void> {
  if(process.argv.slice(2).some(arg=>arg!=='--live')) throw new Error('USAGE');
  const report=await runDoctor(readConfig(),{live:process.argv.includes('--live')});
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.readyForResearch?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{
    console.error(JSON.stringify({readyForResearch:false,executionDisabled:true,
      checks:[{id:'configuration',status:'fail',message:'无法读取有效配置或参数；检查 .env 配置，参数仅支持 --live。'}]},null,2));
    process.exitCode=1;
  });
}
