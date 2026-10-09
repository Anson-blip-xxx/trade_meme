# 0.2.0 接口依据与边界

2026-10-08 核验。区分官方文档/源码、用户提供样本和网页接口实际观察。本项目直接实现受限客户端，不要求安装 GMGN CLI；没有通过执行官方 Skill 或 CLI 提交交易，也不会在运行中抓网页来自动修改发行白名单。

## GMGN：扫描、研究与开单

| 一手来源 | 实现依据 |
| --- | --- |
| [Agent API](https://docs.gmgn.ai/index/gmgn-agent-api) | 官方接入入口。具体路由、鉴权、响应以当前官方源码及字段文档核对 |
| [OpenApiClient.ts](https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts) | `https://openapi.gmgn.ai`；普通查询使用 `X-APIKEY` 与 timestamp/client_id，交易及订单状态使用请求签名 |
| [signer.ts](https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/signer.ts) | Ed25519 或 RSA-PSS/SHA256 签名；路径、排序后的 query、原始 body 和 timestamp 共同构成消息。PEM 为 API 请求签名密钥，不是交易钱包助记词 |
| [链校验](https://github.com/GMGNAI/gmgn-skills/blob/main/src/validate.ts) | 包含 `sol/bsc/robinhood`。本项目 `solana` 映射为 `sol`；接口接受链名不证明具体资产可成交 |
| [gmgn-track](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-track/SKILL.md) | KOL/聪明钱为平台公开标签钱包交易，和用户个人关注列表不同；`base_address` 是目标币，`timestamp` 是交易时间，`price_change` 为事后表现 |
| [gmgn-token](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md) | token info/security/pool、持币者及标签字段；代币描述不是 AI 叙事，平台发行标签不是链上来源证明 |
| [gmgn-portfolio](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md) | 钱包统计、活动、分页；历史累计金额/收益与当前持仓、近期流入应分别处理 |
| [gmgn-swap](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-swap/SKILL.md) | 报价字段、原子单位、滑点、swap 和订单查询；单纯返回 hash/order_id 不等于成交，成交实际金额和状态需单独核对 |

当前实际使用的核心路由：

| 方法/路径 | 用途 |
| --- | --- |
| `GET /v1/user/kol`、`GET /v1/user/smartmoney` | 单页轮询，客户端本地筛 buy；不发送服务器未支持的 side 过滤 |
| `GET /v1/token/info`、`GET /v1/token/security`、`GET /v1/token/pool_info` | 供应商资产与安全素材 |
| `GET /v1/market/token_top_holders` | 普通持币者和 smart_degen 样本 |
| `GET /v1/user/wallet_stats`、`GET /v1/user/wallet_activity` | 有限钱包统计及单币活动页 |
| `GET /v1/trade/quote` | API Key 只读报价，paper 不提交交易 |
| `POST /v1/trade/swap` | 仅显式 live 配置、内部候选规则及签名通过后提交 |
| `GET /v1/trade/query_order` | 签名查询已有订单，不自动重发不明结果的 swap |

普通请求、报价、开单与查询共享排队/冷却；429 使用 reset 信息或保守等待，错误不透传 Key/上游全文。正式入口要求个人 Key，拒绝官方公开演示 Key；公开 Key 只用于隔离的只读验证，不自动作为降级渠道。

本轮曾对 Umi 的 token info/security 做少量只读验证并取得成功响应；这不证明所有路由、钱包字段、资产或套餐权限可用。安全实测同时出现 bool、数字、字符串别名；实现识别已确认类型，矛盾/缺失不当作安全。GMGN 安全结果始终是补充，不能代替 GoPlus、原始 Mint 权限和扩展检查。

钱包部分另做了 4 次有限只读请求：普通持币者返回 20 条，smart_degen 返回 1 条但余额为 0、已卖完；该样本当前聪明钱包支持为 0。统计由顶层 `wallet_address` 对应目标，`common.wallet_address` 为空；活动页有 2 条 buy/sell、`next=''`，资金来源实际字段为 `native_transfer.from_address`。捕获响应离线重放可以解析，`qualifiedSmartWalletCount=0`；数据可解析不表示已经发现买入支持，单一样本不代表全链覆盖。

钱包标签、名字、共同资金来源属于供应商或维护者材料，不能证明真人身份/同一所有者。活动只取一页，保留分页和窗口覆盖；未覆盖近期窗口时不把累计买入冒充近期净流入。分组数量不证明组间独立。

报价/签名/状态转换已做模拟测试，**尚未使用个人真实账户完成报价和实盘成交联调**。自动状态查询覆盖有供应商订单 ID 的待确认订单、已确认但成交金额缺失的订单及退出策略；无 ID 的不明提交不重发。

2026-10-09 更新：已接入用户指定的三档 `condition_orders`，`hold_amount` 按剩余持仓计算，退出记录独立于买单证明；详情见 [README](../README.md#已配置的止盈止损)。本地签名文件成功通过三链策略列表只读认证，真实 BSC quote 两次（第二次在冷却结束且空闲后）仍返回 `429 RATE_LIMIT_EXCEEDED`，未发送交易。此后停止报价重试；没有把账户查询成功当作报价或成交通过。

依据固定官方版本 [参数和 best-effort 说明](https://github.com/GMGNAI/gmgn-skills/blob/4575ef539e6a3115fa0481d41285cb79e77970bf/skills/gmgn-swap/SKILL.md#L201-L278)、[策略查询字段](https://github.com/GMGNAI/gmgn-skills/blob/4575ef539e6a3115fa0481d41285cb79e77970bf/skills/gmgn-swap/SKILL.md#L632-L756)及 [费用单位转换源码](https://github.com/GMGNAI/gmgn-skills/blob/4575ef539e6a3115fa0481d41285cb79e77970bf/src/commands/swap.ts#L56-L72)：买单只在显式附条件时返回可能的 `strategy_order_id`，创建失败不影响买单结果。没有公开的网页预设读取/绑定参数；不假设自动继承。BSC gas API 单位为 wei，SOL priority/tip 为 SOL。Robinhood 列为条件单支持链，但费用规则和真实执行仍需联调。

策略查询父单有 `open/closed`、`running/stopped`；文档只列子单 `cancel/success/failed`，没有待触发枚举。解析器将未知子状态保留未知，不猜数值，也不把 `token_balance` 等未明示单位的字段当原子余额。只有精确策略终止与随后 RPC 零余额共同成立才关闭本地持仓占用。当前主动开仓保护因此保守：附挂活跃状态尚待真实样本验证，未知时不继续增加持仓。

## DeBot 叙事与推送

| 来源 | 依据与限制 |
| --- | --- |
| [官方 AI 信号说明](https://docs.debot.ai/basic-features/ai-xin-hao-ban-kuai) | 账号、CA、相关推文及后续叙事更新；金银铜狗和告警后最大涨幅是事后指标，未给当前 v2 score 的满分/等级映射 |
| [官方合作中心](https://docs.debot.ai/debot-he-zuo-zhong-xin) | API/Webhook 合作入口；本项目没有完成 DeBot 原生 App/网页推送订阅或供应商验签 |
| [Umi 页面](https://debot.ai/token/bsc/248286_0xc24f42b1e458251e3a128b74c65c4c7fa0c97777) | 用户提供的币种页面，核对链与完整 CA |
| [用户响应样本](../fixtures/debot-story-v2.example.json) | `code=0/success=true/data.version=v2`；中文 13 节、38 个来源 ID。只删英文、日文翻译，其余未改写 |

用户提供的 **observed/private web endpoint（观察到的网页接口）**：

```http
GET https://debot.ai/api/v1/nitter/story/latest?request_id=<UUID>&ca_address=<完整CA>
```

本环境曾匿名、无 Cookie 实测 HTTP 200 成功响应，只证明当时该样本可读，不证明公开稳定协议或长期免认证。自动客户端仅用于 BSC/Solana；Robinhood 链覆盖未确认。字段变更、限流、认证或请求失败回未知，不登录绕过。

响应 `history.ca_address`、`story.contract_address` 校验目标，中文 story 保留为供应商材料。`generated_at=2026-10-08T06:31:41.032Z` 是样本的叙事版本时间，不能替代原告警时间。完整 source_tweets 在临时材料中保留，仅抽取有限引用实际读取。

`rating.score/reason` 只展示参考，分数 2 或“不建议关注”不单独拒绝，高分也不直接通过。不猜满分、不设评分阈值。结构化起源、时间、CA、引用及作者覆盖通过只证明材料关联，不证明预测正确；未来收益只能复盘。

GMGN 的 [narrative Skill](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-narrative/SKILL.md) 和其 [接口依赖](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-narrative/references/interfaces.md) 是让执行 Agent 另行检索与生成叙事，没有确认公开读取成品 AI 叙事的接口。本项目未用代币 description 或 [Callout 用户原文](https://docs.gmgn.ai/index/gmgn-callout-openapi) 冒充 GMGN AI 分析；默认使用 DeBot 结构化材料，不需自己的模型。

## 主网身份与发行来源

| 官方依据 | 核对内容 |
| --- | --- |
| [BNB 主网配置](https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/)、[JSON-RPC 方法限制](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/) | chain ID 56；官方 dataseed 禁用 `eth_getLogs`，不能用于创建日志查找 |
| [bloXroute Protect RPC](https://docs.bloxroute.com/core-solutions/rpc-service/protect-rpc) | BSC 模板 `https://bsc.rpc.blxrbdn.com`；2026-10-08 实测近期创建日志、完整回执及代码核验通过，并用 BNB 官方节点交叉核对回执、规范区块和代码哈希 |
| [Solana 集群](https://solana.com/docs/references/clusters)、[getGenesisHash](https://solana.com/docs/rpc/http/getgenesishash) | 模板 `https://api.mainnet.solana.com`，比较完整主网 genesis hash |
| [Solana CAIP-2 规范](https://namespaces.chainagnostic.org/solana/caip2) / [原文](https://github.com/ChainAgnostic/namespaces/blob/main/solana/caip2.md) | 完整 hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`；CAIP-2 前32字符标识不能替代 RPC 完整返回值 |
| [Robinhood 连接文档](https://docs.robinhood.com/chain/connecting/) | 主网 chain ID 4663，模板 `https://rpc.mainnet.chain.robinhood.com` |
| [Pump 程序说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)、[IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json) | 官方程序、Mint 派生 bonding-curve 状态及已实现布局 |
| [Raydium Bonk 示例](https://github.com/raydium-io/raydium-sdk-V2-demo/blob/master/src/launchpad/createBonkMintApi.ts)、[布局](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/launchpad/layout.ts)、[PDA](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/launchpad/pda.ts) | LaunchLab 程序之外还需 Bonk 独立 platform config、目标 Mint 与报价资产对应 |
| [Four 创建流程](https://github.com/four-meme-community/fourmeme-docs/blob/main/docs/create-guide.md) | 官方 TokenCreate emitter 与完整目标地址 |
| [Flap 部署地址](https://docs.flap.sh/flap/developers/deployed-contract-addresses) | 分链部署；Robinhood 主网 Portal 为 `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09`，BSC 为另一地址，不能跨链复用 |
| [Flap 创建事件](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/index-token-created-events)、[版本说明](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/token-version-specification) | TokenCreated 与同交易可选版本/扩展/税事件共同读取；来源与模式支持分开 |
| [Etherscan 创建交易](https://docs.etherscan.io/api-reference/endpoint/getcontractcreation) | 可选 BSC 查找路径，之后仍核验 RPC receipt/规范区块 |

本环境三链主网身份只读探测曾成功；公共 RPC 有限流，不保证历史区块、全部方法和生产可靠性。GMGN 创建时间只是定位区块的提示；查找先从最新区块向前扩大范围，再在范围内二分，最多读取40个定位区块，并限制日志窗口。近期代币不需要远古区块数据；需要但不可用的区块仍保持未知。找到日志也必须重新核对完整 receipt、确认数、规范区块、code，不把供应商平台标签当证明。

Flap 的版本枚举以专门版本说明为依据：0/1 legacy、2 permit、3 GoPlus、4/5/6 三代税币、7 新非税 V3。当前仅适配0/1/2且无扩展/非零税的模式。[Tax Token V3 文档](https://docs.flap.sh/flap/developers/basic-and-mechanism/flap-tax-token/tax-token-v3)说明非对称买卖税；其 newTokenV6 表的部分旧枚举数字与版本说明不一致，因此不据该表扩大白名单。实际税/扩展及畸形模式事件不会降成缺省 legacy 放行。税币官方来源可通过，但模式仍未知/未支持。

## 安全与原帖

- GoPlus [EVM 字段](https://docs.gopluslabs.io/reference/response-details)、[Solana 字段](https://docs.gopluslabs.io/reference/response-detail-1)、[支持 DEX](https://docs.gopluslabs.io/reference/supported-dex)：缺字段不算无风险；官方来源不能覆盖权限、代理、扩展或卖出能力缺项。
- X [帖子读取](https://docs.x.com/x-api/posts/lookup/introduction)、[近期搜索](https://docs.x.com/x-api/posts/recent-search)：需账户凭证和相应权限。
- FxEmbed [介绍/限流](https://docs.fxembed.com/api/introduction/)、[读取](https://docs.fxembed.com/api/twitter/operations/2statusid/)、[搜索](https://docs.fxembed.com/api/twitter/operations/2search/)、[OpenAPI](https://api.fxtwitter.com/2/openapi.json)：本环境少量无 Key 读帖和 CA 搜索曾成功，仍为第三方副本。
- TwitterAPI.io [鉴权](https://docs.twitterapi.io/authentication)、[读取](https://docs.twitterapi.io/api-reference/endpoint/get_tweet_by_ids)、[搜索](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)：适配经模拟测试，未做真实付费账户联调，不自动购买或切换。

来源列表、转载副本、相同资金来源均不是独立性证明。当前没有完整社交传播统计、独立连续买卖模拟、程序升级监控或完整持仓生命周期。

## 本地状态的依据

[运行时](../src/runtime.ts)仅以有 TTL/容量清理的内存库保存研究，CLI 单次研究退出即清空；report/retry 读取运行服务的缓存。[订单账本](../src/orders.ts)永久保存开单明细和有限入场摘要，不保存供应商全文/原始研究。正常运行要求磁盘订单路径；旧 data 文件不自动删除。

[开单控制器](../src/entry.ts)与[状态查询器](../src/reconcile.ts)保留发送不明状态，定期只读补全买单与退出策略。confirmed 在退出状态未经核实关闭前占用名额；paper_open 始终占用。测试通过只验证实现规则，不能代替真实账户和各链的报价、成交、条件单执行联调。
