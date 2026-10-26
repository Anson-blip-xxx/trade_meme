import {dirname,resolve} from 'node:path';
import {readConfig} from '../src/config.js';
import {ControlledTestJournal} from '../src/controlled-test/journal.js';
import {GmgnTestClient} from '../src/controlled-test/gmgn.js';
import {ControlledSolanaReader} from '../src/controlled-test/solana.js';
import {ControlledTestNotifications} from '../src/controlled-test/notifications.js';
import {ControlledTradeRunner, newTestRun, TEST_AMOUNT, TEST_CONDITIONS, TEST_MAX_DEBIT, TEST_MINT} from '../src/controlled-test/runner.js';
import {OrderStore} from '../src/orders.js';
import {readControlledOpeningIdentities} from '../src/signal-counting.js';

process.umask(0o077);
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--execute', '--status'].includes(a) && !/^--resume=[0-9a-f-]{36}$/.test(a)))
    throw new Error('TEST_ARGUMENT_INVALID');
  if (!args.includes('--execute') && !args.includes('--status')) {
    console.log(JSON.stringify({mode: 'preview_no_network_no_trade', chain: 'solana', token: 'BONK', mint: TEST_MINT,
      amountSol: '0.01', amountLamports: TEST_AMOUNT, maxWalletDebitBudgetLamports: TEST_MAX_DEBIT,
      conditions: TEST_CONDITIONS, sellRatioType: 'hold_amount',
      flow: ['buy_with_attached_conditions', 'verify_finalized_buy', 'verify_attached_conditions', 'cancel_and_reconcile', 'sell_test_amount', 'verify_finalized_close', 'telegram'],
      executeCommand: 'npm run test-trade -- --execute',
      warning: '运行 --execute 会使用真实资金。它不会打开常规自动交易。测试核验挂单，不等待翻倍或止损价格真实触发。'}, null, 2)); return;
  }
  const config = readConfig();
  const journalPath=resolve(dirname(config.ordersDatabase),'controlled-trade-tests.sqlite');
  const orders=args.includes('--execute')?new OrderStore(config.ordersDatabase):undefined;
  const journal = new ControlledTestJournal(journalPath,{claimOpening:orders?identity=>orders.claimExternalAttempt(identity):undefined});
  try {
    if (args.includes('--status')) {console.log(JSON.stringify(journal.list(), null, 2)); return;}
    for(const identity of readControlledOpeningIdentities(journalPath))orders!.markPreviouslyOpened(identity);
    if (config.entryMode !== 'off') throw new Error('TEST_REQUIRES_ENTRY_OFF');
    if (!config.gmgnApiKey || !config.gmgnPrivateKey || !config.entryWallets.solana || !config.rpc.solana ||
        !config.telegram?.enabled || !config.telegram.token || !config.telegram.chatId) throw new Error('TEST_CONFIG_MISSING');
    // The running service owns Telegram delivery and must be off for autonomous entries too.
    const health = await fetch(`http://127.0.0.1:${config.port}/health`, {signal: AbortSignal.timeout(5000), redirect: 'error'});
    const status = await health.json();
    if (!health.ok || status.configuredEntryMode !== 'off' || status.executionEnabled !== false) throw new Error('TEST_SERVICE_NOT_READY');
    const resume = args.find(a => a.startsWith('--resume='))?.slice('--resume='.length);
    const run = resume ? journal.get(resume) : newTestRun(config.entryWallets.solana);
    if (!run || run.wallet !== config.entryWallets.solana || run.mint !== TEST_MINT || run.amountLamports !== TEST_AMOUNT)
      throw new Error('TEST_RUN_IDENTITY_MISMATCH');
    if (!resume) journal.create(run);
    console.log(JSON.stringify({runId: run.id, mode: 'operator_started_real_test', amountSol: '0.01', mint: run.mint,
      resumeCommand: `npm run test-trade -- --execute --resume=${run.id}`}, null, 2));
    const notifications = new ControlledTestNotifications(config.telegram.database);
    try {
      const runner = new ControlledTradeRunner({journal,
        client: new GmgnTestClient({apiKey: config.gmgnApiKey, privateKeyPem: config.gmgnPrivateKey}),
        chain: new ControlledSolanaReader(config.rpc.solana), notifier: notifications});
      const result = await runner.execute(run.id);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.phase === 'complete' && result.strategyMatched === true && !result.reasons.length ? 0 : 2;
    } finally {notifications.close();}
  } finally {journal.close();orders?.close();}
}
main().catch(error => {
  const code = error instanceof Error && /^(?:TEST_|CONTROLLED_JOURNAL_|GMGN_TEST_)[A-Z_]{1,100}$/.test(error.message)
    ? error.message : 'TEST_COMMAND_FAILED';
  console.error(JSON.stringify({error: code, advice: '不要新建测试重试；先用 npm run test-trade -- --status 查看本次状态。'}));
  process.exitCode = 2;
});
