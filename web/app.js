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
    followup: ['持续复盘', '保留当时判断，持续比较后续表现，用时间顺序与对照样本验证上涨线索。'],
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
  const checkNames = {provenance: '发行来源', safety: '合约与安全', market: '市场风险', narrative: '叙事参考（非必需）', wallets: '钱包样本', flow: '近期资金流'};
  const reasonNames = {
    OFFICIAL_FACTORY_CREATION_VERIFIED: '已验证来自配置中的官方发行工厂',
    SECURITY_FIELDS_UNVERIFIED: '部分安全字段尚未核实',
    SECURITY_REPORT_MISSING: '安全报告暂未取得',
    SOL_MINT_AUTHORITY_ACTIVE: '仍保留增发权限',
    SOL_FREEZE_AUTHORITY_ACTIVE: '仍保留冻结账户权限',
    SOL_MINT_UNVERIFIED: 'Solana 代币账户尚未核实',
    SOL_MINT_NOT_INITIALIZED: '代币账户尚未初始化',
    SOL_MUTABLE_TRANSFER_FEE: '转账手续费仍可修改',
    SOL_EXCESSIVE_TRANSFER_FEE: '转账手续费超过规则上限',
    SOL_EXTENSIONS_REQUIRE_REVIEW: '代币扩展权限需要进一步核验',
    SOL_MINT_PERMISSIONS_CHECKED: '已核验链上增发、冻结等权限',
    SOLANA_RPC_UNAVAILABLE: 'Solana 链上数据暂不可用',
    GOPLUS_UNAVAILABLE: '补充安全报告暂不可用',
    EVM_IS_HONEYPOT: '安全报告标记为蜜罐',
    EVM_CANNOT_BUY: '合约存在买入限制',
    EVM_CANNOT_SELL_ALL: '合约存在全量卖出限制',
    EVM_IS_MINTABLE: '仍保留增发能力',
    EVM_OWNER_CHANGE_BALANCE: '管理者可修改持有人余额',
    EVM_HIDDEN_OWNER: '存在隐藏管理权限',
    EVM_CAN_TAKE_BACK_OWNERSHIP: '管理权限可被重新取回',
    EVM_TRANSFER_PAUSABLE: '代币转账可被暂停',
    EVM_IS_BLACKLISTED: '存在黑名单控制',
    EVM_IS_WHITELISTED: '存在白名单交易限制',
    EVM_SLIPPAGE_MODIFIABLE: '交易税费仍可调整',
    EXCESSIVE_BUY_TAX: '买入税超过规则上限',
    EXCESSIVE_SELL_TAX: '卖出税超过规则上限',
    KNOWN_COUNTERFEIT: '安全报告标记为仿冒代币',
    WALLET_SAMPLE_UNVERIFIED: '钱包样本尚未完整核实',
    SMART_WALLET_GROUP_SUPPORT_INSUFFICIENT: '合格聪明钱包组支持不足',
    RECENT_SMART_ACCUMULATION_UNVERIFIED: '近期聪明钱包净买入尚未证实',
    SMART_WALLET_ACCUMULATION_SUPPORTED: '已有合格钱包近期净买入支持',
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
    ANALYSIS_DEADLINE_EXCEEDED: '本轮已到分析时限，未完成的核验不视为通过',
    SAFETY_PENDING: '合约安全正在核验',
    SAFETY_DEADLINE_EXCEEDED: '合约安全核验超时',
    SAFETY_NOT_COMPLETED: '合约安全核验尚未完成',
    SAFETY_PROVIDER_FAILED: '安全数据暂不可用',
    PROVENANCE_PENDING: '发行来源正在核验',
    PROVENANCE_DEADLINE_EXCEEDED: '发行来源核验超时',
    PROVENANCE_NOT_COMPLETED: '发行来源核验尚未完成',
    PROVENANCE_PROVIDER_FAILED: '发行来源数据暂不可用',
    MARKET_RISK_PENDING: '市场风险正在核验',
    MARKET_RISK_DEADLINE_EXCEEDED: '市场风险核验超时',
    MARKET_RISK_NOT_COMPLETED: '市场风险核验尚未完成',
    MARKET_RISK_NOT_PASSED: '市场风险核验尚未通过',
    MARKET_RISK_POLICY_INVALID: '市场风险规则配置异常',
    MARKET_TOKEN_SCOPE_UNVERIFIED: '市场数据尚未匹配到当前链与合约',
    MARKET_SNAPSHOT_STALE: '市场数据样本已过期',
    MARKET_INFO_SCOPE_UNVERIFIED: '代币详情与当前链或合约尚未核实',
    MARKET_PRICE_SCOPE_UNVERIFIED: '价格数据与当前链或合约尚未核实',
    MARKET_POOL_SCOPE_UNVERIFIED: '池子数据与当前链或合约尚未核实',
    MARKET_SECURITY_SCOPE_UNVERIFIED: '安全数据与当前链或合约尚未核实',
    MARKET_POOL_ADDRESS_ZERO: '返回的流动性池地址无效',
    MARKET_POOL_TOKEN_PAIR_INVALID: '交易对资产配置异常',
    MARKET_LIQUIDITY_ZERO: '当前报告的流动性为零',
    MARKET_LIQUIDITY_BELOW_POLICY: '当前流动性低于规则要求',
    MARKET_WASH_TRADING_REPORTED: '平台报告疑似刷量，仅作为风险线索',
    MARKET_DEV_HOLD_ABOVE_POLICY: '开发团队持仓估算超过规则上限',
    MARKET_INSIDER_HOLD_ABOVE_POLICY: '疑似关联持仓估算超过规则上限',
    MARKET_BUNDLER_VOLUME_ABOVE_POLICY: '捆绑交易量估算超过规则上限',
    MARKET_TOP_HOLDERS_INCLUDE_UNCLASSIFIED_ACCOUNTS: '大户占比仍包含未分类账户，不能直接等同集中控制',
    MARKET_VENDOR_WALLET_RISK_ESTIMATES: '钱包风险比例来自平台估算，归属尚未证实',
    MARKET_DATA_CONFLICT: '市场数据出现冲突，等待重新核验',
    MARKET_CURVE_POOL_UNVERIFIED: '内盘市场或池子数据尚未核实',
    MARKET_DATA_INCOMPLETE: '池子、报价或风险字段不完整',
    MARKET_REPORTED_LIQUIDITY_PRESENT: '已取得匹配合约的池子、报价与流动性样本',
    REQUIRED_EVIDENCE_STALE: '必要核验证据已过期，需要重新检查',
    DEBOT_DETAILS_UNAVAILABLE: 'DeBot 钱包详情暂不可用',
    NARRATIVE_NOT_PASSED: '叙事研究尚未通过',
    WALLET_SUPPORT_NOT_PASSED: '钱包与资金流证据尚未通过',
    SIGNAL_STALE: '信号已超出有效时间窗',
    DECISION_EXPIRED: '本次研究判断已过期',
    GMGN_WALLET_RESEARCH_UNAVAILABLE: '暂时无法获取 GMGN 钱包研究数据',
    GMGN_RATE_LIMITED: 'GMGN 请求受到限流',
    DEBOT_SIGNAL_STORE_FULL: 'DeBot 信号存储已达到容量上限',
    DEBOT_SIGNAL_PERSIST_FAILED: 'DeBot 信号保存失败',
    DEBOT_SIGNAL_DISPATCH_FAILED: 'DeBot 信号分析失败，本条尚未完成',
    DEBOT_SIGNAL_STALE: 'DeBot 信号已超过分析有效期',
    DEBOT_SIGNAL_INTERRUPTED: 'DeBot 信号分析因服务中断而未完成',
    DEBOT_SIGNAL_COLLECTION_FAILED: 'DeBot 信号采集失败',
    DEBOT_SIGNAL_INPUT_INVALID: 'DeBot 信号采集参数无效',
    DEBOT_SIGNAL_RESPONSE_INVALID: 'DeBot 信号响应格式异常',
    DEBOT_SIGNAL_CHANNEL_MISMATCH: 'DeBot 信号频道与请求网络不一致',
    DEBOT_SIGNAL_RECORDS_REJECTED: '部分 DeBot 信号记录未通过格式与一致性校验',
    DEBOT_SIGNAL_RESPONSE_TOO_LARGE: 'DeBot 信号响应超过接收上限',
    DEBOT_SIGNAL_INVALID_JSON: 'DeBot 信号响应无法解析',
    DEBOT_SIGNAL_HTTP_401: 'DeBot 信号接口要求登录',
    DEBOT_SIGNAL_HTTP_403: 'DeBot 信号接口拒绝匿名访问，需要登录',
    DEBOT_SIGNAL_HTTP_429: 'DeBot 信号接口限流，等待重试',
    DEBOT_SIGNAL_AUTH_REQUIRED: 'DeBot 信号接口要求登录',
    DEBOT_SIGNAL_RATE_LIMITED: 'DeBot 信号接口限流，等待重试',
    DEBOT_SIGNAL_HTTP_ERROR: 'DeBot 信号接口返回异常状态',
    DEBOT_SIGNAL_REQUEST_TIMEOUT: 'DeBot 信号请求超时',
    DEBOT_SIGNAL_REQUEST_FAILED: 'DeBot 信号请求失败',
    DEBOT_SESSION_FILE_MISSING: '尚未保存 DeBot 登录状态，请在上方完成登录',
    DEBOT_SESSION_AUTH_REQUIRED: 'DeBot 登录状态已失效，请重新验证',
    DEBOT_SESSION_FILE_INVALID: 'DeBot 登录文件无效，需要重新登录',
    DEBOT_SESSION_FILE_PERMISSIONS: 'DeBot 登录文件权限异常，等待服务端修复',
    DEBOT_SESSION_REQUEST_TIMEOUT: 'DeBot 登录验证请求超时，等待重试',
    DEBOT_SESSION_REQUEST_FAILED: 'DeBot 登录验证暂不可用，等待重试',
    DEBOT_SESSION_RATE_LIMITED: 'DeBot 登录验证受到限流，等待重试',
    DEBOT_STREAM_AUTH_TIMEOUT: 'DeBot 实时订阅认证超时，等待重连',
    DEBOT_STREAM_AUTH_REJECTED: 'DeBot 实时订阅认证失败，请重新登录',
    DEBOT_STREAM_CONNECT_FAILED: 'DeBot 实时连接失败，等待重连',
    DEBOT_STREAM_DISCONNECTED: 'DeBot 实时连接已断开，等待重连',
    DEBOT_STREAM_TRANSPORT_ERROR: 'DeBot 实时连接异常，等待重连',
    DEBOT_STREAM_DELAYED: '最近收到的 DeBot 信号存在传输延迟',
    DEBOT_STREAM_MESSAGE_INVALID: 'DeBot 推送格式异常，本条未作为有效信号',
    DEBOT_STREAM_CHAIN_NOT_SUBSCRIBED: '收到未订阅网络的推送，未作为有效信号',
    DEBOT_STREAM_CAPTURE_FAILED: 'DeBot 实时信号保存失败',
    DEBOT_STREAM_CAPTURE_BACKLOG: 'DeBot 实时信号处理积压，等待重连恢复',
    DEBOT_STREAM_SYNC_FAILED: 'DeBot 登录后的信号补充读取未完成',
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
    WALLET_TRIGGER_BUY_TOO_SMALL_OR_UNKNOWN: '触发买入金额过小或无法取得有效金额，暂不作为支持依据',
    WALLET_SCREENING_RESEARCH_PARAMETERS: '采用初版研究门槛，尚未校准预测能力',
    WALLET_SCREENING_NOT_PROBABILITY: '研究优先级不是概率或胜率',
    PROFILED_WALLET_SETUP_SUPPORTED: '画像路径满足钱包支持条件',
    WALLET_SETUP_SUPPORT_WITHDRAWN: '关键退出证据已撤回钱包支持',
    WALLET_SCREENING_UNAVAILABLE: '本轮钱包画像筛选暂不可用',
    WALLET_TRIGGER_BUY_CONFLICT: '触发买单证据冲突，已撤回支持',
    WALLET_SCREENING_SAMPLED_OBSERVATIONS: '判断仅使用已经取得的本地样本',
    WALLET_SCREENING_IDENTITY_UNVERIFIED: '公开标签不代表 KOL 本人身份或钱包归属已核实',
    WALLET_SCREENING_INPUT_INVALID: '本轮输入未通过校验',
    WALLET_SCREENING_TRUNCATED: '本轮样本达到上限，覆盖尚不完整',
    WALLET_SCREENING_INVALID_EVENTS_EXCLUDED: '已排除无法校验的交易记录',
    WALLET_SCREENING_CONFLICTING_EVENTS_EXCLUDED: '冲突交易记录未用作支持证据',
    WALLET_SCREENING_NO_RECENT_BUY: '近期窗口内尚无可用买入记录',
    WALLET_SCREENING_COVERAGE_NOT_COMPLETE: '本地采样可能漏掉交易，不能还原完整持仓',
    WALLET_SCREENING_FOLLOWERS_NOT_INDEPENDENCE_PROOF: '后续买入样本尚不能证明独立资金或真实跟单',
    WALLET_PROFILE_MISSING_OR_STALE: '所需钱包画像缺失或已到期',
    PUBLIC_WALLET_LABEL_UNVERIFIED: '未取得有效的公开钱包来源标签',
    PUBLIC_WALLET_PROFIT_COHORT_INSUFFICIENT: '本链有效盈利对照样本不足',
    PUBLIC_WALLET_PROFIT_BELOW_RESEARCH_THRESHOLD: '供应商利润或本地分位未达到研究门槛',
    PUBLIC_WALLET_PROFIT_TOP_QUARTILE: '供应商利润达到门槛，且处于本地盈利样本前四分之一',
    PUBLIC_WALLET_PROFIT_MISSING_OR_STALE: '供应商盈利快照缺失、已过期或无法核实',
    PRECURSOR_RELATION_NOT_KNOWN_BEFORE_BUY: '买入发生前尚无可用的前置模式证据',
    PRECURSOR_PRIOR_LEAD_EVIDENCE_INSUFFICIENT: '买入前已有的其他代币领先证据不足',
    PRECURSOR_PRIOR_PATTERN_SUPPORTED: '本次买入前已记录跨币领先模式',
    PRECURSOR_HISTORICAL_FOLLOW_COUNTEREXAMPLES: '历史样本中也有候选后买的反例',
    PRECURSOR_HISTORICAL_AMBIGUOUS_COUNTEREXAMPLES: '历史样本中存在时序不明或超出窗口的反例',
    PRECURSOR_UNMATCHED_NOT_PREDICTION_FAILURES: '历史未匹配样本不计作预测失败',
    PUBLIC_WALLET_LATER_BUY_OBSERVED: '已取得公开钱包随后买入的样本',
    PUBLIC_WALLET_ALREADY_ENTERED_OR_ORDER_UNCLEAR: '公开钱包已经先买入，或先后顺序无法区分',
    PUBLIC_WALLET_ENTRY_NOT_YET_OBSERVED: '尚未取得公开钱包后续进场的记录',
    PUBLIC_ENTRY_FOLLOW_BUYS_INSUFFICIENT: '未观察到至少 2 组金额不少于 100 美元、仍持仓且未出现减持的后续买入',
    PUBLIC_ENTRY_FOLLOW_BUYS_OBSERVED: '公开钱包买入后已观测到其他钱包组买入',
    WALLET_CURRENT_HOLDING_COVERAGE_MISSING: '缺少有效的当前持仓及近期交易覆盖',
    WALLET_RISK_OR_DEVELOPER_LINK: '触发钱包存在风险标签或开发者关联线索',
    PUBLIC_WALLET_RISK_OR_DEVELOPER_LINK: '公开钱包存在风险标签或开发者关联线索',
    WALLET_RECENT_ACCUMULATION_UNVERIFIED: '近期净买入或当前持仓尚未取得充分覆盖',
    WALLET_CURRENT_ACCUMULATION_SUPPORTED: '已覆盖的近期记录支持当前持有及净买入',
    WALLET_EXIT_SNAPSHOT_AFTER_TRIGGER: '触发买入后，供应商快照报告退出',
    WALLET_ENTRY_PRICE_COVERAGE_MISSING: '触发买入价或当前有效报价缺失',
    WALLET_ENTRY_CHASE_TOO_HIGH: '相对触发买入报价涨幅过高，暂不支持追入',
    WALLET_ENTRY_PRICE_DROPPED: '相对触发买入报价跌幅超出研究保护线',
    WALLET_ENTRY_PRICE_WITHIN_RESEARCH_GUARD: '当前报价相对触发买入处于研究观察范围',
    WALLET_EVENT_CONFLICT_AFTER_TRIGGER: '触发钱包买入后出现交易记录冲突',
    PUBLIC_WALLET_EVENT_CONFLICT_AFTER_TRIGGER: '公开钱包在触发买入后出现交易记录冲突',
    WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER: '触发钱包买入后已观测卖出或转出',
    PUBLIC_WALLET_SELL_OR_TRANSFER_AFTER_TRIGGER: '公开钱包在触发买入后已观测卖出或转出',
    WALLET_CURRENT_POSITION_EMPTY: '当前供应商快照显示触发钱包已无持仓',
    PUBLIC_WALLET_CURRENT_POSITION_EMPTY: '当前供应商快照显示公开钱包已无持仓',
    WALLET_SETUP_WITHDRAWN: '新的退出或冲突证据使该路径的支持撤回',
    WALLET_SCREENING_SETUPS_TRUNCATED: '仅保留本轮优先级较高的有限条路径',
    WALLET_SCREENING_NO_MATCHING_PROFILE: '近期买入尚未匹配到有效的目标钱包画像',
  };
  const state = {authenticated: false, view: 'scans', chain: '', decision: '', search: '', offset: 0, total: 0, items: [], orders: [], overview: null, refreshing: false, queued: false, queryVersion: 0, timer: null, searchTimer: null, lastSuccess: null, resourceErrors: {}, scansLoaded: false, ordersLoaded: false, detailId: null, detailKind: 'scan', detailWallet: null, detailGeneration: 0, returnFocus: null, walletEvidenceOpen: new Set(),
    walletSort: 'profiles', associationStatus: null, walletProfileStatus: null, walletProfilesReady: false, walletGroup: '', walletChain: '', walletSearch: '', walletOffset: 0, walletTotal: 0, walletItems: [], walletStatus: null, walletsLoaded: false, walletSearchTimer: null, protection: null, protectionLoaded: false, chainStream: null, chainStreamLoaded: false, followup: null, followupLoaded: false};

  const debotAuth = {status: null, busy: '', message: '', error: false, generation: 0};
  const debotRisk = {items: [], loaded: false, error: '', lastSuccess: 0, serverNow: 0, timer: null, controller: null, generation: 0, signature: ''};
  const debotAuthErrors = {
    DEBOT_AUTH_DISABLED: 'DeBot 登录功能尚未启用。',
    DEBOT_AUTH_EMAIL_MISSING: '服务器尚未配置登录邮箱。',
    DEBOT_AUTH_RATE_LIMITED: '验证码发送过于频繁，请等待冷却后重试。',
    DEBOT_AUTH_COOLDOWN: '请等待发送倒计时结束后重试。',
    DEBOT_AUTH_CHALLENGE_EXPIRED: '邮箱验证码已过期，请重新发送。',
    DEBOT_AUTH_CHALLENGE_INVALID: '本次验证请求已失效，请重新发送邮箱验证码。',
    DEBOT_AUTH_INVALID_CODE: '验证码未通过，请检查邮箱验证码与当前动态码。',
    DEBOT_AUTH_CODE_INVALID: '验证码未通过，请检查邮箱验证码与当前动态码。',
    DEBOT_AUTH_TOTP_REQUIRED: '请填写 Authenticator 当前显示的 6 位动态码。',
    DEBOT_AUTH_INVALID_INPUT: '请填写两个完整的 6 位验证码。',
    DEBOT_AUTH_REQUEST_TIMEOUT: 'DeBot 响应超时，请检查当前状态后重试。',
    DEBOT_AUTH_REQUEST_FAILED: '暂时无法连接 DeBot，请稍后重试。',
    DEBOT_AUTH_AUTH_REQUIRED: 'DeBot 登录验证未通过，请检查验证码后重试。',
    DEBOT_AUTH_SESSION_SAVE_FAILED: '登录状态保存失败，请稍后重试。',
    DEBOT_AUTH_CONFIG_MISSING: '服务器尚未完成 DeBot 登录配置。',
    DEBOT_AUTH_SEND_COOLDOWN: '请等待发送倒计时结束后重试。',
    DEBOT_AUTH_METHOD_UNSUPPORTED: '当前账户的登录验证方式与邮箱加动态码不匹配。',
    DEBOT_AUTH_ATTEMPTS_EXHAUSTED: '本次验证码尝试次数已用完，请重新发送邮箱验证码。',
    DEBOT_AUTH_BUSY: '已有登录操作正在处理，请等待完成。',
    DEBOT_AUTH_CODE_REJECTED: '验证码未通过，请检查邮箱验证码与当前 Authenticator 动态码。',
    DEBOT_AUTH_LOGIN_REJECTED: 'DeBot 拒绝了本次登录，请重新发送验证码后重试。',
    DEBOT_AUTH_SEND_REJECTED: 'DeBot 未接受本次验证码发送请求，请稍后重试。',
    DEBOT_AUTH_VERIFY_FAILED: 'DeBot 未确认登录后的账户状态，请在此处重新发送验证码验证。',
    DEBOT_AUTH_USER_INFO_INVALID: 'DeBot 账户信息响应异常，请稍后在此处重试。',
    DEBOT_AUTH_INVITE_CODE_INVALID: 'DeBot 账户登录标识无效，请在此处重新验证。',
    DEBOT_AUTH_SUB_TOKEN_INVALID: 'DeBot 未返回有效的信号订阅凭据，暂时无法连接实时推送。',
    DEBOT_AUTH_ACCOUNT_MISMATCH: 'DeBot 返回的账户与服务器配置邮箱不一致，请检查账户配置。',
    DEBOT_AUTH_COOKIE_MISSING: 'DeBot 未返回有效登录状态，请重新登录。',
    DEBOT_AUTH_COOKIE_INVALID: 'DeBot 返回的登录状态无法安全保存，请稍后重试。',
    DEBOT_AUTH_REDIRECT_REJECTED: 'DeBot 登录接口返回了异常跳转，请稍后重试。',
    DEBOT_AUTH_HTTP_ERROR: 'DeBot 登录接口暂不可用，请稍后重试。',
    DEBOT_AUTH_RESPONSE_INVALID: 'DeBot 登录接口响应异常，请稍后重试。',
    DEBOT_AUTH_RESPONSE_TOO_LARGE: 'DeBot 登录接口响应异常，请稍后重试。',
    DEBOT_AUTH_SESSION_TOO_LARGE: '登录状态超过保存上限，请联系服务端检查。',
    DEBOT_AUTH_SESSION_PATH_UNSAFE: '登录状态保存目录需要服务端修复。',
    DEBOT_AUTH_SAVE_FAILED: '登录状态保存失败，请稍后重试。',
    DEBOT_AUTH_RECONNECT_FAILED: '账户已登录，实时连接尚未恢复；请查看连接状态。',
  };

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
  const debotRiskChecks = [['safety', '合约安全'], ['provenance', '官方来源'], ['market', '市场风险'], ['wallets', '钱包支持']];
  function debotRiskVisible() { return state.authenticated && !document.hidden && ['scans', 'candidates'].includes(state.view); }
  function debotRiskNow() { return debotRisk.serverNow ? debotRisk.serverNow + Math.max(0, Date.now() - debotRisk.lastSuccess) : Date.now(); }
  function debotRiskStale() { return Boolean(debotRisk.error || !debotRisk.lastSuccess || Date.now() - debotRisk.lastSuccess > 8000); }
  function debotRiskDuration(value) { return finite(value) && value >= 0 ? value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(1)} 秒` : '—'; }
  function debotRiskConclusion(item) {
    const failed = ['safety', 'provenance', 'market'].some(key => item.checks?.[key]?.status === 'fail');
    if (failed || item.decision === 'REJECT') return ['已拒绝', 'fail'];
    if (['failed', 'interrupted'].includes(item.state)) return ['核验中断', 'watch'];
    if (item.state === 'ignored') return ['已跳过', 'neutral'];
    if (item.state !== 'completed') return [item.state === 'pending' ? '排队 · 等待核验' : '分析中 · 等待核验', 'watch'];
    const validUntil = validDate(item.validUntil)?.getTime();
    if (item.buyEligible === true && item.checks?.wallets?.status !== 'fail' && validUntil && validUntil > debotRiskNow() && !debotRiskStale()) return ['研究候选', 'pass'];
    if ((item.buyEligible === true || item.decision === 'BUY_CANDIDATE') && (!validUntil || validUntil <= debotRiskNow() || debotRiskStale())) return ['结论过期 · 待复核', 'watch'];
    return ['继续观察', 'watch'];
  }
  const debotScoreData = new WeakMap();
  let debotScorePopover = null;
  let debotScoreCloseTimer;
  let suppressDebotScoreFocus = false;
  function debotScoreState(item) {
    const score = item.score;
    const value = finite(score?.value) && score.max === 100 ? Math.max(0, Math.min(100, score.value)) : null;
    const blocked = score?.blocked === true || item.decision === 'REJECT' || ['safety', 'provenance', 'market'].some(key => item.checks?.[key]?.status === 'fail');
    const expired = Boolean(score?.stale || debotRiskStale() || item.state === 'completed' && (!validDate(item.validUntil) || Date.parse(item.validUntil) <= debotRiskNow()));
    const provisional = Boolean(score?.provisional || item.state !== 'completed');
    return {value: blocked ? 0 : value, blocked, expired, provisional, label: blocked ? expired ? '历史阻断' : '风险阻断' : expired ? '历史分' : provisional ? '暂评' : value === null ? '待评分' : '核验评分'};
  }
  function closeDebotScore(restoreFocus = false) {
    clearTimeout(debotScoreCloseTimer);
    if (!debotScorePopover) return;
    const {trigger, panel} = debotScorePopover;
    debotScorePopover = null; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-describedby'); panel.remove();
    if (restoreFocus && trigger.isConnected) { suppressDebotScoreFocus = true; trigger.focus({preventScroll: true}); suppressDebotScoreFocus = false; }
  }
  function positionDebotScore() {
    if (!debotScorePopover) return;
    const {trigger, panel} = debotScorePopover;
    if (!trigger.isConnected) { closeDebotScore(); return; }
    const rect = trigger.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, rect.bottom + panel.offsetHeight + 10 < window.innerHeight ? rect.bottom + 9 : rect.top - panel.offsetHeight - 9)}px`;
  }
  function renderDebotScorePopover(item, panel) {
    const scoreState = debotScoreState(item); panel.replaceChildren();
    const title = el('div', 'debot-score-detail-heading');
    title.append(el('strong', '', `${scoreState.value === null ? '—' : scoreState.value} / 100`), el('span', '', scoreState.label)); panel.append(title);
    const components = Array.isArray(item.score?.components) ? item.score.components : [];
    for (const [key, label] of debotRiskChecks) {
      const component = components.find(value => value?.key === key);
      const weight = finite(component?.weight) ? component.weight : {safety: 30, provenance: 15, market: 15, wallets: 40}[key];
      const earned = finite(component?.earned) ? component.earned : 0;
      const status = ['pass', 'fail'].includes(component?.status) ? component.status : 'unknown';
      const row = el('div', `debot-score-component ${status}`);
      row.append(el('span', '', label), el('span', '', `${earned} / ${weight}`), el('span', '', {pass: '已核验', fail: '未通过', unknown: '待核验'}[status])); panel.append(row);
      if (status !== 'pass') {
        const reasons = Array.isArray(item.checks?.[key]?.reasons) ? item.checks[key].reasons.filter(reason => typeof reason === 'string').slice(0, 2) : [];
        if (reasons.length) panel.append(el('p', 'debot-score-component-reason', reasons.map(reason => reasonNames[reason] || reason).join('；')));
      }
    }
    const note = scoreState.blocked ? `存在明确硬风险，总分归零；分项保留已有核验记录。${scoreState.expired ? '证据已过期，需要重新核验。' : ''}` : scoreState.expired ? '这是历史证据分，数据已过期，需要重新核验。' : scoreState.provisional ? '尚有未核实项目，暂评分只累计已通过项。' : '缺失或未通过的项目不计分，分数不改变最终风控结论。';
    panel.append(el('p', 'debot-score-note', note), el('p', 'debot-score-note', '评分不是胜率，也不代表已下单。'));
  }
  function openDebotScore(trigger, pinned = false) {
    const item = debotScoreData.get(trigger); if (!item) return;
    if (debotScorePopover?.trigger === trigger) { debotScorePopover.pinned ||= pinned; return; }
    closeDebotScore();
    const panel = el('div', 'debot-score-popover'); panel.id = 'debot-score-popover'; panel.setAttribute('role', 'tooltip');
    renderDebotScorePopover(item, panel); document.body.append(panel);
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-describedby', panel.id);
    debotScorePopover = {trigger, panel, eventId: item.eventId, pinned};
    panel.addEventListener('pointerenter', () => clearTimeout(debotScoreCloseTimer));
    panel.addEventListener('pointerleave', scheduleDebotScoreClose); positionDebotScore();
  }
  function scheduleDebotScoreClose() {
    clearTimeout(debotScoreCloseTimer);
    debotScoreCloseTimer = setTimeout(() => { if (debotScorePopover && !debotScorePopover.pinned && document.activeElement !== debotScorePopover.trigger) closeDebotScore(); }, 120);
  }
  function debotRiskScoreNode(item) {
    const current = debotScoreState(item);
    const tone = current.expired ? 'historical' : current.blocked ? 'blocked' : current.provisional ? 'provisional' : debotRiskConclusion(item)[1] === 'pass' ? 'passed' : 'observing';
    const button = el('button', `debot-risk-score ${tone}`); button.type = 'button'; button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-label', `查看 ${scalar(item.address)} 的评分明细`);
    const figure = el('span', 'debot-risk-score-value'); figure.append(el('strong', '', current.value === null ? '—' : String(current.value)), el('span', '', '/ 100'));
    button.append(figure, el('span', 'debot-risk-score-label', current.label)); debotScoreData.set(button, item);
    button.addEventListener('pointerenter', () => { if (matchMedia('(hover: hover)').matches) openDebotScore(button); });
    button.addEventListener('pointerleave', scheduleDebotScoreClose);
    button.addEventListener('focus', () => { if (!suppressDebotScoreFocus) openDebotScore(button); });
    button.addEventListener('blur', () => { if (!debotScorePopover?.pinned) closeDebotScore(); });
    button.addEventListener('click', event => { event.stopPropagation(); if (debotScorePopover?.trigger === button && debotScorePopover.pinned) closeDebotScore(); else openDebotScore(button, true); });
    return button;
  }
  function rebindDebotScore(container) {
    if (!debotScorePopover) return;
    const nextRow = [...container.querySelectorAll('[data-event-id]')].find(node => node.dataset.eventId === debotScorePopover.eventId);
    const next = nextRow?.querySelector('.debot-risk-score');
    if (!next) { closeDebotScore(); return; }
    debotScorePopover.trigger = next; next.setAttribute('aria-expanded', 'true'); next.setAttribute('aria-describedby', debotScorePopover.panel.id);
    renderDebotScorePopover(debotScoreData.get(next), debotScorePopover.panel); positionDebotScore();
  }
  document.addEventListener('pointerdown', event => { if (debotScorePopover && !debotScorePopover.trigger.contains(event.target) && !debotScorePopover.panel.contains(event.target)) closeDebotScore(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && debotScorePopover) { event.preventDefault(); closeDebotScore(true); } });
  document.addEventListener('scroll', positionDebotScore, true);
  window.addEventListener('resize', positionDebotScore);
  function renderDebotRisk() {
    const stale = debotRiskStale();
    const signature = JSON.stringify([debotRisk.items, debotRisk.error, stale, debotRisk.lastSuccess, debotRisk.items.map(item => [debotRiskConclusion(item)[0], debotScoreState(item).expired])]);
    if (signature === debotRisk.signature) return;
    debotRisk.signature = signature;
    const container = $('debot-risk-items');
    const scrollTop = container.scrollTop; const scrollLeft = container.scrollLeft;
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.closest('[data-event-id]')?.dataset.eventId;
    const focusLabel = active?.getAttribute('aria-label');
    const scorePopoverState = debotScorePopover ? {eventId: debotScorePopover.eventId, pinned: debotScorePopover.pinned} : null;
    container.replaceChildren();
    text('debot-risk-count', count(debotRisk.items.length));
    const status = $('debot-risk-status'); status.className = `badge ${stale ? 'watch' : 'neutral'}`;
    status.textContent = !debotRisk.loaded ? debotRisk.error ? '暂不可用' : '读取中' : stale ? '数据过期' : '每 2 秒同步';
    text('debot-risk-updated', debotRisk.lastSuccess ? `最近读取 ${time(new Date(debotRisk.lastSuccess).toISOString())} · 最新 12 条 · 研究候选不代表已下单` : '每 2 秒更新最新 12 条 · 研究候选不代表已下单');
    const warning = $('debot-risk-warning'); warning.hidden = !debotRisk.error && !(debotRisk.loaded && stale);
    warning.textContent = debotRisk.error || '实时记录已超过 8 秒未更新，以下结论暂不能作为当前判断。';
    $('debot-risk-empty').hidden = debotRisk.items.length > 0;
    text('debot-risk-empty', debotRisk.loaded ? '尚未接收到可展示的 DeBot 信号，收到后将显示核验进度。' : debotRisk.error ? '连接恢复后将自动继续读取。' : '正在读取信号核验进度…');
    if (debotRisk.items.length) {
      const table = el('table', 'debot-risk-table');
      const caption = el('caption', 'sr-only', '实时信号风控：名称、所属链、百分制核验评分与分析结果'); table.append(caption);
      const head = el('thead'); const header = el('tr');
      for (const [label, name] of [['代币 / 所属链', 'token'], ['核验分', 'score'], ['所属链', 'chain'], ['核验项目', 'checks'], ['状态 / 主要原因', 'conclusion'], ['接收时间 / 耗时', 'timing'], ['操作', 'actions']]) { const cell = el('th', `debot-risk-${name}-cell`, label); cell.scope = 'col'; header.append(cell); }
      head.append(header); const body = el('tbody'); table.append(head, body); container.append(table);
      for (const item of debotRisk.items) {
        const row = el('tr', 'debot-risk-row'); row.dataset.eventId = scalar(item.eventId, '');
        const token = el('td', 'debot-risk-token-cell');
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : typeof item.symbol === 'string' && item.symbol.trim() ? item.symbol.trim() : '名称待获取';
        const symbol = typeof item.symbol === 'string' && item.symbol.trim() && item.symbol.trim() !== name ? item.symbol.trim() : '';
        const identity = el('div', 'debot-risk-token-name', name); identity.title = name; token.append(identity);
        const tokenMeta = el('div', 'debot-risk-token-meta');
        const chainPill = () => { const node = el('span', `debot-risk-chain ${chainClass(item.chain)}`); node.append(el('span', `chain-dot ${chainClass(item.chain)}`), document.createTextNode(chainName(item.chain))); return node; };
        tokenMeta.append(chainPill()); if (symbol) { const symbolNode = el('span', 'debot-risk-symbol', symbol); symbolNode.title = symbol; tokenMeta.append(symbolNode); } token.append(tokenMeta);
        const shortAddress = typeof item.address === 'string' && item.address.length > 16 ? `${item.address.slice(0, 6)}…${item.address.slice(-6)}` : scalar(item.address);
        const address = el('div', 'debot-risk-address'); const code = el('code', '', shortAddress); code.title = scalar(item.address); address.append(code);
        if (typeof item.address === 'string' && item.address) address.append(copyButton(item.address)); token.append(address);
        const score = el('td', 'debot-risk-score-cell'); score.append(debotRiskScoreNode(item));
        const chain = el('td', 'debot-risk-chain-cell'); chain.append(chainPill());
        const checksCell = el('td', 'debot-risk-checks-cell'); const checks = el('div', 'debot-risk-checks'); const missing = [];
        for (const [key, label] of debotRiskChecks) {
          const check = item.checks?.[key]; const checkStatus = ['pass', 'fail'].includes(check?.status) ? check.status : 'unknown';
          const checkNode = el('span', `debot-risk-check ${checkStatus}`);
          checkNode.append(el('span', 'debot-risk-check-mark', {pass: '✓', fail: '×', unknown: '·'}[checkStatus]), el('span', '', label));
          const checkReasons = Array.isArray(check?.reasons) ? check.reasons.filter(reason => typeof reason === 'string') : [];
          const detail = [`${label}：${{pass: '已核验', fail: '未通过', unknown: '待核验'}[checkStatus]}`, check?.checkedAt ? `检查时间 ${date(check.checkedAt, true)}` : '', finite(check?.elapsedMs) ? `耗时 ${debotRiskDuration(check.elapsedMs)}` : '', ...checkReasons.slice(0, 5).map(reason => reasonNames[reason] || reason)].filter(Boolean).join('\n');
          checkNode.title = detail; checkNode.setAttribute('aria-label', detail);
          if (checkStatus === 'unknown') missing.push(label); checks.append(checkNode);
        }
        checksCell.append(checks);
        const conclusion = debotRiskConclusion(item); const decision = el('td', 'debot-risk-conclusion-cell'); decision.append(badge(...conclusion));
        const reasons = [...new Set([...debotRiskChecks.flatMap(([key]) => item.checks?.[key]?.status !== 'pass' && Array.isArray(item.checks?.[key]?.reasons) ? item.checks[key].reasons : []), ...(Array.isArray(item.reasons) ? item.reasons : [])])].filter(reason => typeof reason === 'string').slice(0, 4);
        const summary = reasons.length ? reasons.map(reason => reasonNames[reason] || reason).join('；') : missing.length ? `待核验：${missing.join('、')}` : conclusion[0] === '研究候选' ? `有效至 ${time(item.validUntil)} · 未代表下单` : '详细结论见核验证据';
        const reason = el('p', 'debot-risk-reason', summary); reason.title = summary; decision.append(reason);
        const timing = el('td', 'debot-risk-timing-cell'); const received = el('time', '', time(item.receivedAt)); received.title = date(item.receivedAt, true); if (validDate(item.receivedAt)) received.dateTime = item.receivedAt;
        timing.append(received, el('span', '', `到达 ${debotRiskDuration(item.signalDelayMs)}`), el('span', '', `分析 ${debotRiskDuration(item.analysisMs)}`)); timing.title = `排队 ${debotRiskDuration(item.queueMs)}\n分析 ${debotRiskDuration(item.analysisMs)}`;
        const actions = el('td', 'debot-risk-actions-cell'); actions.append(gmgnTokenLink(item.chain, item.address));
        if (typeof item.reportId === 'string' && item.reportId) {
          const detail = el('button', 'text-button', '核验证据 ↗'); detail.type = 'button'; detail.setAttribute('aria-label', `查看 ${scalar(item.address)} 的核验证据`); detail.addEventListener('click', () => openDetail(item.reportId, detail)); actions.append(detail);
          const follow = el('button', 'text-button', '后续复盘 ↗'); follow.type = 'button'; follow.setAttribute('aria-label', `查看 ${scalar(item.address)} 的后续复盘`); follow.addEventListener('click', () => openFollowup(item, follow)); actions.append(follow);
        }
        row.append(token, score, chain, checksCell, decision, timing, actions); body.append(row);
      }
    }
    container.scrollTop = scrollTop; container.scrollLeft = scrollLeft;
    rebindDebotScore(container);
    if (scorePopoverState && !debotScorePopover) {
      const next = [...container.querySelectorAll('[data-event-id]')].find(node => node.dataset.eventId === scorePopoverState.eventId)?.querySelector('.debot-risk-score');
      if (next) openDebotScore(next, scorePopoverState.pinned);
    }
    if (focusKey && focusLabel) {
      const replacement = [...container.querySelectorAll('[data-event-id]')].find(node => node.dataset.eventId === focusKey);
      suppressDebotScoreFocus = true;
      [...(replacement?.querySelectorAll('[aria-label]') || [])].find(node => node.getAttribute('aria-label') === focusLabel)?.focus({preventScroll: true});
      suppressDebotScoreFocus = false;
    }
  }
  function stopDebotRiskPolling(clear = false) {
    closeDebotScore();
    clearTimeout(debotRisk.timer); debotRisk.timer = null; debotRisk.generation++;
    debotRisk.controller?.abort(); debotRisk.controller = null;
    if (clear) { debotRisk.items = []; debotRisk.loaded = false; debotRisk.error = ''; debotRisk.lastSuccess = 0; debotRisk.serverNow = 0; debotRisk.signature = ''; renderDebotRisk(); }
  }
  async function pollDebotRisk() {
    if (!debotRiskVisible() || debotRisk.controller) return;
    clearTimeout(debotRisk.timer); const startedAt = Date.now(); const generation = debotRisk.generation;
    const controller = new AbortController(); debotRisk.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    renderDebotRisk();
    try {
      const response = await fetch(`${API}/debot/signals`, {credentials: 'same-origin', cache: 'no-store', headers: {Accept: 'application/json'}, signal: controller.signal});
      if (!response.ok) throw new RequestError(response.status);
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.items) || !validDate(payload.now)) throw new Error('DEBOT_RISK_RESPONSE_INVALID');
      if (generation !== debotRisk.generation || !debotRiskVisible()) return;
      debotRisk.items = payload.items.filter(item => item && typeof item === 'object' && typeof item.eventId === 'string').slice(0, 12);
      debotRisk.loaded = true; debotRisk.error = ''; debotRisk.lastSuccess = Date.now(); debotRisk.serverNow = Date.parse(payload.now) + Math.max(0, Date.now() - startedAt);
    } catch (error) {
      if (generation !== debotRisk.generation || !debotRiskVisible()) return;
      debotRisk.error = error.status === 401 ? '实时风控读取未获授权，已有数据已过期；请在系统状态检查会话。' : '实时风控暂时读取失败，保留上次记录并标记过期，连接恢复后自动更新。';
    } finally {
      clearTimeout(timeout);
      if (debotRisk.controller === controller) debotRisk.controller = null;
      if (generation === debotRisk.generation && debotRiskVisible()) { renderDebotRisk(); debotRisk.timer = setTimeout(pollDebotRisk, Math.max(0, 2000 - (Date.now() - startedAt))); }
    }
  }
  function syncDebotRiskPolling() {
    if (!debotRiskVisible()) { stopDebotRiskPolling(); return; }
    renderDebotRisk(); if (!debotRisk.controller && !debotRisk.timer) void pollDebotRisk();
  }
  setInterval(() => { if (debotRiskVisible()) renderDebotRisk(); }, 1000);
  function showLogin(message = '') {
    state.authenticated = false;
    stopDebotRiskPolling(true);
    debotAuth.generation++; debotAuth.status = null; debotAuth.busy = ''; clearDebotCodes();
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
    syncDebotRiskPolling(); await refresh();
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

  function clearDebotCodes() { $('debot-email-code').value = ''; $('debot-totp-code').value = ''; }
  function debotDelay(value) { return finite(value) && value >= 0 ? `${new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1}).format(value / 1000)} 秒` : '尚无样本'; }
  function debotStreamLabel(stream, scanner) {
    if (scanner?.mode === 'anonymous_poll') return '匿名轮询 · 非实时订阅';
    if (!stream) return scanner?.enabled ? '等待订阅状态' : '未启用';
    if (stream.state === 'auth_required') return '未登录 · 等待验证';
    if (stream.state === 'live' && stream.connected && stream.authorized) return '已认证 · 实时订阅中';
    return {connecting: '正在连接', authorizing: '已连接 · 等待认证', disconnected: '连接断开 · 等待重连', stopped: '订阅未运行', error: '订阅异常'}[stream.state] || '等待订阅状态';
  }
  function renderDebotAuth() {
    const auth = debotAuth.status, stream = state.overview?.debotStream, scanner = state.overview?.debotScanner;
    const authenticated = auth?.state === 'authenticated';
    const badgeNode = $('debot-auth-badge');
    badgeNode.className = `badge ${authenticated ? 'pass' : auth?.state === 'required' ? 'watch' : 'neutral'}`;
    badgeNode.textContent = !auth ? '读取登录状态' : !auth.enabled ? '登录功能未启用' : authenticated ? '账户已登录' : auth.state === 'required' ? '需要登录' : '登录状态暂不可用';
    $('debot-email').value = typeof auth?.email === 'string' ? auth.email : '';
    const live = $('debot-live-status'); live.replaceChildren(kv('实时信号连接', debotStreamLabel(stream, scanner)), kv('最近实时推送', date(stream?.lastSignalAt, true)), kv('最近推送延迟', debotDelay(stream?.lastSignalDelayMs)), kv('最近分析排队耗时', debotDelay(scanner?.lastAnalysisQueueDelayMs)));
    if (stream?.lastError) live.append(el('p', 'detail-small', reasonNames[stream.lastError] || 'DeBot 订阅暂不可用，服务端将重试。'));
    const message = auth?.lastError === 'DEBOT_AUTH_RECONNECT_FAILED' ? debotAuthErrors[auth.lastError] : debotAuth.message || (auth?.lastError ? debotAuthErrors[auth.lastError] || 'DeBot 登录状态暂不可用，请稍后刷新。' : '');
    text('debot-auth-message', message); $('debot-auth-message').hidden = !message;
    $('debot-auth-message').classList.toggle('error', debotAuth.error || Boolean(!debotAuth.message && auth?.lastError));
    renderDebotCountdown();
  }
  function renderDebotCountdown() {
    const auth = debotAuth.status, now = Date.now();
    const remaining = auth?.canSendAt ? Math.max(0, Math.ceil((Date.parse(auth.canSendAt) - now) / 1000)) : 0;
    const challengeValid = typeof auth?.challengeId === 'string' && auth.challengeId.length > 0 && Date.parse(auth.challengeExpiresAt) > now;
    const allowed = state.authenticated && auth?.enabled && typeof auth.email === 'string' && auth.email.length > 0;
    $('debot-send-code').disabled = !allowed || Boolean(debotAuth.busy) || remaining > 0;
    text('debot-send-code', debotAuth.busy === 'code' ? '正在发送…' : remaining > 0 ? `${remaining} 秒后可重发` : auth?.challengeId ? '重新发送验证码' : '发送邮箱验证码');
    $('debot-email-code').disabled = !allowed || !challengeValid || Boolean(debotAuth.busy);
    $('debot-totp-code').disabled = !allowed || !challengeValid || Boolean(debotAuth.busy);
    $('debot-login-submit').disabled = !allowed || !challengeValid || Boolean(debotAuth.busy);
    text('debot-login-submit', debotAuth.busy === 'login' ? '正在验证并连接…' : '验证并连接 DeBot');
    text('debot-code-hint', challengeValid ? `邮箱验证码有效至 ${time(auth.challengeExpiresAt)}；动态码请使用 Authenticator 当前显示的数字。` : auth?.challengeId ? '本次邮箱验证码已过期，请重新发送。' : auth?.state === 'authenticated' ? '账户已登录；重新登录时可再次发送验证码。实时订阅状态见上方。' : '先发送验证码，再填写两项 6 位码。');
  }
  async function debotAuthRequest(path, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetch(`${API}/debot/auth/${path}`, {method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: {Accept: 'application/json', 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      let result; try { result = await response.json(); } catch { result = null; }
      if (!response.ok) {
        const error = new RequestError(response.status);
        error.reason = typeof result?.error === 'string' && (/^DEBOT_AUTH_[A-Z_]+$/.test(result.error) || ['ORIGIN_REJECTED', 'UNAUTHORIZED'].includes(result.error)) ? result.error : '';
        throw error;
      }
      if (!result || !['authenticated', 'required', 'unavailable'].includes(result.state)) throw new Error('DEBOT_AUTH_RESPONSE_INVALID');
      return result;
    } finally { clearTimeout(timeout); }
  }
  function debotAuthError(error) {
    if (error.reason === 'ORIGIN_REJECTED') return '当前页面地址未通过验证，请从控制台的正式地址打开 DeBot 登录入口。';
    if (error.reason === 'UNAUTHORIZED') return '9528 访问会话已失效，请重新打开控制台。';
    return debotAuthErrors[error.reason] || (error.status === 429 ? '请求过于频繁，请稍后重试。' : error.status === 400 || error.status === 422 ? 'DeBot 验证未通过，请检查两个 6 位码；若邮箱验证码已过期，请重新发送。' : 'DeBot 操作未确认，请查看此处的登录状态后重试。');
  }
  $('debot-send-code').addEventListener('click', async () => {
    if (debotAuth.busy || $('debot-send-code').disabled) return;
    debotAuth.busy = 'code'; debotAuth.message = ''; debotAuth.error = false; const generation = ++debotAuth.generation;
    clearDebotCodes(); renderDebotAuth();
    try {
      const result = await debotAuthRequest('code', {});
      if (!state.authenticated || generation !== debotAuth.generation) return;
      debotAuth.status = result; debotAuth.message = '邮箱验证码已发送，请填写邮箱验证码和当前 Authenticator 动态码。';
    } catch (error) {
      if (!state.authenticated || generation !== debotAuth.generation) return;
      debotAuth.error = true; debotAuth.message = debotAuthError(error);
    } finally {
      if (generation === debotAuth.generation) { debotAuth.busy = ''; debotAuth.generation++; renderDebotAuth(); void refresh(); if (!$('debot-email-code').disabled) $('debot-email-code').focus(); }
    }
  });
  $('debot-auth-form').addEventListener('submit', async event => {
    event.preventDefault(); if (debotAuth.busy || $('debot-login-submit').disabled) return;
    let emailCode = $('debot-email-code').value.trim(), totpCode = $('debot-totp-code').value.trim();
    clearDebotCodes();
    if (!/^\d{6}$/.test(emailCode) || !/^\d{6}$/.test(totpCode)) { emailCode = ''; totpCode = ''; debotAuth.message = '请填写两个完整的 6 位验证码。'; debotAuth.error = true; renderDebotAuth(); return; }
    const challengeId = debotAuth.status?.challengeId;
    if (!challengeId || Date.parse(debotAuth.status.challengeExpiresAt) <= Date.now()) { emailCode = ''; totpCode = ''; debotAuth.message = '邮箱验证码已过期，请重新发送。'; debotAuth.error = true; renderDebotAuth(); return; }
    debotAuth.busy = 'login'; debotAuth.message = ''; debotAuth.error = false; const generation = ++debotAuth.generation; renderDebotAuth();
    try {
      const pending = debotAuthRequest('login', {challengeId, emailCode, totpCode}); emailCode = ''; totpCode = '';
      const result = await pending;
      if (!state.authenticated || generation !== debotAuth.generation) return;
      debotAuth.status = result;
      debotAuth.message = result.state === 'authenticated' ? '账户登录成功。实时连接与认证状态见上方。' : '验证尚未完成，请检查登录状态后重试。';
      debotAuth.error = result.state !== 'authenticated';
    } catch (error) {
      if (!state.authenticated || generation !== debotAuth.generation) return;
      debotAuth.error = true; debotAuth.message = debotAuthError(error);
    } finally {
      emailCode = ''; totpCode = ''; clearDebotCodes();
      if (generation === debotAuth.generation) { debotAuth.busy = ''; debotAuth.generation++; renderDebotAuth(); void refresh(); }
    }
  });
  window.addEventListener('pagehide', clearDebotCodes);
  setInterval(() => { if (state.authenticated && state.view === 'system') renderDebotCountdown(); }, 1000);

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
    if (state.walletSort === 'profiles' && state.walletGroup) q.set('group', state.walletGroup);
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
    if (activeView === 'followup') jobs.push({key: 'followup', run: () => api('/followup'), apply: data => { state.followup = data; state.followupLoaded = true; renderFollowup(); }});
    if (activeView === 'protection') jobs.push({key: 'protection', run: () => api('/protection'), apply: data => { state.protection = data; state.protectionLoaded = true; renderProtection(); }});
    if (activeView === 'system') jobs.push({key: 'chainStream', run: () => api('/chain-stream'), apply: data => { state.chainStream = data; state.chainStreamLoaded = true; renderChainStream(); }});
    if (activeView === 'system' && !debotAuth.busy) {
      const generation = debotAuth.generation;
      jobs.push({key: 'debotAuth', run: () => api('/debot/auth'), apply: data => { if (generation === debotAuth.generation && !debotAuth.busy) { debotAuth.status = data; renderDebotAuth(); } }});
    }
    if (activeView === 'orders') jobs.push({key: 'orders', run: () => api('/orders'), apply: data => { state.orders = Array.isArray(data.items) ? data.items : []; state.ordersLoaded = true; renderOrders(); }});
    if (activeView === 'wallets') {
      jobs.push({key: 'walletStatus', run: () => api('/wallet-research/status'), apply: data => { state.walletStatus = data; renderWalletStatus(); }});
      jobs.push({key: 'walletProfiles', run: () => api('/wallet-profiles/status'), apply: data => { state.walletProfileStatus = data; renderWalletProfileStatus(); }});
      if (state.walletSort === 'associations') jobs.push({key: 'associations', run: () => api('/wallet-associations/status'), apply: data => { state.associationStatus = data; renderAssociationStatus(); }});
      jobs.push({key: 'wallets', run: () => api(`/${state.walletSort === 'profiles' ? 'wallet-profiles' : state.walletSort === 'associations' ? 'wallet-associations' : 'wallets'}?${walletQuery()}`), apply: data => {
        if (version !== state.queryVersion) return;
        if (state.walletSort === 'profiles') state.walletProfilesReady = data.ready === true;
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
      if (state.resourceErrors.walletProfiles && state.view === 'wallets') renderWalletProfileStatus();
      if (state.resourceErrors.walletStatus && state.view === 'wallets') renderWalletScreeningStatus();
      if (state.resourceErrors.protection && state.view === 'protection') renderProtection();
      if (state.resourceErrors.followup && state.view === 'followup') renderFollowup();
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
  $('debot-settings-link').addEventListener('click', () => { setView('system'); $('debot-auth-panel').scrollIntoView({block: 'start'}); });
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
    state.walletSort = button.dataset.walletSort; state.walletItems = []; state.walletTotal = 0; state.walletsLoaded = false; $('wallet-rows').replaceChildren(); $('association-rows').replaceChildren(); $('wallet-profile-list').replaceChildren(); walletEmpty('正在读取研究记录', '从真实观测记录中整理研究目标。');
    document.querySelectorAll('[data-wallet-sort]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    renderWalletRankingNote(); walletFiltersChanged();
  }));
  $('wallet-chain').addEventListener('change', () => { state.walletChain = $('wallet-chain').value; walletFiltersChanged(); });
  $('wallet-group').addEventListener('change', () => { state.walletGroup = $('wallet-group').value; walletFiltersChanged(); });
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
    $('scans-panel').hidden = !['scans', 'candidates'].includes(view); $('orders-panel').hidden = view !== 'orders'; $('system-panel').hidden = view !== 'system'; $('protection-panel').hidden = view !== 'protection'; $('followup-panel').hidden = view !== 'followup';
    $('debot-risk-panel').hidden = !['scans', 'candidates'].includes(view); syncDebotRiskPolling();
    $('wallets-panel').hidden = view !== 'wallets'; $('wallet-metrics').hidden = view !== 'wallets'; $('scan-metrics').hidden = ['wallets', 'protection', 'system', 'followup'].includes(view); $('scan-insights').hidden = ['wallets', 'protection', 'system', 'followup'].includes(view); $('workbench').classList.toggle('wallet-mode', ['wallets', 'protection', 'system', 'followup'].includes(view));
    text('list-title', view === 'candidates' ? '曾通过研究判断的信号' : '全部扫描记录');
    delete state.resourceErrors.scans; delete state.resourceErrors.orders; delete state.resourceErrors.wallets; delete state.resourceErrors.walletStatus; delete state.resourceErrors.walletProfiles; delete state.resourceErrors.associations; delete state.resourceErrors.protection; delete state.resourceErrors.chainStream; delete state.resourceErrors.followup;
    if (view === 'scans' || view === 'candidates') { state.items = []; state.scansLoaded = false; $('scan-rows').replaceChildren(); text('list-count', '—'); renderScanEmpty('正在读取记录', '即将展示当前筛选条件下的真实数据。'); }
    if (view === 'system') { renderSystem(); renderChainStream(); renderDebotAuth(); }
    else clearDebotCodes();
    if (view === 'protection') renderProtection();
    if (view === 'followup') renderFollowup();
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
    renderBalances(Array.isArray(data.balances) ? data.balances : []); renderScanner(data.scanner); renderSystemOverview(); renderSystem(); renderDebotAuth(); if (state.view === 'system') renderChainStream();
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
    const debot = data.debotStream, debotScanner = data.debotScanner;
    text('debot-summary-text', `DeBot：${debotStreamLabel(debot, debotScanner)}`);
    text('debot-summary-note', debot?.authorized && debot?.connected ? `最近推送延迟 ${debotDelay(debot.lastSignalDelayMs)} · 登录与连接详情` : '邮箱 + Authenticator 登录 · 查看实时信号设置');
    statusDot('debot-summary-dot', debot?.state === 'live' && debot?.authorized && debot?.connected ? 'pass' : debotScanner?.enabled ? 'watch' : 'neutral');
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
      const walletScreening = walletScreeningSummary(record.walletScreening); if (walletScreening) token.append(walletScreening);
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
  function renderDebotScanner(runtime, scanner, stream) {
    if (!scanner) return;
    const cycle = scanner.lastCycle || {};
    const cooling = scanner.cooldownUntil && Date.parse(scanner.cooldownUntil) > Date.now();
    const authRequired = ['DEBOT_SIGNAL_HTTP_401', 'DEBOT_SIGNAL_HTTP_403', 'DEBOT_SIGNAL_AUTH_REQUIRED'].includes(scanner.lastError) || (Array.isArray(cycle.diagnostics) && cycle.diagnostics.some(item => item.status === 'auth_required'));
    const rateLimited = ['DEBOT_SIGNAL_HTTP_429', 'DEBOT_SIGNAL_RATE_LIMITED'].includes(scanner.lastError) || (Array.isArray(cycle.diagnostics) && cycle.diagnostics.some(item => item.status === 'rate_limited'));
    const status = !scanner.enabled ? '未启用' : !scanner.running ? '未运行' : authRequired ? '待登录后重试' : cooling ? rateLimited ? '限流冷却中' : '等待重试' : scanner.inFlight ? '正在采集' : '持续运行中';
    runtime.append(el('p', 'policy-caption', 'DeBot 信号采集'), kv('DeBot 采集状态', scanner.mode === 'authenticated_stream' ? debotStreamLabel(stream, scanner) : status), kv('采集方式', scanner.mode === 'anonymous_poll' ? `匿名轮询 · 每 ${scalar(scanner.intervalSec)} 秒调度 · 非实时订阅` : scanner.mode === 'authenticated_stream' ? '登录认证后的实时订阅 + 补充读取' : '未配置'), kv('最近一轮补充读取', date(cycle.completedAt, true)), kv('最近收到信号', date(scanner.lastObservedAt, true)), kv('已保存信号 / 已送分析 / 待分析', `${count(scanner.stored)} / ${count(scanner.dispatched)} / ${count(scanner.pending)}`), kv('已忽略信号', count(scanner.ignored)));
    if (stream) runtime.append(kv('最近实时认证成功', date(stream.lastAuthorizedAt, true)), kv('本次服务实时推送数 / 重连次数', `${count(stream.received)} / ${count(stream.reconnects)}`), kv('最近实时推送延迟', debotDelay(stream.lastSignalDelayMs)), kv('最大实时推送延迟', debotDelay(stream.maxSignalDelayMs)), kv('最近分析排队耗时', debotDelay(scanner.lastAnalysisQueueDelayMs)));
    if (finite(scanner.detailsReceived)) runtime.append(kv('已补充钱包详情 / 详情失败', `${count(scanner.detailsReceived)} / ${count(scanner.detailsFailed)}`));
    if (scanner.interrupted > 0 || scanner.failed > 0) runtime.append(kv('分析中断 / 失败', `${count(scanner.interrupted)} / ${count(scanner.failed)}`));
    if (cycle.completedAt || cycle.startedAt) runtime.append(kv('本轮接收 / 新增', `${count(cycle.received)} / ${count(cycle.added)}`), kv('本轮请求 / 错误', `${count(cycle.requests)} / ${count(cycle.errors)}`));
    if (cooling) runtime.append(kv('DeBot 下次重试时间', date(scanner.cooldownUntil, true)));
    if (scanner.deferredReason) runtime.append(kv('DeBot 分析排队原因', reasonNames[scanner.deferredReason] || scalar(scanner.deferredReason)));
    if (scanner.lastError) runtime.append(el('p', 'detail-message detail-error', `DeBot 最近异常：${reasonNames[scanner.lastError] || scalar(scanner.lastError)}`));
    if (Array.isArray(cycle.diagnostics)) {
      const labels = {ok: '正常', unavailable: '暂不可用', rate_limited: '限流', auth_required: '需要登录', invalid_response: '响应异常'};
      for (const item of cycle.diagnostics) {
        runtime.append(kv(`DeBot · ${chainName(item.chain)}`, `${labels[item.status] || scalar(item.status)} · 接收 ${count(item.received)} 条`));
        if (item.reason) runtime.append(el('p', 'detail-small', reasonNames[item.reason] || scalar(item.reason)));
      }
    }
    if (Array.isArray(cycle.reasons) && cycle.reasons.length) runtime.append(reasonList(cycle.reasons));
    runtime.append(el('p', 'detail-small', '完整钱包地址取得后才进入归属研究；钱包别名不能认定独立买家或同一控制人。信号仍需安全与钱包研究检查，已送分析不代表已通过条件或已买入。推送延迟从平台信号时间算起，分析排队耗时从本地接收算起。'));
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
    const comparison = data.stats?.comparison;
    if (comparison) {
      runtime.append(kv('近门槛对照观察 · 已登记 / 正在采样', `${count(comparison.registered)} / ${count(comparison.active)}`), kv('已有价格的对照币', count(comparison.sampled)));
      const groups = {one_smart_group: '一组资金支持', profile_pending: '画像证据待补全', no_confirmed_group: '资金支持未确认'};
      for (const group of comparison.groups || []) {
        const horizon = group.horizons?.find(h => h.seconds === 3600);
        runtime.append(kv(`对照 · ${groups[group.group] || scalar(group.group)}`, `${count(group.registered)} 币 · 1 小时有效样本 ${count(horizon?.covered)} · 涨幅中位数 ${percent(horizon?.medianGainPct)}`));
      }
      runtime.append(el('p', 'detail-small', '对照对象已通过来源与安全检查，尚缺钱包支持。每组最多同时观察 2 币，沿用原有报价额度；按登记后的实际报价记录 1 / 6 / 24 小时表现。容量与报价缺口会影响样本覆盖，数值不代表成交收益。'));
    }
    if (Array.isArray(cycle.diagnostics) && cycle.diagnostics.length) {
      runtime.append(el('p', 'policy-caption', '各来源最近状态'));
      for (const item of cycle.diagnostics) runtime.append(kv(`${chainName(item.chain)} · ${scalar(item.kind)}`, {ok: '正常', empty: '暂无新记录', invalid_response: '响应异常', unavailable: '暂不可用', rate_limited: '限流'}[item.status] || scalar(item.status)));
    }
    renderDebotScanner(runtime, data.debotScanner, data.debotStream);
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

  const followupFeatures = {two_wallet_groups: '至少两组合格钱包线索', positive_net_buy: '已采样钱包净买入为正', social_link: '名人社交关联线索', precursor_setup: '前置钱包买入路径', public_entry_setup: '公开钱包进场路径'};
  const followupWindow = seconds => ({3600: '1 小时', 21600: '6 小时', 86400: '24 小时'}[seconds] || `${seconds} 秒`);
  const followupStatus = {waiting: '等待首个报价', tracking: '采样跟踪中', unavailable: '报价暂不可用', ended: '观察周期结束', not_selected: '容量未入选'};
  function openFollowup(item, trigger) { return openDetail(`followup:${item.chain}:${item.address}`, trigger, {followup: true, chain: item.chain, address: item.address}); }
  function followupChain(chain) { const node = el('span', 'followup-token-meta'); node.append(el('span', `chain-dot ${chainClass(chain)}`), el('span', '', chainName(chain))); return node; }
  function followupHorizon(horizon, seconds, initialAt) {
    const node = el('div', 'followup-horizon'); node.append(el('span', '', {3600: '1h', 21600: '6h', 86400: '24h'}[seconds]), gainNode(horizon?.gainPct));
    const elapsed = validDate(initialAt) && Date.now() >= Date.parse(initialAt) + seconds * 1000 + 600000;
    node.title = horizon ? `${followupWindow(seconds)}报价于 ${date(horizon.at, true)}，相对目标时间延迟 ${count(horizon.delaySec)} 秒` : elapsed ? '窗口内未取得有效报价，不按 0% 计算' : '窗口尚未完成或尚无准时报价'; return node;
  }
  function renderFollowup() {
    const data = state.followup || {}, error = Boolean(state.resourceErrors.followup), loaded = state.followupLoaded;
    text('followup-total', count(data.total)); text('followup-sampled', `${count(data.sampled)} / ${count(data.selected)}`); text('followup-active', count(data.active)); text('followup-skipped', count(data.capacitySkipped));
    const status = $('followup-status'); status.className = `badge ${error ? 'watch' : data.enabled ? 'pass' : 'neutral'}`; status.textContent = error ? '更新暂时中断' : !loaded ? '正在读取' : data.enabled ? '持续积累中' : '未启用';
    const started = validDate(data.startedAt) ? `登记起点 ${date(data.startedAt, true)}` : '等待新信号建立登记起点';
    text('followup-refresh-note', `每 15 秒读取 · 汇总每 ${finite(data.refreshIntervalSec) ? data.refreshIntervalSec : 60} 秒更新`);
    text('followup-coverage', `${started} · 汇总计算于 ${date(data.computedAt, true)} · 最近报价 ${date(data.lastSampleAt, true)}。${finite(data.retentionDays) ? `保留 ${count(data.retentionDays)} 天，` : ''}按首次到达与容量选取样本；观察和排除信号均参与对照，历史涨幅不回填。`);
    $('followup-warning').hidden = !error; text('followup-warning', loaded ? '后续记录暂时无法更新，已保留最近成功读取的结果。页面会自动重试。' : '暂时无法读取持续复盘数据，连接恢复后会自动更新。');
    const learning = $('followup-learning'); learning.replaceChildren();
    learning.append(el('p', '', '分别检验钱包分组、净买入、名人链接、前置路径与公开钱包进场：同链、同首次判断、同策略版本、同观察窗口进行比较，按时间分为早期样本与后期验证样本。早期结果必须在后期样本登记前已经可知，跨越分界的结果剔除。'));
    const hypotheses = Array.isArray(data.learning) ? data.learning : []; const ready = hypotheses.filter(item => item.status && item.status !== 'collecting');
    const cards = el('div', 'followup-learning-cards');
    if (!ready.length) {
      const card = el('article', 'followup-learning-card'); card.append(badge('样本积累中', 'neutral'), el('h3', '', '先收齐结果，再验证线索')); const minimum = hypotheses.find(item => finite(item.minimumPerFeatureGroup))?.minimumPerFeatureGroup || 20;
      card.append(el('p', '', `每项线索的“出现”和“未出现”两组，在早期样本中各需至少 ${minimum} 个有效固定窗结果；再用后期样本验证。缺失的线索与报价单独计数。`)); cards.append(card);
      const features = el('article', 'followup-learning-card'); features.append(badge('持续比较', 'neutral'), el('h3', '', '观察涨前有哪些共同证据'), el('p', '', Object.values(followupFeatures).join(' · ')), el('p', '', '目前不会根据单个暴涨币上调权重；新证据与复盘结果持续保留。')); cards.append(features);
    } else for (const item of ready.slice(0, 8)) {
      const card = el('article', 'followup-learning-card'); const statusLabel = {needs_validation: '待后期样本验证', consistent_association: '前后样本方向一致', not_replicated: '后期未复现'}[item.status] || '积累中';
      card.append(badge(statusLabel, item.status === 'consistent_association' ? 'pass' : 'watch'), el('h3', '', followupFeatures[item.feature] || scalar(item.feature)), el('p', '', `${chainName(item.chain)} · ${decisions[item.decision]?.[0] || scalar(item.decision)} · ${followupWindow(item.seconds)} · ${scalar(item.policyVersion)}`));
      for (const [key, label] of [['train', '早期样本'], ['validation', '后期验证']]) {
        const split = item[key] || {}; const p = split.present || {}, a = split.absent || {}, u = split.unknown || {};
        card.append(el('p', '', `${label}：线索出现 ${count(p.covered)} 个，中位涨幅 ${percent(p.medianGainPct)}；未出现 ${count(a.covered)} 个，中位涨幅 ${percent(a.medianGainPct)}。报价缺失 ${count((p.missing || 0) + (a.missing || 0) + (u.missing || 0))} 个，线索未知 ${count(u.count)} 个。`));
      }
      card.append(el('p', '', `剔除跨越时间分界的早期样本 ${count(item.purgedTrainingCount)} 个；早期结果须在后期样本登记前已经可知。`), el('p', '', '这是样本内关联，仍需新增样本检验；不会自动改动交易门槛。')); cards.append(card);
    }
    learning.append(cards); if (Array.isArray(data.groups) && data.groups.length > 30) learning.append(el('p', 'detail-small', `共 ${data.groups.length} 个分组，下面展示前 30 组。`)); if (ready.length > 8) learning.append(el('p', 'detail-small', `当前展示 ${ready.length} 项已达到初步门槛的关系中的前 8 项。`));
    const groups = $('followup-groups'); const groupScroll = groups.scrollLeft; groups.replaceChildren(); const allGroups = Array.isArray(data.groups) ? data.groups : [];
    if (allGroups.length) {
      const table = el('table', 'followup-group-table'), head = el('thead'), hr = el('tr');
      for (const label of ['分组 / 策略版本', '登记 / 入选', '1 小时中位涨幅', '6 小时中位涨幅', '24 小时中位涨幅']) hr.append(el('th', '', label)); head.append(hr); table.append(head); const body = el('tbody');
      for (const group of allGroups.slice(0, 30)) {
        const row = el('tr'), label = el('td'); label.append(followupChain(group.chain), badge(...(decisions[group.decision] || [scalar(group.decision), 'neutral'])), el('small', '', scalar(group.policyVersion))); row.append(label, el('td', '', `${count(group.count)} / ${count(group.selected)}`));
        for (const seconds of [3600, 21600, 86400]) { const horizon = (Array.isArray(group.horizons) ? group.horizons : []).find(h => h.seconds === seconds), cell = el('td'); cell.append(gainNode(horizon?.medianGainPct), el('small', '', `覆盖 ${count(horizon?.covered)} / 到期 ${count(horizon?.mature)}`), el('small', '', `缺失 ${count(horizon?.missing)}`)); const boundary = hypotheses.find(item => item.chain === group.chain && item.decision === group.decision && item.policyVersion === group.policyVersion && item.seconds === seconds); if (finite(boundary?.purgedTrainingCount)) cell.append(el('small', '', `训练跨界剔除 ${count(boundary.purgedTrainingCount)}`)); row.append(cell); }
        body.append(row);
      } table.append(body); groups.append(table); groups.scrollLeft = groupScroll;
    }
    const body = $('followup-rows'); const scroll = $('followup-list').scrollLeft; const focused = body.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null; body.replaceChildren();
    const items = Array.isArray(data.items) ? data.items : []; text('followup-count', `展示 ${count(items.length)} 个`); $('followup-empty').hidden = items.length > 0; $('followup-list').hidden = !items.length;
    if (!loaded) { $('followup-empty').querySelector('h3').textContent = error ? '暂时无法读取记录' : '正在读取后续记录'; $('followup-empty').querySelector('p').textContent = '连接成功后展示真实采样记录。'; }
    else { $('followup-empty').querySelector('h3').textContent = '开始积累后续证据'; $('followup-empty').querySelector('p').textContent = '新信号完成分析后登记；首个有效价格样本到达后显示后续涨跌。'; }
    for (const item of items.slice(0, 30)) {
      const p = item.performance || {}, initial = item.initial || {}, row = el('tr'), token = el('td'), name = scalar(item.name || item.symbol, '未命名代币');
      const title = el('button', 'token-name', name); title.type = 'button'; title.setAttribute('aria-label', `查看 ${scalar(item.chain)} ${scalar(item.address)} 的后续复盘`); title.addEventListener('click', () => openFollowup(item, title)); token.append(title, followupChain(item.chain));
      const address = scalar(item.address); const short = el('code', 'followup-address', address.length > 19 ? `${address.slice(0, 8)}…${address.slice(-7)}` : address); short.title = address; token.append(short); if (item.name && item.symbol && item.name !== item.symbol) token.append(el('div', 'cell-subtitle', scalar(item.symbol))); row.append(token);
      const decision = el('td'); decision.append(badge(...(decisions[initial.decision] || ['待判断', 'neutral'])), el('div', 'cell-subtitle', followupStatus[p.status] || (item.selected ? '已入选' : '未入选')), el('div', 'cell-subtitle', `${count(p.samples)} 个报价`)); row.append(decision);
      for (const field of ['maxGainPct', 'currentGainPct', 'maxDrawdownPct']) { const cell = el('td', 'numeric'); cell.append(field === 'maxDrawdownPct' ? el('span', `gain ${finite(p[field]) && p[field] > 0 ? 'negative' : 'missing'}`, finite(p[field]) ? `${p[field] > 0 ? '−' : ''}${percent(p[field]).replace(/^\+/, '')}` : '—') : gainNode(p[field])); row.append(cell); }
      const horizons = el('td'); for (const seconds of [3600, 21600, 86400]) horizons.append(followupHorizon(item.horizons?.[String(seconds)], seconds, item.registeredAt)); row.append(horizons);
      const actions = el('td'); actions.append(el('time', 'followup-time', date(p.latestAt, true)), gmgnTokenLink(item.chain, item.address)); const detail = el('button', 'text-button', '证据与时间线 ↗'); detail.type = 'button'; detail.setAttribute('aria-label', `查看 ${scalar(item.chain)} ${scalar(item.address)} 的后续时间线`); detail.addEventListener('click', () => openFollowup(item, detail)); actions.append(detail); row.append(actions); body.append(row);
    }
    $('followup-list').scrollLeft = scroll; if (focused) [...body.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused)?.focus({preventScroll: true});
  }
  function followupTradeLink(chain, hash) {
    const evm = typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash), sol = typeof hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(hash);
    const url = chain === 'bsc' && evm ? `https://bscscan.com/tx/${hash}` : chain === 'solana' && sol ? `https://solscan.io/tx/${hash}` : null;
    if (!url) return el('p', 'followup-evidence-note', `交易标识 ${scalar(hash)}`);
    const link = el('a', 'source-link', '查看交易记录 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  function followupWalletContext(evidence, chain) {
    const node = el('div', 'followup-evidence-card'); node.append(el('h4', '', '在此时间点之前已取得的钱包样本'));
    if (!evidence || evidence.coverage === 'unavailable') { node.append(el('p', 'followup-evidence-note', '当时尚无可用的钱包活动覆盖，不能把缺少记录解释为没有资金进入。')); return node; }
    node.append(el('p', 'followup-evidence-note', `${date(evidence.fromAt, true)} 至 ${date(evidence.untilAt, true)} · ${count(evidence.evidenceCount)} 条证据${evidence.coverage === 'truncated' ? ' · 容量截断样本' : ' · 已采集样本'}`), kv('买入 / 卖出金额', `${usd(evidence.buyUsd)} / ${usd(evidence.sellUsd)}`), kv('采样净买入', usd(evidence.netBuyUsd)), kv('买入 / 卖出钱包', `${count(evidence.buyerCount)} / ${count(evidence.sellerCount)}`));
    const tradeExamples = el('details', 'followup-trade-examples'); const trades = (Array.isArray(evidence.trades) ? evidence.trades : []).slice(0, 6); tradeExamples.append(el('summary', '', `查看 ${trades.length} 条交易原始证据`));
    for (const trade of trades) {
      const card = el('div', 'followup-evidence-card'); card.append(el('h4', '', `${trade.side === 'buy' ? '买入' : '卖出'} · ${usd(trade.volumeUsd)}`), addressNode(trade.wallet), kv('交易发生', date(trade.eventAt, true)), kv('本地发现', date(trade.observedAt, true)), el('p', 'followup-evidence-note', walletSource(trade.source)), followupTradeLink(chain, trade.txHash)); tradeExamples.append(card);
    }
    if (trades.length) node.append(tradeExamples);
    node.append(el('p', 'followup-evidence-note', '金额仅覆盖已取得的交易；买入与价格突破的先后关系用于验证线索，不能单独证明拉盘、真实身份或完整资金流。')); return node;
  }
  function renderFollowupDetail(record) {
    const container = $('detail-content'), wrapper = el('div', 'followup-detail'), initial = record.initial || {}, p = record.performance || {}, name = scalar(record.name || record.symbol, '未命名代币');
    const heading = el('div', 'detail-token'), title = el('h2', '', name); title.id = 'detail-title'; heading.append(title); wrapper.append(heading, followupChain(record.chain), addressNode(record.address, 'detail-address'));
    const links = el('div', 'detail-links'); links.append(gmgnTokenLink(record.chain, record.address)); wrapper.append(links);
    const status = el('div', 'detail-pills'); status.append(badge(...(decisions[initial.decision] || ['初始判断未知', 'neutral'])), badge(followupStatus[p.status] || '等待采样', p.status === 'tracking' ? 'pass' : 'neutral')); wrapper.append(status);
    const initialSection = section('首次判断 · 原样留档'); initialSection.append(kv('来源 / 策略版本', `${scalar(initial.source)} · ${scalar(initial.policyVersion)}`), kv('首次信号 / 完成判断', `${date(initial.receivedAt, true)} / ${date(initial.evaluatedAt, true)}`), kv('开始登记 / 观察截止', `${date(record.registeredAt, true)} / ${date(record.endsAt, true)}`));
    initialSection.append(el('p', 'detail-small', '以下为登记时已知依据；后续取得的证据单独记录，不会改写首次判断。'));
    if (initial.reasons?.length) initialSection.append(reasonList(initial.reasons));
    for (const [key, label] of Object.entries(checkNames)) { const check = initial.checks?.[key]; if (!check) continue; const line = el('div', 'check-row'), top = el('div', 'check-top'); top.append(el('span', '', label), badge(key === 'narrative' ? '仅作参考' : check.status === 'pass' ? '通过' : check.status === 'fail' ? '未通过' : '证据不足', key === 'narrative' ? 'neutral' : check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'fail' : 'watch')); line.append(top); if (check.reasons?.length) line.append(reasonList(check.reasons)); initialSection.append(line); }
    wrapper.append(initialSection);
    const result = section('后续表现 · 固定窗口对照'); const metrics = el('div', 'detail-metrics'); metrics.append(detailStat('采样最高涨幅', percent(p.maxGainPct), date(p.peakAt, true), p.maxGainPct < 0 ? 'negative' : 'positive'), detailStat('最新涨幅', percent(p.currentGainPct), date(p.latestAt, true), p.currentGainPct < 0 ? 'negative' : 'positive'), detailStat('峰后最大回撤', finite(p.maxDrawdownPct) ? `${p.maxDrawdownPct > 0 ? '−' : ''}${percent(p.maxDrawdownPct).replace(/^\+/, '')}` : '—', '从此前峰值计算', 'negative')); result.append(metrics);
    if (Array.isArray(p.points) && p.points.length) { const chart = priceChart(p); chart.querySelector('svg')?.setAttribute('aria-label', `首次登记后价格曲线，共 ${p.points.length} 个报价样本`); result.append(chart); }
    else result.append(el('p', 'detail-message', record.selected ? '还没有取得有效的新报价，暂时无法比较涨跌。' : '本币已保留首次判断，未进入有界报价采样队列，因此没有后续涨跌数据。'));
    result.append(kv('首个报价 / 基准价', `${date(p.baselineAt, true)} / ${usd(p.baselinePriceUsd)}`), kv('有效报价 / 最大间隔', `${count(p.samples)} / ${finite(p.maxSampleGapSec) ? `${count(p.maxSampleGapSec)} 秒` : '—'}`));
    if (p.baselineDelayed) result.append(el('p', 'detail-small', '首个报价迟到超过 10 分钟，该币不参与固定窗口结果统计。'));
    if (p.baselineMarket || p.latestMarket) result.append(kv('流动性：基准 / 最近', `${usd(p.baselineMarket?.liquidityUsd)} / ${usd(p.latestMarket?.liquidityUsd)}`), kv('持币地址：基准 / 最近', `${count(p.baselineMarket?.holderCount)} / ${count(p.latestMarket?.holderCount)}`), kv('行情快照时间：基准 / 最近', `${date(p.baselineMarketAt, true)} / ${date(p.latestMarketAt, true)}`));
    if (p.error) result.append(el('p', 'detail-small', `最新报价问题：${reasonNames[p.error] || scalar(p.error)}，累计失败 ${count(p.errorCount)} 次。`));
    const horizons = el('div', 'followup-detail-horizons'); for (const seconds of [3600, 21600, 86400]) { const h = record.horizons?.[String(seconds)], box = el('div'); box.append(el('p', '', followupWindow(seconds)), gainNode(h?.gainPct), el('small', '', h ? `${date(h.at, true)} · 延迟 ${count(h.delaySec)} 秒` : '尚未完成 / 无准时报价')); horizons.append(box); } result.append(horizons, el('p', 'detail-small', '固定窗口从首次登记开始计时，允许窗口后 10 分钟内的首个报价；未覆盖显示 —。报价涨幅没有扣除滑点、税费，不代表实际收益。')); wrapper.append(result);
    const evidence = section('涨前有哪些线索'); evidence.append(kv('首次合格钱包组 / 采样净买入', `${count(initial.qualifiedGroups)} / ${usd(initial.recentNetBuyUsd)}`));
    for (const [key, label] of Object.entries(followupFeatures)) evidence.append(kv(label, initial.features?.[key] === true ? '首次判断时已出现' : initial.features?.[key] === false ? '首次判断时未出现' : '当时证据未知'));
    for (const setup of (Array.isArray(initial.setups) ? initial.setups : []).slice(0, 8)) { const card = el('div', 'followup-evidence-card'); card.append(el('h4', '', walletSetupName(setup.route)), kv('当时路径状态', walletSetupStatuses[setup.status] || scalar(setup.status)), el('p', 'followup-evidence-note', '触发钱包'), addressNode(setup.wallet)); if (setup.leader && setup.leader !== setup.wallet) card.append(el('p', 'followup-evidence-note', '公开标记钱包'), addressNode(setup.leader)); evidence.append(card); }
    for (const group of (Array.isArray(initial.walletGroups) ? initial.walletGroups : []).slice(0, 8)) { const card = el('div', 'followup-evidence-card'); card.append(el('h4', '', '首次钱包分组证据')); for (const [label, value] of [['分组标识', group.id], ['钱包数量', group.walletCount], ['聪明钱包持有人', group.smartCurrentHolders]]) if (value !== undefined) card.append(kv(label, scalar(value))); if (Array.isArray(group.basis)) card.append(reasonList(group.basis)); if (group.developerLinked === true) card.append(el('p', 'followup-evidence-note', '该组存在开发者关联线索')); for (const address of (Array.isArray(group.wallets) ? group.wallets : []).slice(0, 6)) if (typeof address === 'string') card.append(addressNode(address)); evidence.append(card); }
    evidence.append(el('p', 'detail-small', '钱包分组和名人链接是待验证线索。时间线只采用该时刻之前本地已取得的交易；后来补查到的历史不会变成提前发现。')); wrapper.append(evidence);
    if (initial.socialSignals?.length) wrapper.append(renderSocial({signals: initial.socialSignals}));
    const timelineSection = section('价格变化与同时段证据'); const timeline = el('ol', 'followup-timeline'); const labels = {baseline: '建立首个有效报价基准', gain_50: '采样首次达到 +50%', gain_100: '采样首次达到 +100%', drawdown_30: '采样首次出现 30% 回撤', horizon_1h: '取得 1 小时窗口样本', horizon_6h: '取得 6 小时窗口样本', horizon_24h: '取得 24 小时窗口样本', wallet_sample: '后续钱包与行情证据快照'};
    for (const event of (Array.isArray(record.timeline) ? record.timeline : []).slice(0, 32)) { const item = el('li'); item.append(el('time', '', date(event.at, true)), el('h4', '', labels[event.kind] || scalar(event.kind)), el('p', '', `报价 ${usd(event.priceUsd)} · 涨幅 ${percent(event.gainPct)} · 相对此前峰值回撤 ${finite(event.drawdownPct) ? percent(event.drawdownPct).replace(/^\+/, '') : '—'}`));
      if (event.market) item.append(el('p', '', `流动性 ${usd(event.market.liquidityUsd)} · 持币地址 ${count(event.market.holderCount)}`));
      if (event.walletEvidence) item.append(followupWalletContext(event.walletEvidence, record.chain)); else item.append(el('p', '', '此时点尚未留存可用的钱包交易快照。')); timeline.append(item); }
    if (timeline.children.length) timelineSection.append(timeline); else timelineSection.append(el('p', 'detail-message', '收到首个有效报价后开始生成时间线。'));
    timelineSection.append(el('p', 'detail-small', '时间线帮助检查“钱包买入先发生，还是上涨后才跟随”。上涨原因需要与未上涨样本和后续样本比较，单币事件顺序不会被写成确定因果。')); wrapper.append(timelineSection);
    const openTradeExamples = new Set([...container.querySelectorAll('.followup-trade-examples')].flatMap((node, index) => node.open ? [index] : [])); [...wrapper.querySelectorAll('.followup-trade-examples')].forEach((node, index) => { node.open = openTradeExamples.has(index); });
    const focus = container.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null; container.replaceChildren(wrapper); if (focus) [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focus)?.focus({preventScroll: true});
  }

  async function openDetail(id, trigger, wallet) {
    if (typeof id !== 'string') return;
    closeNarrative();
    state.returnFocus = trigger || document.activeElement; state.detailId = id; state.detailKind = wallet?.followup ? 'followup' : wallet?.association ? 'association' : wallet?.profile ? 'profile' : wallet ? 'wallet' : 'scan'; state.detailWallet = wallet || null; state.detailGeneration++; state.walletEvidenceOpen = new Set();
    text('detail-eyebrow', wallet?.followup ? 'SIGNAL FOLLOW-UP' : wallet ? 'WALLET RESEARCH' : 'SIGNAL DETAIL');
    $('drawer-backdrop').hidden = false; $('detail-drawer').hidden = false; $('app').inert = true; document.body.classList.add('drawer-open');
    const loading = el('p', 'drawer-loading', wallet ? '正在读取研究证据…' : '正在读取信号详情…'); loading.id = 'detail-title'; $('detail-content').replaceChildren(loading); $('detail-drawer').focus();
    await loadDetail(id);
  }
  async function loadDetail(id, quiet = false) {
    const generation = state.detailGeneration;
    const wallet = state.detailKind === 'wallet' ? state.detailWallet : null;
    const association = state.detailKind === 'association' ? state.detailWallet : null;
    const profile = state.detailKind === 'profile' ? state.detailWallet : null;
    const followup = state.detailKind === 'followup' ? state.detailWallet : null;
    try {
      const record = await api(followup ? `/followup/${encodeURIComponent(followup.chain)}/${encodeURIComponent(followup.address)}` : profile ? `/wallet-profiles/${encodeURIComponent(profile.chain)}/${encodeURIComponent(profile.address)}` : association ? `/wallet-associations/${encodeURIComponent(association.chain)}/${encodeURIComponent(association.leader)}/${encodeURIComponent(association.candidate)}` : wallet ? `/wallets/${encodeURIComponent(wallet.chain)}/${encodeURIComponent(wallet.address)}` : `/scans/${encodeURIComponent(id)}`);
      if (state.detailId === id && generation === state.detailGeneration) { if (followup) renderFollowupDetail(record); else if (profile) renderWalletProfileDetail(record.profile || record); else if (association) renderAssociationDetail(record); else if (wallet) renderWalletResearchDetail(record); else { renderDetail(record); void loadWalletScreeningLedger(record, id, generation); } }
    } catch (error) {
      if (error.status === 401) { showLogin('会话已结束，请重新登录。'); return; }
      if (state.detailId !== id || generation !== state.detailGeneration) return;
      if (!quiet) $('detail-content').replaceChildren(el('h2', '', '详情暂不可用'), el('p', 'drawer-loading detail-error', error.status === 404 ? followup ? '本币尚未在持续复盘模块中登记。模块上线前的旧信号不会补造首次价格或后续表现。' : '这条记录已超出保留期或不存在。' : '连接异常，请关闭详情后重试。'));
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
    state.walletEvidenceOpen = new Set([...container.querySelectorAll('details[data-wallet-evidence][open]')].map(item => item.dataset.walletEvidence));
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
    fragment.append(performance, renderWalletScreening(record.walletScreening), walletScreeningLedgerPlaceholder());
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
  const walletSetupRoutes = {precursor: '前置钱包买入', public_entry: '公开钱包进场'};
  const walletSetupStages = {awaiting_public_entry: '等待公开钱包后续进场', public_entry_observed: '已观测公开钱包进场', direct_entry: '公开钱包直接买入'};
  const walletSetupStatuses = {supported: '研究支持', watch: '待补证据', withdrawn: '支持已撤回', unavailable: '暂不可用'};
  function walletSetupName(route) { return walletSetupRoutes[route] || '钱包买入线索'; }
  function walletSetupTone(status) { return status === 'supported' ? 'pass' : status === 'withdrawn' ? 'fail' : 'watch'; }
  function screeningReasons(label, values, className = '') {
    if (!Array.isArray(values) || !values.some(value => typeof value === 'string')) return null;
    const area = el('div', `role-explanation ${className}`); area.append(el('h4', '', label), reasonList(values)); return area;
  }
  function screeningEvidence(key, label) { const item = el('details', 'wallet-setup-evidence'); item.dataset.walletEvidence = key; item.open = state.walletEvidenceOpen.has(key); item.append(el('summary', '', label)); return item; }
  function screeningScore(value) { return finite(value) && value >= 0 && value <= 20 ? `${value} / 20` : '—'; }
  function walletScreeningSummary(report) {
    if (!report || report.scope !== 'research_priority') return null;
    const area = el('div', 'scan-wallet-screening'); const setups = Array.isArray(report.setups) ? report.setups : [];
    for (const route of ['precursor', 'public_entry']) if (setups.some(item => item.route === route)) area.append(badge(walletSetupName(route), 'wallet-path'));
    const expired = validDate(report.validUntil) && Date.parse(report.validUntil) <= Date.now();
    const status = el('span', 'scan-wallet-screening-note', `${expired ? '历史判断' : walletSetupStatuses[report.status] || '待核对'} · 优先级 ${screeningScore(report.priorityScore)}`);
    status.title = '钱包线索用于研究排序；不代表 KOL 身份已核实、预测胜率或已下单。'; area.append(status); return area;
  }
  function walletSetupIdentity(setup) {
    const area = el('div', 'wallet-setup-identity');
    area.append(el('p', '', setup.route === 'precursor' ? '触发买入的前置候选钱包' : '触发买入的公开标记钱包'), addressNode(setup.wallet));
    if (setup.route === 'precursor') area.append(el('p', '', '比较对象 · 公开标记钱包'), addressNode(setup.leader));
    return area;
  }
  function renderWalletScreening(report) {
    const content = section('钱包线索参与筛选 · 当时判断'); content.classList.add('wallet-screening-section');
    content.append(el('p', 'wallet-section-note', '分别研究前置钱包买入和公开钱包直接进场。此处保存本次扫描时的判断；后续买卖另列在持续账本中。钱包归属、KOL 本人身份及喊单时间尚未核实。'));
    if (!report || report.scope !== 'research_priority') { content.append(el('p', 'detail-message', '这条扫描当时未保存钱包路径判断。后续取得的证据不会补写成当时已知。')); return content; }
    const header = el('div', 'wallet-setup-heading'); header.append(badge(walletSetupStatuses[report.status] || '待核对', walletSetupTone(report.status)), el('span', '', `研究优先级 ${screeningScore(report.priorityScore)}`)); content.append(header, kv('判断时间', date(report.checkedAt, true)), kv('有效期至', date(report.validUntil, true)));
    if (validDate(report.validUntil) && Date.parse(report.validUntil) <= Date.now()) content.append(el('p', 'wallet-screening-caveat', '判断已过期，以下是留档依据，不能作为当前开单依据。'));
    const setups = Array.isArray(report.setups) ? report.setups.slice(0, 20) : [];
    if (!setups.length) content.append(el('p', 'detail-message', '本轮尚未形成可用的前置或公开钱包进场线索。'));
    for (const setup of setups) {
      const card = el('article', 'wallet-setup-card'); const top = el('div', 'wallet-setup-heading'); top.append(el('h4', '', walletSetupName(setup.route)), badge(walletSetupStatuses[setup.status] || '待核对', walletSetupTone(setup.status))); card.append(top, walletSetupIdentity(setup), kv('观察阶段', walletSetupStages[setup.stage] || '阶段待确认'), kv('路径研究优先级', screeningScore(setup.priorityScore)));
      const counters = screeningReasons('反例与缺口', setup.counterEvidence, 'role-counter-evidence'); if (counters) card.append(counters);
      const reasons = screeningReasons('筛选依据', setup.reasons); if (reasons) card.append(reasons);
      if (setup.route === 'public_entry') card.append(kv('后续买入钱包组', count(setup.followers)), el('p', 'wallet-screening-caveat', '按已知资金联系折叠后的采样组数；未识别的关联仍可能存在，不等于独立跟单人数或净流入金额。'));
      if (setup.profit) {
        const profit = setup.profit; const evidence = el('div', 'wallet-setup-profit'); evidence.append(el('strong', '', '公开钱包的供应商盈利快照'), kv('报告的已实现利润', usd(profit.realizedProfitUsd)), kv('本地样本分位 / 样本钱包数', `${finite(profit.percentile) ? percent(profit.percentile).replace(/^\+/, '') : '—'} / ${count(profit.cohortSize)}`), kv('快照采集时间', date(profit.observedAt, true)), el('p', '', '供应商统计口径，不是本系统核算利润；本地样本分位不是全市场排名，也不是胜率。')); card.append(evidence);
      }
      card.append(kv('触发买入后报价变化', percent(setup.chasePct)), el('p', 'wallet-screening-caveat', '报价相对触发买入的变化仅用于观察追高，不能代表钱包实际收益或确认仍在持仓。'));
      if (setup.profileComputedAt) card.append(kv('采用的画像计算时间', date(setup.profileComputedAt, true)));
      if (setup.relationKnownAt) card.append(kv('采用的关系证据时间', date(setup.relationKnownAt, true)));
      if (setup.trigger) { const evidence = screeningEvidence(`scan:${setup.id}`, '核对触发买入记录'); evidence.append(associationEvent('触发买入', setup.trigger)); card.append(evidence); }
      content.append(card);
    }
    const reasons = screeningReasons('本轮整体说明', report.reasons); if (reasons) content.append(reasons);
    content.append(el('p', 'wallet-screening-caveat', '两条路径的线索用于研究优先级，仍需通过发行来源、合约安全和近期资金流检查。采样记录不能确认完整持仓，也不能单凭随后买入证明跟单或共同控制。')); return content;
  }
  function walletScreeningLedgerPlaceholder() {
    const content = section('钱包机会 · 持续观察账本'); content.id = 'wallet-screening-ledger'; content.setAttribute('aria-live', 'polite');
    content.append(el('p', 'wallet-section-note', '首次登记的证据保持不变，后续公开钱包进场、卖出和支持撤回单独记录。'), el('p', 'detail-message', '正在读取本币持续观察记录…')); return content;
  }
  async function loadWalletScreeningLedger(record, id, generation) {
    const target = $('wallet-screening-ledger'); if (!target || typeof record.chain !== 'string' || typeof record.address !== 'string') return;
    const current = () => target.isConnected && state.detailId === id && generation === state.detailGeneration;
    try {
      const query = new URLSearchParams({chain: record.chain, address: record.address, limit: '20'}); const data = await api(`/wallet-screening?${query}`);
      if (current()) renderWalletScreeningLedger(target, data);
    } catch (error) {
      if (!current()) return;
      if (error.status === 401) { showLogin('会话已结束，请重新登录。'); return; }
      target.querySelector('.detail-message')?.remove(); target.append(el('p', 'wallet-screening-caveat', '持续账本暂不可用，页面会在下一次刷新时重试；上方扫描留档仍可查看。'));
    }
  }
  function renderWalletScreeningLedger(content, data) {
    content.querySelector('.detail-message')?.remove();
    const items = Array.isArray(data?.items) ? data.items.slice(0, 20) : [];
    if (!items.length) { content.append(el('p', 'detail-message', '本币暂无已登记的钱包机会。缺少记录不代表没有相关钱包活动。')); return; }
    const states = {awaiting_leader: ['等待公开钱包', 'watch'], direct_entry: ['公开钱包直接进场', 'neutral'], leader_entered: ['已观测公开钱包进场', 'pass'], reduced: ['已观测卖出 / 转出', 'watch'], expired_unconfirmed: ['到期未确认', 'neutral']};
    for (const item of items) {
      const card = el('article', 'wallet-setup-card wallet-ledger-card'); const top = el('div', 'wallet-setup-heading'); top.append(el('h4', '', walletSetupName(item.route)), badge(...(states[item.state] || ['状态待确认', 'neutral']))); card.append(top, walletSetupIdentity(item), kv('首次登记', date(item.registeredAt, true)), kv('本次观察截止', date(item.expiresAt, true)), kv('最近核对', date(item.lastCheckedAt, true)));
      if (item.closedAt) card.append(kv('本次观察关闭', date(item.closedAt, true)));
      if (item.review?.status === 'withdrawn') { const notice = el('div', 'wallet-ledger-withdrawn'); notice.append(badge('研究支持已撤回', 'fail'), el('p', '', '撤回不抹去已发生的交易事实。')); const reasons = screeningReasons('撤回依据', item.review.reasons); if (reasons) notice.append(reasons); card.append(notice); }
      if (item.state === 'expired_unconfirmed') card.append(el('p', 'wallet-screening-caveat', '观察窗内未取得可确认的后续进场记录；采集不完整，不能记为预测失败。'));
      if (item.reduction) card.append(associationEvent(item.reduction.wallet === item.leader ? '公开标记钱包后续卖出 / 转出' : '触发钱包后续卖出 / 转出', item.reduction), el('p', 'wallet-screening-caveat', '仅说明观测到卖出或转出，不能认定清仓或已获利。'));
      if (item.leaderEntry) card.append(associationEvent('后续公开钱包买入记录', item.leaderEntry));
      if (finite(item.conflicts) && item.conflicts > 0) card.append(el('p', 'wallet-screening-caveat', `记录中有 ${count(item.conflicts)} 条冲突线索，先后次序或结论需要继续核对。`));
      if (item.observationsTruncated) card.append(el('p', 'wallet-screening-caveat', '本轮活动样本达到上限，后续记录可能尚未完整核对。'));
      const proof = item.proof;
      if (proof) {
        const evidence = screeningEvidence(`ledger:${item.id}`, '查看首次登记时的证据'); evidence.append(kv('首次判断时间', date(proof.checkedAt, true)), kv('当时结论', walletSetupStatuses[proof.status] || '待核对'), kv('当时阶段', walletSetupStages[proof.stage] || '阶段待确认'), kv('当时研究优先级', screeningScore(proof.priorityScore)));
        if (proof.trigger) evidence.append(associationEvent('首次登记依据的买入', proof.trigger));
        if (proof.profileComputedAt) evidence.append(kv('当时画像计算时间', date(proof.profileComputedAt, true)));
        if (proof.relationKnownAt) evidence.append(kv('当时采用的关系证据时间', date(proof.relationKnownAt, true)));
        for (const [label, values] of [['当时反例与缺口', proof.counterEvidence], ['当时支持依据', proof.reasons]]) { const list = screeningReasons(label, values); if (list) evidence.append(list); } card.append(evidence);
      }
      content.append(card);
    }
    content.append(el('p', 'wallet-screening-caveat', '仅展示最近 20 条本地机会记录。这里追踪已登记的样本，不把未知、漏采或到期未确认换算成胜率；持续账本的变化不会改写扫描时的留档结论。'));
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
  const profileGroupNames = {follower_pattern: '跟随模式样本', precursor_pattern: '前置模式样本', mixed_pattern: '方向混合', public_kol: '公开 KOL 来源', early_candidate: '前置买入候选', repeated_early: '历史重复提前', forward_validated: '已有后续验证', shared_funding: '共同资金来源', synchronized: '同步交易线索', vendor_profit_positive: '供应商报告盈利', observed_runner: '采样捕获翻倍', insufficient_evidence: '证据尚少', inactive_observed: '近期未观测活动'};
  function profileGroupName(id) { return profileGroupNames[id] || scalar(id, '未分类'); }
  function profileGroupTone(id) { return id === 'forward_validated' ? 'pass' : ['early_candidate', 'repeated_early', 'shared_funding', 'synchronized'].includes(id) ? 'watch' : 'neutral'; }
  function profileIsStale(profile) { const until = validDate(profile?.freshUntil); return profile?.status === 'stale' || Boolean(until && until.getTime() < Date.now()); }
  function profileHealth(profile) { return profileIsStale(profile) ? '待重新评估' : profile.status === 'partial' ? '部分证据待更新' : '画像已更新'; }
  function profileGroups(profile) { return Array.isArray(profile?.groups) ? profile.groups : []; }
  function renderWalletProfileStatus() {
    const data = state.walletProfileStatus;
    const failed = Boolean(state.resourceErrors.walletProfiles);
    const enabled = data?.enabled !== false;
    const limited = data?.capacityReached === true || Boolean(data?.error);
    const running = enabled && data?.running === true;
    const lastRun = validDate(data?.lastRunAt); const delayed = running && lastRun && Date.now() - lastRun.getTime() > Math.max(600000, (numeric(data.intervalSec) || 2) * 10000);
    const label = failed ? '状态读取失败' : !enabled ? '画像未启用' : limited ? '更新需关注' : delayed ? '处理进度过旧' : running ? data?.inFlight ? '正在分析' : '持续更新中' : data?.running === false ? '后台任务已暂停' : '等待后台任务';
    text('profile-status-badge', label); $('profile-status-badge').className = `badge ${failed || limited || delayed ? 'watch' : running ? 'pass' : 'neutral'}`;
    text('profile-status-title', !enabled ? '钱包画像任务未启用' : failed || limited || delayed || data?.running === false ? '已有画像保留，更新状态需确认' : data?.initialComplete ? '已有画像持续重新评估' : '正在为已积累钱包建立画像');
    text('profile-built-count', count(data?.profiles)); text('profile-source-count', count(data?.sourceWallets));
    const sourceProfiles = finite(data?.profiledSourceWallets) ? data.profiledSourceWallets : data?.profiles;
    text('profile-pending-count', finite(sourceProfiles) && finite(data?.sourceWallets) ? count(Math.max(0, data.sourceWallets - sourceProfiles)) : '—');
    const coverage = finite(sourceProfiles) && finite(data?.sourceWallets) && data.sourceWallets > 0 ? Math.min(100, sourceProfiles / data.sourceWallets * 100) : 0;
    $('profile-build-progress').value = coverage;
    $('profile-build-progress').setAttribute('aria-valuetext', `${Math.floor(coverage)}% 的已积累钱包已有画像`);
    text('profile-status-note', `${data?.lastRunAt ? `最近处理 ${date(data.lastRunAt, true)}。` : '等待首次后台处理。'}${finite(data?.staleProfiles) ? `${count(data.staleProfiles)} 个画像已到期等待重评。` : ''}${running && !failed && !limited && !delayed ? `${finite(data?.intervalSec) ? `后台每 ${data.intervalSec} 秒调度一批，` : ''}新增证据和到期画像会分批重新评估；页面关闭后仍继续。` : '当前不能确认画像正在正常更新。'}覆盖率只表示已建档，不代表全部交易历史已覆盖。`);
    const warning = failed ? '状态暂时无法更新，以下保留最近成功读取的数据。' : data?.capacityReached ? '画像库已达容量上限，更新暂停；已有画像保留，请检查服务端存储。' : data?.error ? '后台画像处理异常，已有画像可能未更新。' : delayed ? '较长时间未完成画像处理，已有结果可能过时，请查看后台任务状态。' : '';
    $('profile-status-warning').hidden = !warning; text('profile-status-warning', warning);
    text('profile-role-progress', finite(data?.roleProfiles) ? `有向行为比较：已处理 ${count(data.roleProfiles)} 个画像${finite(data.rolePending) ? ` · 尚待 ${count(data.rolePending)} 个` : ''}${data.roleLastRunAt ? ` · 最近 ${date(data.roleLastRunAt, true)}` : ''}。按每一对钱包分别比较先后方向。` : '有向行为比较尚未取得处理状态；已有历史分组不等于已完成角色辨别。');
    const groups = $('profile-group-counts'); const active = document.activeElement?.dataset.profileGroup; groups.replaceChildren();
    const groupCounts = Array.isArray(data?.groupCounts) ? data.groupCounts.map(item => [item.id || item.group, item.count]) : Object.entries(data?.groupCounts || {});
    for (const [id, size] of groupCounts.filter(([id, size]) => Object.hasOwn(profileGroupNames, id) && finite(size) && size > 0)) {
      const button = el('button', 'profile-group-count'); button.type = 'button'; button.dataset.profileGroup = id; button.setAttribute('aria-pressed', String(state.walletGroup === id)); button.append(el('span', '', profileGroupName(id)), el('strong', '', count(size)));
      button.addEventListener('click', () => { state.walletGroup = state.walletGroup === id ? '' : id; $('wallet-group').value = state.walletGroup; renderWalletProfileStatus(); walletFiltersChanged(); }); groups.append(button);
    }
    if (active) [...groups.children].find(item => item.dataset.profileGroup === active)?.focus();
  }
  function openWalletProfile(profile, trigger) { return openDetail(`profile:${profile.chain}:${profile.address}`, trigger, {profile: true, chain: profile.chain, address: profile.address}); }
  function profilePagination() {
    text('wallet-pagination-info', state.walletTotal ? `显示 ${state.walletOffset + 1}–${Math.min(state.walletOffset + state.walletItems.length, state.walletTotal)} 条，共 ${count(state.walletTotal)} 个画像` : '当前筛选下共 0 个画像');
    text('wallet-page-number', String(Math.floor(state.walletOffset / PAGE_SIZE) + 1).padStart(2, '0')); $('wallet-previous-page').disabled = state.walletOffset === 0; $('wallet-next-page').disabled = state.walletOffset + PAGE_SIZE >= state.walletTotal;
  }
  function renderWalletProfileList() {
    const list = $('wallet-profile-list'); list.replaceChildren(); text('wallet-list-count', count(state.walletTotal)); $('wallet-empty').hidden = state.walletItems.length > 0;
    if (!state.walletItems.length) walletEmpty(state.walletProfileStatus?.enabled === false ? '画像任务尚未启用' : !state.walletProfilesReady ? '画像正在等待首次处理' : '当前筛选暂无画像', state.walletProfileStatus?.enabled === false ? '尚无可显示的画像，已有钱包采样档案可在其他研究视图查看。' : !state.walletProfilesReady ? '后台任务就绪后会分批整理已经积累的钱包，首批完成后自动显示。' : '可以切换行为分组、网络或搜索条件。数据补建期间，尚未建档的钱包还不会出现在这里。');
    for (const profile of state.walletItems) {
      const card = el('article', 'wallet-profile-card'); const heading = el('div', 'profile-card-heading'); const identity = el('div', 'profile-card-identity'); identity.append(badge(chainName(profile.chain), 'neutral'), addressNode(profile.address));
      const action = el('button', 'association-evidence-button', '查看画像'); action.type = 'button'; action.setAttribute('aria-label', `查看钱包画像 ${profile.address}`); action.addEventListener('click', () => openWalletProfile(profile, action)); heading.append(identity, action); card.append(heading);
      card.append(walletRoleSummary(profile));
      const groups = el('div', 'profile-memberships'); for (const group of profileGroups(profile).filter(item => !['follower_pattern', 'precursor_pattern', 'mixed_pattern'].includes(item.id))) { const tag = badge(profileGroupName(group.id), profileGroupTone(group.id)); tag.title = `${scalar(group.reason, '')} · 首次入组 ${date(group.firstObservedAt, true)}`; groups.append(tag); } if (!groups.childNodes.length) groups.append(badge('暂无其他历史线索', 'neutral')); card.append(groups);
      const metrics = profile.metrics || {}, associations = metrics.associations || {}, chain = metrics.chain || {};
      const values = el('div', 'profile-card-values'); values.append(profileValue('已观测买 / 卖', `${count(metrics.buyEvents)} / ${count(metrics.sellEvents)}`, `${count(metrics.distinctTokens)} 个代币 · ${count(metrics.observedEvents)} 条活动`), profileValue('前置关联', `${count(associations.leaders)} 个公开钱包`, `${count(associations.distinctTokens)} 个代币 · ${count(associations.forwardTokens)} 个后续验证`), profileValue('供应商 7 日已实现收益', usd(metrics.vendorProfit?.realizedProfitUsd), metrics.vendorProfit ? `供应商快照 · ${date(metrics.vendorProfit.observedAt)}` : '暂无有效快照'), profileValue('买入后采样最高涨幅', percent(metrics.observedGain?.maxGainPct), '基于报价样本 · 非钱包收益')); card.append(values);
      const footer = el('div', 'profile-card-footer'); footer.append(badge(profileHealth(profile), profileIsStale(profile) || profile.status === 'partial' ? 'watch' : 'neutral'), el('time', '', `画像更新 ${date(profile.computedAt, true)}`), el('span', '', `RPC 交易参与 ${count(chain.transactions)} · 转账 ${count(chain.transfers)}`)); card.append(footer); list.append(card);
    }
    profilePagination();
  }
  function profileValue(label, value, note) { const item = el('div', 'profile-card-value'); item.append(el('span', '', label), el('strong', '', value), el('small', '', note)); return item; }
  const roleNames = {follower_pattern: '跟随模式样本', precursor_pattern: '前置模式样本', mixed_pattern: '方向混合', insufficient: '样本不足'};
  const roleDirections = {lead: '候选先买', follow: '候选后买', ambiguous: '先后不清', unmatched: '未匹配', outsideWindow: '超出比较窗口', outside_window: '超出比较窗口'};
  function roleName(value) { return roleNames[value] || '判别待确认'; }
  function roleTone(value) { return value === 'precursor_pattern' ? 'pass' : value === 'follower_pattern' ? 'follower' : 'neutral'; }
  function rolePeers(profile) { return Array.isArray(profile?.roleAnalysis?.peers) ? profile.roleAnalysis.peers : []; }
  function walletRoleSummary(profile) {
    const area = el('div', 'wallet-role-summary'); area.append(el('span', 'wallet-role-label', '行为判别 · 逐对比较'));
    if (!profile.roleAnalysis) { area.append(badge('待比较', 'neutral')); return area; }
    const peers = rolePeers(profile), classifications = [...new Set(peers.map(peer => peer.classification).filter(value => Object.hasOwn(roleNames, value)))];
    for (const classification of classifications) { const label = badge(roleName(classification), roleTone(classification)); label.title = `与 ${peers.filter(peer => peer.classification === classification).length} 个公开标记钱包的比较结果；不同对手钱包的次数不合并判断。`; area.append(label); }
    if (!classifications.length) area.append(badge(peers.length ? '判别待确认' : '样本不足', 'neutral'));
    if (profile.roleAnalysis.status === 'partial') area.append(el('span', 'wallet-role-coverage', '样本覆盖有限'));
    return area;
  }
  function roleTextList(label, values, className = '') {
    const items = Array.isArray(values) ? values.filter(value => typeof value === 'string').slice(0, 12) : [];
    if (!items.length) return null;
    const block = el('div', `role-explanation ${className}`); block.append(el('h4', '', label)); const list = el('ul'); for (const item of items) list.append(el('li', '', item)); block.append(list); return block;
  }
  function walletRoleSection(profile) {
    const content = section('有向行为比较：谁跟随谁'); content.classList.add('wallet-role-section');
    content.append(el('p', 'wallet-section-note', '每一对钱包独立比较，同一钱包可以跟随 A、领先 B。公开钱包仅指供应商标记来源，未验证 KOL 本人或喊单时间；这里判断采样行为，不判断真实身份。'));
    const role = profile.roleAnalysis;
    if (!role) { content.append(badge('待比较', 'neutral'), el('p', 'wallet-detail-empty', '这份画像尚未完成有向比较。已有“历史重复提前”分组保留为线索，暂不据此认定前置模式或关联小钱包。')); return content; }
    content.append(kv('最近比较', date(role.computedAt, true)), kv('覆盖状态', profileIsStale(profile) ? '画像待重评 · 以下为已保存结果' : role.status === 'partial' ? '部分样本受限' : '本轮样本已比较'), kv('钱包归属', '未知 · 行为模式不能证明共同控制'));
    const peers = rolePeers(profile);
    if (!peers.length) content.append(badge('样本不足', 'neutral'), el('p', 'wallet-detail-empty', '本轮尚未形成可比较的钱包对。未匹配到样本不能解释为互不关联。'));
    for (const peer of peers) {
      const card = el('article', 'wallet-role-peer'); const heading = el('div', 'wallet-evidence-heading'); heading.append(el('span', '', '与这个公开标记钱包比较'), badge(roleName(peer.classification), roleTone(peer.classification))); card.append(heading, addressNode(peer.address));
      const counts = peer.directionalTokens || {}, directions = el('div', 'role-direction-counts');
      for (const [key, label] of [['lead', '候选先买'], ['follow', '候选后买'], ['ambiguous', '先后不清'], ['unmatched', '未匹配'], ['outsideWindow', '超出窗口']]) { const value = el('div', `role-direction-count ${key}`); value.append(el('strong', '', count(counts[key])), el('span', '', label)); directions.append(value); } card.append(directions);
      card.append(kv('已匹配 CA / 候选采样 CA', `${count(peer.matchedTokens)} / ${count(peer.totalCandidateTokens)}`));
      if (finite(peer.leadShare)) card.append(kv('先买占已匹配 CA', percent(peer.leadShare * 100).replace(/^\+/, '')));
      if (finite(peer.followShare)) card.append(kv('后买占已匹配 CA', percent(peer.followShare * 100).replace(/^\+/, '')));
      card.append(el('p', 'role-denominator-note', '占比只描述这对钱包已匹配到的代币样本，不是预测命中率。已匹配包含方向不清和超出窗口的共同代币；同一方向至少 3 个代币且占比达到 75% 才形成对应模式，不跨对手钱包拼接次数。这是初版研究门槛，尚未校准置信度。'));
      if (finite(peer.pendingTokens) || finite(peer.unobservedTokens)) card.append(kv('未匹配：近期待观察 / 更早未覆盖', `${count(peer.pendingTokens)} / ${count(peer.unobservedTokens)}`), el('p', 'role-denominator-note', '未匹配不等于对方没有买入，也不计作预测失败。'));
      const counter = roleTextList('反向与不确定证据', peer.counterEvidence, 'role-counter-evidence'); if (counter) card.append(counter);
      const reasons = roleTextList('本轮判断依据', peer.reasons); if (reasons) card.append(reasons);
      const alternatives = roleTextList('其他可能解释', peer.alternativeExplanations); if (alternatives) card.append(alternatives);
      if (finite(peer.forwardObservedTokens)) card.append(kv('关系已知后的前向观察代币', count(peer.forwardObservedTokens)));
      if (finite(peer.medianLagSeconds)) card.append(kv('买入时间差中位数', `${peer.medianLagSeconds > 0 ? '+' : ''}${scalar(peer.medianLagSeconds)} 秒`), el('p', 'role-denominator-note', '时间差 = 当前候选买入 − 公开标记钱包买入；正数为候选后买，负数为先买。'));
      if (finite(peer.lagMadSeconds)) card.append(kv('时间差离散度（中位绝对偏差）', `${scalar(peer.lagMadSeconds)} 秒`));
      const funding = peer.funding || {}; const fundingBox = el('div', 'role-funding-note'); fundingBox.append(el('strong', '', '资金联系单独看'), el('p', '', `直接联系 ${count(funding.direct)} · 共同来源 ${count(funding.common)} · 已排除 ${count(funding.excluded)}`), el('p', '', '公共服务或冲突线索会被排除；有效资金联系也不能证明 KOL 本人或同一控制人。')); card.append(fundingBox);
      const events = Array.isArray(peer.evidence) ? peer.evidence.slice(0, 6) : [];
      if (events.length) {
        const evidence = el('details', 'role-evidence'); const key = `${profile.chain}:${profile.address}:${peer.address}`; evidence.dataset.roleEvidence = key; evidence.open = [...$('detail-content').querySelectorAll('details[data-role-evidence][open]')].some(node => node.dataset.roleEvidence === key); const toggle = el('summary', '', `逐币核对 · ${events.length} 条代表样本`); toggle.setAttribute('aria-label', `核对与 ${peer.address} 的逐币角色证据`); evidence.append(toggle);
        for (const event of events) { const item = evidenceCard(roleDirections[event.direction] || '方向待确认', badge('交易时序样本', 'neutral')); item.append(addressNode(event.tokenAddress), gmgnTokenLink(profile.chain, event.tokenAddress)); if (typeof event.reason === 'string') item.append(el('p', 'association-detail-note', event.reason)); if (event.candidateBuy) item.append(associationEvent('当前候选钱包买入', event.candidateBuy)); else item.append(el('p', 'association-detail-note', '候选买入证据不完整或存在冲突，当前不能确定先后。')); if (event.leaderBuy) item.append(associationEvent('公开标记钱包买入', event.leaderBuy)); else item.append(el('p', 'association-detail-note', '未取得公开标记钱包在该币的可用买入记录。')); if (event.candidateSellAfterLeader) item.append(associationEvent('候选钱包随后卖出', event.candidateSellAfterLeader), el('p', 'association-detail-note', '观察到卖出不等于已获利。')); evidence.append(item); } card.append(evidence);
      }
      content.append(card);
    }
    const limits = roleTextList('本轮比较的覆盖边界', role.limitations); if (limits) content.append(limits); return content;
  }
  function profileEvidenceSection(profile) {
    const content = section('持续行为画像');
    content.append(kv('更新状态', profileHealth(profile)), kv('画像最近计算', date(profile.computedAt, true)), kv('最近证据观测', date(profile.evidenceThroughAt, true)), kv('下次到期评估', date(profile.freshUntil, true)), el('p', 'wallet-section-note', '以下保留历史研究线索。“历史重复提前”可合并跨对手钱包的历史次数，不代表对同一个钱包的领先方向占多数，也不等于稳定角色。同一钱包可属于多个组，证据变化或过期后会重新评估；首次入组是系统建立标签的时间。'));
    for (const group of profileGroups(profile)) { const card = evidenceCard(profileGroupName(group.id), badge('行为研究分组', profileGroupTone(group.id))); card.append(el('p', 'profile-group-reason', scalar(group.reason, '尚无可展示的入组说明')), kv('首次入组', date(group.firstObservedAt, true)), kv('支持证据数', count(group.evidenceCount))); content.append(card); }
    if (!profileGroups(profile).length) walletEmptyDetail(content, '当前没有有效行为分组，等待进一步证据。');
    const limitationNames = {HISTORICAL_ASSOCIATION_EVIDENCE: '前置关联依据包含历史样本，不代表这些钱包当前仍在协同。', HISTORICAL_COORDINATION_EVIDENCE: '同步或资金联系依据包含历史样本，不能据此判断当前活跃程度。', SAMPLED_OBSERVATIONS_NOT_COMPLETE_HISTORY: '只覆盖已采集样本，交易历史可能不完整。', ASSOCIATIONS_DO_NOT_PROVE_COMMON_OWNERSHIP: '关联行为不能证明共同控制或实际身份。', VENDOR_PROFIT_IS_NOT_LOCAL_REALIZED_PNL: '供应商收益数据不是本系统核算的已实现利润。', EVENT_SAMPLE_LIMIT_500: '本轮画像只分析最近 500 条活动，完整采样档案另行保留。', PUBLIC_ANCHOR_SAMPLE_LIMIT_100: '公开来源仅取前 100 个入口样本。', RELATION_SAMPLE_LIMIT_20: '本轮前置关联分析最多涵盖 20 对关系。', RELATION_CACHE_PENDING_OR_STALE: '部分前置关联等待重算，尚未用于当前分组。', EPISODE_SAMPLE_LIMIT_100: '每对关联最多分析最近 100 条时序证据。', VENDOR_PROFIT_MISSING_STALE_OR_INVALID: '供应商利润快照缺失、过期或未通过校验，未用于当前盈利分组。', COORDINATION_CACHE_PENDING_OR_STALE: '部分协同线索等待重算，尚未用于当前分组。', CHAIN_EVENT_SAMPLE_LIMIT_500: '本轮链上依据最多使用最近 500 条活动。', CHAIN_PARTICIPATION_OR_TRANSFER_IS_NOT_A_BUY_SELL_OR_HOLDING: 'RPC 交易参与、转账记录不直接等于买卖或持仓。', CHAIN_EVENT_TIME_UNKNOWN: '部分链上记录只有采集时间，缺少事件发生时间。'};
    const limitations = Array.isArray(profile.limitations) ? profile.limitations.filter(item => Object.hasOwn(limitationNames, item)) : [];
    if (limitations.length) { const list = el('ul', 'profile-limitations'); for (const item of limitations) list.append(el('li', '', limitationNames[item])); content.append(list); }
    return content;
  }
  function renderWalletProfileDetail(profile) {
    const fragment = document.createDocumentFragment(); const title = el('h2', '', '钱包行为画像'); title.id = 'detail-title'; fragment.append(title, el('p', 'association-detail-note', `${chainName(profile.chain)} · 持续更新的研究记录 · 归属未知`), addressNode(profile.address, 'detail-address'), walletRoleSection(profile), profileEvidenceSection(profile));
    const metrics = profile.metrics || {}, associations = metrics.associations || {}, chain = metrics.chain || {};
    const summary = section('观测依据'); summary.append(kv('买入 / 卖出活动', `${count(metrics.buyEvents)} / ${count(metrics.sellEvents)}`), kv('已观测活动 / 代币', `${count(metrics.observedEvents)} / ${count(metrics.distinctTokens)}`), kv('最近交易事件时间', date(metrics.lastEventAt, true)), kv('关联公开钱包 / 代币', `${count(associations.leaders)} / ${count(associations.distinctTokens)}`), kv('后续验证代币', count(associations.forwardTokens)), kv('供应商 7 日已实现收益', usd(metrics.vendorProfit?.realizedProfitUsd)), kv('买入后采样最高涨幅', percent(metrics.observedGain?.maxGainPct)), el('p', 'wallet-section-note', '供应商收益不是本地核算利润；采样涨幅以观测到买入后的报价为基准，不是钱包实际收益。'));
    if (metrics.observedGain?.tokenAddress) summary.append(el('p', 'detail-small', '采样涨幅对应代币'), addressNode(metrics.observedGain.tokenAddress), gmgnTokenLink(profile.chain, metrics.observedGain.tokenAddress)); fragment.append(summary);
    const raw = section('链上原始活动'); raw.append(kv('RPC 交易参与', count(chain.transactions)), kv('RPC 转账记录', count(chain.transfers)), kv('最近取得链上记录', date(chain.lastObservedAt, true)), el('p', 'wallet-section-note', 'RPC 交易参与与转账只表示已观测链上事实，未直接归类为买卖。当前仅覆盖被选中监测的钱包，缺少记录不代表没有活动。')); fragment.append(raw);
    const peers = section('关联研究对象'); const counterparties = Array.isArray(profile.counterparties) ? profile.counterparties : [];
    for (const peer of counterparties.slice(0, 20)) { const card = evidenceCard({leader: '前置时序对应的公开钱包', shared_funding: '共同资金来源线索', synchronized: '同步交易线索'}[peer.kind] || '关联线索', badge('归属未知', 'watch')); card.append(addressNode(peer.address), kv('支持证据数', count(peer.evidenceCount))); if (peer.kind === 'leader') { const action = el('button', 'association-evidence-button', '查看这对关系的证据'); action.type = 'button'; action.addEventListener('click', () => openDetail(`association:${profile.chain}:${peer.address}:${profile.address}`, action, {association: true, chain: profile.chain, leader: peer.address, candidate: profile.address})); card.append(action); } peers.append(card); }
    if (!counterparties.length) walletEmptyDetail(peers, '暂未形成可展示的关联对象，不能据此判断不存在关联。'); peers.append(el('p', 'wallet-disclaimer', '共同资金来源、同步交易或前置买入不能单独证明同一人控制，也不直接认定“阴谋钱包”。')); fragment.append(peers);
    const changes = section('分组变化记录'); const events = Array.isArray(profile.changes) ? profile.changes : [];
    for (const change of events) { const card = evidenceCard(date(change.at || change.changedAt || change.computedAt, true), badge('本地画像变化', 'neutral')); const added = change.added || change.addedGroups || []; const removed = change.removed || change.removedGroups || []; if (added.length) card.append(el('p', 'profile-group-reason', `加入：${added.map(id => profileGroupName(typeof id === 'string' ? id : id.id)).join('、')}`)); if (removed.length) card.append(el('p', 'profile-group-reason', `退出：${removed.map(id => profileGroupName(typeof id === 'string' ? id : id.id)).join('、')}`)); if (!added.length && !removed.length) card.append(el('p', 'profile-group-reason', scalar(change.reason, '画像依据更新'))); changes.append(card); }
    if (!events.length) walletEmptyDetail(changes, '尚无可展示的变化记录。后续入组与退出会保留历史。'); fragment.append(changes);
    const full = el('button', 'association-evidence-button profile-full-history', '查看完整采样档案'); full.type = 'button'; full.addEventListener('click', () => openWallet(profile, full)); fragment.append(full); $('detail-content').replaceChildren(fragment);
  }
  function renderWalletRankingNote() {
    const associations = state.walletSort === 'associations', profiles = state.walletSort === 'profiles'; $('association-table').hidden = !associations; $('wallet-history-table').hidden = associations || profiles; $('association-status-note').hidden = !associations; $('wallet-profile-list').hidden = !profiles; $('wallet-profile-status').hidden = !profiles; $('wallet-group-filter').hidden = !profiles;
    $('wallet-search').placeholder = profiles ? '搜索钱包地址…' : associations ? '搜索公开钱包或候选钱包地址…' : '搜索钱包地址、名称或标签…'; renderAssociationStatus(); if (profiles) renderWalletProfileStatus();
    text('wallet-ranking-note', {
      profiles: '先看“行为判别”中的逐对比较，再看历史分组。同一钱包可跟随 A、早于 B；“历史重复提前”可合并不同对象的次数，不代表对同一钱包持续领先。分组可重叠，资金同源或时序相近均不证明共同控制。',
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
    renderWalletScreeningStatus();
  }
  function renderWalletScreeningStatus() {
    let node = $('wallet-screening-status');
    if (!node) { node = el('p', 'wallet-screening-status'); node.id = 'wallet-screening-status'; node.setAttribute('role', 'status'); $('profile-role-progress').after(node); }
    const data = state.walletStatus?.screening, failed = Boolean(state.resourceErrors.walletStatus);
    const label = failed ? '状态暂不可用 · 以下为上次记录' : !data ? '等待运行状态' : data.enabled === false ? '未启用' : data.error ? '观察异常' : data.running ? '持续观察中' : '观察任务未运行';
    const counts = data && data.enabled !== false ? ` · 已登记 ${count(data.records)} · 待观察 ${count(data.pending)} · 支持已撤回 ${count(data.withdrawn)} · 存储 ${bytes(data.bytes)} / ${bytes(data.maxBytes)}` : '';
    node.textContent = `持续机会账本：${label}${counts}`;
    node.classList.toggle('attention', failed || Boolean(data?.error) || data?.capacityReached === true || data?.enabled === true && data?.running === false);
    if (data?.capacityReached) node.append(el('strong', '', '容量已达上限，已停止登记新机会；已有记录保留。'));
    else if (data?.error) node.append(el('strong', '', '后续观察可能未更新，请检查运行状态。'));
  }
  function walletLabel(label) { return {smart: '聪明钱标签', kol: 'KOL 标签', bundler: '捆绑标签', rat_trader: '老鼠仓标签', developer: '开发者标签', exchange_or_pool: '交易所 / 池子'}[label] || scalar(label); }
  function walletMoney(value) { const n = numeric(value); return el('span', `gain ${n === undefined ? 'missing' : n >= 0 ? 'positive' : 'negative'}`, usd(value)); }
  function openWallet(wallet, trigger) { return openDetail(`wallet:${wallet.chain}:${wallet.address}`, trigger, {chain: wallet.chain, address: wallet.address}); }
  function renderWalletList() {
    if (state.walletSort === 'profiles') { renderWalletProfileList(); return; }
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
    if (data.behaviorProfile) fragment.append(walletRoleSection(data.behaviorProfile), profileEvidenceSection(data.behaviorProfile));
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

  document.addEventListener('visibilitychange', () => { syncDebotRiskPolling(); if (!document.hidden && state.authenticated) void refresh(); });
  window.addEventListener('online', () => { syncDebotRiskPolling(); if (state.authenticated) void refresh(); });
  window.addEventListener('pagehide', () => stopDebotRiskPolling());
  window.addEventListener('pageshow', syncDebotRiskPolling);
  void boot();
})();
