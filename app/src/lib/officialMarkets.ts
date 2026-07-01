/// The canonical first-class markets every visitor sees by default — SOL,
/// BTC, ETH and JUP. Unlike user-launched markets (which live in this
/// browser's localStorage `registry`), these are baked into the app and
/// pinned to fixed asset slots in the shared market group, so they render
/// with proper metadata for everyone regardless of who launched what.
///
/// Their on-chain slots are bootstrapped on devnet (ActivateMarket) and the
/// indexer relayer pushes live Pyth prices to them every minute, so the mark
/// + PnL track the real market. Slot assignment matches the on-chain reality:
/// SOL=0 and BTC=2 were already live; ETH=3 and JUP=4 were activated +
/// registered alongside this change.

import type { RegistryEntry } from "./registry";
import { ASSET_PRESETS } from "./assets";
import { QUOTE_MINT } from "./collateral";
import { GROUP_MAX_FEE_BPS, SHARED_MARKET, SHARED_SLOT_CAPACITY, SHARED_VAULT } from "./sharedMarket";

/// (ticker → fixed asset slot) for the built-in majors. Keep in sync with the
/// indexer's relayer registration and the on-chain activations.
const OFFICIAL_SLOTS: Record<string, number> = {
  SOL: 0,
  BTC: 2,
  ETH: 3,
  JUP: 4,
};

/// Asset slots reserved for official markets — the launcher must never hand
/// these out to custom SPL markets.
export const OFFICIAL_SLOT_INDICES: number[] = Object.values(OFFICIAL_SLOTS);

function presetTier(ticker: string): number {
  if (ticker === "SOL" || ticker === "BTC" || ticker === "ETH") return 20;
  return 10;
}

/// The official markets as registry-shaped entries, so `useMarkets` can render
/// them through the same path as user-launched markets.
export const OFFICIAL_MARKETS: RegistryEntry[] = Object.entries(OFFICIAL_SLOTS)
  .map(([ticker, assetIndex]): RegistryEntry | null => {
    const preset = ASSET_PRESETS.find((p) => p.ticker === ticker);
    if (!preset) return null;
    return {
      pubkey: SHARED_MARKET.toBase58(),
      symbol: preset.symbol,
      base: preset.ticker,
      quoteMint: QUOTE_MINT.toBase58(),
      vault: SHARED_VAULT.toBase58(),
      assetSlotCapacity: SHARED_SLOT_CAPACITY,
      assetIndex,
      baseMint: preset.baseMint,
      // Priced from the live Pyth feed via the relayer.
      oracleKind: "pyth",
      oracleFeedId: preset.pythFeedId,
      maxLeverage: presetTier(ticker),
      feeBps: GROUP_MAX_FEE_BPS,
      seedPriceUsd: preset.defaultPriceUsd,
      addedAt: 0,
    };
  })
  .filter((m): m is RegistryEntry => m !== null);

/// Whether an asset slot is reserved for an official market.
export function isOfficialSlot(assetIndex: number): boolean {
  return OFFICIAL_SLOT_INDICES.includes(assetIndex);
}
