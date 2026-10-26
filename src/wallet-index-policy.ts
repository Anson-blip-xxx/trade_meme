export function walletIndexNextDelay(intervalMs:number,input:{invalidationPending:number;processed:number;derivedPending?:boolean;livePriority?:boolean}):number {
  // Catch up durable graph invalidations without restoring the former 100ms
  // write loop. Live counting leaves ten seconds between bounded cycles;
  // idle production uses five seconds and shorter test cadences stay unchanged.
  if(input.invalidationPending>0||input.derivedPending)return Math.min(intervalMs,input.livePriority?10_000:5_000);
  return input.processed>0?intervalMs:Math.max(intervalMs,Math.min(60_000,intervalMs*6));
}
