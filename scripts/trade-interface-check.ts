import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import bs58 from 'bs58';
import {readConfig} from '../src/config.js';
import {readNativeBalance, NATIVE_INPUT_TOKENS} from '../src/native-balance.js';
import {readOnlyGmgnFetch, inspectTestQuote, safeProbeError} from '../src/trade-interface-check.js';

// This command has no trade execution mode. The SDK transport is GET-only.
const args = process.argv.slice(2);
if (args.some(arg => !['--notify', '--negative-only'].includes(arg) && !arg.startsWith('--negative-ca='))) throw new Error('PROBE_ARGUMENT_INVALID');
const negative = args.find(arg => arg.startsWith('--negative-ca='))?.split('=')[1];
if (negative && bs58.decode(negative).length !== 32) throw new Error('PROBE_CA_INVALID');
if (args.includes('--negative-only') && !negative) throw new Error('PROBE_CA_REQUIRED');
const config = readConfig(), wallet = config.entryWallets.solana;
if (!config.gmgnApiKey || !config.gmgnPrivateKey || !wallet) throw new Error('PROBE_CONFIG_MISSING');
if (config.entryMode !== 'off') throw new Error('PROBE_REQUIRES_ENTRY_OFF');
const runId = randomUUID(), directory = resolve('data/interface-checks', runId);
mkdirSync(directory, {recursive: true, mode: 0o700});
const report: Record<string, unknown> = {runId, mode: 'read_only', startedAt: new Date().toISOString(), chain: 'solana',
  wallet, submittedOrders: 0, createCancelAndTriggerVerified: false, entryMode: config.entryMode,
  quoteInputLamports: '1000000', negativeCandidate: negative,
  intendedConditions: [{order_type: 'profit_stop', side: 'sell', price_scale: '100', sell_ratio: '50'},
    {order_type: 'loss_stop', side: 'sell', price_scale: '60', sell_ratio: '100'}],
  conditionsScope: 'interface_fixture_only_not_active_policy'};
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
save();
// Explicit project credentials: the CLI's global profile must never override this account.
const sdkPath = join(execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim(), 'gmgn-cli/dist/client/OpenApiClient.js');
process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS = '0';
delete process.env.GMGN_DEBUG;
const {OpenApiClient} = await import(pathToFileURL(sdkPath).href);
const originalFetch = globalThis.fetch;
globalThis.fetch = readOnlyGmgnFetch(originalFetch);
const client = new OpenApiClient({apiKey: config.gmgnApiKey, privateKeyPem: config.gmgnPrivateKey, host: 'https://openapi.gmgn.ai'});
let rateLimited = false;
async function probe(name: string, action: () => Promise<unknown>, summarize: (data: any) => unknown = data => data) {
  if (rateLimited) {report[name] = {status: 'skipped', reason: 'PROBE_RATE_LIMIT_COOLDOWN'}; save(); return;}
  try {const result = summarize(await action()); report[name] = {status: 'ok', checkedAt: new Date().toISOString(), result};}
  catch (error) {
    const safe = safeProbeError(error); report[name] = {...safe, checkedAt: new Date().toISOString()};
    rateLimited = safe.httpStatus === 429 || safe.apiCode === 429 || safe.apiError?.includes('RATE_LIMIT') === true;
  }
  save();
  // This is a one-shot diagnostic, not another background polling loop.
  await new Promise(resolve => setTimeout(resolve, 3500));
}
try {
  report.nativeBalance = await readNativeBalance('solana', wallet, config, originalFetch); save();
  if (!args.includes('--negative-only')) {
  await probe('account', () => client.getUserInfo(), data => ({returnedAccountData: !!data,
    responseFields: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : []}));
  await probe('holdings', () => client.getWalletHoldings('sol', wallet, {limit: '20'}), data => ({
    returnedHoldingsData: !!data, responseFields: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : []}));
  }
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const quote = (target: string) => probe(target === usdc ? 'liquidQuote' : 'negativeCandidateQuote',
    () => client.quoteOrder('sol', wallet, NATIVE_INPUT_TOKENS.solana, target, '1000000', '1'),
    data => inspectTestQuote(data, {input: NATIVE_INPUT_TOKENS.solana, output: target, amount: '1000000', slippage: 1}));
  if (!args.includes('--negative-only')) await quote(usdc);
  if (negative) {
    await probe('negativeCandidateInfo', () => client.getTokenInfo('sol', negative), data => {
      return {address: data?.address, name: typeof data?.name === 'string' ? data.name.slice(0, 80) : undefined,
        symbol: typeof data?.symbol === 'string' ? data.symbol.slice(0, 30) : undefined,
        liquidity: data?.liquidity, indicativePrice: data?.price?.price,
        poolLiquidity: data?.pool?.liquidity, scope: 'vendor_snapshot_not_proof_of_no_route'};
    });
    await quote(negative);
  }
  if (!args.includes('--negative-only')) await probe('openStrategies', () => client.getStrategyOrders('sol', {from_address: wallet, group_tag: 'STMix', type: 'open', limit: '20'}),
    data => ({schemaValid: Array.isArray(data?.list), countOnPage: Array.isArray(data?.list) ? data.list.length : undefined,
      hasMore: typeof data?.next_page_token === 'string' && !!data.next_page_token,
      scope: 'query_authentication_only_not_creation_or_trigger_test'}));
} finally {globalThis.fetch = originalFetch; report.completedAt = new Date().toISOString(); save();}

if (args.includes('--notify')) {
  if (!config.telegram?.enabled) throw new Error('PROBE_TELEGRAM_NOT_ENABLED');
  const key = `interface-check:${runId}:result`;
  const brief = (name: string): string => {
    const row = report[name] as any;
    if (!row) return '未检查';
    if (row.status === 'error') return `失败（${row.apiError ?? row.reason}，HTTP ${row.httpStatus ?? '未知'}）`;
    if (row.status === 'skipped') return '限流冷却，跳过';
    if (row.result?.status === 'available') return '报价参数有效，尚未验证成交';
    if (row.result?.status === 'invalid') return '返回报价无效';
    return row.status === 'ok' ? '读取成功' : row.status;
  };
  const candidateInfo = (report.negativeCandidateInfo as any)?.result;
  const lines = ['【接口检查：只读，未发生买卖】', '链：Solana', `检查编号：${runId}`,
    ...(!args.includes('--negative-only') ? [`账号：${brief('account')}`, `签名持仓查询：${brief('holdings')}`,
      `0.001 SOL → USDC：${brief('liquidQuote')}`, `签名策略查询：${brief('openStrategies')}`] : []),
    ...(negative ? [`负例候选：${candidateInfo?.name ?? '未知名称'}`, `CA：${negative}`,
      `供应商报告流动性：${candidateInfo?.liquidity ?? '未知'}`, `候选报价：${brief('negativeCandidateQuote')}`,
      '显示零流动性不等于没有交易路由；报价成功不等于成交。'] : []),
    '止盈止损创建、撤销及实际触发成交：尚未实盘验证。', '自动开仓仍关闭；本次交易资金支出 0。'];
  const db = new DatabaseSync(config.telegram.database);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('INSERT OR IGNORE INTO trade_notification_events(event_key,text,queued,created_at) VALUES(?,?,0,?)')
      .run(key, lines.join('\n').slice(0, 4000), Date.now());
  } finally {db.close();}
  report.telegramEventKey = key; save();
}
chmodSync(join(directory, 'report.json'), 0o600);
console.log(JSON.stringify({reportPath: join(directory, 'report.json'), ...report}, null, 2));
