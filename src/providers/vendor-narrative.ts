import {createHash} from 'node:crypto';
import {VendorNarrativeSchema,type Evidence,type NarrativeReport,type Signal} from '../types.js';
import type {Config} from '../config.js';
import {mentionsAddress,xPostId} from './evidence.js';

const CLOCK_SKEW_MS=30_000;

function referencePostIds(reference:string):string[] {
  const direct=xPostId(reference);
  if(direct) return [direct];
  return (reference.match(/https?:\/\/[^\s<>"'（）【】]+/g)??[])
    .map(url=>xPostId(url.replace(/[,.;!?，。；！？、:：)\]}]+$/g,'')))
    .filter((id):id is string=>!!id);
}

function acceptedEvidence(e:Evidence,now:Date,maxAgeSec:number):boolean {
  if(!e||typeof e.text!=='string'||!e.text.trim()||e.text.length>25_000||
    typeof e.authorId!=='string'||!/^\d{1,20}$/.test(e.authorId)) return false;
  const postId=xPostId(e.url);
  if(!postId||e.id!==`x:${postId}`) return false;
  const sourceAccepted=e.provider==='x_official'?e.verification==='first_party'
    :['fxembed','twitterapi_io'].includes(e.provider)&&e.verification==='third_party';
  const published=Date.parse(e.publishedAt),fetched=Date.parse(e.fetchedAt),current=now.getTime();
  return sourceAccepted&&Number.isFinite(published)&&Number.isFinite(fetched)&&
    published<=current+CLOCK_SKEW_MS&&fetched<=current+CLOCK_SKEW_MS&&
    published<=fetched+CLOCK_SKEW_MS&&current-published<=maxAgeSec*1000;
}

// This imports a platform narrative copy. It never authenticates the platform or calls a model.
// Text copies stay unknown. Structured material can pass source/CA mapping checks, but supplier
// ratings and opinions are advisory only and never determine this check's outcome.
export function analyzeVendorNarrative(signal:Signal,evidence:Evidence[],config:Config,now:Date):NarrativeReport {
  const accepted:Evidence[]=[],seenIds=new Set<string>(),seenText=new Set<string>();
  for(const post of evidence) {
    if(!acceptedEvidence(post,now,config.maxEvidenceAgeSec)) continue;
    const hash=createHash('sha256').update(post.text.trim()).digest('hex');
    if(seenIds.has(post.id)||seenText.has(hash)) continue;
    seenIds.add(post.id);seenText.add(hash);accepted.push(post);
  }
  const caEvidence=accepted.filter(post=>mentionsAddress(post.text,signal));
  const report:NarrativeReport={status:'unknown',reasons:[],checkedAt:now.toISOString(),evidence,
    facts:{narrativeProvider:'vendor',ingestion:'user_supplied_snapshot',
      nativeNarrativeApiStatus:'unconfirmed',providerApiAuthenticated:false,structuredAssessmentAvailable:false,
      evidenceCount:evidence.length,validEvidenceCount:accepted.length,
      evidenceProviders:[...new Set(accepted.map(post=>post.provider))],
      hasThirdPartyEvidence:accepted.some(post=>post.verification==='third_party'),
      fullAddressEvidenceCount:caEvidence.length,distinctAuthorCount:new Set(accepted.map(post=>post.authorId)).size,
      fullAddressAuthorCount:new Set(caEvidence.map(post=>post.authorId)).size}};
  if(!signal.vendorNarrative) {report.reasons=['VENDOR_NARRATIVE_MISSING'];return report;}

  let parsed:ReturnType<typeof VendorNarrativeSchema.safeParse>;
  try { parsed=VendorNarrativeSchema.safeParse(signal.vendorNarrative); }
  catch {
    // A custom schema refinement may throw on a malformed URL; direct callers still fail closed.
    report.reasons=['VENDOR_NARRATIVE_INVALID','VENDOR_NARRATIVE_SOURCE_URL_INVALID'];return report;
  }
  if(!parsed.success) {
    report.reasons=['VENDOR_NARRATIVE_INVALID'];
    if(parsed.error.issues.some(issue=>issue.path[0]==='updatedAt')) report.reasons.push('VENDOR_NARRATIVE_UPDATED_AT_INVALID');
    if(parsed.error.issues.some(issue=>issue.path[0]==='sourceUrl')) report.reasons.push('VENDOR_NARRATIVE_SOURCE_URL_INVALID');
    return report;
  }
  const vendor=parsed.data;
  report.supplier={provider:vendor.provider,text:vendor.text,sourceUrl:vendor.sourceUrl,
    ...(vendor.updatedAt?{updatedAt:vendor.updatedAt}:{}),verification:'user_supplied',contentType:'vendor_ai_narrative'};
  report.facts.supplierToken=vendor.token;
  const structured=vendor.structured;
  const sourceIds=structured?[...new Set(structured.sourceTweetIds)]:[];
  const fieldReferenceIds=structured?[...new Set(structured.sections.flatMap(section=>referencePostIds(section.reference)))]:[];
  const declaredSourceIds=new Set([...sourceIds,...fieldReferenceIds]);
  if(structured) {
    const referencedSections=structured.sections.filter(section=>section.reference.trim()).length;
    const originAvailable=structured.sections.some(section=>
      /^(?:story\.)?background\.origin(?:\.text)?$/.test(section.path)&&section.text.trim().length>0);
    report.facts={...report.facts,structuredAssessmentAvailable:vendor.provider==='debot',
      structuredFormat:structured.format,historyId:structured.historyId,projectName:structured.projectName,
      narrativeType:structured.narrativeType,
      vendorRating:{score:structured.rating.score,reason:structured.rating.reason,
        scoreMax:null,scaleSource:'unverified',advisoryOnly:true},
      narrativeOriginAvailable:originAvailable,
      sourceTweetIds:structured.sourceTweetIds,sourceTweetCount:structured.sourceTweetIds.length,
      uniqueSourceTweetCount:sourceIds.length,claimLevelCitationsAvailable:referencedSections>0,
      claimLevelCitationCount:referencedSections,sectionCount:structured.sections.length,
      supplierClaimsVerified:false,
      claimVerificationNote:'供应商观点未逐项证实；source_tweets 仅为来源列表，不代表逐句证明，原文中的刷量等判断不视为已核实事实。',
      decisionBasis:'narrative_material_and_token_mapping_not_vendor_rating',
      assessmentScope:'material_identity_and_evidence_mapping_not_profitability_or_vendor_opinion'};
    if(vendor.provider!=='debot') report.reasons.push('VENDOR_STRUCTURED_PROVIDER_MISMATCH');
    if(!originAvailable) report.reasons.push('VENDOR_NARRATIVE_ORIGIN_MISSING');
  }
  const tokenMatches=vendor.token.chain===signal.token.chain&&(vendor.token.chain==='solana'
    ?vendor.token.address===signal.token.address:vendor.token.address.toLowerCase()===signal.token.address.toLowerCase());
  report.facts.supplierTokenMatches=tokenMatches;
  if(!tokenMatches) report.reasons.push('VENDOR_NARRATIVE_TOKEN_MISMATCH');
  if(!vendor.text.trim()) report.reasons.push('VENDOR_NARRATIVE_TEXT_EMPTY');
  if(!vendor.updatedAt) report.reasons.push('VENDOR_NARRATIVE_UPDATED_AT_MISSING');
  else {
    const age=now.getTime()-Date.parse(vendor.updatedAt);
    report.facts.supplierAgeSec=age/1000;
    if(age< -CLOCK_SKEW_MS) report.reasons.push('VENDOR_NARRATIVE_UPDATED_AT_FUTURE');
    else if(age>config.maxEvidenceAgeSec*1000) report.reasons.push('VENDOR_NARRATIVE_STALE');
  }

  // An arbitrary CA search hit is not automatically a source cited by the imported narrative.
  const citedPostIds=[...new Set(vendor.evidenceUrls.map(xPostId).filter((id):id is string=>!!id))];
  const linked=accepted.filter(post=>citedPostIds.includes(xPostId(post.url)!)
    &&(!structured||declaredSourceIds.has(xPostId(post.url)!)));
  const linkedCa=tokenMatches?linked.filter(post=>mentionsAddress(post.text,signal)):[];
  const distinctAuthors=new Set(linked.map(post=>post.authorId));
  // Use the operator's account-ID configuration; do not trust a supplied authority label alone.
  const tracked=linked.some(post=>config.trackedIds.includes(post.authorId)||config.issuerIds.includes(post.authorId));
  const unsupportedUrls=vendor.evidenceUrls.filter(url=>!xPostId(url));
  report.facts={...report.facts,citedEvidenceUrlCount:vendor.evidenceUrls.length,
    supportedCitedPostCount:citedPostIds.length,mappedEvidenceCount:linked.length,
    mappedEvidenceIds:linked.map(post=>post.id),mappedFullAddressEvidenceCount:linkedCa.length,
    mappedDistinctAuthorCount:distinctAuthors.size,mappedTrackedAuthor:tracked,
    unmappedCitedPostCount:citedPostIds.filter(id=>!linked.some(post=>post.id===`x:${id}`)).length,
    unsupportedCitedUrlCount:unsupportedUrls.length};
  if(structured) {
    const requested=sourceIds.filter(id=>citedPostIds.includes(id)).length;
    const sampledSourceTweets=linked.filter(post=>sourceIds.includes(xPostId(post.url)!)).length;
    report.facts={...report.facts,requestedSourceTweetCount:requested,
      requestedSourceTweetSamplingRatio:sourceIds.length?requested/sourceIds.length:0,
      sampledSourceTweetCount:sampledSourceTweets,sourceTweetSamplingRatio:sourceIds.length?sampledSourceTweets/sourceIds.length:0,
      fieldReferenceTweetIds:fieldReferenceIds,fieldReferenceTweetCount:fieldReferenceIds.length,
      mappedFieldReferenceCount:linked.filter(post=>fieldReferenceIds.includes(xPostId(post.url)!)).length,
      citedPostsOutsideSourceList:citedPostIds.filter(id=>!sourceIds.includes(id)),
      citedPostsOutsideDeclaredSources:citedPostIds.filter(id=>!declaredSourceIds.has(id))};
  }
  if(!evidence.length) report.reasons.push('ORIGINAL_EVIDENCE_MISSING');
  else if(!accepted.length) report.reasons.push('VENDOR_NARRATIVE_EVIDENCE_UNAVAILABLE_OR_STALE');
  if(!vendor.evidenceUrls.length) report.reasons.push('VENDOR_NARRATIVE_EVIDENCE_LINKS_MISSING');
  else if(unsupportedUrls.length||linked.length!==citedPostIds.length)
    report.reasons.push('VENDOR_NARRATIVE_EVIDENCE_MAPPING_INSUFFICIENT');
  if(!linkedCa.length) report.reasons.push('TOKEN_NARRATIVE_MAPPING_UNVERIFIED');
  if(!tracked&&distinctAuthors.size<2) report.reasons.push('INDEPENDENT_NARRATIVE_SUPPORT_INSUFFICIENT');
  // Even a first-party post from an issuer does not let this non-semantic importer assert endorsement.
  if(signal.claim==='official') report.reasons.push('OFFICIAL_ENDORSEMENT_UNVERIFIED');
  if(structured) {
    const evidencePolicyPassed=report.reasons.length===0;
    report.reasons.push('VENDOR_CLAIMS_NOT_INDIVIDUALLY_VERIFIED');
    if(!evidencePolicyPassed) return report;
    report.status='pass';report.reasons.push('NARRATIVE_MATERIAL_AND_TOKEN_MAPPING_VERIFIED');return report;
  }
  report.reasons.push('VENDOR_NARRATIVE_TEXT_REQUIRES_ASSESSMENT');
  return report;
}
