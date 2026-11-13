import {readConfig} from '../src/config.js';
import {runStrategyEvolutionDaily} from '../src/strategy-evolution-daily.js';

const config=readConfig();
if(!config.meme)throw new Error('STRATEGY_EVOLUTION_MEME_ARCHIVE_UNAVAILABLE');
const result=runStrategyEvolutionDaily({archivePath:config.dashboard.archivePath,memeDatabase:config.meme.database,
  asOf:new Date().toISOString(),chains:config.scannerChains});
console.log(JSON.stringify(result));
