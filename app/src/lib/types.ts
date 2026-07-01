/// Data shape types shared across routes.
///
/// `Market` deliberately keeps the price/volume/funding fields the Lovable
/// design used, but they are now *optional* — the engine knows nothing about
/// 24h volume or oracle source until an indexer / Pyth CPI exposes them.
/// Components render a "—" placeholder when these are undefined.

export type OracleSource = "Pyth" | "Switchboard" | "Authority" | "DEX";
export type OracleStatus = "live" | "stale" | "degraded";

export type Market = {
  /// On-chain market account pubkey.
  pubkey: string;
  /// User-supplied or registry-stored label (e.g. "SOL-PERP").
  symbol: string;
  /// Underlying base label (e.g. "SOL").
  base: string;
  /// Quote SPL mint address used for collateral.
  quoteMint: string;
  /// Per-market vault TokenAccount PDA address.
  vault: string;
  /// Number of asset slots the market group was sized for.
  assetSlotCapacity: number;
  /// Asset slot index of this pair within the shared market group. PlaceOrder
  /// / CrankOracle target this index; the mark lives in slot[assetIndex].
  assetIndex: number;
  /// SPL mint of the underlying asset, if tokenized on Solana.
  baseMint?: string;
  /// Oracle binding: "dex" (DEX-pool EWMA), "pyth" (feed bound,
  /// CPI pending) or "manual".
  oracleKind?: "pyth" | "manual" | "dex";
  /// Pyth price-feed id (hex) when oracleKind === "pyth".
  oracleFeedId?: string;
  /// DEX pool account address when oracleKind === "dex".
  oraclePool?: string;
  /// Max leverage from the chosen risk tier (display metadata).
  maxLeverage?: number;
  /// Taker fee in bps (drives the default order fee).
  feeBps?: number;
  /// Binance spot symbol for the reference order book (majors only).
  cexSymbol?: string;
  /// Standalone isolated group (custom SPL): its own House + seeded LP. Trades
  /// route to `house`, not the shared majors House.
  ownGroup?: boolean;
  house?: string;
  houseBump?: number;
  seedLp?: number;
  /// Official Integration partner (launchpad / bot) that listed this market;
  /// undefined for ordinary permissionless launches. Drives the "Official" badge.
  partner?: string;
  partnerUrl?: string;
  /// True when the market runs a House-LP (HLP) vault (anyone can LP its House).
  hlp?: boolean;
  /// Coin-margined (inverse): collateral mint == underlying mint, so the token
  /// itself is the collateral. Trades, deposits and PnL are in the base token,
  /// not mUSDC, and leverage is capped at 5x on-chain.
  coinMargin?: boolean;
  /// Decimals of the collateral mint (`quoteMint`). mUSDC = 6; a coin-margin
  /// market uses the base token's own decimals. Defaults to QUOTE_DECIMALS.
  quoteDecimals?: number;
  /// Spot venue for the token: "curve" → a pump-style bonding curve (`curve` PDA)
  /// is the live spot market; "pool" → a graduated/standalone AMM pool. The trading
  /// view shows the curve buy/sell widget when this is "curve".
  spotKind?: "curve" | "pool";
  /// Bonding-curve state PDA (curve program) when `spotKind === "curve"`.
  curve?: string;
  /// Spot AMM pool id when a pool backs the token.
  spotPool?: string;

  // Display fields. Without an indexer / oracle CPI these default to 0 so
  // existing chart/orderbook components keep rendering without null-checks.
  // The route-level UI is responsible for surfacing "no data yet" copy.
  price: number;
  change24h: number;
  volume24h: number;
  openInterest: number;
  funding: number;
  oracle: OracleSource;
  oracleStatus: OracleStatus;
  favorite?: boolean;
  /// Wall-clock ms the market was added to this browser's registry. Drives the
  /// honest "New" sort; undefined for markets discovered on-chain but launched
  /// elsewhere (we can't know their age without an indexer).
  createdAt?: number;
};

/// Stable, unique key for a market across BOTH tiers. The shared majors all
/// share one `pubkey` (SHARED_MARKET) and differ only by `assetIndex`, while
/// every custom own-group launch has a unique `pubkey` but `assetIndex` 0 — so
/// neither field alone is unique. The composite is. Used as the URL/selection
/// key so clicking a custom market doesn't collide with the slot-0 major (SOL).
export function marketKey(m: { pubkey: string; assetIndex: number }): string {
  return `${m.pubkey}:${m.assetIndex}`;
}

export type Position = {
  market: string;
  side: "long" | "short";
  size: number;
  notional: number;
  entry: number;
  mark: number;
  liq: number;
  pnl: number;
  funding: number;
};

export type TradeRow = {
  ts: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  size: number;
};

export type FundingEvent = {
  ts: string;
  market: string;
  rate: number;
  longs: "pay" | "receive";
};

export type LiquidationRow = {
  ts: string;
  account: string;
  market: string;
  side: "long" | "short";
  size: number;
  notional: number;
  insurance: number;
};

export type CrankQueueRow = {
  account: string;
  market: string;
  health: number;
  mr: number;
  equity: number;
  reward: number;
};

export type AccountSummary = {
  address: string;
  collateral: number;
  withdrawable: number;
  marginRatio: number;
  health: number;
  unrealized: number;
  realized: number;
};

export type VaultSummary = {
  tvl: number;
  utilization: number;
  reserves: number;
  insurance: number;
  apr: number;
  protocolFees: number;
};
