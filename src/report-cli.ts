import {readConfig} from './config.js';
import {localRequest} from './local-api.js';

async function main() {
  const [id,...flags]=process.argv.slice(2);
  if(!id||!/^[0-9a-f-]{36}$/.test(id)||flags.some(f=>!['--history','--json'].includes(f)))
    throw new Error('Usage: npm run report -- <report-id> [--history|--json]; reports are held by the running service only');
  const history=flags.includes('--history'),json=flags.includes('--json');
  const response=await localRequest(readConfig(),`/v1/signals/${id}${history?'/history':json?'':'/report'}`);
  console.log(history||json?JSON.stringify(await response.json(),null,2):await response.text());
}
main().catch(error=>{console.error(error instanceof Error?error.message:'REPORT_UNAVAILABLE');process.exitCode=1;});
