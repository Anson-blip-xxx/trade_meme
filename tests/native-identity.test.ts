import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {ExtensionType,type Mint} from '@solana/spl-token';
import {pack} from '@solana/spl-token-metadata';
import {nativeTokenIdentity,validNativeTokenIdentity} from '../src/native-solana/identity.js';

function mintWithMetadata(mint:ReturnType<typeof Keypair.generate>['publicKey'],name:string,symbol:string):Mint {
  const packed=Buffer.from(pack({mint,updateAuthority:undefined,name,symbol,uri:'https://example.invalid/meta.json',additionalMetadata:[]}));
  const tlvData=Buffer.alloc(4+packed.length);
  tlvData.writeUInt16LE(ExtensionType.TokenMetadata,0);tlvData.writeUInt16LE(packed.length,2);packed.copy(tlvData,4);
  return {tlvData} as Mint;
}

test('native identity is decoded from metadata bound to the exact Token-2022 mint',()=>{
  const address=Keypair.generate().publicKey;
  const identity=nativeTokenIdentity(address,mintWithMetadata(address,'ハッチャン','Hatchan'));
  assert.deepEqual(identity,{source:'token_2022_mint_extension',name:'ハッチャン',symbol:'Hatchan'});
  assert.equal(validNativeTokenIdentity(identity),true);
});

test('metadata for another mint cannot rename a native order',()=>{
  const address=Keypair.generate().publicKey,other=Keypair.generate().publicKey;
  assert.equal(nativeTokenIdentity(address,mintWithMetadata(other,'Forged','FAKE')),undefined);
});

test('display metadata removes controls and rejects reconstructed or oversized values',()=>{
  const address=Keypair.generate().publicKey;
  assert.deepEqual(nativeTokenIdentity(address,mintWithMetadata(address,'  名\u202e称\n  ','  SYM\0  ')),
    {source:'token_2022_mint_extension',name:'名 称',symbol:'SYM'});
  assert.equal(validNativeTokenIdentity({source:'token_2022_mint_extension',name:'x'.repeat(81)}),false);
  assert.equal(validNativeTokenIdentity({source:'token_2022_mint_extension',name:'ok',extra:'untrusted'}),false);
});
