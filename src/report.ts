import {effectiveReport} from './engine.js';
import type {Report} from './types.js';

const labels={BUY_CANDIDATE:'买入研究候选',WATCH:'观察，信息不足或条件未满足',REJECT:'拒绝'};
const status={pass:'通过当前检查',unknown:'未确认',fail:'发现阻断项'};

// Plain text only: post content is never interpreted as HTML or terminal instructions.
const plain=(s:string)=>s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,'');
export function renderReport(input:Report,now=new Date()):string {
  const report=effectiveReport(input,now),n=report.narrative.analysis;
  const lines=[`结果：${labels[report.decision]}`,`链 / CA：${report.signal.token.chain} / ${report.signal.token.address}`,
    `运行模式：${report.mode==='demo'?'模拟演示':'只读研究'}`,
    `报告 ID：${report.id}`,`信号时间：${report.signal.occurredAt}`,`评估时间：${report.evaluatedAt}`,
    `有效截止：${report.validUntil}`,`此处为研究报告；实际开单状态以开单明细为准。`,
    '',`发行来源：${status[report.provenance.status]}${report.provenance.platform?` (${report.provenance.platform})`:''}`,
    `技术安全：${status[report.safety.status]}`,`叙事判断：${status[report.narrative.status]}`];
  if(report.decisionAtEvaluation) lines.push(`评估时历史结论：${labels[report.decisionAtEvaluation]}（以当前有效性为准）`);
  if(report.wallets) {
    const w=report.wallets,s=w.summary;
    lines.push('',`钱包样本：${s.uniqueWalletCount} 个地址；仍持仓聪明钱包 ${s.smartCurrentHolderCount} 个`,
      `近期增持支持：${report.flow?status[report.flow.status]:'未确认'}；合格钱包 ${s.qualifiedSmartWalletCount} 个；资金关联分组 ${s.qualifiedSmartFundingClusterCount} 组`,
      `观察窗口：${s.recentWindowSeconds} 秒；窗口净买入 USD：${s.recentNetBuyUsd??'覆盖不足，未知'}`,
      '钱包标签由 GMGN 提供；分组只是资金关联线索，不证明同一主人，也不证明各组相互独立。');
    for(const wallet of w.wallets.slice(0,20)) {
      const who=wallet.attribution.identity;
      lines.push(`钱包 ${wallet.address}`,
        `  标签：${wallet.recognizedLabels.join('、')||'未知'}；持仓占比：${wallet.holding.supplyRatio===null?'未知':(wallet.holding.supplyRatio*100).toFixed(3)+'%'}`,
        `  归属：${who?`${who.label}（本地配置，未独立核实；${who.reference}）`:'未知'}`,
        `  平台身份线索：${wallet.vendorIdentity.name??wallet.vendorIdentity.twitterUsername??'无'}（供应商声明）`,
        `  资金来源：${wallet.funding.address??'未知'}${wallet.funding.sharedService?'（交易所或公共服务，不据此合并归属）':''}`,
        `  开发者关联：${wallet.developerLinks.join('、')||'样本中未发现'}；分组：${wallet.clusterId}`,
        `  近期净买入 USD：${wallet.enrichment.activity?.recent.netBuyUsd??'未知'}；覆盖：${wallet.enrichment.activity?.recent.coverage??'未取得'}`);
    }
  } else if(report.flow) lines.push('',`资金行为支持：${status[report.flow.status]}`);
  if(n) lines.push('',`叙事：${n.thesis}`,`催化：${n.catalyst}`,`关系：${n.relation}；阶段：${n.stage}；置信度：${n.confidence}`,
    ...n.reasons.map(s=>`判断依据：${s}`),...n.uncertainties.map(s=>`未确认：${s}`));
  const supplier=report.narrative.supplier;
  if(supplier) lines.push('',`供应商叙事：${supplier.provider}（${supplier.verification==='vendor_endpoint'?'从供应商页面接口只读取得':'用户导入，未验证供应商来源'}）`,
    `供应商更新时间：${supplier.updatedAt??'未知'}`,supplier.sourceUrl,supplier.text,
    '供应商评分和评价仅供参考；材料关联通过不代表收益预测。');
  lines.push('','原因码：',...[...new Set(report.reasons)].map(s=>`- ${s}`),'','证据：');
  for(const e of report.narrative.evidence) {
    const use=n?.supportingEvidenceIds.includes(e.id)?'支持':n?.opposingEvidenceIds.includes(e.id)?'反对':'背景';
    lines.push(`[${e.id}] ${use} | ${e.provider} | ${e.verification} | 作者ID ${e.authorId}`,
      `发布 ${e.publishedAt}；采集 ${e.fetchedAt}`,e.url,e.text,'');
  }
  if(!report.narrative.evidence.length) lines.push('没有可引用的帖子证据。');
  return plain(lines.join('\n'))+'\n';
}
