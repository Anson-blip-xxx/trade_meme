export interface LatestWorkQueueOptions<T> {
  capacity:number;
  batchSize:number;
  consume:(value:T)=>void;
  onError?:()=>void;
  schedule?:(run:()=>void)=>void;
}

export interface LatestWorkQueueStatus {
  pending:number;
  priorityPending:number;
  processed:number;
  replaced:number;
  dropped:number;
  priorityDropped:number;
  normalDropped:number;
  normalEvicted:number;
  errors:number;
}

/**
 * Bounded work queue for synchronous observers. Priority observations retain
 * FIFO order; ordinary observations retain only the latest value per key.
 *
 * Each scheduled turn processes only one small batch so websocket parsing and
 * signal callbacks regain the event loop between research-store writes.
 */
export class LatestWorkQueue<T> {
  // Priority values are financial-position observations. Preserve every frame
  // in arrival order so a short-lived peak or stop crossing cannot be erased by
  // a later frame for the same token before the next event-loop turn.
  private readonly priority:T[]=[];
  private readonly normal=new Map<string,T>();
  private readonly schedule:(run:()=>void)=>void;
  private scheduled=false;
  private closed=false;
  private processed=0;
  private replaced=0;
  private dropped=0;
  private priorityDropped=0;
  private normalDropped=0;
  private normalEvicted=0;
  private errors=0;

  constructor(private readonly options:LatestWorkQueueOptions<T>) {
    if(!Number.isSafeInteger(options.capacity)||options.capacity<1||
      !Number.isSafeInteger(options.batchSize)||options.batchSize<1||options.batchSize>options.capacity)
      throw new Error('LATEST_WORK_QUEUE_OPTIONS_INVALID');
    this.schedule=options.schedule??(run=>setImmediate(run));
  }

  enqueue(key:string,value:T,priority=false):boolean {
    if(this.closed||!key)return false;
    if(priority&&this.normal.has(key)) {
      this.normal.delete(key);
      this.replaced++;
    }else if(!priority&&this.normal.has(key)) {
      this.normal.delete(key);this.normal.set(key,value);
      this.replaced++;this.ensureScheduled();return true;
    }
    if(this.priority.length+this.normal.size>=this.options.capacity) {
      if(!priority){this.dropped++;this.normalDropped++;return false;}
      if(!this.normal.size){this.dropped++;this.priorityDropped++;return false;}
      const oldest=this.normal.keys().next().value;
      if(typeof oldest==='string')this.normal.delete(oldest);
      this.dropped++;this.normalDropped++;this.normalEvicted++;
    }
    if(priority)this.priority.push(value);else this.normal.set(key,value);
    this.ensureScheduled();return true;
  }

  status():LatestWorkQueueStatus {
    return {pending:this.priority.length+this.normal.size,priorityPending:this.priority.length,
      processed:this.processed,replaced:this.replaced,dropped:this.dropped,priorityDropped:this.priorityDropped,
      normalDropped:this.normalDropped,normalEvicted:this.normalEvicted,errors:this.errors};
  }

  close():void {
    this.closed=true;this.priority.length=0;this.normal.clear();
  }

  private ensureScheduled():void {
    if(this.scheduled||this.closed)return;
    this.scheduled=true;this.schedule(()=>this.drain());
  }

  private drain():void {
    this.scheduled=false;
    if(this.closed)return;
    for(let index=0;index<this.options.batchSize;index++) {
      const hasUrgent=this.priority.length>0;
      const urgent=hasUrgent?this.priority.shift():undefined;
      const ordinary=hasUrgent?undefined:this.normal.entries().next().value as [string,T]|undefined;
      if(!hasUrgent&&!ordinary)break;
      if(ordinary)this.normal.delete(ordinary[0]);
      const value=hasUrgent?urgent as T:ordinary![1];
      try {this.options.consume(value);}
      catch {this.errors++;try {this.options.onError?.();}catch {/* Error reporting must not strand queued work. */}}
      this.processed++;
    }
    if(this.priority.length||this.normal.size)this.ensureScheduled();
  }
}
