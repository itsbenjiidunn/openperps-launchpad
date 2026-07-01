/// Underlying-asset presets for the market launcher. A perp market is
/// `(underlying asset, oracle, USDC quote, risk config)` — NOT a freshly
/// minted token. These presets bind a ticker to its on-Solana SPL mint (if
/// one exists) and its Pyth price-feed id, so the user picks "SOL-PERP",
/// not "mint a random token".
///
/// `baseMint` is intentionally optional: BTC and ETH have no SPL mint on
/// Solana — they trade as *synthetic* perps off a price feed alone. BONK /
/// JUP / SOL do have SPL mints, so the market can also reference the real
/// token for display + future spot tie-ins.
///
/// `pythFeedId` is the canonical Pyth pull-oracle feed id (hex). In Phase 5
/// it is stored as metadata only — the on-chain price is still
/// authority-set via ActivateMarket / AccrueAsset until the Pyth CPI lands
/// (Phase 7). The UI labels a market "Pyth (CPI pending)" vs "Devnet
/// simulated" accordingly.

export type OracleKind = "pyth" | "manual" | "dex";

export type AssetPreset = {
  /// Bare ticker, e.g. "SOL".
  ticker: string;
  /// Market symbol shown everywhere, e.g. "SOL-PERP".
  symbol: string;
  /// Full name for the picker.
  name: string;
  /// SPL mint on Solana mainnet, if the asset is tokenized. Undefined for
  /// pure synthetics (BTC, ETH).
  baseMint?: string;
  /// Pyth price-feed id (hex, pull oracle). Undefined → manual-only.
  pythFeedId?: string;
  /// Sensible USD seed price for the manual/devnet oracle path.
  defaultPriceUsd: number;
  /// Whether the asset is a synthetic (no SPL mint) — for UI copy.
  synthetic: boolean;
  /// Binance spot symbol (e.g. "BTCUSDT") for the *reference* order book the
  /// terminal mirrors. OpenPerps has no order book (matched-cross via vault),
  /// so this depth is display-only, clearly labelled "Reference · Binance".
  cexSymbol?: string;
};

export const ASSET_PRESETS: AssetPreset[] = [
  {
    ticker: "SOL",
    symbol: "SOL-PERP",
    name: "Solana",
    baseMint: "So11111111111111111111111111111111111111112",
    pythFeedId:
      "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    defaultPriceUsd: 150,
    synthetic: false,
    cexSymbol: "SOLUSDT",
  },
  {
    ticker: "BTC",
    symbol: "BTC-PERP",
    name: "Bitcoin",
    pythFeedId:
      "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    defaultPriceUsd: 95000,
    synthetic: true,
    cexSymbol: "BTCUSDT",
  },
  {
    ticker: "ETH",
    symbol: "ETH-PERP",
    name: "Ethereum",
    pythFeedId:
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    defaultPriceUsd: 3500,
    synthetic: true,
    cexSymbol: "ETHUSDT",
  },
  {
    ticker: "BONK",
    symbol: "BONK-PERP",
    name: "Bonk",
    baseMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    pythFeedId:
      "0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
    defaultPriceUsd: 0.00002,
    synthetic: false,
    cexSymbol: "BONKUSDT",
  },
  {
    ticker: "JUP",
    symbol: "JUP-PERP",
    name: "Jupiter",
    baseMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    pythFeedId:
      "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
    defaultPriceUsd: 0.8,
    synthetic: false,
    cexSymbol: "JUPUSDT",
  },
];

/// Risk tiers map to a max leverage the UI surfaces and (later) on-chain
/// initial-margin bps. For Phase 5 they are display metadata — the engine
/// uses its built-in config — but they shape the trader's mental model.
export type RiskTier = {
  id: string;
  label: string;
  maxLeverage: number;
  /// initial-margin bps = 10000 / maxLeverage (for when InitMarket takes it).
  initialMarginBps: number;
  blurb: string;
};

export const RISK_TIERS: RiskTier[] = [
  {
    id: "blue",
    label: "Blue-chip",
    maxLeverage: 20,
    initialMarginBps: 500,
    blurb: "Deep liquidity majors (SOL, BTC, ETH). 5% initial margin.",
  },
  {
    id: "mid",
    label: "Mid-cap",
    maxLeverage: 10,
    initialMarginBps: 1000,
    blurb: "Established alts (JUP). 10% initial margin.",
  },
  {
    id: "long-tail",
    label: "Long-tail",
    maxLeverage: 5,
    initialMarginBps: 2000,
    blurb: "Volatile / meme assets (BONK) or custom mints. 20% initial margin.",
  },
];

export function defaultTierFor(preset: AssetPreset | null): RiskTier {
  if (!preset) return RISK_TIERS[2]!;
  if (["SOL", "BTC", "ETH"].includes(preset.ticker)) return RISK_TIERS[0]!;
  if (preset.ticker === "JUP") return RISK_TIERS[1]!;
  return RISK_TIERS[2]!;
}

/// Convert a human USD price to the engine's u64 atom scale (QUOTE_DECIMALS).
export function priceUsdToAtoms(usd: number, decimals: number): bigint {
  const scaled = Math.round(usd * 10 ** decimals);
  return BigInt(scaled);
}
