/** Public, deterministic SDK fixtures for offline capacity measurements only.
 * No keypairs, network access, signing, execution, or live wallet data are used.
 * Run consumers with `node --import tsx` to load the production TypeScript adapter.
 */
import {createHash} from 'node:crypto';
import BN from 'bn.js';
import {Connection,PublicKey} from '@solana/web3.js';
import {MintLayout,AccountLayout,TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {getPumpProgram,PUMP_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,PUMP_FEE_CONFIG_PDA,GLOBAL_PDA,bondingCurvePda} from '@pump-fun/pump-sdk';
import {getPumpAmmProgram,PUMP_AMM_PROGRAM_ID,PUMP_AMM_FEE_CONFIG_PDA,GLOBAL_CONFIG_PDA,canonicalPumpPoolPda,pumpPoolAuthorityPda} from '@pump-fun/pump-swap-sdk';
import {PumpNativeAdapter} from '../../src/native-solana/pump.ts';

const publicKey=label=>new PublicKey(createHash('sha256').update(`native-capacity-public-fixture:${label}`).digest());
// Anchor only uses this object to construct a coder. Its transport throws if invoked.
const disconnected=new Connection('https://example.invalid',{fetch:async()=>{throw Error('FIXTURE_NETWORK_FORBIDDEN');}});
const pumpProgram=getPumpProgram(disconnected),ammProgram=getPumpAmmProgram(disconnected);
const account=(data,owner)=>({data,owner,lamports:1_000_000_000,executable:false,rentEpoch:0});
function defaults(program,name){
  const fields=program.idl.types.find(entry=>entry.name===name).type.fields;
  const value=type=>{
    if(type==='pubkey')return PublicKey.default;
    if(type==='bool')return false;
    if(['u8','u16','u32','i8','i16','i32'].includes(type))return 0;
    if(typeof type==='string'&&/^[ui]\d+$/.test(type))return new BN(0);
    if(type.array)return Array.from({length:type.array[1]},()=>value(type.array[0]));
    if(type.vec)return [];
    if(type.defined)return defaults(program,type.defined.name);
    throw Error('Unsupported fixture IDL field');
  };
  return Object.fromEntries(fields.map(field=>[field.name,value(field.type)]));
}
function encoded(program,name,data,minimumSize=0){
  const layout=program.coder.accounts.accountLayouts.get(name),body=Buffer.alloc(16_384);
  const length=layout.layout.encode(data,body),raw=Buffer.concat([Buffer.from(layout.discriminator),body.subarray(0,length)]);
  return raw.length>=minimumSize?raw:Buffer.concat([raw,Buffer.alloc(minimumSize-raw.length)]);
}
function mintAccount(){
  const data=Buffer.alloc(82);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1_000_000_000_000_000n,
    decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  return account(data,TOKEN_PROGRAM_ID);
}
function tokenAccount(authority,amount,mint){
  const data=Buffer.alloc(165);
  AccountLayout.encode({mint,owner:authority,amount,delegateOption:0,delegate:PublicKey.default,state:1,
    isNativeOption:mint.equals(NATIVE_MINT)?1:0,isNative:mint.equals(NATIVE_MINT)?2_039_280n:0n,
    delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return account(data,TOKEN_PROGRAM_ID);
}

export async function createMarket(count){
  if(!Number.isSafeInteger(count)||count<1||count>1000)throw Error('FIXTURE_COUNT_INVALID');
  const wallet=publicKey('wallet'),creator=publicKey('creator'),feeRecipient=publicKey('fee-recipient'),buybackRecipient=publicKey('buyback-recipient');
  const map=new Map();let reads=0;
  const global={...defaults(pumpProgram,'global'),initialized:true,feeRecipient,feeRecipients:Array(7).fill(feeRecipient),
    buybackFeeRecipients:Array(8).fill(buybackRecipient),creatorFeeBasisPoints:new BN(50),feeBasisPoints:new BN(100),poolMigrationFee:new BN(15_000_001)};
  const fees={lpFeeBps:new BN(20),protocolFeeBps:new BN(100),creatorFeeBps:new BN(50)};
  const feeConfig={...defaults(pumpProgram,'feeConfig'),flatFees:fees,feeTiers:[{marketCapLamportsThreshold:new BN(0),fees}]};
  const ammGlobal={...defaults(ammProgram,'globalConfig'),protocolFeeRecipients:Array(8).fill(feeRecipient),
    buybackFeeRecipients:Array(8).fill(buybackRecipient),lpFeeBasisPoints:new BN(20),protocolFeeBasisPoints:new BN(100),coinCreatorFeeBasisPoints:new BN(50)};
  map.set(GLOBAL_PDA.toBase58(),account(encoded(pumpProgram,'global',global),PUMP_PROGRAM_ID));
  map.set(PUMP_FEE_CONFIG_PDA.toBase58(),account(encoded(pumpProgram,'feeConfig',feeConfig,4097),PUMP_FEE_PROGRAM_ID));
  map.set(GLOBAL_CONFIG_PDA.toBase58(),account(encoded(ammProgram,'globalConfig',ammGlobal),PUMP_AMM_PROGRAM_ID));
  map.set(PUMP_AMM_FEE_CONFIG_PDA.toBase58(),account(encoded(ammProgram,'feeConfig',feeConfig,4097),PUMP_FEE_PROGRAM_ID));
  const connection={async getMultipleAccountsInfoAndContext(keys,config){
    reads++;if(config.minContextSlot!==undefined&&config.minContextSlot>100)throw Error('FIXTURE_UNEXPECTED_WARM_SLOT');
    return {context:{slot:100},value:keys.map(key=>map.get(key.toBase58())??null)};
  },async getTokenAccountsByOwner(){throw Error('FIXTURE_OWNER_LOOKUP_FORBIDDEN');}};
  const adapter=new PumpNativeAdapter({connection}),tokens=[];
  for(let index=0;index<count;index++){
    const mint=publicKey(`mint-${index}`),venue=index%3===0?'pump':'pumpswap';
    const curveKey=bondingCurvePda(mint),poolKey=canonicalPumpPoolPda(mint,NATIVE_MINT);
    const userAta=getAssociatedTokenAddressSync(mint,wallet,true,TOKEN_PROGRAM_ID);
    const curveVault=getAssociatedTokenAddressSync(mint,curveKey,true,TOKEN_PROGRAM_ID);
    const poolBase=getAssociatedTokenAddressSync(mint,poolKey,true,TOKEN_PROGRAM_ID),poolQuote=getAssociatedTokenAddressSync(NATIVE_MINT,poolKey,true);
    const curve={...defaults(pumpProgram,'bondingCurve'),virtualTokenReserves:new BN('1073000000000000'),
      virtualQuoteReserves:new BN('30000000000'),realTokenReserves:new BN('793100000000000'),
      realQuoteReserves:new BN('10000000000'),tokenTotalSupply:new BN('1000000000000000'),creator,
      complete:venue==='pumpswap',isCashbackCoin:false};
    const pool={...defaults(ammProgram,'pool'),index:0,creator:pumpPoolAuthorityPda(mint),baseMint:mint,quoteMint:NATIVE_MINT,
      poolBaseTokenAccount:poolBase,poolQuoteTokenAccount:poolQuote,coinCreator:creator,lpMint:publicKey(`lp-mint-${index}`),
      virtualQuoteReserves:new BN(0),isCashbackCoin:false};
    map.set(mint.toBase58(),mintAccount());
    map.set(curveKey.toBase58(),account(encoded(pumpProgram,'bondingCurve',curve),PUMP_PROGRAM_ID));
    map.set(curveVault.toBase58(),tokenAccount(curveKey,1_000_000_000_000_000n,mint));
    map.set(userAta.toBase58(),tokenAccount(wallet,100_000_000n,mint));
    map.set(poolKey.toBase58(),account(encoded(ammProgram,'pool',pool),PUMP_AMM_PROGRAM_ID));
    map.set(poolBase.toBase58(),tokenAccount(poolKey,100_000_000_000_000n,mint));
    map.set(poolQuote.toBase58(),tokenAccount(poolKey,50_000_000_000n,NATIVE_MINT));
    const warmed=await adapter.warmQuoteCache(wallet.toBase58(),mint.toBase58()),amount='100000000';
    const baseline=adapter.quoteSellCached({wallet:wallet.toBase58(),mint:mint.toBase58(),amount,slippageBps:100});
    tokens.push({mint:mint.toBase58(),venue,subscriptionAccounts:warmed.subscriptionAccounts,amount,baselineOutput:baseline.expectedOutputAmount,
      frames(round){
        if(!Number.isSafeInteger(round)||round<0)throw Error('FIXTURE_ROUND_INVALID');
        const slot=101+round,delta=BigInt((round+index)%11-5); // Bounded +/- 0.5% quote-reserve movement.
        if(venue==='pump'){
          const updated={...curve,virtualQuoteReserves:new BN((30_000_000_000n+delta*30_000_000n).toString())};
          return [{address:curveKey.toBase58(),info:account(encoded(pumpProgram,'bondingCurve',updated),PUMP_PROGRAM_ID),slot}];
        }
        return [
          {address:poolKey.toBase58(),info:account(encoded(ammProgram,'pool',pool),PUMP_AMM_PROGRAM_ID),slot},
          {address:poolBase.toBase58(),info:tokenAccount(poolKey,100_000_000_000_000n,mint),slot},
          {address:poolQuote.toBase58(),info:tokenAccount(poolKey,50_000_000_000n+delta*50_000_000n,NATIVE_MINT),slot},
        ];
      }});
  }
  return {adapter,wallet:wallet.toBase58(),tokens,mockReadCount:()=>reads};
}
