/** Profile cohorts that receive priority receipt review in the live wallet path. */
export const WALLET_FAST_PROFILE_PRIORITY_GROUPS=[
  'market_visible_start','market_precursor_pattern','forward_validated','repeated_early','precursor_pattern','public_kol'
] as const;

/** launcher_candidate is a live synthetic tag rather than a persisted profile group. */
export const WALLET_FAST_PRIORITY_GROUPS=['launcher_candidate',...WALLET_FAST_PROFILE_PRIORITY_GROUPS] as const;
