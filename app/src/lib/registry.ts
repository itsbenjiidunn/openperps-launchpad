/// localStorage-backed registry of markets the user has launched (or
/// imported by pubkey). This is a stop-gap until an indexer / on-chain
/// registry account exists.

const KEY = "openperps:markets";

export type RegistryEntry = {
  pubkey: string;
  symbol: string;
  base: string;
  quoteMint: string;
  vault: string;
  assetSlotCapacity: number;
  /// Asset slot index of this pair within the shared market group.
  assetIndex: number;
  /// SPL mint of the underlying asset, if it is tokenized on Solana.
  /// Undefined for synthetics (BTC, ETH) traded off a price feed alone.
  baseMint?: string;
  /// "dex" → priced from a DEX pool's on-chain EWMA; "pyth" → a
  /// Pyth feed bound (CPI pending); "manual" → authority-set price.
  oracleKind?: "pyth" | "manual" | "dex";
  /// Pyth price-feed id (hex) when oracleKind === "pyth".
  oracleFeedId?: string;
  /// DEX pool account address when oracleKind === "dex".
  oraclePool?: string;
  /// Max leverage from the chosen risk tier — display metadata for now.
  maxLeverage?: number;
  /// Taker fee in bps set at launch; drives the default PlaceOrder fee.
  feeBps?: number;
  /// Seed/oracle price in USD set at launch (ActivateMarket). Used to
  /// prefill the order panel and show a mark until the Pyth CPI lands.
  seedPriceUsd?: number;
  /// Custom SPL markets are their OWN isolated group (separate market account
  /// + vault + House seeded by the creator), so trades/positions on them never
  /// touch the shared majors pool. `house`/`houseBump` are that group's House
  /// portfolio PDA; `ownGroup` flags it as a standalone group (vs a slot in the
  /// shared group). Majors/shared markets leave these unset.
  house?: string;
  houseBump?: number;
  ownGroup?: boolean;
  /// mUSDC the creator seeded into the group's House (LP + insurance), human.
  seedLp?: number;
  /// Official Integration partner that listed this market (launchpad / bot), set
  /// by the partner-authed indexer endpoint. Undefined for ordinary launches.
  partner?: string;
  partnerUrl?: string;
  /// True when the market runs a House-LP (HLP) vault (anyone can LP its House).
  hlp?: boolean;
  /// Coin-margined (inverse) market: the token itself is the collateral, so
  /// `quote_mint == base_mint`. Set by coin-margin launches and the launchpad.
  coinMargin?: boolean;
  /// Decimals of the collateral mint (mUSDC = 6; coin-margin = the token's own),
  /// so the trading UI sizes deposits/positions in the right scale.
  quoteDecimals?: number;
  /// Which launch route minted this token (e.g. "native"); display metadata.
  launchpad?: string;
  /// Spot venue for the token before/after graduation. "curve" → a pump-style
  /// bonding curve (the `curve` PDA below) is the live spot market; "pool" → a
  /// graduated/standalone AMM pool (`spotPool`). Undefined → perp-only.
  spotKind?: "curve" | "pool";
  /// Bonding-curve state PDA (curve program) when `spotKind === "curve"`.
  curve?: string;
  /// Spot AMM pool id when a Raydium/CPMM pool backs the token.
  spotPool?: string;
  /// Wall-clock ms when the user added it; just for sorting.
  addedAt: number;
};

function readRaw(): RegistryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as RegistryEntry[];
  } catch {
    return [];
  }
}

function writeRaw(entries: RegistryEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

export function listMarkets(): RegistryEntry[] {
  return readRaw().sort((a, b) => b.addedAt - a.addedAt);
}

export function addMarket(entry: Omit<RegistryEntry, "addedAt">): void {
  const existing = readRaw();
  const without = existing.filter((m) => m.pubkey !== entry.pubkey);
  without.push({ ...entry, addedAt: Date.now() });
  writeRaw(without);
}

export function removeMarket(pubkey: string): void {
  writeRaw(readRaw().filter((m) => m.pubkey !== pubkey));
}

/// Merge a partial patch into an existing market entry (e.g. flip a graduated
/// curve to a spot pool). No-op if the market is not in the local registry.
export function updateMarket(
  pubkey: string,
  patch: Partial<Omit<RegistryEntry, "pubkey" | "addedAt">>,
): void {
  const entries = readRaw();
  const idx = entries.findIndex((m) => m.pubkey === pubkey);
  if (idx < 0) return;
  entries[idx] = { ...entries[idx], ...patch };
  writeRaw(entries);
}

export function clearRegistry(): void {
  writeRaw([]);
}
