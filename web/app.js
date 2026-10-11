'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const API = '/dashboard/api';
  const PAGE_SIZE = 25;
  const chainNames = {bsc: 'BSC', solana: 'Solana', robinhood: 'Robinhood'};
  const chainSymbols = {bsc: 'BNB', solana: 'SOL', robinhood: 'ETH'};
  const views = {
    scans: ['信号扫描', '从链上信号到筛选依据，让每一次观察都有迹可循。'],
    candidates: ['条件后追踪', '回看曾通过研究判断的信号，观察此后的价格表现。'],
    wallets: ['钱包研究', '回查公开钱包之前的买入者，持续验证跨币时序与资金联系。'],
    protection: ['止盈保护', '前瞻验证动态保护线与触发建议，观察利润回撤时策略会如何响应。'],
    orders: ['订单记录', '核对实际订单、执行结果与退出保护状态。'],
    system: ['运行状态', '查看扫描进度、资金上限与服务端的运行配置。'],
  };
  const decisions = {BUY_CANDIDATE: ['买入候选', 'pass'], WATCH: ['继续观察', 'watch'], REJECT: ['已排除', 'fail']};
  const orderStatuses = {prepared: ['已准备', 'neutral'], submitting: ['提交中', 'watch'], submitted: ['已提交', 'watch'], confirmed: ['已确认', 'pass'], unknown: ['结果未知', 'watch'], failed: ['失败', 'fail'], paper_open: ['模拟开仓', 'neutral']};
  const exitStatuses = {awaiting_swap: '等待成交', paper: '模拟保护', unverified: '未验证', monitoring: '监控中', attention: '需要关注', closed: '已平仓'};
  const stageNames = {emerging: '萌芽', spreading: '传播中', crowded: '拥挤', fading: '热度回落', unknown: '阶段未知'};
  const assessmentNames = {favorable: '研究判断有利', watch: '继续观察', adverse: '研究判断不利'};
  const checkNames = {provenance: '发行来源', safety: '合约与安全', narrative: '叙事参考（非必需）', wallets: '钱包样本', flow: '近期资金流'};
  const reasonNames = {
    OFFICIAL_FACTORY_CREATION_VERIFIED: '已验证来自配置中的官方发行工厂',
    SECURITY_FIELDS_UNVERIFIED: '部分安全字段尚未核实',
    GMGN_REPORTED_FLAGS_CLEAR_PARTIAL_COVERAGE: 'GMGN 已覆盖的风险项未报告异常，但覆盖不完整',
    VENDOR_NARRATIVE_MISSING: '暂无供应商叙事材料，不作为开单阻断条件',
    SUPERSEDED: '更新的信号已接替本轮观察',
    SIGNAL_EXPIRED: '原始信号已超过有效窗口',
    SIGNAL_TIME_IN_FUTURE: '信号时间异常，未加入观察队列',
    WINDOW_EXPIRED: '观察窗口已结束',
    BUY_CANDIDATE: '已通过研究条件',
    REJECTED: '已发现明确阻断项',
    LEGACY_SIGNAL_UNAVAILABLE: '历史原始信号不完整，无法加入自动复评',
    SIGNAL_UNSAFE: '信号未满足安全校验要求',
    OBSERVATION_WINDOW_ENDED: '观察窗口已结束',
    OBSERVATION_EXPIRED: '观察窗口已结束',
    WATCH_WINDOW_EXPIRED: '观察窗口已结束',
    OBSERVATION_REJECTED: '复评发现明确阻断项',
    OBSERVATION_PASSED: '复评已通过研究条件',
    OBSERVATION_SUPERSEDED: '已由更新的信号接续观察',
    OBSERVATION_RECHECK_FAILED: '本次复评暂未完成，等待后续重试',
    WALLET_TAGS_ARE_VENDOR_CLAIMS: '钱包标签来自供应商，不构成身份核验',
    WALLET_OWNERSHIP_UNVERIFIED: '钱包的实际归属尚未核实',
    CUMULATIVE_VOLUMES_ARE_NOT_RECENT_FLOW: '累计交易量不能替代近期资金流',
    PLATFORM_ORIGIN_NOT_VERIFIED: '发行平台来源尚未验证',
    TECHNICAL_SAFETY_NOT_PASSED: '尚未通过技术安全检查',
    NARRATIVE_NOT_PASSED: '叙事研究尚未通过',
    WALLET_SUPPORT_NOT_PASSED: '钱包与资金流证据尚未通过',
    SIGNAL_STALE: '信号已超出有效时间窗',
    DECISION_EXPIRED: '本次研究判断已过期',
    GMGN_WALLET_RESEARCH_UNAVAILABLE: '暂时无法获取 GMGN 钱包研究数据',
    GMGN_RATE_LIMITED: 'GMGN 请求受到限流',
    SERVICE_STOPPING: '服务正在停止',
    GMGN_API_KEY_MISSING: '尚未配置 GMGN 访问凭证',
    RESEARCH_BUSY: '等待当前研究任务完成',
    SCANNER_BUSY: '等待当前扫描任务完成',
    NATIVE_RPC_RATE_LIMITED: '网络 RPC 请求受到限流，稍后自动重试',
    NATIVE_RPC_TIMEOUT: '网络 RPC 查询超时，稍后自动重试',
    NATIVE_RPC_UNAVAILABLE: '网络 RPC 暂不可用，稍后自动重试',
    NATIVE_RPC_CHAIN_MISMATCH: 'RPC 返回的网络与配置不一致',
    NATIVE_BALANCE_RESPONSE_INVALID: 'RPC 返回的余额数据无效',
    NATIVE_RPC_NOT_CONFIGURED: '该网络尚未配置 RPC',
    SYSTEM_STATS_UNAVAILABLE: '服务器资源采样暂不可用',
    DISK_STATS_UNAVAILABLE: '磁盘资源采样暂不可用',
    ENTRY_BALANCE_RPC_UNAVAILABLE: '网络 RPC 查询暂不可用',
    ENTRY_BALANCE_RPC_INVALID: '网络 RPC 返回异常',
    ENTRY_BALANCE_CHAIN_MISMATCH: '余额网络与配置不一致',
    ENTRY_BALANCE_UNCONFIGURED: '余额查询尚未配置',
    WALLET_HISTORY_CAPACITY_REACHED: '钱包历史库已到容量上限',
    GMGN_FEED_SCHEMA_INVALID: 'GMGN 信号响应格式异常',
    GMGN_FEED_CHAIN_MISMATCH: '信号网络与请求的网络不匹配',
    ENTRY_INSUFFICIENT_BALANCE: '可用余额不足',
    ENTRY_BALANCE_STALE: '余额查询结果已过期',
    EXIT_PROTECTION_UNVERIFIED: '退出保护尚未验证',
    ASSET_ALREADY_OPEN: '同一资产已有占用仓位',
    OPENING_LIMIT_REACHED: '已达到开仓数量上限',
    WALLET_HISTORY_WRITE_FAILED: '钱包历史写入失败',
    WALLET_REQUEST_BUDGET_REACHED: '本轮请求预算已用完，部分来源等待后续采集',
    WALLET_ANALYSIS_PARTIAL: '钱包增强分析尚不完整',
    WALLET_FEED_SCHEMA_INVALID: '钱包信号数据格式异常',
    WALLET_ACTIVITY_SCHEMA_INVALID: '钱包活动数据格式异常',
    GMGN_RANK_SCHEMA_INVALID: '代币排行榜数据格式异常',
    GMGN_TRADERS_SCHEMA_INVALID: '单币交易者榜数据格式异常',
    GMGN_TOKEN_INFO_SCHEMA_INVALID: '代币报价或基础信息格式异常',
    GMGN_WALLET_STATS_SCHEMA_INVALID: '钱包 7 日统计数据格式异常',
    WALLET_COORDINATION_REFRESH_FAILED: '协同线索刷新失败',
    WALLET_ASSOCIATION_REFRESH_FAILED: '前置关联分析暂未完成',
    GMGN_ASSOCIATION_TRADERS_SCHEMA_INVALID: '关联交易者样本格式异常',
    GMGN_ASSOCIATION_TRADERS_ROWS_INVALID: '部分关联交易者记录无法核实',
    HARD_STOP_OBSERVED: '样本价格达到硬止损线',
    DYNAMIC_PROTECTION_OBSERVED: '样本价格回落至动态保护线',
    PARTIAL_PROFIT_STAGE_OBSERVED: '样本涨幅达到分档止盈条件',
    WALLET_NET_SELLING_TIGHTENED: '已覆盖钱包净卖出，保护线随之收紧',
    SHADOW_STARTED: '首条新报价建立影子基准',
    DYNAMIC_PROTECTION_ARMED: '样本涨幅达到动态跟踪启动条件',
    PROTECTION_LINE_RAISED: '后续样本推动动态保护线上调',
    PRICE_SAMPLE_UNAVAILABLE: '本次报价暂不可用，保留已有观察结果',
    PRICE_SAMPLE_RECOVERED: '新的有效报价已恢复',
    EXIT_SHADOW_CAPTURE_FAILED: '影子观察记录保存失败',
    EXIT_SHADOW_READ_FAILED: '影子观察记录读取失败',
    EXIT_SHADOW_WRITE_FAILED: '影子历史写入失败',
    EXIT_SHADOW_CAPACITY_REACHED: '影子历史已达到存储容量上限',
    EXIT_SHADOW_POSITION_CAPACITY_REACHED: '影子观察对象已达到容量上限',
    EXIT_SHADOW_STATE_INVALID: '影子模型状态异常，记录可能不完整',
    RPC_CHAIN_IDENTITY_MISMATCH: 'RPC 网络标识与配置不一致，暂停使用该连接',
    RPC_CONFIG_INVALID: '链上连接配置无效',
    RPC_CONNECTION_CLOSED: '链上连接已断开，等待重连',
    RPC_CONNECTION_ERROR: '链上连接出现异常',
    RPC_CONNECT_FAILED: '链上连接未建立',
    RPC_CONNECT_TIMEOUT: '链上连接超时',
    RPC_HEARTBEAT_TIMEOUT: '链上连接心跳超时',
    RPC_CONSUMER_ERROR: '链上事件处理暂未完成',
    RPC_MESSAGE_INVALID: '上游链上消息格式异常',
    RPC_MESSAGE_TOO_LARGE: '上游消息超出大小限制',
    RPC_NOT_OPEN: '链上连接尚未就绪',
    RPC_PENDING_LIMIT: '当前待处理请求达到上限',
    RPC_RECONNECT_REQUESTED: '正在重新建立链上连接',
    RPC_REMOTE_ERROR: 'RPC 服务返回请求错误',
    RPC_REQUEST_INVALID: '链上查询参数无效',
    RPC_REQUEST_TIMEOUT: '链上查询超时',
    RPC_SEND_FAILED: '链上查询发送失败',
    RPC_STOPPED: '链上连接已停止',
    RPC_SUBSCRIBE_FAILED: '链上订阅未成功建立',
    RPC_SUBSCRIPTION_ID_CONFLICT: '上游订阅标识冲突',
    RPC_SUBSCRIPTION_ID_INVALID: '上游订阅标识无效',
    RPC_SUBSCRIPTION_INVALID: '链上订阅配置无效',
    RPC_UNSUBSCRIBE_FAILED: '上游取消订阅未确认',
    CHAIN_INITIAL_HISTORY_WINDOW: '首次采集仅覆盖最近一页，更早历史未纳入',
    CHAIN_BACKFILL_RANGE_EXCEEDED: '离线跨度较大，按受限批次继续补数',
    CHAIN_BACKFILL_CONTINUING: '活动较多，已保存分页进度，下一轮接着补',
    CHAIN_BACKFILL_TRUNCATED: '补数达到单轮上限，历史尚未补全',
    CHAIN_BACKFILL_INVALID: '补数响应未通过校验，游标保持原位',
    CHAIN_PRICE_RPC_FAILED: '池状态读取失败，报价回退 GMGN',
    CHAIN_PRICE_DATA_STALE: '链上池数据过旧，报价回退 GMGN',
    CHAIN_PRICE_ANCHOR_INVALID: '美元参照无法验证，报价回退 GMGN',
    CHAIN_HTTP_RATE_LIMITED: '公共 RPC / 市场参照限流，等待冷却',
    CHAIN_RPC_REJECTED: 'RPC 拒绝了本次只读查询',
    CHAIN_HTTP_FAILED: 'RPC / 市场参照请求失败',
    CHAIN_HTTP_TIMEOUT: 'RPC / 市场参照请求超时',
    CHAIN_USD_REFERENCE_UNAVAILABLE: '暂缺有效美元参照，报价回退 GMGN',
    CHAIN_MARKET_REFERENCE_UNAVAILABLE: '池或美元参照暂不可用，报价回退 GMGN',
    CHAIN_IDENTITY_MISMATCH: '节点链标识不匹配，暂停使用',
    CHAIN_STATUS_READ_FAILED: '链上状态读取失败',
    POOL_PROTOCOL_UNSUPPORTED: '该池协议暂未适配，使用 GMGN 报价',
    CHAIN_STORE_CAPACITY: '链上事件档案达到容量上限，新增记录可能未保存',
  };
  const state = {authenticated: false, view: 'scans', chain: '', decision: '', search: '', offset: 0, total: 0, items: [], orders: [], overview: null, refreshing: false, queued: false, queryVersion: 0, timer: null, searchTimer: null, lastSuccess: null, resourceErrors: {}, scansLoaded: false, ordersLoaded: false, detailId: null, detailKind: 'scan', detailWallet: null, detailGeneration: 0, returnFocus: null,
    walletSort: 'associations', associationStatus: null, walletChain: '', walletSearch: '', walletOffset: 0, walletTotal: 0, walletItems: [], walletStatus: null, walletsLoaded: false, walletSearchTimer: null, protection: null, protectionLoaded: false, chainStream: null, chainStreamLoaded: false};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function text(id, value) { $(id).textContent = value; }
  function scalar(value, fallback = '—') { return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback; }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function numeric(value) { return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : undefined; }
  function count(value) { return finite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—'; }
  function percent(value) { return finite(value) ? `${value > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', {maximumFractionDigits: 2}).format(value)}%` : '—'; }
  function usd(value) { const n = numeric(value); return n === undefined ? '—' : new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumSignificantDigits: 6}).format(n); }
  function validDate(value) { const d = typeof value === 'string' ? new Date(value) : null; return d && Number.isFinite(d.getTime()) ? d : null; }
  function date(value, full = false) { const d = validDate(value); return d ? new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? {second: '2-digit'} : {}), hour12: false}).format(d) : '—'; }
  function time(value) { const d = validDate(value); return d ? new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(d) : '—'; }
  function badge(label, tone = 'neutral') { return el('span', `badge ${tone}`, label); }
  function safeUrl(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } }
  function gmgnTokenLink(chain, address, label = 'GMGN ↗') {
    const network = {bsc: 'bsc', solana: 'sol', robinhood: 'robinhood'}[chain];
    let valid = typeof address === 'string' && /^(?:0x[0-9a-fA-F]{40})$/.test(address);
    if (chain === 'solana') {
      valid = typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
      if (valid) {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let decoded = 0n; for (const character of address) decoded = decoded * 58n + BigInt(alphabet.indexOf(character));
        let bytes = 0; while (decoded > 0n) { bytes++; decoded >>= 8n; }
        valid = bytes + (address.match(/^1*/)?.[0].length || 0) === 32;
      }
    }
    if (!network || !valid) { const unavailable = el('span', 'gmgn-link', 'GMGN'); unavailable.setAttribute('aria-disabled', 'true'); unavailable.title = '完整合约地址不可用'; return unavailable; }
    const link = el('a', 'gmgn-link', label); link.href = `https://gmgn.ai/${network}/token/${encodeURIComponent(address)}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('aria-label', `在 GMGN 打开 ${chainName(chain)} 代币 ${address} 的详情`);
    return link;
  }
  function chainName(chain) { return chainNames[chain] || scalar(chain, '未知网络'); }
  function chainClass(chain) { return Object.hasOwn(chainNames, chain) ? chain : ''; }
  function gainNode(value) { return el('span', `gain ${!finite(value) ? 'missing' : value >= 0 ? 'positive' : 'negative'}`, percent(value)); }
  function reasonList(reasons) {
    const list = el('ul', 'reason-list');
    if (Array.isArray(reasons)) for (const reason of reasons.slice(0, 30)) if (typeof reason === 'string') { const item = el('li', '', reasonNames[reason] || reason); item.title = reason; list.append(item); }
    return list;
  }
  function kv(label, value) { const row = el('div', 'key-value'); row.append(el('span', '', label), el('span', '', scalar(value))); return row; }
  function showToast(message) { text('toast', message); $('toast').hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { $('toast').hidden = true; }, 2500); }
  function copyButton(value, label = '复制完整合约地址') {
    const button = el('button', 'copy-button', '⧉');
    button.type = 'button'; button.setAttribute('aria-label', label); button.title = label;
    button.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
        await navigator.clipboard.writeText(String(value)); showToast('完整地址已复制');
      } catch { showToast('无法访问剪贴板，请选中完整地址复制'); }
    });
    return button;
  }
  function addressNode(address, className = 'address-line') {
    const row = el('div', className); row.append(el('code', '', scalar(address)));
    if (typeof address === 'string' && address) row.append(copyButton(address));
    return row;
  }


  const narrativeData = new WeakMap();
  let narrativePopover = null;
  let narrativeCloseTimer;
  let suppressNarrativeFocus = false;
  function narrativeText(narrative) {
    return typeof narrative?.text === 'string' && narrative.text.trim() ? narrative.text : typeof narrative?.thesis === 'string' ? narrative.thesis : '';
  }
  function closeNarrative(restoreFocus = false) {
    clearTimeout(narrativeCloseTimer);
    if (!narrativePopover) return;
    const {trigger, panel} = narrativePopover;
    narrativePopover = null; trigger.setAttribute('aria-expanded', 'false'); panel.remove();
    if (restoreFocus && trigger.isConnected) { suppressNarrativeFocus = true; trigger.focus({preventScroll: true}); suppressNarrativeFocus = false; }
  }
  function placeNarrative() {
    if (!narrativePopover) return;
    const {trigger, panel} = narrativePopover;
    if (!trigger.isConnected) { closeNarrative(); return; }
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(500, window.innerWidth - 24);
    panel.style.width = `${width}px`; panel.style.maxHeight = `${Math.max(120, window.innerHeight - 24)}px`;
    const height = panel.getBoundingClientRect().height;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 8;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }
  function scheduleNarrativeClose() {
    clearTimeout(narrativeCloseTimer);
    narrativeCloseTimer = setTimeout(() => {
      if (!narrativePopover || narrativePopover.pinned || narrativePopover.panel.matches(':hover') || narrativePopover.trigger.matches(':hover')) return;
      if (narrativePopover.panel.contains(document.activeElement) || document.activeElement === narrativePopover.trigger) return;
      closeNarrative();
    }, 180);
  }
  function openNarrative(trigger, pinned = false) {
    clearTimeout(narrativeCloseTimer);
    if (narrativePopover?.trigger === trigger) { narrativePopover.pinned ||= pinned; return; }
    closeNarrative();
    const n = narrativeData.get(trigger); if (!narrativeText(n)) return;
    const panel = el('section', 'narrative-popover'); panel.id = 'narrative-popover'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '平台叙事全文');
    const heading = el('div', 'narrative-popover-heading');
    heading.append(el('strong', '', `${n.supplier ? scalar(n.supplier).toUpperCase() : '平台'}叙事 · AI 参考`));
    const close = el('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', '收起叙事全文'); close.addEventListener('click', () => closeNarrative(true)); heading.append(close);
    const body = el('div', 'narrative-popover-body'); body.tabIndex = 0; body.setAttribute('aria-label', '完整叙事内容，可滚动'); body.append(el('p', '', narrativeText(n)));
    if (n.textTruncated) body.append(el('p', 'narrative-disclosure-note', '平台内容较长，当前保存了部分文本；可通过来源页面继续阅读。'));
    if (n.updatedAt) body.append(el('p', 'narrative-disclosure-note', `平台更新时间 ${date(n.updatedAt, true)}`));
    if (n.retained) body.append(el('p', 'narrative-disclosure-note', '本次未取得新叙事，展示此前取得的参考文本；更新时间未重置。'));
    const source = safeUrl(n.sourceUrl);
    if (source && !new URL(source).pathname.startsWith('/api/')) { const link = el('a', 'source-link', '查看平台来源 ↗'); link.href = source; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); }
    const note = el('p', 'narrative-popover-note', '供应商生成的叙事只作参考；缺少叙事不会阻止开单。');
    panel.append(heading, body, note); (state.detailId ? $('detail-drawer') : document.body).append(panel);
    narrativePopover = {trigger, panel, pinned, key: trigger.dataset.narrativeKey}; trigger.setAttribute('aria-expanded', 'true');
    panel.addEventListener('pointerenter', () => clearTimeout(narrativeCloseTimer)); panel.addEventListener('pointerleave', scheduleNarrativeClose);
    panel.addEventListener('focusout', scheduleNarrativeClose); placeNarrative();
  }
  function narrativePreview(narrative, key) {
    const content = narrativeText(narrative); if (!content) return null;
    const origin = narrative?.supplier === 'debot' ? content.split('\n').find(line => line.startsWith('背景 / 起源：')) : '';
    const excerpt = origin || narrative?.thesis?.trim() || content;
    const trigger = el('button', 'narrative-preview'); trigger.type = 'button'; trigger.dataset.narrativeKey = key;
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'narrative-popover');
    trigger.setAttribute('aria-label', '展开或收起平台叙事全文');
    trigger.append(el('span', 'narrative-preview-text', excerpt), el('span', 'narrative-preview-hint', 'AI 叙事参考 · 悬停 / 点击查看'));
    narrativeData.set(trigger, narrative);
    trigger.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') openNarrative(trigger); });
    trigger.addEventListener('pointerleave', scheduleNarrativeClose);
    trigger.addEventListener('focus', () => { if (!suppressNarrativeFocus && matchMedia('(hover: hover)').matches) openNarrative(trigger); });
    trigger.addEventListener('focusout', scheduleNarrativeClose);
    trigger.addEventListener('click', event => { event.stopPropagation(); if (narrativePopover?.trigger === trigger && narrativePopover.pinned) closeNarrative(); else { openNarrative(trigger, true); narrativePopover?.panel.querySelector('.narrative-popover-body')?.focus({preventScroll: true}); } });
    trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); openNarrative(trigger, true); narrativePopover?.panel.querySelector('.narrative-popover-body')?.focus({preventScroll: true}); } });
    return trigger;
  }
  function rebindNarrative(container) {
    if (!narrativePopover || narrativePopover.trigger.isConnected) return;
    const next = [...container.querySelectorAll('[data-narrative-key]')].find(node => node.dataset.narrativeKey === narrativePopover.key);
    if (!next) { closeNarrative(); return; }
    narrativePopover.trigger = next; next.setAttribute('aria-expanded', 'true'); placeNarrative();
  }
  document.addEventListener('pointerdown', event => {
    if (narrativePopover && !narrativePopover.panel.contains(event.target) && !narrativePopover.trigger.contains(event.target)) closeNarrative();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && narrativePopover) { event.preventDefault(); event.stopImmediatePropagation(); closeNarrative(true); }
  }, true);
  document.addEventListener('scroll', event => {
    if (narrativePopover && !narrativePopover.panel.contains(event.target)) placeNarrative();
  }, true);
  window.addEventListener('resize', placeNarrative);
  function socialBadge(social) {
    if (!finite(social?.score) || social.score <= 0 || social.scope !== 'research_priority') return null;
    const node = badge(`社交关注 +${social.score}`, 'social'); node.title = '增加研究优先级；项目链接不等于名人支持，也不替代安全和钱包检查'; return node;
  }

  class RequestError extends Error { constructor(status) { super(`HTTP_${status}`); this.status = status; } }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${API}${path}`, {credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal, headers: {Accept: 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}), ...(options.headers || {})}});
      if (!response.ok) throw new RequestError(response.status);
      return response.status === 204 ? null : await response.json();
    } finally { clearTimeout(timeout); }
  }
  function showLogin(message = '') {
    state.authenticated = false;
    clearTimeout(state.timer); closeDrawer();
    $('app').hidden = true; $('boot-view').hidden = true; $('login-view').hidden = false;
    text('login-error', message); $('password').value = ''; $('password').focus();
  }
  async function startSession(session) {
    if (!session) session = await api('/session');
    $('logout').hidden = session.authentication === 'proxy';
    state.authenticated = true;
    $('login-view').hidden = true; $('boot-view').hidden = true; $('app').hidden = false;
    text('current-date', new Intl.DateTimeFormat('en-CA', {year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()));
    await refresh();
  }
  async function boot() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    let access = fragment.get('access');
    if (access !== null) history.replaceState(null, '', location.pathname + location.search);
    try {
      if (access !== null) { await api('/login', {method: 'POST', body: JSON.stringify({password: access})}); access = null; }
      else { const session = await api('/session'); await startSession(session); return; }
      await startSession();
    } catch (error) { access = null; showLogin(error.status === 401 ? '' : '暂时无法连接服务，请稍后重试。'); }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-submit').disabled = true; text('login-error', '');
    const password = $('password').value; $('password').value = '';
    try { await api('/login', {method: 'POST', body: JSON.stringify({password})}); await startSession(); }
    catch (error) { showLogin(error.status === 401 || error.status === 403 ? '访问密码不正确，请重试。' : error.status === 429 ? '尝试次数较多，请稍后再试。' : '连接失败，请稍后重试。'); }
    finally { $('login-submit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/logout', {method: 'POST'}); showLogin(); }
    catch { showToast('退出失败，请重试'); }
  });

  function scanQuery() {
    const q = new URLSearchParams({limit: String(PAGE_SIZE), offset: String(state.offset)});
    if (state.chain) q.set('chain', state.chain);
    if (state.decision) q.set('decision', state.decision);
    if (state.search) q.set('search', state.search);
    if (state.view === 'candidates') q.set('eligible', 'true');
    return q.toString();
  }
  function walletQuery() {
    const q = new URLSearchParams({limit: String(PAGE_SIZE), offset: String(state.walletOffset), sort: state.walletSort});
    if (state.walletChain) q.set('chain', state.walletChain);
    if (state.walletSearch) q.set('search', state.walletSearch);
    return q.toString();
  }
  function networkState() {
    const failures = Object.values(state.resourceErrors).filter(Boolean);
    const archival = state.overview?.archiveError;
    const walletError = state.walletStatus?.store?.error || state.walletStatus?.captureError || state.walletStatus?.observer?.feedError;
    const protectionError = state.overview?.exitProtection?.captureError || (state.view === 'protection' && state.protection?.captureError);
    const status = $('connection-status'); status.classList.toggle('stale', failures.length > 0 || Boolean(archival) || Boolean(walletError) || Boolean(protectionError));
    status.lastElementChild.textContent = failures.length ? '连接异常' : archival || walletError || protectionError ? '记录读写异常' : '数据已连接';
    $('network-warning').hidden = failures.length === 0 && !archival && !walletError && !protectionError;
    if (failures.length) text('network-warning', `部分数据暂时无法更新，已保留最近一次成功结果。${state.lastSuccess ? `最近同步 ${date(state.lastSuccess, true)}。` : ''} 页面会自动重试。`);
    else if (archival) text('network-warning', '扫描档案写入异常，页面记录可能不完整。请检查服务端运行状态。');
    else if (protectionError) text('network-warning', `影子保护记录异常：${protectionReason(protectionError)}。已有记录可能未更新，实盘保护仍未就绪。`);
    else if (walletError) text('network-warning', walletError === 'WALLET_HISTORY_CAPACITY_REACHED' ? '钱包历史库已到容量上限，新增数据暂未保存。原有研究记录仍保留，请检查服务端存储配置。' : '钱包历史保存异常，新增数据可能不完整。请检查服务端运行状态。');
  }
  async function refresh() {
    if (!state.authenticated) return;
    if (state.refreshing) { state.queued = true; return; }
    state.refreshing = true; clearTimeout(state.timer); $('refresh').classList.add('spinning'); $('refresh').setAttribute('aria-busy', 'true');
    const version = state.queryVersion;
    const activeView = state.view;
    const jobs = [{key: 'overview', run: () => api('/overview'), apply: data => { state.overview = data; renderOverview(); }}];
    if (activeView === 'scans' || activeView === 'candidates') jobs.push({key: 'scans', run: () => api(`/scans?${scanQuery()}`), apply: data => {
      if (version !== state.queryVersion) return;
      state.items = Array.isArray(data.items) ? data.items : []; state.total = finite(data.total) ? data.total : state.items.length; state.scansLoaded = true; renderScans();
    }});
    if (activeView === 'protection') jobs.push({key: 'protection', run: () => api('/protection'), apply: data => { state.protection = data; state.protectionLoaded = true; renderProtection(); }});
    if (activeView === 'system') jobs.push({key: 'chainStream', run: () => api('/chain-stream'), apply: data => { state.chainStream = data; state.chainStreamLoaded = true; renderChainStream(); }});
    if (activeView === 'orders') jobs.push({key: 'orders', run: () => api('/orders'), apply: data => { state.orders = Array.isArray(data.items) ? data.items : []; state.ordersLoaded = true; renderOrders(); }});
    if (activeView === 'wallets') {
      jobs.push({key: 'walletStatus', run: () => api('/wallet-research/status'), apply: data => { state.walletStatus = data; renderWalletStatus(); }});
      if (state.walletSort === 'associations') jobs.push({key: 'associations', run: () => api('/wallet-associations/status'), apply: data => { state.associationStatus = data; renderAssociationStatus(); }});
      jobs.push({key: 'wallets', run: () => api(`/${state.walletSort === 'associations' ? 'wallet-associations' : 'wallets'}?${walletQuery()}`), apply: data => {
        if (version !== state.queryVersion) return;
        state.walletItems = Array.isArray(data.items) ? data.items : []; state.walletTotal = finite(data.total) ? data.total : state.walletItems.length; state.walletsLoaded = true; renderWalletList();
      }});
    }
    try {
      const results = await Promise.allSettled(jobs.map(job => job.run()));
      if (!state.authenticated) return;
      if (results.some(result => result.status === 'rejected' && result.reason.status === 401)) { showLogin('会话已结束，请重新登录。'); return; }
      results.forEach((result, index) => {
        const job = jobs[index];
        if (result.status === 'fulfilled') { delete state.resourceErrors[job.key]; job.apply(result.value); }
        else state.resourceErrors[job.key] = true;
      });
      if (results.every(result => result.status === 'fulfilled')) { state.lastSuccess = new Date().toISOString(); text('last-updated', `最近同步 ${date(state.lastSuccess, true)}`); }
      if (!state.scansLoaded && state.resourceErrors.scans) renderScanEmpty('暂时无法读取扫描记录', '检查服务连接后重试。页面不会用示例数据替代真实记录。');
      if (!state.ordersLoaded && state.resourceErrors.orders) { $('orders-empty').hidden = false; $('orders-empty').querySelector('h3').textContent = '暂时无法读取订单'; $('orders-empty').querySelector('p').textContent = '服务连接恢复后会自动更新。'; }
      if (!state.walletsLoaded && state.resourceErrors.wallets) walletEmpty('暂时无法读取钱包档案', '连接恢复后会自动更新。原有研究记录不会被示例数据替代。');
      if (state.resourceErrors.protection && state.view === 'protection') renderProtection();
      if (state.resourceErrors.chainStream && state.view === 'system') renderChainStream();
      networkState();
      if (state.detailId) await loadDetail(state.detailId, true);
    } finally {
      state.refreshing = false; $('refresh').classList.remove('spinning'); $('refresh').removeAttribute('aria-busy');
      if (state.authenticated) {
        if (state.queued) { state.queued = false; void refresh(); }
        else state.timer = setTimeout(refresh, 15000);
      }
    }
  }
  $('refresh').addEventListener('click', refresh);
  $('system-details').addEventListener('click', () => setView('system'));
  $('system-protection-link').addEventListener('click', () => setView('protection'));
  $('chain-stream-summary').addEventListener('click', () => { setView('system'); $('chain-stream-panel').scrollIntoView({block: 'start'}); });
  function filtersChanged() { state.offset = 0; state.queryVersion++; void refresh(); }
  document.querySelectorAll('[data-chain]').forEach(button => button.addEventListener('click', () => {
    state.chain = button.dataset.chain;
    document.querySelectorAll('[data-chain]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    filtersChanged();
  }));
  $('decision').addEventListener('change', () => { state.decision = $('decision').value; filtersChanged(); });
  $('search').addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => { state.search = $('search').value.trim(); filtersChanged(); }, 300); });
  $('previous-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); state.queryVersion++; void refresh(); });
  $('next-page').addEventListener('click', () => { if (state.offset + PAGE_SIZE < state.total) { state.offset += PAGE_SIZE; state.queryVersion++; void refresh(); } });
  function walletFiltersChanged() { state.walletOffset = 0; state.queryVersion++; void refresh(); }
  document.querySelectorAll('[data-wallet-sort]').forEach(button => button.addEventListener('click', () => {
    state.walletSort = button.dataset.walletSort; state.walletItems = []; state.walletTotal = 0; state.walletsLoaded = false; $('wallet-rows').replaceChildren(); $('association-rows').replaceChildren(); walletEmpty('正在读取研究记录', '从真实观测记录中整理研究目标。');
    document.querySelectorAll('[data-wallet-sort]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    renderWalletRankingNote(); walletFiltersChanged();
  }));
  $('wallet-chain').addEventListener('change', () => { state.walletChain = $('wallet-chain').value; walletFiltersChanged(); });
  $('wallet-search').addEventListener('input', () => { clearTimeout(state.walletSearchTimer); state.walletSearchTimer = setTimeout(() => { state.walletSearch = $('wallet-search').value.trim(); walletFiltersChanged(); }, 300); });
  $('wallet-previous-page').addEventListener('click', () => { state.walletOffset = Math.max(0, state.walletOffset - PAGE_SIZE); state.queryVersion++; void refresh(); });
  $('wallet-next-page').addEventListener('click', () => { if (state.walletOffset + PAGE_SIZE < state.walletTotal) { state.walletOffset += PAGE_SIZE; state.queryVersion++; void refresh(); } });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  function setView(view) {
    if (!Object.hasOwn(views, view)) return;
    state.view = view; state.offset = 0; state.queryVersion++;
    state.decision = ''; $('decision').value = '';
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === view; button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    text('breadcrumb-current', views[view][0]); $('page-title').replaceChildren(document.createTextNode(views[view][0]), el('span', 'title-dot', '.')); text('page-description', views[view][1]);
    $('scans-panel').hidden = !['scans', 'candidates'].includes(view); $('orders-panel').hidden = view !== 'orders'; $('system-panel').hidden = view !== 'system'; $('protection-panel').hidden = view !== 'protection';
    $('wallets-panel').hidden = view !== 'wallets'; $('wallet-metrics').hidden = view !== 'wallets'; $('scan-metrics').hidden = ['wallets', 'protection', 'system'].includes(view); $('scan-insights').hidden = ['wallets', 'protection', 'system'].includes(view); $('workbench').classList.toggle('wallet-mode', ['wallets', 'protection', 'system'].includes(view));
    text('list-title', view === 'candidates' ? '曾通过研究判断的信号' : '全部扫描记录');
    delete state.resourceErrors.scans; delete state.resourceErrors.orders; delete state.resourceErrors.wallets; delete state.resourceErrors.walletStatus; delete state.resourceErrors.associations; delete state.resourceErrors.protection; delete state.resourceErrors.chainStream;
    if (view === 'scans' || view === 'candidates') { state.items = []; state.scansLoaded = false; $('scan-rows').replaceChildren(); text('list-count', '—'); renderScanEmpty('正在读取记录', '即将展示当前筛选条件下的真实数据。'); }
    if (view === 'system') { renderSystem(); renderChainStream(); }
    if (view === 'protection') renderProtection();
    if (view === 'wallets') { state.walletOffset = 0; renderWalletRankingNote(); if (state.walletStatus) renderWalletStatus(); if (!state.walletsLoaded) walletEmpty('正在读取钱包研究档案', '从真实观测记录中整理研究目标。'); }
    void refresh();
  }

  function renderOverview() {
    const data = state.overview || {}; const stats = data.stats || {}; const settings = data.settings || {};
    text('metric-total', count(stats.total)); text('metric-eligible', count(stats.eligible)); text('metric-tracking', count(stats.tracking)); text('metric-peak', percent(stats.maxGainPct));
    $('metric-peak').classList.toggle('negative', finite(stats.maxGainPct) && stats.maxGainPct < 0); $('metric-peak').classList.toggle('positive', !finite(stats.maxGainPct) || stats.maxGainPct >= 0);
    text('candidate-count', count(stats.eligible));
    text('metric-total-note', finite(settings.scanRetentionDays) ? `最近 ${settings.scanRetentionDays} 天 · 信号档案` : '保留期内的全部信号');
    text('tracking-policy-note', finite(settings.sampleIntervalSec) ? `每 ${settings.sampleIntervalSec} 秒轮询 · 逐币报价时间可不同` : '按服务端间隔轮询，逐币时间以报价为准');
    text('performance-note', `以首次符合条件后的首个有效价格为基准${finite(settings.trackingHours) ? `，追踪 ${settings.trackingHours} 小时` : ''}；最高涨幅仅为采样观测值，不代表全市场最高价或实际收益。通过研究门槛不代表已下单。`);
    if (data.walletResearch) { state.walletStatus = data.walletResearch; renderWalletStatus(); }
    renderBalances(Array.isArray(data.balances) ? data.balances : []); renderScanner(data.scanner); renderSystemOverview(); renderSystem(); if (state.view === 'system') renderChainStream();
  }
  function renderBalances(balances) {
    const container = $('balance-list'); container.replaceChildren();
    if (!balances.length) { container.append(el('p', 'panel-placeholder', '尚无可用的钱包余额数据。')); return; }
    for (const balance of balances) {
      const card = el('div', 'balance-item'); const top = el('div', 'balance-top'); const network = el('span', 'balance-network');
      network.append(el('span', `chain-dot ${chainClass(balance.chain)}`), document.createTextNode(chainName(balance.chain)));
      const amount = el('span', 'balance-amount', ['ok', 'stale'].includes(balance.status) ? scalar(balance.amount) : '—'); amount.append(el('small', '', scalar(balance.symbol, chainSymbols[balance.chain] || ''))); top.append(network, amount); card.append(top);
      if (typeof balance.address === 'string') card.append(addressNode(balance.address, 'balance-address'));
      const bottom = el('div', 'balance-bottom'); bottom.append(el('span', '', balance.status === 'ok' ? '已查询' : balance.status === 'stale' ? '上次成功 · 刷新失败' : balance.status === 'loading' ? '查询中' : '暂不可用'), el('span', '', balance.checkedAt ? date(balance.checkedAt) : '尚未查询')); card.append(bottom);
      if (balance.status !== 'ok' && balance.reason) card.append(el('div', 'balance-status', reasonNames[balance.reason] || scalar(balance.reason)));
      if (balance.status === 'stale') card.append(el('div', 'balance-status', `保留上次成功余额，不能视为当前可用资金${balance.lastAttemptAt ? `；最近重试 ${date(balance.lastAttemptAt, true)}` : ''}`));
      container.append(card);
    }
  }
  function bytes(value) {
    if (!finite(value) || value < 0) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let unit = 0; let amount = value;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return `${new Intl.NumberFormat('zh-CN', {maximumFractionDigits: unit ? 1 : 0}).format(amount)} ${units[unit]}`;
  }
  function utilization(used, total) { return finite(used) && finite(total) && total > 0 ? used / total * 100 : undefined; }
  function plainPercent(value) { return finite(value) ? `${new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1}).format(value)}%` : '—'; }
  function duration(value) {
    if (!finite(value) || value < 0) return '—';
    const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60);
    return hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
  }
  function entryModeLabel(mode) { return {disabled: '未启用开仓', off: '未启用开仓', paper: '模拟开仓', live: '实盘配置'}[mode] || scalar(mode); }
  function watchRecheckLabel(watch) {
    return !watch ? '状态暂不可用' : !watch.enabled ? '未启用' : watch.lastError ? '最近复评异常' : watch.inFlight ? '正在复评' : !watch.running ? '未运行' : watch.deferredReason ? `延后 · ${reasonNames[watch.deferredReason] || scalar(watch.deferredReason)}` : watch.queue?.due > 0 ? '等待队列调度' : '等待下一次计划';
  }
  function statusDot(id, tone) { $(id).className = `tiny-dot status-dot ${tone}`; }
  function renderSystemOverview() {
    const data = state.overview || {}, system = data.system || {}, scanner = data.scanner || {}, research = data.walletResearch || state.walletStatus || {};
    const balances = Array.isArray(data.balances) ? data.balances : [], cycle = scanner.lastCycle || {}, observer = research.observer || {}, walletCycle = observer.lastCycle || {}, store = research.store || {};
    const cooling = scanner.cooldownUntil && Date.parse(scanner.cooldownUntil) > Date.now();
    const watch = data.watchRecheck, watchProblem = Boolean(watch?.enabled && (watch.lastError || !watch.running || ['GMGN_API_KEY_MISSING', 'GMGN_RATE_LIMITED'].includes(watch.deferredReason)));
    const scanProblem = Boolean(cooling || !scanner.running || cycle.status === 'partial' || cycle.errors > 0 || watchProblem);
    text('status-scanner', cooling ? '限流冷却中' : scanner.running ? scanner.inFlight ? '正在扫描' : '持续运行中' : '未运行');
    text('status-scanner-note', cooling ? `恢复时间 ${time(scanner.cooldownUntil)}` : cycle.completedAt ? `最近 ${time(cycle.completedAt)} · 接收 ${count(cycle.received)} 条` : '等待第一轮扫描完成');
    text('status-watch-note', `复评：${watchRecheckLabel(watch)}${watch?.enabled ? ` · 待复评 ${count(watch.queue?.scheduled)} 条${watch.queue?.due > 0 ? `（到期排队 ${count(watch.queue.due)}）` : ''}` : ''}`);
    statusDot('status-scanner-dot', scanProblem ? 'watch' : 'pass');
    const walletError = store.error || research.captureError || observer.feedError;
    const walletCooling = observer.cooldownUntil && Date.parse(observer.cooldownUntil) > Date.now();
    const walletProblem = Boolean(walletError || research.enabled && (!observer.running || walletCooling || walletCycle.status === 'partial'));
    text('status-wallet', walletError ? '保存异常' : !research.enabled ? '未启用' : walletCooling ? '归档运行 · 增强采集冷却' : observer.running ? observer.inFlight ? '正在增强采集' : '持续积累中' : '增强采集未运行');
    text('status-wallet-note', walletError ? reasonNames[walletError] || scalar(walletError) : `${count(store.wallets)} 个钱包 · ${count(store.events)} 条活动${walletCycle.status === 'partial' ? ' · 增强数据待补全' : ''}`);
    statusDot('status-wallet-dot', walletProblem ? 'watch' : research.enabled ? 'pass' : 'neutral');
    const successCount = balances.filter(balance => balance.status === 'ok').length, failed = balances.filter(balance => ['stale', 'unavailable', 'error'].includes(balance.status));
    const balanceProblem = failed.length > 0;
    text('status-balance', balances.length ? successCount === balances.length ? `${successCount} 个网络查询正常` : `${successCount} / ${balances.length} 个网络查询正常` : '等待余额查询');
    text('status-balance-note', balances.length ? balances.map(balance => `${chainName(balance.chain)} ${balance.status === 'ok' ? '正常' : balance.status === 'stale' ? '刷新失败' : balance.status === 'loading' ? '查询中' : '暂不可用'}`).join(' · ') : 'BNB / SOL / ETH');
    statusDot('status-balance-dot', balanceProblem ? 'watch' : successCount ? 'pass' : 'neutral');
    const memoryUsage = utilization(system.memory?.usedBytes, system.memory?.totalBytes), diskUsage = utilization(system.disk?.usedBytes, system.disk?.totalBytes);
    text('status-cpu', plainPercent(system.cpu?.usagePct)); text('status-memory', plainPercent(memoryUsage)); text('status-disk', plainPercent(diskUsage));
    const resourceProblem = system.status === 'partial' || system.warnings?.length > 0 || system.cpu?.usagePct >= 90 || diskUsage >= 90 || memoryUsage >= 90;
    statusDot('status-resource-dot', resourceProblem ? 'watch' : system.status === 'ok' ? 'pass' : 'neutral');
    text('status-resource-note', system.sampledAt ? `采样 ${time(system.sampledAt)} · 磁盘剩余 ${bytes(system.disk?.freeBytes)}` : '等待服务器采样');
    text('system-uptime', `已运行 ${duration(system.uptimeSec)}`); text('system-entry-mode', entryModeLabel(data.entryMode));
    const protectionError = data.exitProtection?.captureError || data.exitProtection?.status?.lastError;
    text('system-protection-link', protectionError ? '止盈：影子记录异常 / 实盘未就绪' : data.exitProtection?.enabled ? '止盈：影子验证 / 实盘未就绪' : '止盈：实盘保护未就绪');
    const stream = data.chainStream, streamChains = Array.isArray(stream?.chains) ? stream.chains : [];
    const streamIssue = Boolean(stream?.enabled && (!stream.running || stream.store?.incomplete || streamChains.some(chain => ['reconnecting', 'degraded'].includes(chain.state) || chain.state === 'live' && chain.identityVerified !== true || hasGapIssue(chain.gap?.incomplete))));
    const streamLive = streamChains.filter(chain => chain.state === 'live' && chain.identityVerified === true).length;
    text('chain-stream-summary-text', !stream ? '链上订阅：状态未知' : !stream.enabled ? '链上订阅：未启用' : !stream.running ? '链上订阅：未运行' : `链上订阅：${streamLive} / ${streamChains.length} 个网络已连接`);
    statusDot('chain-stream-summary-dot', streamIssue ? 'watch' : streamLive ? 'pass' : 'neutral');
    text('chain-stream-summary-note', streamIssue ? '连接或补数需关注 · 查看各链详情；实盘保护仍需单独核实。' : '仅观察目标钱包与池，连接正常不代表实盘保护就绪。');
    const problem = scanProblem || walletProblem || balanceProblem || resourceProblem || data.archiveError || protectionError || streamIssue;
    const loading = !data.system || system.status === 'loading' || balances.length === 0 || balances.some(balance => balance.status === 'loading') || stream?.enabled && streamChains.some(chain => chain.state === 'connecting');
    const status = $('system-overall-status'); status.className = `badge ${problem ? 'watch' : loading ? 'neutral' : 'pass'}`; status.textContent = problem ? '部分项目需关注' : loading ? '正在初始化 / 等待采样' : '运行正常';
  }
  const streamStateNames = {disabled: ['未启用', 'neutral'], connecting: ['正在连接', 'neutral'], live: ['订阅在线', 'pass'], reconnecting: ['正在重连', 'watch'], degraded: ['采集受限', 'watch']};
  const streamEventNames = {wallet_transaction: '钱包交易活动', token_transfer: '代币转账', native_transfer: '原生币转账', pool_change: '流动性池变化'};
  function hasGapIssue(value) { return value === true || finite(value) && value > 0; }
  function gapLabel(gap) {
    if (!gap || typeof gap !== 'object') return '补数状态未知';
    if (hasGapIssue(gap.incomplete)) return hasGapIssue(gap.pending) ? '补数中 · 已有缺口未覆盖' : '仍有未覆盖缺口';
    if (hasGapIssue(gap.pending)) return finite(gap.pending) ? `待补 ${count(gap.pending)} 段` : '补数待完成';
    return gap.pending === false || gap.pending === 0 ? '当前无待补任务' : '补数状态未知';
  }
  function streamErrorLabel(value) { return reasonNames[value] || scalar(value, '未提供异常原因'); }
  function chainStreamCard(chain) {
    const card = el('article', 'chain-stream-card'); const heading = el('div', 'chain-stream-card-heading');
    const title = el('h3'); title.append(el('span', `chain-dot ${chainClass(chain.chain)}`), document.createTextNode(chainName(chain.chain)));
    heading.append(title, badge(...(chain.state === 'live' && chain.identityVerified !== true ? ['连接待核验', 'watch'] : streamStateNames[chain.state] || ['状态未知', 'neutral']))); card.append(heading);
    card.append(el('p', `chain-identity ${chain.identityVerified === true ? 'positive' : 'attention-text'}`, chain.identityVerified === true ? (chain.chain === 'solana' ? '配对 HTTP 主网已核验' : 'HTTP / WS 主网已核验') : '网络标识尚未核验'));
    const subscriptions = el('div', 'chain-subscription-count'); subscriptions.append(el('strong', '', count(chain.activeSubscriptions)), el('span', '', `/ ${count(chain.desiredSubscriptions)} 个目标订阅`)); card.append(subscriptions);
    card.append(kv('观察钱包 / 流动性池', `${count(chain.watchedWallets)} / ${count(chain.watchedPools)}`), kv('链上池报价覆盖', count(chain.coveredPrices)), kv('GMGN 报价回退对象', count(chain.fallbackTokens)), kv('尚未支持的池', count(chain.unsupportedPools)), kv('本次重连次数', count(chain.reconnects)), kv('最近连接消息', date(chain.lastMessageAt, true)), kv(chain.chain === 'solana' ? '最近 slot 通知' : '最近区块头通知', date(chain.lastHeadAt, true)), kv('最近链上报价', date(chain.latestPriceAt, true)));
    const gapComplete = chain.gap && [false, 0].includes(chain.gap.pending) && [false, 0].includes(chain.gap.incomplete);
    const gap = el('div', `chain-gap ${hasGapIssue(chain.gap?.incomplete) || hasGapIssue(chain.gap?.pending) ? 'attention' : gapComplete ? 'complete' : ''}`);
    gap.append(el('strong', '', `断线补数：${gapLabel(chain.gap)}`), el('p', '', `最近完成 ${date(chain.gap?.lastCompletedAt, true)}`)); card.append(gap);
    card.append(el('p', 'chain-card-counts', `${count(chain.events)} 条观察事件 · ${count(chain.poolPriceSamples)} 个池报价样本`));
    if (chain.lastError) card.append(el('p', 'chain-error', `最近异常：${streamErrorLabel(chain.lastError)}`));
    return card;
  }
  function chainEventCard(event, openEvents) {
    const card = el('details', `chain-event${event.removed === true ? ' removed' : ''}`); card.dataset.chainEventId = scalar(event.id, ''); card.open = openEvents.has(card.dataset.chainEventId);
    const summary = el('summary', 'chain-event-summary'); const heading = el('div', 'chain-event-title');
    heading.append(el('strong', '', streamEventNames[event.kind] || '链上事件'), el('span', '', chainName(event.chain)));
    const tags = el('div', 'chain-event-tags'); tags.append(badge(event.source === 'live' ? '实时订阅' : event.source === 'backfill' ? '历史补数' : '来源未知', 'neutral'));
    tags.append(badge(event.removed === true ? '链重组撤回' : event.verification === 'rpc_confirmed' ? 'RPC 已确认' : event.verification === 'rpc_observed' ? 'RPC 已观测' : '核验状态未知', event.removed === true ? 'fail' : 'neutral'));
    summary.append(heading, tags, el('time', '', date(event.observedAt, true))); card.append(summary);
    const body = el('div', 'chain-event-body');
    if (event.removed === true) body.append(el('p', 'chain-error', '该事件已被标记为链重组撤回，不作为有效转账或成交的确认依据。'));
    for (const [label, value] of [['观察钱包', event.wallet], ['关联地址 / 池', event.address], ['代币合约', event.tokenAddress], ['转出地址', event.from], ['转入地址', event.to], ['交易哈希 / 签名', event.txHash]]) {
      if (typeof value !== 'string' || !value) continue;
      const row = el('div', 'chain-event-field'); row.append(el('span', '', label), addressNode(value)); body.append(row);
    }
    if (event.amountAtomic !== undefined) body.append(kv('原子数量（未换算）', scalar(event.amountAtomic)));
    if (event.blockNumber !== undefined) body.append(kv('区块高度', scalar(event.blockNumber)));
    if (event.slot !== undefined) body.append(kv('Slot', scalar(event.slot)));
    body.append(el('p', 'chain-event-caveat', '转账或钱包交易活动本身不足以判断买卖方向、真实成交或实际控制人。'));
    card.append(body); return card;
  }
  function renderChainStream() {
    const data = state.chainStream || state.overview?.chainStream, chains = Array.isArray(data?.chains) ? data.chains.filter(chain => chain && typeof chain === 'object') : [], store = data?.store || {};
    const cards = $('chain-stream-cards'); cards.replaceChildren(); for (const chain of chains) cards.append(chainStreamCard(chain));
    const empty = $('chain-stream-empty'); empty.hidden = chains.length > 0;
    empty.textContent = state.resourceErrors.chainStream && !data ? '暂时无法读取链上订阅状态，页面会自动重试。' : !data ? '正在读取链上订阅状态…' : !data.enabled ? '链上长连接尚未启用。这里不提供交易或订阅开关。' : '等待服务端返回各链的订阅状态。';
    const mode = $('chain-stream-mode'); mode.className = `badge ${data?.enabled && !data.running ? 'watch' : 'neutral'}`; mode.textContent = !data ? '等待状态' : !data.enabled ? '观察未启用' : data.mode === 'observation_only' ? '仅链上观察 · 不发送交易' : '模式待核实';
    const warnings = [];
    if (state.resourceErrors.chainStream) warnings.push('链上监控详情暂时无法更新，下方保留最近成功读取的状态。');
    if (data?.enabled && !data.running) warnings.push('链上观察进程当前未运行。');
    if (data?.captureError) warnings.push(streamErrorLabel(data.captureError));
    if (store.incomplete) warnings.push('链上事件存档存在缺失，不能将当前列表视为完整历史。');
    if (chains.some(chain => hasGapIssue(chain.gap?.incomplete))) warnings.push('部分网络仍有未覆盖的历史范围，请查看各链补数状态。');
    $('chain-stream-warning').hidden = warnings.length === 0; text('chain-stream-warning', warnings.join(' '));
    text('chain-stream-storage-note', `已存 ${count(store.events)} 条事件 · ${bytes(store.bytes)} / ${bytes(store.maxBytes)}`);
    text('chain-stream-coverage-note', data?.coverage === 'targeted_observation' ? '仅目标观察 · EVM 代币转账 / Solana 钱包交易提及 · 非全链覆盖' : '覆盖范围尚未确认');
    const container = $('chain-stream-events'); const openEvents = new Set([...container.querySelectorAll('details[data-chain-event-id][open]')].map(item => item.dataset.chainEventId)); container.replaceChildren();
    const events = Array.isArray(data?.recentEvents) ? data.recentEvents.filter(event => event && typeof event === 'object') : [];
    text('chain-events-count', count(events.length)); $('chain-events-empty').hidden = events.length > 0;
    text('chain-events-empty', !data?.enabled ? '监控未启用时没有新增订阅事件；已存历史以服务端返回为准。' : '暂未收到目标钱包或池的可展示事件，不代表这些目标没有活动。');
    for (const event of events) container.append(chainEventCard(event, openEvents));
  }
  function renderScanner(scanner) {
    if (!scanner) { text('scanner-label', '状态暂不可用'); text('scanner-description', '尚未获得扫描器运行信息'); text('scanner-last', '—'); return; }
    const cycle = scanner.lastCycle || {};
    const cooling = scanner.cooldownUntil && Date.parse(scanner.cooldownUntil) > Date.now();
    text('scanner-label', cooling ? '限流冷却中' : scanner.running ? scanner.inFlight ? '正在扫描信号' : '扫描器运行中' : '扫描器未运行');
    text('scanner-description', cooling ? `上游冷却至 ${date(scanner.cooldownUntil, true)}` : cycle.status === 'partial' ? '部分来源暂不可用，已保留成功结果' : scanner.running ? '持续读取配置中的网络与信号来源' : '等待服务端启动或配置扫描任务');
    text('scanner-last', time(cycle.completedAt));
  }
  function renderScanEmpty(title, description) { $('scan-empty').hidden = false; text('scan-empty-title', title); text('scan-empty-description', description); }
  function decisionExpired(record) {
    const deadline = validDate(record.validUntil); return Boolean(deadline && deadline.getTime() <= Date.now());
  }
  function observationEnded(record) {
    const observation = record.observation;
    return observation?.state === 'ended' || Boolean(validDate(observation?.endsAt) && Date.parse(observation.endsAt) <= Date.now());
  }
  function decisionBadge(record) {
    if (record.decision === 'WATCH') {
      if (observationEnded(record)) return badge('观察结束', 'neutral');
      if (record.observation?.state === 'processing') return badge('复评中', 'watch');
      if (record.observation?.state === 'scheduled') return badge(validDate(record.observation.nextCheckAt) && Date.parse(record.observation.nextCheckAt) <= Date.now() ? '等待复评' : '待复评', 'watch');
      return badge(decisionExpired(record) ? '历史判断已过期' : '上次判断待观察', 'neutral');
    }
    if (record.decision === 'BUY_CANDIDATE' && decisionExpired(record)) return badge('曾通过 · 已过期', 'neutral');
    if (decisions[record.decision]) return badge(...decisions[record.decision]);
    return record.status === 'interrupted' ? badge('研究中断', 'watch') : record.status === 'failed' || record.status === 'error' ? badge('处理异常', 'fail') : badge('研究中', 'neutral');
  }
  function observationSubtitle(record) {
    const observation = record.observation;
    if (record.decision !== 'WATCH') return record.decision === 'BUY_CANDIDATE' && decisionExpired(record) ? '需重新判断后才能作为当前候选' : null;
    if (observationEnded(record)) return `观察截止 ${date(observation?.endsAt)}`;
    if (observation?.state === 'processing') return `正在复评 · 截止 ${date(observation.endsAt)}`;
    if (observation?.nextCheckAt) return Date.parse(observation.nextCheckAt) <= Date.now() ? `排队中 · 截止 ${date(observation.endsAt)}` : `计划复评 ${date(observation.nextCheckAt)}`;
    if (observation?.endsAt) return `观察截止 ${date(observation.endsAt)}`;
    return '历史记录未加入定时复评';
  }
  function renderScans() {
    const body = $('scan-rows'); body.replaceChildren(); text('list-count', count(state.total)); $('scan-empty').hidden = state.items.length > 0;
    if (!state.items.length) {
      const filtered = state.chain || state.decision || state.search;
      renderScanEmpty(filtered ? '没有匹配的扫描记录' : state.view === 'candidates' ? '等待第一个符合条件的信号' : '等待第一个信号', filtered ? '尝试调整网络、筛选结果或搜索关键词。' : state.view === 'candidates' ? '通过研究判断后，才会开始采集价格样本。未符合条件的记录不会计算条件后涨幅。' : '扫描结果到达后，会在这里显示筛选依据与后续表现。');
    }
    for (const record of state.items) {
      const row = el('tr'); const token = el('td'); const top = el('div', 'token-top'); const displayName = record.symbol || record.name || '未命名代币';
      top.append(el('span', `token-avatar ${chainClass(record.chain)}`, Array.from(String(displayName))[0]?.toUpperCase() || '?'));
      const heading = el('div', 'token-heading'); const button = el('button', 'token-name', displayName); button.type = 'button'; button.addEventListener('click', () => openDetail(record.id, button)); heading.append(button);
      const meta = el('div', 'token-meta'); meta.append(el('span', '', chainName(record.chain)), el('span', '', scalar(record.source).toUpperCase())); heading.append(meta); top.append(heading); token.append(top, addressNode(record.address)); const mobileLink = gmgnTokenLink(record.chain, record.address); mobileLink.classList.add('scan-mobile-link'); token.append(mobileLink); row.append(token);
      const narrative = narrativePreview(record.narrative, `scan:${record.id}`); if (narrative) token.append(narrative);
      const social = socialBadge(record.social); if (social) { const chips = el('div', 'scan-social-line'); chips.append(social); token.append(chips); }
      const decision = el('td'); decision.append(decisionBadge(record)); decision.append(el('div', 'cell-subtitle', `上次判断 ${date(record.evaluatedAt || record.receivedAt)}`)); const observationNote = observationSubtitle(record); if (observationNote) decision.append(el('div', 'cell-subtitle observation-subtitle', observationNote)); row.append(decision);
      const p = record.performance; const when = el('td', 'cell-date', date(p?.eligibleAt)); if (p?.eligibleAt) when.append(el('div', 'cell-subtitle', p.status === 'waiting' ? '等待首个报价' : p.status === 'ended' ? '追踪已结束' : p.status === 'unavailable' ? '报价暂不可用' : `最近 ${time(p.latestAt)}`)); row.append(when);
      const max = el('td', 'numeric'); max.append(gainNode(p?.maxGainPct)); if (p?.peakAt) max.append(el('div', 'cell-subtitle', time(p.peakAt))); row.append(max);
      const current = el('td', 'numeric'); current.append(gainNode(p?.currentGainPct)); if (finite(p?.samples)) current.append(el('div', 'cell-subtitle', `${p.samples} 个样本`)); row.append(current);
      const action = el('td'); const actions = el('div', 'scan-row-actions'); actions.append(gmgnTokenLink(record.chain, record.address)); const arrow = el('button', 'row-arrow', '›'); arrow.type = 'button'; arrow.setAttribute('aria-label', `查看 ${displayName} 的扫描详情`); arrow.addEventListener('click', () => openDetail(record.id, arrow)); actions.append(arrow); action.append(actions); row.append(action); body.append(row);
    }
    rebindNarrative(body);
    text('pagination-info', state.total ? `显示 ${state.items.length ? state.offset + 1 : 0}–${Math.min(state.offset + state.items.length, state.total)} 条，共 ${count(state.total)} 条` : '共 0 条记录');
    text('page-number', String(Math.floor(state.offset / PAGE_SIZE) + 1).padStart(2, '0')); $('previous-page').disabled = state.offset === 0; $('next-page').disabled = state.offset + PAGE_SIZE >= state.total;
  }
  const protectionEventNames = {
    initialized: '建立模拟基准', protection_armed: '启动动态跟踪', partial_exit: '触发部分卖出建议', full_exit: '触发全部卖出建议',
    price_unavailable: '报价暂不可用', price_recovered: '报价恢复', observation_ended: '影子观察结束',
    baseline: '建立模拟基准', baseline_set: '建立模拟基准', started: '开始影子观察',
    activated: '达到跟踪启动条件', protection_activated: '达到跟踪启动条件',
    peak: '记录新峰值', new_peak: '记录新峰值', peak_updated: '记录新峰值',
    protection_updated: '更新动态保护线', protection_raised: '上调动态保护线',
    pressure_tighten: '根据样本卖压收紧保护线',
    trailing_stop: '触发跟踪回撤建议', trail_triggered: '触发跟踪回撤建议',
    stop_loss: '触发止损建议', take_profit: '触发止盈建议', triggered: '触发影子卖出建议',
    stale: '报价延迟', unavailable: '报价不可用', ended: '影子观察结束',
  };
  function protectionReason(value) { return reasonNames[value] || protectionEventNames[value] || scalar(value, '未提供原因'); }
  function protectionEmpty(title, description) { $('protection-empty').hidden = false; text('protection-empty-title', title); text('protection-empty-description', description); }
  function protectionMetric(label, value, hint, tone = '') {
    const node = el('div', 'protection-value'); node.append(el('span', '', label), el('strong', tone, value));
    if (hint) node.append(el('small', '', hint)); return node;
  }
  function protectionEvent(event) {
    const row = el('li', 'protection-event'); const head = el('div', 'protection-event-heading');
    head.append(el('strong', '', protectionEventNames[event.kind] || scalar(event.kind, '观察事件')), el('time', '', date(event.at, true))); row.append(head);
    row.append(el('p', '', protectionReason(event.reason)), el('span', 'protection-observation-label', '仅观察 · 未执行交易'));
    const values = [];
    if (finite(numeric(event.sellPct))) values.push(`影子建议卖出当时剩余的 ${plainPercent(numeric(event.sellPct))}`);
    if (finite(numeric(event.gainPct))) values.push(`模拟浮盈 ${percent(numeric(event.gainPct))}`);
    if (values.length) row.append(el('p', 'protection-event-values', values.join(' · ')));
    return row;
  }
  function protectionCard(item, openEvents) {
    const card = el('article', 'protection-card'); const header = el('div', 'protection-card-heading');
    const identity = el('div', 'protection-identity'); const name = el('h3', '', item.symbol || '未命名代币');
    identity.append(name, el('div', 'token-meta', `${chainName(item.chain)} · 影子观察`));
    const actions = el('div', 'protection-card-actions');
    actions.append(badge(item.phase === 'triggered' ? '已触发模拟建议' : item.phase === 'ended' ? '观察已结束' : finite(numeric(item.baselinePriceUsd)) ? '影子跟踪中' : '等待模拟基准', item.phase === 'triggered' ? 'watch' : 'neutral'), gmgnTokenLink(item.chain, item.address));
    header.append(identity, actions); card.append(header, addressNode(item.address, 'detail-address'));
    const data = el('div', 'protection-value-grid'); const gain = numeric(item.gainPct), peak = numeric(item.peakGainPct);
    data.append(protectionMetric('当前模拟涨幅', percent(gain), '相对影子基准，非持仓收益', finite(gain) ? gain < 0 ? 'negative' : 'positive' : ''), protectionMetric('观察期最高涨幅', percent(peak), '包含影子退出后的新报价', finite(peak) ? peak < 0 ? 'negative' : 'positive' : ''), protectionMetric(item.protectionActive === false ? '基础止损线（影子）' : '动态保护线', usd(item.protectionPriceUsd), finite(numeric(item.protectionGainPct)) ? `相对基准 ${percent(numeric(item.protectionGainPct))}` : '尚无有效保护线', 'protection-line-value'), protectionMetric('建议剩余比例', plainPercent(numeric(item.remainingPct)), '相对模拟初始仓位，非真实持仓'));
    card.append(data);
    const prices = el('div', 'protection-price-grid');
    prices.append(kv('模拟基准价', usd(item.baselinePriceUsd)), kv('最新样本价', usd(item.latestPriceUsd)), kv('峰值样本价', usd(item.peakPriceUsd)), kv('跟踪启动涨幅', percent(numeric(item.activationGainPct))), kv('当前跟踪回撤', plainPercent(numeric(item.trailPct))));
    if (finite(numeric(item.triggerPeakGainPct))) prices.append(kv(item.phase === 'triggered' ? '触发前模型峰值涨幅' : '当前模型峰值涨幅', percent(numeric(item.triggerPeakGainPct))));
    card.append(prices, el('p', 'protection-window-note', '当前涨幅与观察期最高涨幅均相对影子基准计算，不是实际持仓收益。触发建议不代表成交；全部影子退出后模型停止更新，观察期最高涨幅仍会记录后续新报价。'));
    const priceSource = {chain_pool_sample: '链上池报价（USD 参照价）', gmgn_token_info_sample: 'GMGN 回退报价'}[item.priceSource] || '报价来源未知';
    const priceSourceRow = el('div', 'protection-price-source'); priceSourceRow.append(badge(priceSource, item.priceSource === 'chain_pool_sample' ? 'pass' : 'neutral'), el('span', '', item.priceSource === 'chain_pool_sample' ? '池内价格按 USD 参照价换算，不代表可成交美元价格。' : item.priceSource === 'gmgn_token_info_sample' ? '当前样本来自 GMGN 代币报价。' : '供应商未明确当前样本来源，不推定为链上报价。')); card.append(priceSourceRow);
    const health = el('div', `protection-health ${item.health === 'fresh' ? 'fresh' : 'attention'}`);
    const healthLabel = {fresh: '行情样本正常', stale: '行情样本延迟', unavailable: '行情样本不可用'}[item.health] || '行情健康未知';
    health.append(badge(healthLabel, item.health === 'fresh' ? 'pass' : 'watch'), el('span', '', `最近报价 ${date(item.lastPriceAt, true)}`));
    if (finite(numeric(item.maxGapSec))) health.append(el('span', '', `最大报价间隔 ${count(numeric(item.maxGapSec))} 秒`));
    if (item.health !== 'fresh') health.append(el('p', '', '显示的是最近已收到的样本与保护线，不能视为当前行情或实时可执行价格。'));
    card.append(health);
    const pressure = item.pressure || {}, pressureNode = el('div', 'protection-pressure');
    const pressureHeading = el('div', 'protection-pressure-heading'); pressureHeading.append(el('strong', '', '钱包卖压证据'), badge(pressure.status === 'observed' ? '已有样本' : '未知', pressure.status === 'observed' ? 'neutral' : 'watch')); pressureNode.append(pressureHeading);
    if (pressure.status === 'observed') {
      const values = el('div', 'protection-pressure-values'); values.append(kv('交易样本', count(pressure.tradeCount)), kv('钱包样本', count(pressure.walletCount)), kv('样本净卖出比例', finite(numeric(pressure.netSellRatio)) ? plainPercent(numeric(pressure.netSellRatio) * 100) : '—')); pressureNode.append(values);
      pressureNode.append(el('p', '', `来源：${scalar(pressure.source, '未提供')}。仅反映已覆盖钱包与交易，不能代表全市场卖压。`));
    } else pressureNode.append(el('p', '', '缺少可核验的近期卖出样本，无法判断钱包卖压；未知不等于没有卖压。'));
    card.append(pressureNode);
    if (item.lastEvent && typeof item.lastEvent === 'object') {
      const latest = el('div', 'protection-last-event'); latest.append(el('span', '', '最近观察事件'), el('strong', '', protectionReason(item.lastEvent.reason)), el('time', '', date(item.lastEvent.at, true)));
      if (finite(numeric(item.lastEvent.sellPct))) latest.append(el('p', '', `影子建议卖出当时剩余的 ${plainPercent(numeric(item.lastEvent.sellPct))} · 未执行交易`)); card.append(latest);
    }
    const events = Array.isArray(item.events) ? item.events.filter(event => event && typeof event === 'object').slice(0, 5) : [];
    const disclosure = el('details', 'protection-events'); disclosure.dataset.protectionId = scalar(item.id, ''); disclosure.open = openEvents.has(disclosure.dataset.protectionId);
    disclosure.append(el('summary', '', `最近观察事件 · ${events.length} 条`));
    if (events.length) { const list = el('ol', 'protection-event-list'); for (const event of events) list.append(protectionEvent(event)); disclosure.append(list); }
    else disclosure.append(el('p', 'protection-event-empty', '暂无可展示的事件记录。未发生事件不代表已执行任何保护。'));
    card.append(disclosure);
    const times = el('div', 'protection-card-times'); times.append(el('span', '', `符合条件 ${date(item.eligibleAt, true)}`), el('span', '', `模拟起点 ${date(item.startedAt, true)}`), el('span', '', `记录更新 ${date(item.updatedAt, true)}`)); card.append(times);
    return card;
  }
  function renderProtection() {
    const data = state.protection, status = data?.status || {}, items = Array.isArray(data?.items) ? data.items.filter(item => item && typeof item === 'object') : [];
    const container = $('protection-items'); const openEvents = new Set([...container.querySelectorAll('details[data-protection-id][open]')].map(item => item.dataset.protectionId)); container.replaceChildren();
    text('protection-total', count(status.positions)); text('protection-active', count(status.active)); text('protection-triggered', count(status.triggered)); text('protection-stale', count(status.stale)); text('protection-count', count(items.length));
    const marker = $('protection-status-badge'); marker.className = `badge ${data?.enabled ? 'watch' : 'neutral'}`; marker.textContent = data ? data.enabled ? '仅影子验证' : '影子验证未启用' : '正在读取';
    text('protection-policy-note', `策略版本 ${scalar(data?.policyVersion)} · 实盘保护未就绪`);
    text('protection-history-note', status.historyComplete === true ? '启用后成功获取的原始报价逐条保留；采样间隔内的行情仍未知。' : status.historyComplete === false ? '原始报价存档存在缺失，请结合记录异常复核。' : '原始采样保存状态尚未确认。');
    text('protection-collection-status', data?.enabled ? `累计 ${count(status.samples)} 个价格样本 · ${count(status.events)} 条观察事件 · 最近采样 ${date(status.lastSampleAt, true)}` : data ? '尚未启用影子观察，当前页面不提供开启交易或挂单操作。' : '正在读取保护观察记录…');
    const warnings = [];
    if (state.resourceErrors.protection) warnings.push('保护记录暂时无法更新；下方若有数据，仍为最近一次成功读取的结果。');
    for (const captureError of new Set([data?.captureError, state.overview?.exitProtection?.captureError].filter(Boolean))) warnings.push(`影子记录读写异常：${protectionReason(captureError)}。本页数据可能不完整或未更新。`);
    if (status.lastError) warnings.push(`最近采样异常：${protectionReason(status.lastError)}`);
    if (status.historyComplete === false) warnings.push('部分已获取的原始样本未完整留存，请检查采样保存状态。');
    if (data && data.mode !== 'shadow') warnings.push('服务返回的模式与影子验证界面不一致，页面不确认任何实盘保护状态。');
    $('protection-warning').hidden = warnings.length === 0; text('protection-warning', warnings.join(' '));
    $('protection-empty').hidden = items.length > 0;
    if (!items.length) {
      if (state.resourceErrors.protection && !state.protectionLoaded) protectionEmpty('暂时无法读取保护观察记录', '连接恢复后会自动重试。页面不会补入模拟收益或历史峰值。');
      else if (!data) protectionEmpty('正在读取影子验证状态', '读取真实观察记录后，会展示动态保护线和行情健康状况。');
      else if (!data.enabled) protectionEmpty('影子验证尚未启用', '目前没有前瞻保护记录。实盘保护仍未就绪，页面不提供交易操作。');
      else protectionEmpty('等待第一条前瞻保护记录', '符合条件的对象收到新的有效报价后，才建立模拟基准。已有历史高点不会回填为模拟收益。');
    }
    for (const item of items) container.append(protectionCard(item, openEvents));
  }
  function renderOrders() {
    const body = $('order-rows'); body.replaceChildren(); text('orders-count', count(state.orders.length)); $('orders-empty').hidden = state.orders.length > 0;
    $('orders-empty').querySelector('h3').textContent = '暂无订单记录'; $('orders-empty').querySelector('p').textContent = '当服务端产生订单后，这里会展示实际执行状态。';
    for (const order of state.orders) {
      const row = el('tr'); const asset = el('td'); asset.append(el('div', 'token-meta', chainName(order.chain)), addressNode(order.tokenAddress), el('div', 'cell-subtitle', `ID ${scalar(order.id)}`)); row.append(asset);
      row.append(el('td', 'cell-date', date(order.createdAt, true)));
      const amount = order.amountIn !== undefined ? `${scalar(order.amountIn)} ${scalar(order.inputSymbol, chainSymbols[order.chain] || '')}` : order.inputAmount !== undefined ? `${scalar(order.inputAmount)} 原子单位` : '—';
      const amountCell = el('td', '', amount); amountCell.append(el('div', 'cell-subtitle', order.amountBasis === 'actual' ? '成交支出' : '计划金额 · 未确认')); row.append(amountCell);
      const status = el('td'); status.append(badge(...(orderStatuses[order.status] || [scalar(order.status), 'neutral']))); if (order.mode === 'paper' && order.status !== 'paper_open') status.append(el('div', 'cell-subtitle', '模拟订单')); row.append(status);
      const exit = el('td'); exit.append(badge(exitStatuses[order.exit?.state] || '未配置 / 无记录', ['attention', 'unverified'].includes(order.exit?.state) ? 'watch' : order.exit?.state === 'monitoring' ? 'pass' : 'neutral')); if (order.exit?.checkedAt) exit.append(el('div', 'cell-subtitle', date(order.exit.checkedAt))); row.append(exit); body.append(row);
    }
  }
  function renderSystem() {
    const runtime = $('system-runtime'); const policy = $('system-policy'); runtime.replaceChildren(); policy.replaceChildren();
    const data = state.overview;
    if (!data) { runtime.append(el('p', 'panel-placeholder', '正在读取运行信息…')); policy.append(el('p', 'panel-placeholder', '等待服务端配置')); return; }
    const scanner = data.scanner || {}; const cycle = scanner.lastCycle || {}; const settings = data.settings || {}; const tracking = data.tracking || {};
    const mode = entryModeLabel(data.entryMode);
    const system = data.system || {}; const research = data.walletResearch || state.walletStatus || {};
    runtime.append(kv('服务启动时间', date(system.startedAt, true)), kv('连续运行', duration(system.uptimeSec)), kv('服务器 CPU', `${plainPercent(system.cpu?.usagePct)} · ${scalar(system.cpu?.cores)} 核`), kv('服务器内存', `${bytes(system.memory?.usedBytes)} / ${bytes(system.memory?.totalBytes)}`), kv('机器人进程内存', bytes(system.memory?.processRssBytes)), kv('磁盘已用 / 总量', `${bytes(system.disk?.usedBytes)} / ${bytes(system.disk?.totalBytes)}`), kv('磁盘可用空间', bytes(system.disk?.freeBytes)), kv('资源采样时间', date(system.sampledAt, true)));
    if (Array.isArray(system.warnings) && system.warnings.length) runtime.append(reasonList(system.warnings));
    runtime.append(kv('钱包历史采集', research.enabled ? '已启用 · 长期保留' : '未启用'), kv('钱包历史 / 容量上限', `${bytes(research.store?.bytes)} / ${bytes(research.store?.maxBytes)}`), kv('最近钱包观测', date(research.store?.lastObservedAt, true)), kv('最近钱包增强采集', date(research.observer?.lastCycle?.completedAt, true)));
    const researchError = research.store?.error || research.captureError || research.observer?.feedError;
    if (researchError) runtime.append(el('p', 'detail-message detail-error', reasonNames[researchError] || scalar(researchError)));
    for (const balance of Array.isArray(data.balances) ? data.balances : []) {
      runtime.append(kv(`${chainName(balance.chain)} · 余额查询`, balance.status === 'ok' ? `正常 · ${date(balance.checkedAt, true)}` : balance.status === 'stale' ? `刷新失败 · 上次成功 ${date(balance.checkedAt, true)}` : balance.status === 'loading' ? '查询中' : '暂不可用'));
      if (balance.status !== 'ok' && balance.reason) runtime.append(el('p', 'detail-message detail-error', reasonNames[balance.reason] || scalar(balance.reason)));
    }
    runtime.append(kv('服务端开仓模式', mode), kv('扫描任务', scanner.running ? '运行中' : '未运行'), kv('当前扫描', scanner.inFlight ? '正在处理' : '等待下一轮'), kv('最近扫描结束', date(cycle.completedAt, true)), kv('最近一轮接收 / 输出', finite(cycle.received) ? `${cycle.received} / ${scalar(cycle.emitted)}` : '—'), kv('最近一轮错误数', cycle.errors), kv('档案保留', finite(settings.scanRetentionDays) ? `${settings.scanRetentionDays} 天` : '—'), kv('条件后追踪窗口', finite(settings.trackingHours) ? `${settings.trackingHours} 小时` : '—'), kv('价格轮询间隔', finite(settings.sampleIntervalSec) ? `${settings.sampleIntervalSec} 秒 / 轮` : '—'));
    if (tracking.lastCycle?.completedAt || tracking.lastAt) runtime.append(kv('最近价格轮询', date(tracking.lastCycle?.completedAt || tracking.lastAt, true)));
    if (Array.isArray(cycle.diagnostics) && cycle.diagnostics.length) {
      runtime.append(el('p', 'policy-caption', '各来源最近状态'));
      for (const item of cycle.diagnostics) runtime.append(kv(`${chainName(item.chain)} · ${scalar(item.kind)}`, {ok: '正常', empty: '暂无新记录', invalid_response: '响应异常', unavailable: '暂不可用', rate_limited: '限流'}[item.status] || scalar(item.status)));
    }
    if (data.archiveError) runtime.append(el('p', 'detail-message detail-error', '档案写入失败，记录可能不完整。'));
    runtime.append(el('p', 'policy-caption', '工作台只展示服务端状态。通过研究门槛不代表已下单；实际开单还需报价、余额和执行检查。价格任务逐币轮询，实际间隔以最后报价时间为准。'));
    if (settings.watchRecheck) policy.append(kv('观察定时复评', settings.watchRecheck.enabled ? '已启用' : '未启用'), kv('最长观察窗口', `${scalar(settings.watchRecheck.windowSec)} 秒（受原始信号有效期限制）`), kv('复评队列调度', `每 ${scalar(settings.watchRecheck.intervalSec)} 秒，单轮最多 ${scalar(settings.watchRecheck.maxPerCycle)} 条`));
    const watch = data.watchRecheck;
    if (watch) {
      runtime.append(kv('观察复评运行状态', watchRecheckLabel(watch)));
      if (watch.enabled) {
        runtime.append(kv('待复评 / 到期排队', `${count(watch.queue?.scheduled)} / ${count(watch.queue?.due)}`), kv('正在复评 / 已结束观察', `${count(watch.queue?.processing)} / ${count(watch.queue?.ended)}`), kv('本次服务已完成复评', count(watch.completed)), kv('最近一轮复评调度', date(watch.lastRunAt, true)));
        if (watch.queue?.nextCheckAt) runtime.append(kv('最近待执行计划', date(watch.queue.nextCheckAt, true)));
        if (watch.deferredReason) runtime.append(kv('当前延后原因', reasonNames[watch.deferredReason] || scalar(watch.deferredReason)));
        if (watch.lastError) runtime.append(kv('最近复评错误', reasonNames[watch.lastError] || scalar(watch.lastError)));
        runtime.append(el('p', 'detail-small', '已完成复评统计执行次数，不是通过条件的数量。到期任务按队列逐条检查，调度运行中不代表每个币都已重新判断。'));
      }
    }
    const protection = data.exitProtection || {};
    policy.append(kv('动态止盈保护', protection.enabled ? '仅影子验证 · 不发送卖单' : '影子验证未启用'), kv('实盘保护就绪', '未就绪'), kv('保护策略版本', protection.policyVersion), kv('影子观察对象 / 触发建议', `${count(protection.status?.positions)} / ${count(protection.status?.triggered)}`));
    if (protection.captureError) policy.append(el('p', 'detail-message detail-error', `影子保护记录异常：${protectionReason(protection.captureError)}`));
    const caps = Array.isArray(settings.caps) ? settings.caps : [];
    if (caps.length) for (const cap of caps) { policy.append(kv(`${chainName(cap.chain)} · 单笔上限`, `${scalar(cap.maxPerOrder)} ${scalar(cap.symbol, chainSymbols[cap.chain] || '')}`), kv(`${chainName(cap.chain)} · 费用预留`, `${scalar(cap.feeReserve)} ${scalar(cap.symbol, chainSymbols[cap.chain] || '')}`)); }
    else policy.append(el('p', 'panel-placeholder', '暂无可展示的开仓上限。'));
    const exit = settings.exitPolicy;
    if (exit?.enabled) {
      if (Array.isArray(exit.takeProfit)) for (const tier of exit.takeProfit) policy.append(kv(`止盈 · 涨幅 ${percent(tier.gainPct)}`, `卖出当时持仓的 ${scalar(tier.sellPct)}%`));
      if (exit.stopLoss) policy.append(kv(`止损 · 下跌 ${scalar(exit.stopLoss.dropPct)}%`, `卖出当时持仓的 ${scalar(exit.stopLoss.sellPct)}%`));
    } else policy.append(kv('自动退出规则', '未启用 / 未配置'));
    policy.append(el('p', 'policy-caption', '配置中的阈值与订单的实际退出保护状态分别展示；具体执行结果请查看订单记录。'));
  }

  async function openDetail(id, trigger, wallet) {
    if (typeof id !== 'string') return;
    closeNarrative();
    state.returnFocus = trigger || document.activeElement; state.detailId = id; state.detailKind = wallet?.association ? 'association' : wallet ? 'wallet' : 'scan'; state.detailWallet = wallet || null; state.detailGeneration++;
    text('detail-eyebrow', wallet ? 'WALLET RESEARCH' : 'SIGNAL DETAIL');
    $('drawer-backdrop').hidden = false; $('detail-drawer').hidden = false; $('app').inert = true; document.body.classList.add('drawer-open');
    const loading = el('p', 'drawer-loading', wallet ? '正在读取研究证据…' : '正在读取信号详情…'); loading.id = 'detail-title'; $('detail-content').replaceChildren(loading); $('detail-drawer').focus();
    await loadDetail(id);
  }
  async function loadDetail(id, quiet = false) {
    const generation = state.detailGeneration;
    const wallet = state.detailKind === 'wallet' ? state.detailWallet : null;
    const association = state.detailKind === 'association' ? state.detailWallet : null;
    try {
      const record = await api(association ? `/wallet-associations/${encodeURIComponent(association.chain)}/${encodeURIComponent(association.leader)}/${encodeURIComponent(association.candidate)}` : wallet ? `/wallets/${encodeURIComponent(wallet.chain)}/${encodeURIComponent(wallet.address)}` : `/scans/${encodeURIComponent(id)}`);
      if (state.detailId === id && generation === state.detailGeneration) { if (association) renderAssociationDetail(record); else if (wallet) renderWalletResearchDetail(record); else renderDetail(record); }
    } catch (error) {
      if (error.status === 401) { showLogin('会话已结束，请重新登录。'); return; }
      if (state.detailId !== id || generation !== state.detailGeneration) return;
      if (!quiet) $('detail-content').replaceChildren(el('h2', '', '详情暂不可用'), el('p', 'drawer-loading detail-error', error.status === 404 ? '这条记录已超出保留期或不存在。' : '连接异常，请关闭详情后重试。'));
      else { const old = $('detail-stale'); if (!old) { const note = el('p', 'notice warning', '详情暂时无法更新，以下为最近成功读取的记录。'); note.id = 'detail-stale'; $('detail-content').prepend(note); } }
    }
  }
  function closeDrawer() {
    closeNarrative();
    const wasOpen = state.detailId !== null;
    state.detailId = null; state.detailWallet = null; state.detailGeneration++; $('detail-drawer').hidden = true; $('drawer-backdrop').hidden = true; $('app').inert = false; document.body.classList.remove('drawer-open');
    if (wasOpen && state.returnFocus?.isConnected) state.returnFocus.focus();
  }
  $('close-drawer').addEventListener('click', closeDrawer); $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', event => {
    if (!state.detailId) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
    if (event.key === 'Tab') {
      const items = [...$('detail-drawer').querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')].filter(item => item.getClientRects().length); const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === $('detail-drawer'))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  function section(title) { const node = el('section', 'detail-section'); node.append(el('h3', '', title)); return node; }
  function detailStat(label, value, hint, tone = '') { const node = el('div', 'detail-stat'); node.append(el('span', '', label), el('strong', tone, value)); if (hint) node.append(el('small', '', hint)); return node; }
  function renderDetail(record) {
    const container = $('detail-content'); const openProfiles = new Set([...container.querySelectorAll('details[data-profile-address][open]')].map(item => item.dataset.profileAddress));
    const fragment = document.createDocumentFragment(); const name = record.symbol || record.name || '未命名代币';
    const heading = el('div', 'detail-token'); heading.append(el('span', `token-avatar ${chainClass(record.chain)}`, Array.from(String(name))[0]?.toUpperCase() || '?')); const titleGroup = el('div'); const title = el('h2', '', name); title.id = 'detail-title'; titleGroup.append(title, el('div', 'token-meta', `${chainName(record.chain)} · ${scalar(record.source).toUpperCase()}`)); heading.append(titleGroup); fragment.append(heading, addressNode(record.address, 'detail-address'));
    const links = el('div', 'detail-links'); links.append(gmgnTokenLink(record.chain, record.address, '在 GMGN 查看代币 ↗')); fragment.append(links);
    const pills = el('div', 'detail-pills'); pills.append(decisionBadge(record)); if (record.performance) pills.append(badge('曾通过研究判断', 'neutral')); fragment.append(pills);
    const meta = section('信号时间线'); meta.append(kv('信号发生', date(record.occurredAt, true)), kv('扫描接收', date(record.receivedAt, true)), kv('最近研究判断', date(record.evaluatedAt, true))); if (record.validUntil) meta.append(kv('判断有效期至', date(record.validUntil, true)));
    const observation = record.observation;
    if (observation) {
      meta.append(kv('观察首次接收', date(observation.firstReceivedAt, true)), kv('观察截止', date(observation.endsAt, true)), kv('已尝试复评次数', count(observation.attempts)));
      if (observation.lastCheckAt) meta.append(kv('最近复评', date(observation.lastCheckAt, true)));
      if (!observationEnded(record) && observation.nextCheckAt) meta.append(kv('计划复评', `${date(observation.nextCheckAt, true)}${Date.parse(observation.nextCheckAt) <= Date.now() ? ' · 等待队列调度' : ''}`));
      if (!observationEnded(record)) meta.append(el('p', 'detail-small', '复评按队列与请求预算调度，限流或排队可能延迟；到达观察截止后会结束本轮。'));
      if (observation.endReason) meta.append(kv('结束原因', reasonNames[observation.endReason] || scalar(observation.endReason)));
      if (observationEnded(record)) meta.append(el('p', 'detail-small', '这轮观察已结束，历史判断与已采集的钱包证据仍保留。'));
    } else if (record.decision === 'WATCH') meta.append(el('p', 'detail-small', '这是一条历史判断，未加入定时复评。旧状态不代表系统仍在持续检查。'));
    if (record.decision === 'BUY_CANDIDATE' && decisionExpired(record)) meta.append(el('p', 'detail-small', '此前通过的判断已过期；保留条件后价格表现，但不能直接用于当前开单。'));
    fragment.append(meta);
    const performance = section('条件后价格表现'); const p = record.performance;
    if (!p) performance.append(el('p', 'detail-message', '这条信号尚未符合研究条件，因此没有条件后价格基准和涨幅记录。'));
    else {
      const metrics = el('div', 'detail-metrics'); metrics.append(detailStat('采样最高涨幅', percent(p.maxGainPct), p.peakAt ? `观测于 ${date(p.peakAt)}` : '等待有效价格样本', finite(p.maxGainPct) && p.maxGainPct < 0 ? 'negative' : 'positive'), detailStat('最新样本涨幅', percent(p.currentGainPct), p.latestAt ? `报价于 ${date(p.latestAt)}` : '尚无最新报价', finite(p.currentGainPct) && p.currentGainPct < 0 ? 'negative' : 'positive'), detailStat('有效价格样本', count(p.samples), {waiting: '等待基准价', tracking: '追踪中', ended: '追踪已结束', unavailable: '报价暂不可用'}[p.status] || '状态未知')); performance.append(metrics, priceChart(p), el('p', 'chart-caption-label', '曲线连接已获取的真实报价样本。逐币采样间隔可能不同；未采样的价格不计入最高涨幅。'));
      performance.append(kv('首次符合条件', date(p.eligibleAt, true)), kv('基准价 / 采样时间', `${usd(p.baselinePriceUsd)} · ${date(p.baselineAt, true)}`), kv('最新样本价', usd(p.latestPriceUsd)), kv('最高样本价', usd(p.peakPriceUsd)), kv('报价来源', scalar(p.source)));
      if (validDate(p.baselineAt) && validDate(p.eligibleAt)) performance.append(kv('基准报价延迟', `${Math.max(0, Math.round((Date.parse(p.baselineAt) - Date.parse(p.eligibleAt)) / 1000))} 秒`));
      if (finite(p.maxSampleGapSec)) performance.append(kv('最大报价间隔', `${p.maxSampleGapSec} 秒`));
      if (finite(p.errorCount)) performance.append(kv('累计报价失败次数', count(p.errorCount)));
      if (p.lastErrorAt) performance.append(kv('最近报价失败', date(p.lastErrorAt, true)));
      if (p.lastError && p.lastError !== p.error) performance.append(el('p', 'detail-small', `最近失败原因：${scalar(p.lastError)}`));
      if (p.error) performance.append(el('p', 'detail-small detail-error', `报价状态：${scalar(p.error)}`));
      performance.append(el('p', 'detail-small', '涨幅 =（样本价格 ÷ 首次符合条件后的首个有效价格 − 1）× 100%。这是观测表现，不是实际成交收益，也不是全市场历史最高价。'));
    }
    fragment.append(performance);
    const checks = section('研究判断与筛选依据');
    for (const [key, label] of Object.entries(checkNames)) { const check = record.checks?.[key]; const row = el('div', 'check-row'); const top = el('div', 'check-top'); top.append(el('span', '', label), key === 'narrative' ? badge(narrativeText(record.narrative) ? '仅供参考' : '暂无材料 · 不阻断', 'neutral') : badge(check?.status === 'pass' ? '通过' : check?.status === 'fail' ? '未通过' : '证据不足', check?.status === 'pass' ? 'pass' : check?.status === 'fail' ? 'fail' : 'watch')); row.append(top); if (check?.reasons?.length) row.append(reasonList(check.reasons)); checks.append(row); }
    if (record.reasons?.length) { checks.append(el('p', 'detail-small', '综合判断依据'), reasonList(record.reasons)); }
    checks.append(el('p', 'detail-small', '通过研究门槛不代表已下单；实际开单还需报价、余额和执行检查。')); fragment.append(checks);
    const narrative = section('叙事参考'); const n = record.narrative;
    const preview = narrativePreview(n, `detail:${record.id}`);
    if (preview) narrative.append(preview); else narrative.append(el('p', 'detail-message', '暂无可用的平台叙事，缺失不会阻止开单。'));
    if (n?.stage) narrative.append(kv('平台叙事阶段', stageNames[n.stage] || scalar(n.stage)));
    if (n?.assessment) narrative.append(kv('平台叙事判断', assessmentNames[n.assessment] || scalar(n.assessment)));
    if (n?.supplier) narrative.append(kv('叙事来源', scalar(n.supplier).toUpperCase()));
    if (n?.updatedAt) narrative.append(kv('平台更新时间', date(n.updatedAt, true)));
    const narrativeUrl = safeUrl(n?.sourceUrl); if (narrativeUrl) { const link = el('a', 'source-link', '打开来源页面 ↗'); link.href = narrativeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; narrative.append(link); }
    narrative.append(el('p', 'detail-small', '平台 AI 的评价只用于辅助研究，不以其评分或建议单独决定是否开单。'));
    fragment.append(narrative, renderSocial(record.social), renderWallets(record.wallets, openProfiles));
    const active = document.activeElement;
    const focusLabel = container.contains(active) ? active?.getAttribute('aria-label') : null;
    container.replaceChildren(fragment);
    rebindNarrative(container);
    if (focusLabel) [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focusLabel)?.focus();
  }
  function renderSocial(social) {
    const sectionNode = section('社交关联与研究优先级');
    const score = socialBadge(social);
    if (score) sectionNode.append(score);
    const signals = Array.isArray(social?.signals) ? social.signals : [];
    if (!signals.length) sectionNode.append(el('p', 'detail-message', '暂未取得符合规则的名人社交关联线索。'));
    for (const signal of signals) {
      const item = el('div', 'social-evidence');
      const title = el('div', 'social-evidence-heading'); title.append(el('strong', '', scalar(signal.label || signal.person)), badge(finite(signal.weight) ? `+${signal.weight}` : '线索', 'neutral')); item.append(title);
      item.append(kv('线索类型', signal.kind === 'ca_post' ? '原帖包含本币完整 CA' : '项目社交资料链接'), kv('验证级别', {project_link: '由项目填写，未核实本人支持', first_party: '本人账号来源线索', third_party: '第三方引用线索'}[signal.verification] || '尚未核实'));
      const url = safeUrl(signal.sourceUrl); if (url) { const link = el('a', 'source-link', '查看社交来源 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
      sectionNode.append(item);
    }
    sectionNode.append(el('p', 'detail-small', '项目填写名人的 X 链接不等于本人支持。本人账号原帖与完整 CA 对应的证据权重更高；社交加分仅用于研究优先级，不替代合约安全或钱包证据，也不代表已核实背书。'));
    return sectionNode;
  }
  function svgNode(tag, attributes = {}, content) { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (content !== undefined) node.textContent = String(content); return node; }
  function priceChart(performance) {
    const wrap = el('div', 'chart-wrap');
    const points = (Array.isArray(performance.points) ? performance.points : []).filter(point => validDate(point.at) && finite(point.priceUsd) && point.priceUsd > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!points.length) { wrap.append(el('p', 'chart-empty', performance.status === 'waiting' ? '等待符合条件后的第一个有效价格样本' : '暂无可绘制的价格样本')); return wrap; }
    const baseline = finite(performance.baselinePriceUsd) && performance.baselinePriceUsd > 0 ? performance.baselinePriceUsd : null;
    const values = points.map(point => baseline ? (point.priceUsd / baseline - 1) * 100 : point.priceUsd);
    let low = Math.min(...values), high = Math.max(...values); const pad = (high - low) * .18 || Math.abs(high) * .02 || 1; low -= pad; high += pad;
    const first = Date.parse(points[0].at), last = Date.parse(points[points.length - 1].at); const x = at => last === first ? 230 : 16 + (Date.parse(at) - first) / (last - first) * 438; const y = value => 163 - (value - low) / (high - low) * 137;
    const svg = svgNode('svg', {viewBox: '0 0 560 190', class: 'price-chart', role: 'img', 'aria-label': `条件后价格样本曲线，共 ${points.length} 个报价样本`}); svg.append(svgNode('title', {}, '真实报价样本的价格表现'));
    for (let i = 0; i < 4; i++) { const value = low + (high - low) * i / 3; const yy = y(value); svg.append(svgNode('line', {x1: 16, y1: yy, x2: 454, y2: yy, stroke: '#202d3d', 'stroke-width': 1, 'stroke-dasharray': '3 5'}), svgNode('text', {x: 469, y: yy + 3, fill: '#677b96', stroke: 'none', 'font-size': 12, 'font-family': 'monospace'}, baseline ? percent(value) : usd(value))); }
    if (baseline && low <= 0 && high >= 0) svg.append(svgNode('line', {x1: 16, y1: y(0), x2: 454, y2: y(0), stroke: '#526579', 'stroke-dasharray': '4 4'}));
    if (points.length > 1) {
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.at).toFixed(2)},${y(values[index]).toFixed(2)}`).join(' ');
      svg.append(svgNode('path', {d: `${path} L${x(points[points.length - 1].at)},174 L${x(points[0].at)},174 Z`, fill: '#64e4c00b', stroke: 'none'}), svgNode('path', {d: path, stroke: '#64e4c0', 'stroke-width': 2, fill: 'none'}));
    }
    points.forEach((point, index) => { const dot = svgNode('circle', {cx: x(point.at), cy: y(values[index]), r: points.length > 80 ? 1.5 : 2.5, fill: '#64e4c0', stroke: '#142b26', 'stroke-width': 1}); dot.append(svgNode('title', {}, `${date(point.at, true)} · ${usd(point.priceUsd)}${baseline ? ` · ${percent(values[index])}` : ''}`)); svg.append(dot); });
    const caption = el('div', 'chart-caption'); caption.append(el('span', '', date(points[0].at, true)), el('span', '', date(points[points.length - 1].at, true))); wrap.append(svg, caption); return wrap;
  }
  function walletProfile(profile, index, openProfiles) {
    const card = el('details', 'wallet-profile'); card.dataset.profileAddress = profile.address; card.open = openProfiles.has(profile.address);
    const summary = el('summary', 'wallet-profile-summary'); summary.setAttribute('aria-label', `展开钱包画像 ${profile.address}`);
    const identity = el('div', 'wallet-profile-identity'); identity.append(el('strong', '', profile.vendorName || profile.attribution?.label || `钱包 ${String(index + 1).padStart(2, '0')}`), el('code', '', profile.address));
    summary.append(el('span', 'wallet-profile-number', String(index + 1).padStart(2, '0')), identity, el('span', 'wallet-profile-chevron', '⌄')); card.append(summary);
    const body = el('div', 'wallet-profile-body');
    body.append(addressNode(profile.address), el('p', 'wallet-profile-source', 'GMGN 标签 / 归属未核实'));
    const labels = el('div', 'wallet-labels');
    for (const label of Array.isArray(profile.labels) ? profile.labels : []) labels.append(badge({smart: '聪明钱标签', kol: 'KOL 标签', bundler: '捆绑钱包标签', rat_trader: '老鼠仓标签', developer: '开发者标签', exchange_or_pool: '交易所 / 池子标签'}[label] || scalar(label), 'neutral'));
    if (labels.childNodes.length) body.append(labels); else body.append(el('p', 'detail-small', '暂未获取可展示的钱包标签。'));
    body.append(kv('GMGN 名称线索', profile.vendorName), kv('GMGN 社交账号线索', profile.vendorTwitter));
    const attribution = profile.attribution || {};
    body.append(kv('人工归属标注', attribution.status === 'operator_supplied' ? `${scalar(attribution.label, '未提供名称')} · 未核实` : '未知 / 未标注'));
    if (attribution.status === 'operator_supplied' && attribution.category) body.append(kv('人工标注类别', {exchange: '交易所', public_entity: '公开实体', operator_defined: '自定义实体', unknown: '未知'}[attribution.category] || scalar(attribution.category)));
    const funding = profile.funding || {};
    body.append(el('p', 'wallet-profile-source', '资金来源线索 · 供应商报告'));
    if (typeof funding.address === 'string') body.append(addressNode(funding.address));
    else body.append(el('p', 'detail-small', '暂未获取资金来源地址。'));
    if (funding.label) body.append(kv('来源标签', funding.label));
    if (funding.source) body.append(kv('线索来源', {native_transfer: '原生币转账', wallet_stats: '钱包统计', both: '转账与钱包统计', unknown: '未知'}[funding.source] || scalar(funding.source)));
    if (funding.sharedService || funding.conflict) { const cautions = el('div', 'wallet-labels'); if (funding.sharedService) cautions.append(badge('公共服务来源，不能据此合并归属', 'watch')); if (funding.conflict) cautions.append(badge('资金来源存在冲突', 'watch')); body.append(cautions); }
    if (Array.isArray(profile.risks) && profile.risks.length) { body.append(el('p', 'detail-small', '风险与数据限制'), reasonList(profile.risks)); }
    body.append(el('p', 'wallet-profile-note', '名称、账号和标签仅为供应商线索；人工标注同样未经独立核实，不认定钱包的实际控制人。'));
    card.append(body); return card;
  }
  function renderWallets(wallets, openProfiles = new Set()) {
    const node = section('钱包与资金关联分析');
    if (!wallets) { node.append(el('p', 'detail-message', '暂无可用的钱包样本。缺少数据不代表钱包之间没有关联。')); return node; }
    const summary = wallets.summary || {}; const cards = el('div', 'wallet-summary');
    for (const [label, value] of [['采样钱包', summary.uniqueWalletCount], ['聪明钱持有人', summary.smartCurrentHolderCount], ['资金关联分组', summary.smartFundingClusterCount]]) { const card = el('div'); card.append(el('strong', '', count(value)), el('span', '', label)); cards.append(card); } node.append(cards);
    node.append(kv('完成增强分析的钱包', count(summary.enrichedWalletCount)), kv('合格聪明钱钱包 / 资金分组', `${count(summary.qualifiedSmartWalletCount)} / ${count(summary.qualifiedSmartFundingClusterCount)}`), kv('近期净买入（样本）', usd(summary.recentNetBuyUsd)), kv('观察时间窗', finite(summary.recentWindowSeconds) ? `${summary.recentWindowSeconds} 秒` : '—'), kv('近期有积累行为', summary.hasRecentAccumulation === true ? '有观测证据' : summary.hasRecentAccumulation === false ? '未观察到' : '证据不足'), kv('样本持仓比例', finite(summary.sampledHoldingRatio) ? percent(summary.sampledHoldingRatio * 100).replace(/^\+/, '') : '—'));
    const profiles = Array.isArray(wallets.profiles) ? wallets.profiles.slice(0, 12) : [];
    if (profiles.length) {
      const heading = el('div', 'wallet-profiles-heading'); heading.append(el('span', '', '钱包画像与归属线索'), badge(`${profiles.length} 个样本`, 'neutral')); node.append(heading);
      for (const [index, profile] of profiles.entries()) if (profile && typeof profile.address === 'string') node.append(walletProfile(profile, index, openProfiles));
    }
    const groups = Array.isArray(wallets.groups) ? wallets.groups : [];
    if (groups.length) {
      node.append(el('p', 'detail-small', '资金关联分组'));
      for (const [index, group] of groups.entries()) {
        const card = el('div', 'wallet-record'); const top = el('div', 'wallet-record-top'); top.append(el('span', '', `分组 ${String(index + 1).padStart(2, '0')}`), badge(`${count(group.walletCount)} 个钱包`, 'neutral')); card.append(top);
        const labels = el('div', 'wallet-labels'); for (const basis of Array.isArray(group.basis) ? group.basis : []) labels.append(badge({shared_funding: '共同资金来源', funding_link: '资金转移关联', operator_entity: '人工标注关联', single_wallet: '单个钱包'}[basis] || scalar(basis), 'neutral')); if (group.developerLinked) labels.append(badge('开发者关联', 'watch')); card.append(labels);
        if (Array.isArray(group.wallets)) for (const address of group.wallets) if (typeof address === 'string') card.append(addressNode(address));
        card.append(el('p', 'detail-small', `聪明钱当前持有人：${count(group.smartCurrentHolders)}`)); node.append(card);
      }
    } else node.append(el('p', 'detail-small', '暂无可展示的资金关联分组。'));
    node.append(el('p', 'wallet-disclaimer', '分析仅覆盖已采样的钱包。平台标签不证明身份；共同资金来源不证明同一控制人，分组数量也不证明独立参与者数量。累计交易量不等于近期净流入。'));
    return node;
  }

  function walletEmpty(title, description) { $('wallet-empty').hidden = false; text('wallet-empty-title', title); text('wallet-empty-description', description); }
  function renderAssociationStatus() {
    const a = state.associationStatus;
    text('association-status-note', !a ? '正在读取关联索引进度…' : a.enabled === false ? '关联研究未启用。' : `已建立 ${count(a.relations)} 组候选关系 · ${count(a.episodes)} 条同币时序 · 待分析 ${count(a.pending)} 个公开钱包 / 代币组合${a.backfillPending ? ' · 正在回填已有历史' : ''}。仅覆盖已采集样本，归属待核实。关联调查与市场研究轮换，具体钱包还会轮换采样；并非全量实时监测。`);
  }
  function leadTime(seconds) {
    if (!finite(seconds)) return '—';
    return seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} 小时` : seconds >= 60 ? `${(seconds / 60).toFixed(1)} 分钟` : `${Math.round(seconds)} 秒`;
  }
  function fundingLabel(kind) { return {direct: '直接注资线索', common: '共同资金来源'}[kind] || scalar(kind); }
  function associationGrade(a) { return {timing_only: '单币时序', repeated_timing: '跨币重复时序', funding_supported: '另有资金联系'}[a.grade] || '待分析'; }
  function renderAssociationList() {
    const body = $('association-rows'); body.replaceChildren(); text('wallet-list-count', count(state.walletTotal)); $('wallet-empty').hidden = state.walletItems.length > 0;
    if (!state.walletItems.length) walletEmpty('尚无匹配的前置关联', '继续积累公开钱包与候选钱包的交易样本；无记录不表示没有关联。已有历史正在分批分析。');
    for (const a of state.walletItems) {
      const row = el('tr'); const pair = el('td'); pair.append(badge(chainName(a.chain), 'neutral'), el('p', 'association-wallet-caption', '公开钱包 · GMGN KOL 来源'), addressNode(a.leader), el('p', 'association-wallet-caption', a.candidatePublic ? '↓ 前置候选 · 也出现在 KOL 来源' : '↓ 前置候选 · 未观测到 KOL 来源记录'), addressNode(a.candidate)); row.append(pair);
      const timing = el('td'); timing.append(el('strong', '', `${count(a.distinctTokens)} 个代币`), el('div', 'cell-subtitle', `领先中位数 ${leadTime(a.medianLeadSeconds)}`), el('div', 'cell-subtitle', `公开钱包买入后卖出：${count(a.exitAfterLeaderTokens)} 币`)); row.append(timing);
      const funding = el('td'); funding.append(badge(associationGrade(a), 'watch')); for (const kind of a.fundingKinds || []) funding.append(el('div', 'cell-subtitle', fundingLabel(kind))); if (!a.fundingKinds?.length) funding.append(el('div', 'cell-subtitle', '未取得有效资金联系')); row.append(funding);
      const validation = el('td'); validation.append(el('div', '', `后续验证 ${count(a.forwardValidatedTokens)} 币`), el('div', 'cell-subtitle', `提前观测 ${count(a.prospectiveTokens)} / 事后回溯 ${count(a.retrospectiveTokens)}`), el('div', 'cell-subtitle', `关系首见 ${date(a.firstDiscoveredAt)}`)); if (a.status === 'stale') validation.append(badge('有新证据 · 待刷新', 'watch')); row.append(validation);
      const action = el('td'); const button = el('button', 'association-evidence-button', '看证据'); button.type = 'button'; button.setAttribute('aria-label', `查看 ${a.leader} 与 ${a.candidate} 的关联证据`); button.addEventListener('click', () => openDetail(`association:${a.chain}:${a.leader}:${a.candidate}`, button, {association: true, chain: a.chain, leader: a.leader, candidate: a.candidate})); action.append(button); row.append(action); body.append(row);
    }
    text('wallet-pagination-info', state.walletTotal ? `显示 ${state.walletItems.length ? state.walletOffset + 1 : 0}–${Math.min(state.walletOffset + state.walletItems.length, state.walletTotal)} 条，共 ${count(state.walletTotal)} 组候选关系` : '共 0 组候选关系');
    text('wallet-page-number', String(Math.floor(state.walletOffset / PAGE_SIZE) + 1).padStart(2, '0')); $('wallet-previous-page').disabled = state.walletOffset === 0; $('wallet-next-page').disabled = state.walletOffset + PAGE_SIZE >= state.walletTotal;
  }
  function walletSource(source) { return {gmgn_kol_feed: 'GMGN KOL 交易来源', gmgn_smartmoney_feed: 'GMGN 聪明钱交易来源', gmgn_association_wallet_activity: 'GMGN 关联调查 · 单币历史', gmgn_association_candidate_activity: 'GMGN 候选持续观察 · 全钱包活动', gmgn_association_leader_activity: 'GMGN 公开钱包持续观察 · 全钱包活动', gmgn_association_wallet_funding: 'GMGN 钱包资料注资来源', gmgn_association_trader_funding: 'GMGN 交易者页注资来源', gmgn_association_trader_sell_volume: 'GMGN 卖出量交易者样本', gmgn_association_trader_buy_volume: 'GMGN 买入量交易者样本'}[source] || scalar(source); }
  function associationEvent(label, event) {
    const node = el('div', 'association-event'); node.append(el('p', '', label), kv('来源报告的交易时间', date(event.eventAt, true)), kv('本地取得记录时间', date(event.observedAt, true)), kv('数据来源', walletSource(event.source)));
    node.append(el('p', 'detail-small', '交易标识'), el('code', '', scalar(event.txHash))); return node;
  }
  function renderAssociationDetail(data) {
    const a = data.association || {}; const fragment = document.createDocumentFragment(); const title = el('h2', '', '前置钱包关联证据'); title.id = 'detail-title';
    fragment.append(title, el('p', 'association-detail-note', `${chainName(a.chain)} · 供应商交易与注资线索 · 钱包归属未核实`));
    const identity = section('调查对象'); identity.append(el('p', 'detail-small', '公开钱包'), addressNode(a.leader), el('p', 'detail-small', '前置候选钱包'), addressNode(a.candidate), kv('关系首次被系统发现', date(a.firstDiscoveredAt, true)), kv('最近分析', date(a.updatedAt, true)), kv('分析状态', a.status === 'stale' ? '待刷新 · 以下为缓存结果' : '已更新'), kv('线索类型', associationGrade(a))); fragment.append(identity);
    const metrics = el('div', 'detail-metrics wallet-research-detail'); metrics.append(detailStat('重复参与', count(a.distinctTokens), '不同代币'), detailStat('领先中位数', leadTime(a.medianLeadSeconds), '已记录的首次买入'), detailStat('后续验证', count(a.forwardValidatedTokens), '先发现关系，再观察下一币')); fragment.append(metrics);
    const scope = section('如何区分回溯与后续验证'); scope.append(kv('提前观测的代币', count(a.prospectiveTokens)), kv('事后回溯的代币', count(a.retrospectiveTokens)), el('p', 'wallet-section-note', '提前观测：公开钱包买入前，本地已经取得候选钱包的买入记录。后续验证还要求：这对关系在候选钱包本次买入前就已建立。历史补查不会自动成为后续验证。'), el('p', 'association-detail-note', '公开钱包指 GMGN KOL 来源中的钱包；这里只比较链上交易记录，未验证实际喊单时间。单币领先或共同注资不能证明同一控制人，买后卖出也不等于已盈利。')); fragment.append(scope);
    const episodes = section('逐币交易证据');
    for (const item of Array.isArray(data.episodes) ? data.episodes : []) {
      const card = evidenceCard(`领先 ${leadTime(item.leadSeconds)}`, badge(item.forwardValidated ? '后续验证' : item.observationMode === 'prospective' ? '提前观测' : '事后回溯', item.forwardValidated ? 'pass' : 'neutral'));
      card.append(addressNode(item.tokenAddress), gmgnTokenLink(a.chain, item.tokenAddress), kv('这一条时序首次发现', date(item.firstDiscoveredAt, true)), associationEvent('① 候选钱包买入', item.candidateBuy), associationEvent('② 公开钱包买入', item.leaderBuy));
      if (item.candidateSellAfterLeader) card.append(associationEvent('③ 候选钱包随后卖出', item.candidateSellAfterLeader)); else card.append(el('p', 'association-detail-note', '未取得公开钱包买入后 24 小时内的候选卖出记录。'));
      episodes.append(card);
    }
    episodes.append(el('p', 'wallet-sample-note', `每个公开钱包 / 代币组合在前 24 小时窗口内最多分析 ${count(data.coverage?.candidateEventLimit)} 条买入、${count(data.coverage?.candidateWalletLimit)} 个候选钱包；此处最多展示 ${count(data.coverage?.episodeDisplayLimit)} 条逐币证据。交易者页面也属于样本，可能遗漏小额或未覆盖钱包。`)); fragment.append(episodes);
    const funding = section('补充资金联系'); const evidence = Array.isArray(data.fundingEvidence) ? data.fundingEvidence : [];
    if (!evidence.length) walletEmptyDetail(funding, '暂无有效资金联系。已识别的交易所、桥、路由等公共来源以及有冲突的来源，不用于支持这里的关联。');
    for (const item of evidence) {
      const card = evidenceCard(fundingLabel(item.kind), badge('供应商线索 · 未核实', 'watch')); card.append(addressNode(item.address), kv('这组资金线索取得时间', date(item.observedAt, true)));
      for (const edge of item.edges || []) { card.append(el('p', 'detail-small', '接收注资的钱包'), addressNode(edge.wallet), kv('来源', walletSource(edge.source)), kv('本地取得时间', date(edge.observedAt, true))); if (edge.eventAt) card.append(kv('来源报告的注资时间', date(edge.eventAt, true))); if (edge.txHash) card.append(el('code', 'association-detail-note', edge.txHash)); }
      funding.append(card);
    }
    funding.append(el('p', 'wallet-sample-note', '资金联系为目前取得的补充证据，不表示在上述历史交易发生前就已知。这里不核算完整利润，也不自动触发买单。')); fragment.append(funding);
    $('detail-content').replaceChildren(fragment);
  }
  function renderWalletRankingNote() {
    const associations = state.walletSort === 'associations'; $('association-table').hidden = !associations; $('wallet-history-table').hidden = associations; $('association-status-note').hidden = !associations;
    $('wallet-search').placeholder = associations ? '搜索公开钱包或候选钱包地址…' : '搜索钱包地址、名称或标签…'; renderAssociationStatus();
    text('wallet-ranking-note', {
      associations: '以 GMGN KOL 买入记录为入口，寻找其之前 24 小时内买入同币的钱包。按重复代币数排列；链上买入时间不等于已核实的喊单时间，首次观测买入也不等于该钱包真正首买。',
      profit: '供应商报告的最近 7 日已实现收益，仅用于发现研究目标；榜单不证明可跟单能力，也不是本地核算利润。',
      gain: '捕获涨幅按首次观测到买入后的价格样本排列。基准是此后的首个报价，不是钱包真实买入成本。',
      coordination: '协同排名综合共同资金来源与相近时间交易等线索，仅用于进一步研究，不证明共同控制或内幕关系。',
      recent: '按最近观测到的钱包活动排列，持续保留不同代币、不同筛选结果中的研究样本。',
    }[state.walletSort]);
  }
  function renderWalletStatus() {
    const data = state.walletStatus || {}; const stats = data.store || {}; const observer = data.observer || {};
    text('wallet-metric-total', count(stats.wallets)); text('wallet-metric-events', count(stats.events)); text('wallet-metric-tokens', count(stats.tokens)); text('wallet-metric-since', date(stats.firstObservedAt));
    const cooling = observer.cooldownUntil && Date.parse(observer.cooldownUntil) > Date.now();
    const partial = observer.lastCycle?.status === 'partial' || observer.feedError;
    const label = data.enabled === false ? '研究采集未启用' : cooling ? '供应商限流冷却' : partial ? '部分采集待补' : observer.running ? observer.inFlight ? '正在采集样本' : '持续观察中' : '等待采集状态';
    text('wallet-observer-badge', label); $('wallet-observer-badge').className = `badge ${cooling || partial ? 'watch' : data.enabled && observer.running ? 'pass' : 'neutral'}`;
    const last = observer.lastCycle?.completedAt || observer.lastCompletedAt || observer.lastObservedAt;
    const explanations = Array.isArray(observer.lastCycle?.reasons) ? observer.lastCycle.reasons.filter(value => typeof value === 'string').slice(0, 3).map(value => reasonNames[value] || value) : [];
    text('wallet-observer-note', `${label}${last ? ` · 最近一轮 ${date(last, true)}` : ''}${finite(observer.lastCycle?.accepted) ? ` · 接收 ${observer.lastCycle.accepted} 个样本` : ''}${finite(stats.coordinationPending) ? ` · 协同待分析 ${count(stats.coordinationPending)} 个钱包` : ''}${observer.lastCycle?.collectionMode === 'kol_association' ? ' · 最近一轮为公开钱包关联调查' : ''}${explanations.length ? ` · 采集说明：${explanations.join('；')}` : ''}`);
  }
  function walletLabel(label) { return {smart: '聪明钱标签', kol: 'KOL 标签', bundler: '捆绑标签', rat_trader: '老鼠仓标签', developer: '开发者标签', exchange_or_pool: '交易所 / 池子'}[label] || scalar(label); }
  function walletMoney(value) { const n = numeric(value); return el('span', `gain ${n === undefined ? 'missing' : n >= 0 ? 'positive' : 'negative'}`, usd(value)); }
  function openWallet(wallet, trigger) { return openDetail(`wallet:${wallet.chain}:${wallet.address}`, trigger, {chain: wallet.chain, address: wallet.address}); }
  function renderWalletList() {
    if (state.walletSort === 'associations') { renderAssociationList(); return; }
    const body = $('wallet-rows'); body.replaceChildren(); text('wallet-list-count', count(state.walletTotal)); $('wallet-empty').hidden = state.walletItems.length > 0;
    if (!state.walletItems.length) walletEmpty(state.walletChain || state.walletSearch ? '没有匹配的钱包档案' : '开始积累钱包的长期记录', state.walletChain || state.walletSearch ? '调整网络或搜索关键词，查看其他已发现的钱包。' : '发现钱包后，会保存活动、持仓样本与资金线索。没有数据的排名字段显示为 —。');
    for (const wallet of state.walletItems) {
      const row = el('tr'); const identity = el('td'); const top = el('div', 'token-top'); const name = wallet.name || '未标记钱包';
      top.append(el('span', `token-avatar ${chainClass(wallet.chain)}`, wallet.name ? Array.from(String(wallet.name))[0]?.toUpperCase() : 'W'));
      const heading = el('div', 'token-heading'); const link = el('button', 'token-name', name); link.type = 'button'; link.addEventListener('click', () => openWallet(wallet, link)); heading.append(link, el('div', 'token-meta', `${chainName(wallet.chain)} · 归属未核实`)); top.append(heading); identity.append(top, addressNode(wallet.address));
      const labels = el('div', 'wallet-label-line'); for (const label of Array.isArray(wallet.labels) ? wallet.labels.slice(0, 3) : []) labels.append(badge(walletLabel(label), 'neutral')); if (labels.childNodes.length) identity.append(labels); row.append(identity);
      const profit = el('td', 'numeric'); profit.append(walletMoney(wallet.profit?.realizedProfitUsd)); profit.append(el('div', 'cell-subtitle', wallet.profit ? `统计时间 ${date(wallet.profit.snapshotAt || wallet.profit.observedAt)}` : '未获取供应商统计')); row.append(profit);
      const gain = el('td', 'numeric'); gain.append(gainNode(wallet.gain?.maxGainPct)); gain.append(el('div', 'cell-subtitle', wallet.gain ? `峰值 ${date(wallet.gain.peakAt)}` : '等待买入后的报价')); row.append(gain);
      const activity = el('td'); activity.append(el('div', '', `买 ${count(wallet.buyEvents)} / 卖 ${count(wallet.sellEvents)}`), el('div', 'cell-subtitle', `${count(wallet.tokenCount)} 个代币 · ${count(wallet.observedEventCount)} 条活动`)); row.append(activity);
      const c = wallet.coordination || {}; const pending = c.status === 'pending'; const stale = c.status === 'stale';
      const coordination = el('td'); coordination.append(badge(pending ? '待分析' : `${count(c.score)}${stale ? ' 缓存' : ''}线索分`, pending || stale || c.score > 0 ? 'watch' : 'neutral'));
      if (stale) coordination.append(el('div', 'cell-subtitle', '待刷新'));
      coordination.append(el('div', 'cell-subtitle', `共同来源 ${pending ? '—' : count(c.sharedFundingPeers)}`), el('div', 'cell-subtitle', `同步行为 ${pending ? '—' : count(c.synchronizedPeers)}`));
      coordination.title = '线索分用于研究排序，不是风险评级；0 分不代表无风险。'; row.append(coordination);
      const last = el('td', 'cell-date', date(wallet.lastObservedAt)); last.append(el('div', 'cell-subtitle', `首见 ${date(wallet.firstObservedAt)}`)); row.append(last);
      const action = el('td'); const arrow = el('button', 'row-arrow', '↗'); arrow.type = 'button'; arrow.setAttribute('aria-label', `研究钱包 ${wallet.address}`); arrow.addEventListener('click', () => openWallet(wallet, arrow)); action.append(arrow); row.append(action); body.append(row);
    }
    text('wallet-pagination-info', state.walletTotal ? `显示 ${state.walletItems.length ? state.walletOffset + 1 : 0}–${Math.min(state.walletOffset + state.walletItems.length, state.walletTotal)} 条，共 ${count(state.walletTotal)} 个钱包` : '共 0 个钱包');
    text('wallet-page-number', String(Math.floor(state.walletOffset / PAGE_SIZE) + 1).padStart(2, '0')); $('wallet-previous-page').disabled = state.walletOffset === 0; $('wallet-next-page').disabled = state.walletOffset + PAGE_SIZE >= state.walletTotal;
  }
  function evidenceCard(label, right) { const card = el('div', 'wallet-evidence-card'); const heading = el('div', 'wallet-evidence-heading'); heading.append(el('span', '', label)); if (right) heading.append(right); card.append(heading); return card; }
  function walletEmptyDetail(container, message) { container.append(el('p', 'wallet-detail-empty', message)); }
  function renderWalletResearchDetail(data) {
    const openedEvidence = new Set([...$('detail-content').querySelectorAll('details[data-event-id][open]')].map(item => item.dataset.eventId));
    const wallet = data.wallet || {}; const fragment = document.createDocumentFragment(); const name = wallet.name || '未标记钱包';
    const heading = el('div', 'detail-token'); heading.append(el('span', `token-avatar ${chainClass(wallet.chain)}`, wallet.name ? Array.from(String(wallet.name))[0]?.toUpperCase() : 'W')); const titleGroup = el('div'); const title = el('h2', '', name); title.id = 'detail-title'; titleGroup.append(title, el('div', 'token-meta', `${chainName(wallet.chain)} · 本地钱包研究档案`)); heading.append(titleGroup); fragment.append(heading, addressNode(wallet.address, 'detail-address'));
    const labels = el('div', 'detail-pills'); labels.append(badge('GMGN 线索 · 归属未核实', 'watch')); for (const label of Array.isArray(wallet.labels) ? wallet.labels : []) labels.append(badge(walletLabel(label), 'neutral')); fragment.append(labels);
    const metrics = el('div', 'detail-metrics wallet-research-detail'); metrics.append(detailStat('GMGN 7 日已实现收益', usd(wallet.profit?.realizedProfitUsd), '整个钱包 · 供应商报告', numeric(wallet.profit?.realizedProfitUsd) < 0 ? 'negative' : 'positive'), detailStat('买入后采样最高涨幅', percent(wallet.gain?.maxGainPct), '样本观测值 · 非实际收益', 'positive'), detailStat('已观测活动', count(wallet.observedEventCount), `买 ${count(wallet.buyEvents)} / 卖 ${count(wallet.sellEvents)}`)); fragment.append(metrics);
    const coverage = data.coverage || {}; const observed = section('观察范围与身份线索');
    observed.append(el('p', 'wallet-section-note', '从本地首次发现开始累积样本。首次发现前、来源未覆盖或采集失败期间的交易可能缺失，不能据此核算完整已实现利润。'), kv('本地首次观测', date(coverage.firstObservedAt || wallet.firstObservedAt, true)), kv('最近观测', date(coverage.lastObservedAt || wallet.lastObservedAt, true)), kv('已记录事件 / 观测证据', `${count(coverage.eventCount)} / ${count(coverage.observationCount)}`), kv('涉及代币', count(wallet.tokenCount)), kv('GMGN 名称线索', wallet.name), kv('GMGN 社交账号线索', wallet.twitter), kv('本地完整已实现利润', '未核算 · 覆盖不完整'));
    fragment.append(observed);
    const coordination = section('协同研究线索'); const c = wallet.coordination || {};
    const pendingCoordination = c.status === 'pending';
    if (c.status) coordination.append(kv('分析状态', {pending: '待分析', stale: '待刷新 · 以下为缓存结果', current: '已更新'}[c.status] || '状态未知'));
    if (c.checkedAt) coordination.append(kv('最近分析时间', date(c.checkedAt, true)));
    coordination.append(kv('启发式线索分', pendingCoordination ? '—' : count(c.score)), kv('共同资金来源关联钱包', pendingCoordination ? '—' : count(c.sharedFundingPeers)), kv('相近时间交易关联钱包', pendingCoordination ? '—' : count(c.synchronizedPeers)), kv('线索证据数', pendingCoordination ? '—' : count(c.evidenceCount)));
    const shared = Array.isArray(data.coordinationEvidence?.sharedFunding) ? data.coordinationEvidence.sharedFunding : [];
    const synchronized = Array.isArray(data.coordinationEvidence?.synchronized) ? data.coordinationEvidence.synchronized : [];
    for (const item of shared.slice(0, 12)) { const card = evidenceCard('共同资金来源线索', badge('归属未知', 'watch')); card.append(el('p', 'detail-small', '关联钱包'), addressNode(item.wallet), el('p', 'detail-small', '共同资金来源'), addressNode(item.address), kv('观测时间', date(item.observedAt, true))); coordination.append(card); }
    for (const item of synchronized.slice(0, 12)) { const card = evidenceCard('相近时间交易线索', badge(`${scalar(item.windowSeconds)} 秒窗口`, 'neutral')); card.append(el('p', 'detail-small', '关联钱包'), addressNode(item.wallet), el('p', 'detail-small', '涉及代币'), addressNode(item.tokenAddress), kv('不同交易数', count(item.distinctTransactions))); coordination.append(card); }
    coordination.append(el('p', 'wallet-disclaimer', '共同来源、同步交易和平台标签均只是研究线索，不证明钱包属于同一控制人，也不认定内幕关系。')); fragment.append(coordination);
    const gains = section('捕获涨幅记录'); const gainItems = Array.isArray(data.gains) ? data.gains : [];
    gains.append(el('p', 'wallet-section-note', '基准为首次观测到买入后的首个有效报价。采样最高涨幅不等于实际买入价格、卖出收益或全市场最高涨幅。'));
    if (!gainItems.length) walletEmptyDetail(gains, '尚无观测买入后的有效报价，继续采样后才会显示捕获记录。');
    for (const gain of gainItems.slice(0, 30)) {
      const card = evidenceCard('买入后报价样本', gainNode(gain.maxGainPct)); card.append(addressNode(gain.tokenAddress), kv('基准价 / 时间', `${usd(gain.baselinePriceUsd)} · ${date(gain.baselineAt, true)}`), kv('采样最高价 / 时间', `${usd(gain.peakPriceUsd)} · ${date(gain.peakAt, true)}`), kv('最新报价 / 时间', `${usd(gain.latestPriceUsd)} · ${date(gain.latestAt, true)}`), kv('报价来源', gain.source)); gains.append(card);
    }
    if (gainItems.length > 30) gains.append(el('p', 'wallet-sample-note', `当前展示 ${gainItems.length} 条返回记录中的前 30 条。`)); fragment.append(gains);
    const timeline = section('买卖与活动时间线'); const events = Array.isArray(data.timeline) ? data.timeline : [];
    if (!events.length) walletEmptyDetail(timeline, '尚未获得可记录的活动。钱包发现记录不等于已覆盖完整交易历史。');
    const list = el('ol', 'wallet-timeline');
    for (const event of events.slice(0, 100)) {
      const side = ['buy', 'sell'].includes(event.side) ? event.side : ''; const item = el('li', side); const top = el('div', 'timeline-top'); top.append(badge({buy: '买入', sell: '卖出', transferIn: '转入', transferOut: '转出', add: '增加流动性', remove: '移除流动性'}[event.side] || scalar(event.side), side === 'buy' ? 'pass' : side === 'sell' ? 'fail' : 'neutral'), el('time', '', date(event.eventAt, true))); item.append(top, addressNode(event.tokenAddress));
      const amounts = el('div', 'timeline-amounts'); if (event.amount !== undefined && event.amount !== null) amounts.append(el('span', '', `${scalar(event.amount)} ${{human: '代币单位', atomic: '代币原子单位', vendor_quantity: '供应商数量', unknown: '未知单位'}[event.amountUnit] || scalar(event.amountUnit, '未知单位')}`)); if (event.usd !== undefined && event.usd !== null) amounts.append(el('span', '', usd(event.usd))); if (!amounts.childNodes.length) amounts.append(el('span', 'missing', '金额暂不可用')); item.append(amounts);
      if (event.ambiguous) item.append(badge('交易内活动存在歧义', 'watch'));
      const evidence = el('details', 'timeline-evidence'); evidence.dataset.eventId = scalar(event.id, ''); evidence.open = openedEvidence.has(evidence.dataset.eventId); const toggle = el('summary', '', `来源 ${scalar(event.source)} · 观测于 ${date(event.observedAt)}`); toggle.setAttribute('aria-label', `活动证据 ${scalar(event.id)}`); evidence.append(toggle, el('p', '', `证据范围：${event.scope === 'indexed_event' ? '已索引事件' : '交易 / 钱包 / 代币 / 方向级别'}`));
      if (event.txHash) { const tx = el('p', '', '交易标识：'); tx.append(el('code', '', event.txHash)); evidence.append(tx); }
      if (Array.isArray(event.evidence)) for (const source of event.evidence.slice(0, 6)) evidence.append(el('p', '', `${scalar(source.source)} · 记录于 ${date(source.observedAt, true)}${source.usd !== undefined ? ` · ${usd(source.usd)}` : ''}`)); item.append(evidence); list.append(item);
    }
    if (events.length) timeline.append(list, el('p', 'wallet-sample-note', `本次展示 ${Math.min(events.length, 100)} 条返回活动；时间为来源报告的事件发生时间，并另列本地观测时间。`)); fragment.append(timeline);
    const funding = section('资金来源记录'); const edges = Array.isArray(data.fundingEdges) ? data.fundingEdges : [];
    if (!edges.length) walletEmptyDetail(funding, '暂无资金来源线索，不能推断钱包之间不存在关联。');
    for (const edge of edges.slice(0, 30)) {
      const card = evidenceCard(edge.label || '未标记资金来源', badge('供应商线索', 'neutral')); card.append(addressNode(edge.fundingAddress), kv('本地观测时间', date(edge.observedAt, true)), kv('线索来源', edge.source)); if (edge.snapshotAt) card.append(kv('供应商快照时间', date(edge.snapshotAt, true))); if (edge.eventAt) card.append(kv('来源事件时间', date(edge.eventAt, true)));
      const warnings = el('div', 'wallet-labels'); if (edge.sharedService) warnings.append(badge('公共服务来源，不能据此合并归属', 'watch')); if (edge.conflict) warnings.append(badge('来源信息存在冲突', 'watch')); if (warnings.childNodes.length) card.append(warnings); funding.append(card);
    }
    fragment.append(funding);
    const holdings = section('持仓采样历史'); const snapshots = Array.isArray(data.holdings) ? data.holdings : [];
    if (!snapshots.length) walletEmptyDetail(holdings, '尚无持仓快照。未观测到持仓不等于钱包已经清仓。');
    for (const snapshot of snapshots.slice(0, 40)) {
      const hold = snapshot.holding || {}; const card = evidenceCard(date(snapshot.observedAt, true), badge(hold.currentlyHolding === true ? '报告仍持有' : hold.currentlyHolding === false ? '报告未持有' : '持仓状态未知', hold.currentlyHolding === true ? 'pass' : 'neutral'));
      card.append(addressNode(snapshot.tokenAddress), kv('代币数量', hold.amount), kv('样本持仓估值', usd(hold.usd)), kv('占供应量比例', finite(hold.supplyRatio) ? percent(hold.supplyRatio * 100).replace(/^\+/, '') : '—'), kv('供应商累计买入 / 卖出', `${usd(snapshot.cumulative?.buyVolumeUsd)} / ${usd(snapshot.cumulative?.sellVolumeUsd)}`), kv('来源', snapshot.source)); if (snapshot.snapshotAt) card.append(kv('供应商快照时间', date(snapshot.snapshotAt, true)));
      if (Array.isArray(snapshot.risks) && snapshot.risks.length) card.append(el('p', 'detail-small', '风险与数据限制'), reasonList(snapshot.risks.slice(0, 12)));
      if (Array.isArray(snapshot.developerLinks) && snapshot.developerLinks.length) card.append(el('p', 'detail-small', '开发者关联线索 · 未核实'), reasonList(snapshot.developerLinks.slice(0, 12)));
      holdings.append(card);
    }
    if (snapshots.length) holdings.append(el('p', 'wallet-sample-note', `展示本次返回的前 ${Math.min(snapshots.length, 40)} 个持仓样本。供应商累计买卖额不是近期净流入，也不是本地已实现利润。`)); fragment.append(holdings);
    const vendor = section('供应商 7 日表现快照'); const statistics = Array.isArray(data.vendorStats) ? data.vendorStats : [];
    if (!statistics.length) walletEmptyDetail(vendor, '尚未获取供应商钱包表现统计。');
    for (const stats of statistics.slice(0, 20)) {
      const card = evidenceCard(`本地观测 ${date(stats.observedAt, true)}`, badge('钱包整体 · 7 日', 'neutral')); card.append(kv('供应商已实现收益', usd(stats.realizedProfitUsd)), kv('供应商胜率', finite(stats.winRate) ? percent(stats.winRate * 100).replace(/^\+/, '') : '—'), kv('来源', stats.source)); if (stats.snapshotAt) card.append(kv('供应商统计时间', date(stats.snapshotAt, true))); vendor.append(card);
    }
    vendor.append(el('p', 'wallet-disclaimer', '供应商报告的窗口收益可能随时间和上游口径变化；不同时间的 7 日快照彼此重叠，不能相加。')); fragment.append(vendor);
    const traderSnapshots = Array.isArray(data.tokenTraderSnapshots) ? data.tokenTraderSnapshots : [];
    if (traderSnapshots.length) {
      const traders = section('单币交易者收益快照'); traders.append(el('p', 'wallet-section-note', '以下是供应商报告的单个代币累计收益。与整个钱包的 7 日已实现收益口径不同，不合并计算。'));
      for (const item of traderSnapshots.slice(0, 20)) { const card = evidenceCard(date(item.observedAt, true), badge('单币累计 · 供应商报告', 'neutral')); card.append(addressNode(item.tokenAddress), kv('累计收益', usd(item.profitUsd)), kv('其中已实现收益', usd(item.realizedProfitUsd)), kv('其中未实现收益', usd(item.unrealizedProfitUsd)), kv('来源', item.source)); traders.append(card); } fragment.append(traders);
    }
    const container = $('detail-content'); const active = document.activeElement; const label = container.contains(active) ? active?.getAttribute('aria-label') : null; container.replaceChildren(fragment); if (label) [...container.querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === label)?.focus();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) void refresh(); });
  window.addEventListener('online', () => { if (state.authenticated) void refresh(); });
  void boot();
})();
