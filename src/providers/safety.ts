import type {Config} from '../config.js';
import {type Signal, type Check, unknown} from '../types.js';
import {jsonRequest, rpc, type Fetcher} from '../http.js';

const EVM_RISKS = ['is_honeypot','cannot_buy','cannot_sell_all','is_mintable','owner_change_balance',
  'hidden_owner','can_take_back_ownership','transfer_pausable','is_blacklisted','is_whitelisted','slippage_modifiable'] as const;
const SOL_RISKS = ['mintable','freezable','closable','transfer_fee_upgradable',
  'default_account_state_upgradable','balance_mutable_authority','transfer_hook_upgradable'] as const;
const flag=(v:unknown):boolean|undefined => v==='1'||v===1||v===true ? true : v==='0'||v===0||v===false ? false:undefined;
const rate=(v:unknown):number|undefined => (typeof v==='number'||typeof v==='string') && String(v).trim()!=='' && Number.isFinite(Number(v)) && Number(v)>=0 && Number(v)<=1 ? Number(v):undefined;

export function assessGoPlus(chain:Signal['token']['chain'], row:any, maxTaxRate:number):Check {
  if (!row || typeof row!=='object' || Array.isArray(row)) return unknown('SECURITY_REPORT_MISSING');
  const failures:string[]=[], missing:string[]=[];
  if(chain==='solana') {
    for(const key of SOL_RISKS) {
      const v=flag(row[key]?.status);
      if(v===true) failures.push(`SOL_${key.toUpperCase()}`);
      else if(v===undefined) missing.push(key);
    }
    if(String(row.default_account_state)==='2') failures.push('SOL_DEFAULT_FROZEN');
    if(flag(row.non_transferable)===true) failures.push('SOL_NON_TRANSFERABLE');
    if(row.transfer_hook?.program_id || flag(row.transfer_hook?.status)===true) missing.push('transfer_hook_review');
  } else {
    for(const key of EVM_RISKS) {
      const v=flag(row[key]);
      if(v===true) failures.push(`EVM_${key.toUpperCase()}`);
      else if(v===undefined) missing.push(key);
    }
    if(flag(row.is_open_source)!==true) missing.push('verified_source');
    if(flag(row.is_proxy)!==false) missing.push('proxy_implementation_review');
    for(const key of ['buy_tax','sell_tax']) {
      const v=rate(row[key]);
      if(v===undefined) missing.push(key);
      else if(v>maxTaxRate) failures.push(`EXCESSIVE_${key.toUpperCase()}`);
    }
    if(flag(row.fake_token)===true) failures.push('KNOWN_COUNTERFEIT');
    if(flag(row.b20_token?.is_b20)===true) missing.push('b20_mode_review');
  }
  return {status:failures.length?'fail':missing.length?'unknown':'pass',
    reasons:failures.length?failures:missing.length?['SECURITY_FIELDS_UNVERIFIED']:['NO_BLOCKING_PROVIDER_FLAGS'],
    checkedAt:new Date().toISOString(),facts:{provider:'goplus',missingFields:missing,report:row}};
}

export function assessSolanaMint(account:any,maxTaxRate:number):Check {
  const reasons:string[]=[], unsupported:string[]=[];
  const tokenPrograms=['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
  const info=account?.data?.parsed?.info;
  if(!account || !tokenPrograms.includes(account.owner) || account.data?.parsed?.type!=='mint' || !info)
    return unknown('SOL_MINT_UNVERIFIED');
  if(info.isInitialized!==true) reasons.push('SOL_MINT_NOT_INITIALIZED');
  if(!Object.hasOwn(info,'mintAuthority') || !Object.hasOwn(info,'freezeAuthority')) unsupported.push('authorities');
  if(info.mintAuthority) reasons.push('SOL_MINT_AUTHORITY_ACTIVE');
  if(info.freezeAuthority) reasons.push('SOL_FREEZE_AUTHORITY_ACTIVE');
  if(account.owner===tokenPrograms[1] && !Array.isArray(info.extensions)) unsupported.push('token2022_extensions');
  for(const ext of info.extensions??[]) {
    const type=ext.extension, state=ext.state??{};
    if(['metadataPointer','tokenMetadata'].includes(type)) continue;
    if(['permanentDelegate','nonTransferable','defaultAccountState','transferHook','mintCloseAuthority','pausableConfig'].includes(type)) {
      unsupported.push(type); continue;
    }
    if(type==='transferFeeConfig') {
      if(state.transferFeeConfigAuthority) reasons.push('SOL_MUTABLE_TRANSFER_FEE');
      for(const key of ['olderTransferFee','newerTransferFee']) {
        const bps=state[key]?.transferFeeBasisPoints;
        if(typeof bps!=='number') unsupported.push('transfer_fee');
        else if(bps/10000>maxTaxRate) reasons.push('SOL_EXCESSIVE_TRANSFER_FEE');
      }
      continue;
    }
    unsupported.push(String(type));
  }
  return {status:reasons.length?'fail':unsupported.length?'unknown':'pass',
    reasons:reasons.length?reasons:unsupported.length?['SOL_EXTENSIONS_REQUIRE_REVIEW']:['SOL_MINT_PERMISSIONS_CHECKED'],
    checkedAt:new Date().toISOString(),facts:{owner:account.owner,mint:info,unsupported}};
}

export async function checkSafety(signal:Signal,config:Config,fetcher:Fetcher=fetch):Promise<Check> {
  const path=signal.token.chain==='solana'?'solana/token_security':`token_security/${signal.token.chain==='bsc'?56:4663}`;
  let provider:Check;
  try {
    const response=await jsonRequest(`https://api.gopluslabs.io/api/v1/${path}?contract_addresses=${signal.token.address}`,
      {headers:config.goPlusToken?{authorization:`Bearer ${config.goPlusToken}`}:{ }},fetcher);
    if(Number(response.code)!==1) throw new Error('GOPLUS_ERROR');
    const row=response.result?.[signal.token.address]??(signal.token.chain!=='solana'?response.result?.[signal.token.address.toLowerCase()]:undefined);
    provider=assessGoPlus(signal.token.chain,row,config.maxTaxRate);
  } catch { provider=unknown('GOPLUS_UNAVAILABLE'); }
  if(signal.token.chain!=='solana') return provider;
  let onchain:Check;
  try {
    if(!config.rpc.solana) throw new Error('NO_RPC');
    const res=await rpc(config.rpc.solana,'getAccountInfo',[signal.token.address,{encoding:'jsonParsed',commitment:'finalized'}],fetcher);
    onchain=assessSolanaMint(res?.value,config.maxTaxRate);
  } catch { onchain=unknown('SOLANA_RPC_UNAVAILABLE'); }
  // Raw mint parsing is mandatory. Supplemental flags can veto, never override unknown on-chain data.
  const status=provider.status==='fail'||onchain.status==='fail'?'fail':onchain.status;
  return {status,reasons:[...onchain.reasons,...provider.reasons],checkedAt:new Date().toISOString(),
    facts:{onchain,provider,scope:'token_permissions_not_execution_simulation'}};
}
