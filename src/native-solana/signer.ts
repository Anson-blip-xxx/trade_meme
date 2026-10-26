import {openSync,closeSync,fstatSync,readFileSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
/** This key signs chain transactions; it is never the GMGN HTTP authentication key. */
export class NativeSigner {
  #key:Keypair;
  constructor(file:string,expectedWallet:string){
    let fd:number|undefined;
    try {
      if(!isAbsolute(file))throw Error();
      fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=fstatSync(fd);
      if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.size>4096||stat.size<64||
        typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error();
      const raw:unknown=JSON.parse(readFileSync(fd,'utf8'));
      if(!Array.isArray(raw)||raw.length!==64||raw.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error();
      const bytes=Uint8Array.from(raw);
      try {
        // web3.js retains the Uint8Array passed to fromSecretKey. Keep a private
        // owned copy inside Keypair before wiping the temporary file buffer;
        // otherwise later signatures are produced from zeroed secret bytes.
        this.#key=Keypair.fromSecretKey(Uint8Array.from(bytes));
      }finally{bytes.fill(0);raw.fill(0);}
      if(this.#key.publicKey.toBase58()!==new PublicKey(expectedWallet).toBase58())throw Error();
    }catch{throw Error('NATIVE_SIGNER_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
  }
  publicKey():PublicKey{return this.#key.publicKey;}
  sign(transaction:VersionedTransaction):void {
    if(transaction.message.header.numRequiredSignatures!==1||!transaction.message.staticAccountKeys[0].equals(this.#key.publicKey))
      throw Error('NATIVE_SIGNER_PAYER_MISMATCH');
    transaction.sign([this.#key]);
  }
}
