import {readFileSync} from 'node:fs';
import {Chain} from '../src/types.js';
import {normalizeDebotStory} from '../src/providers/debot-story.js';

// Parse a captured response without making up a signal time or calling external services.
try {
  const [path,chain,address,sourceUrl,...extra]=process.argv.slice(2);
  if(!path||!chain||!address||!sourceUrl||extra.length) throw new Error('Usage: npm run inspect-debot -- response.json <bsc|solana|robinhood> <full-CA> <DeBot-page-URL>');
  const text=readFileSync(path,'utf8');if(Buffer.byteLength(text)>65536) throw new Error('INPUT_TOO_LARGE');
  const snapshot=normalizeDebotStory(JSON.parse(text),{chain:Chain.parse(chain),address},sourceUrl);
  console.log(JSON.stringify({kind:'vendor_snapshot_inspection',submittedAsSignal:false,snapshot},null,2));
} catch(e) {console.error(e instanceof Error?e.message:'Cannot parse response');process.exitCode=1;}
