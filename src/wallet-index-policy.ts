export function walletIndexNextDelay(intervalMs:number,input:{invalidationPending:number;processed:number}):number {
  if(input.invalidationPending>0)return intervalMs;
  return input.processed>0?intervalMs:Math.max(intervalMs,Math.min(60_000,intervalMs*6));
}
