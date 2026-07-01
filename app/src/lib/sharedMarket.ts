/// The single shared market group that gives OpenPerps real cross-margin:
/// one group, many asset slots, one vault, one shared House Vault, and one
/// portfolio per user. Bootstrapped once on devnet via
/// `ts/sdk/scripts/bootstrap-shared-group.ts`. "Launching a market" no longer
/// creates a group — it claims a free asset slot in THIS group.

import { PublicKey } from "@solana/web3.js";

// Recreated on the OSS program 2TGY1 (2026-06-10) via
// `create-shared-market.ts`: the previous group (EZj2ES82...) belonged to the
// old pre-OSS program, so every action against it failed InvalidAccountOwner
// once the frontend moved to 2TGY1. Slots 0=SOL 1=SPETTRO 2=BTC 3=ETH 4=JUP,
// activated at live prices; House seeded $20k; oracle authority = the indexer
// cron relayer; House cap set (skew funding on).
export const SHARED_MARKET = new PublicKey(
  "8AVLXoCsgiQygvDahjgrfG5QBrmZ5sMWAZaXwfemcAsK",
);
export const SHARED_VAULT = new PublicKey(
  "3qfUVHMiM3ktnsGcp2YnafdKpJYLP43LphCw1L1fo8C4",
);
export const SHARED_HOUSE = new PublicKey(
  "BzJZwxb5MKrFyqRPm5kJD1S9VXov48vzLVsJ436fcF4i",
);
export const SHARED_HOUSE_BUMP = 254;
export const SHARED_SLOT_CAPACITY = 16;

/// The group's `max_trading_fee_bps` as baked into the shared market's
/// on-chain config (see `default_market_config` in the program). PlaceOrder
/// passes a per-trade `fee_bps`, and the engine rejects any trade where
/// `fee_bps > max_trading_fee_bps` with `InvalidConfig` — which the wallet
/// surfaces as a generic "Unexpected error". Every per-trade fee MUST be
/// clamped to this cap, and the launch UI must not advertise a higher fee.
export const GROUP_MAX_FEE_BPS = 10;
