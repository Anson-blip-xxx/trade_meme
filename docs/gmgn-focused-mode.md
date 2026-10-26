# GMGN 按需使用模式

设置 `GMGN_BACKGROUND_RESEARCH_ENABLED=false` 后，服务暂停 GMGN 全市场 KOL/聪明钱扫描、钱包观察器的远端扩展采集、Meme 观察器的 GMGN 行情补样、钱包候选自动触发的完整研究和 WATCH 定时重查。开关默认 `true`，兼容原有部署；重启后生效，不删除已有数据。

DeBot/Ave 的新通知仍然进入正常评估，所需的代币详情、安全和钱包持仓查询仍可使用 GMGN。GMGN 缺少凭证或处于冷却期时，这些来源继续采集和评估；缺少的安全证据保持未知，不能据此放行买入。重复信号继续遵守各来源已有的去重和再评估规则。

持仓查询、可执行报价、开平仓接口保持原有权限和保护要求。价格路由继续使用链上订阅、Ave、DeBot 和 Dexscreener；只对缺少有效价格的目标保留有预算的 GMGN 兜底。参考价格不能替代可执行报价，GMGN 限流时价格降级也不代表交易接口可用。

钱包数据积累继续：链上钱包消息的真买卖/转账分类和落库、DeBot/Ave 钱包提名、已有本地钱包画像、关联索引和榜单归因仍运行。WalletFast 暂停的仅是买入后自动触发完整 GMGN 研究，链上分类与持久化不受开关限制。本地画像筛选仍可参与新信号评估。

`/dashboard/api/overview` 的 `gmgnUsage` 会显示模式及暂停/保留任务；`scanner`、`walletResearch.observer`、`watchRecheck` 显示 `GMGN_BACKGROUND_RESEARCH_DISABLED` 原因。首页与运行状态显示“交易与按需查询”和“按配置暂停”，不会将有意暂停误报成扫描故障；实际限流或保存错误仍正常显示。链上状态中的 `walletFast.research.fullResearchEnabled=false` 说明完整研究暂停，并不表示链上买卖分类停止。

认证后的 `POST /v1/scanner/run` 在此模式下也返回 HTTP 409 / `GMGN_BACKGROUND_RESEARCH_DISABLED`，不请求 GMGN。`GET /v1/scanner` 可查看暂停原因。

该开关不修改 `ENTRY_MODE`、签名账号、钱包地址、金额或止盈止损参数，也不会授权新的实盘交易。
