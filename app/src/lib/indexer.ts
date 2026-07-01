/// Client for the OpenPerps indexer Worker (global trade feed, 24h stats,
/// fees). Everything is best-effort: if the indexer is unreachable or empty
/// the callers fall back to local state, so the app degrades gracefully.

import type { RegistryEntry } from "./registry";

const INDEXER_URL =
  import.meta.env.VITE_OPENPERPS_INDEXER ??
  "https://openperps-indexer.denath1707.workers.dev";

/// Ask the server-side faucet to mint test mUSDC to `owner`. The mint authority
/// lives ONLY in the Worker (a secret) — no key ships in the client bundle.
export async function requestFaucet(owner: string): Promise<string> {
  const res = await fetch(`${INDEXER_URL}/faucet?owner=${owner}`);
  const j = (await res.json()) as { signature?: string; error?: string };
  if (j.error || !j.signature) throw new Error(j.error ?? "Faucet request failed.");
  return j.signature;
}

export type IndexedTrade = {
  signature: string;
  ts: number;
  market: string;
  assetIndex: number;
  side: number; // 0 long, 1 short
  size: number;
  price: number;
  notional: number;
  feeBps: number;
  trader: string;
};

/// Proxy a GeckoTerminal request through the indexer Worker (server-side fetch
/// + edge cache + CORS). `path` is everything after `/api/v2/`. The browser
/// can't hit GeckoTerminal directly — its 429s drop CORS headers.
export function geckoProxy(path: string): string {
  return `${INDEXER_URL}/gecko?path=${encodeURIComponent(path)}`;
}

/// Cached OHLCV candles for a token's DEX pool, served from the indexer's D1
/// (GeckoTerminal fetched server-side once per refresh window, shared by all
/// users — so it doesn't 429 the way per-browser GeckoTerminal calls do).
/// `tf` ∈ 1m|5m|15m|1h. Returns `{ ohlcv_list: [[t,o,h,l,c,v], ...] }` ascending.
export function candlesUrl(mint: string, tf: string): string {
  return `${INDEXER_URL}/candles?mint=${mint}&tf=${tf}`;
}

/// Nudge the indexer to parse + store a just-confirmed trade immediately, so the
/// VWAP entry (/positions) and history (/trades) are durable and available on
/// EVERY device within seconds — instead of waiting up to a minute for the cron.
/// Fire-and-forget: the cron still backstops it if this call fails. The browser
/// localStorage log is only a same-device instant cache, not the source of truth.
export function ingestTrade(signature: string): void {
  void fetch(`${INDEXER_URL}/ingest?sig=${signature}`).catch(() => {});
}

async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${INDEXER_URL}${path}`);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export function fetchGlobalTrades(limit = 30): Promise<IndexedTrade[]> {
  return get<IndexedTrade[]>(`/trades?limit=${limit}`, []);
}

export function fetchUserTrades(owner: string, limit = 30): Promise<IndexedTrade[]> {
  return get<IndexedTrade[]>(`/trades?owner=${owner}&limit=${limit}`, []);
}

/// A comment on a coin's thread. `author` is the poster's wallet address.
export interface CoinComment {
  id: number;
  author: string;
  body: string;
  ts: number;
}

export function fetchComments(mint: string): Promise<CoinComment[]> {
  return get<CoinComment[]>(`/comments?mint=${mint}`, []);
}

export async function postComment(mint: string, author: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(`${INDEXER_URL}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mint, author, body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function fetchStats(): Promise<
  Record<number, { trades: number; volume: number }>
> {
  return get(`/stats`, {});
}

export async function fetchFees24h(owner: string): Promise<number | null> {
  const r = await get<{ fees24h?: number }>(`/fees?owner=${owner}`, {});
  return r.fees24h ?? null;
}

export type EquityPoint = { ts: number; equity: number };

export function fetchEquity(portfolio: string): Promise<EquityPoint[]> {
  return get<EquityPoint[]>(`/equity?portfolio=${portfolio}`, []);
}

/// Tell the relayer which price source backs an asset slot, so it can push
/// live prices on-chain. Fire-and-forget (best-effort).
export async function registerMarket(m: {
  assetIndex: number;
  symbol: string;
  pythFeedId?: string;
  baseMint?: string;
}): Promise<void> {
  try {
    await fetch(`${INDEXER_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(m),
    });
  } catch {
    /* best-effort */
  }
}

/// Publish a launched custom market to the shared registry so every other
/// wallet/device can discover it (not just this browser's localStorage).
/// Fire-and-forget — local registry is still written as a fallback.
export async function postMarket(
  entry: Omit<RegistryEntry, "addedAt">,
): Promise<void> {
  try {
    await fetch(`${INDEXER_URL}/markets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    /* best-effort */
  }
}

/// All custom markets launched by anyone (the shared registry). Returns [] if
/// the indexer is unreachable, so callers fall back to local state.
export async function fetchCustomMarkets(): Promise<RegistryEntry[]> {
  const r = await get<RegistryEntry[]>(`/markets`, []);
  return Array.isArray(r) ? r : [];
}

export type PositionEntry = {
  /// The group/market account the fill was placed against. Disambiguates custom
  /// isolated markets, which all share asset slot 0.
  market: string;
  assetIndex: number;
  side: number;
  size: number;
  entry: number;
};

/// Composite key for a position leg: its group account + asset slot. Custom
/// markets each have their own group, so this never collides; majors share the
/// House group and differ by slot.
export function entryKey(market: string, assetIndex: number): string {
  return `${market}:${assetIndex}`;
}

/// Every (portfolio, market) the wallet has traded, from the indexer — keyed by
/// the wallet on-chain, so positions/accounts are discoverable on ANY device.
/// Portfolios are random keypairs the launcher stored only in the creating
/// browser's localStorage; this is how a second browser finds them.
export async function fetchUserPortfolios(
  owner: string,
): Promise<{ portfolio: string; market: string }[]> {
  return get<{ portfolio: string; market: string }[]>(`/portfolios?owner=${owner}`, []);
}

/// VWAP entry per (market, asset slot), derived from the owner's indexed fills.
/// Keyed by `entryKey` for collision-free lookup against on-chain positions.
export async function fetchPositionEntries(
  owner: string,
): Promise<Map<string, PositionEntry>> {
  const arr = await get<PositionEntry[]>(`/positions?owner=${owner}`, []);
  return new Map(arr.map((p) => [entryKey(p.market, p.assetIndex), p]));
}
