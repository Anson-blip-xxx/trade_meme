import type {OrderStore} from './orders.js';
import type {EntryController} from './entry.js';

/** Poll accepted buys and their attached exits. No-ID submissions and missing exits are never resent. */
export class OrderReconciler {
  private active?:Promise<void>;
  private cursor=0;
  private stopped=false;
  constructor(private readonly orders:OrderStore,private readonly entry:Pick<EntryController,'reconcile'>) {}
  runOnce():Promise<void> {
    if(this.stopped) return Promise.resolve();
    if(this.active) return this.active;
    this.active=this.run().finally(()=>{this.active=undefined;});
    return this.active;
  }
  private async run():Promise<void> {
    const pending=this.orders.pending();
    if(!pending.length) {this.cursor=0;return;}
    const start=this.cursor%pending.length,count=Math.min(3,pending.length);
    this.cursor=(start+count)%pending.length;
    for(let index=0;index<count&&!this.stopped;index++) {
      // A failed status read says nothing about the trade. Retain its previous ledger state.
      try {await this.entry.reconcile(pending[(start+index)%pending.length].id);} catch { /* Retry GET on the next poll. */ }
    }
  }
  async stop():Promise<void> {this.stopped=true;await this.active;}
}
