/// Continuous live price for the display layer. Streams Pyth Hermes
/// (server-sent events, multiple ticks/sec) so the mark, chart and PnL move
/// like a real perp DEX — instead of only stepping once a minute when the
/// on-chain relayer pushes a new AccrueAsset. The on-chain `effective_price`
/// remains the settlement/PnL anchor; this is purely the smooth display feed.
///
/// Markets without a Pyth feed (custom devnet SPL) get no stream — the hook
/// just returns the on-chain fallback.

import { useEffect, useRef, useState } from "react";

import { useMainnetPrice } from "./mainnetPrice";
import { useDexStats } from "./dexscreener";
import { geckoProxy } from "./indexer";

const HERMES_STREAM = "https://hermes.pyth.network/v2/updates/price/stream";

/// Latest live USD price for `feedId`, updating continuously from Hermes.
/// Falls back to `fallback` (the on-chain mark) until the first tick arrives
/// or when there is no feed.
export function useLivePrice(feedId: string | undefined, fallback: number): number {
  const [price, setPrice] = useState<number>(fallback);
  // Keep the freshest fallback without resubscribing the stream.
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  // Throttle React updates so a busy feed doesn't re-render every few ms.
  const lastEmit = useRef(0);

  useEffect(() => {
    if (!feedId) {
      setPrice(fallbackRef.current);
      return;
    }
    const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
    // Reset to the on-chain mark when switching markets.
    setPrice(fallbackRef.current);

    let es: EventSource | null = null;
    try {
      es = new EventSource(
        `${HERMES_STREAM}?ids[]=${id}&parsed=true&ignore_invalid_price_ids=true`,
      );
    } catch {
      return;
    }
    es.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data) as {
          parsed?: { price?: { price?: string; expo?: number } }[];
        };
        const p = j.parsed?.[0]?.price;
        if (!p || p.price === undefined || p.expo === undefined) return;
        const v = Number(p.price) * 10 ** p.expo;
        if (!Number.isFinite(v) || v <= 0) return;
        const now = Date.now();
        if (now - lastEmit.current < 250) return; // ~4 updates/sec max
        lastEmit.current = now;
        setPrice(v);
      } catch {
        /* ignore malformed frame */
      }
    };
    // EventSource auto-reconnects on error; keep the last/fallback price.
    return () => es?.close();
  }, [feedId]);

  return price > 0 ? price : fallback;
}

/// Normalize a Pyth feed id to bare lowercase hex (no `0x`), matching the `id`
/// field in Hermes stream frames.
export function normalizeFeedId(id: string): string {
  return id.replace(/^0x/, "").toLowerCase();
}

const JUP_PRICE = "https://api.jup.ag/price/v2";

/// Live USD price for a mainnet SPL mint. GeckoTerminal first (covers pump /
/// long-tail SPL that Jupiter's price API doesn't), Jupiter as a fallback.
async function fetchTokenPriceUsd(mint: string): Promise<number | null> {
  try {
    const res = await fetch(geckoProxy(`simple/networks/solana/token_price/${mint}`));
    if (res.ok) {
      const j = (await res.json()) as {
        data?: { attributes?: { token_prices?: Record<string, string> } };
      };
      const prices = j.data?.attributes?.token_prices ?? {};
      const raw = prices[mint] ?? Object.values(prices)[0];
      const v = Number(raw);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    /* try jupiter */
  }
  try {
    const res = await fetch(`${JUP_PRICE}?ids=${mint}`);
    if (res.ok) {
      const j = (await res.json()) as { data?: Record<string, { price?: string | number }> };
      const raw = j.data?.[mint]?.price;
      const v = typeof raw === "string" ? Number(raw) : raw;
      if (v !== undefined && Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/// Live USD price for a mainnet SPL mint, polled (~every 6s). Custom markets
/// list a real mainnet token, so this is their display feed (the Pyth-equivalent
/// for tokens without a Pyth feed). 0 until the first response.
export function useTokenPrice(mint: string | undefined): number {
  const [price, setPrice] = useState(0);
  useEffect(() => {
    if (!mint) {
      setPrice(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      const v = await fetchTokenPriceUsd(mint);
      if (alive && v !== null) setPrice(v);
    };
    void tick();
    const id = setInterval(tick, 6_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mint]);
  return price;
}

/// The mark for ANY market — the live price the UI shows and marks PnL to:
///   - majors      → Pyth Hermes stream (the relayer feeds effective_price from
///                   Pyth, so the live tick IS the settlement mark).
///   - custom SPL  → the live DEX spot (DexScreener / shared on-chain feed),
///                   updating every few seconds, falling back to the on-chain
///                   engine mark (`market.price`) until the first spot tick.
///
/// We show live spot rather than the raw on-chain `effective_price` because the
/// relayer only pushes effective_price every ~1–2 min (clamped), which makes the
/// number look FROZEN between pushes. The relayer continuously converges
/// effective_price toward this same spot (kept within ~1%), and a close settles
/// at effective_price — so what realizes tracks what's shown. On mainnet a
/// continuous oracle makes effective_price == spot exactly.
/// One call site for the mark regardless of market type.
export function useMarketMark(market: {
  oracleFeedId?: string;
  baseMint?: string;
  price: number;
}): number {
  const pyth = useLivePrice(market.oracleFeedId, market.price);
  const spot = useSpotPrice(market);
  if (market.oracleFeedId) return pyth;
  return spot > 0 ? spot : market.price;
}

/// The price to SIZE / EXECUTE an order at — the engine's settlement price, NOT
/// the display spot. Sizing must match how the engine values the position
/// (`size_q × effective_price`); using the live spot here over-sizes the
/// position whenever spot ≠ effective_price (a not-yet-converged custom market),
/// pushing it past the initial-margin limit so the open reverts with
/// InvalidConfig (0x3e8). Majors → Pyth (the relayer feeds it as the mark, so
/// Pyth IS effective_price). Custom → the on-chain engine mark `market.price`.
export function useExecPrice(market: { oracleFeedId?: string; price: number }): number {
  const pyth = useLivePrice(market.oracleFeedId, market.price);
  if (market.oracleFeedId) return pyth;
  return market.price;
}

/// The realtime SPOT price of a custom market's token — the live DEX-pool price
/// (shared on-chain feed → DexScreener), updating sub-second. This is purely
/// informational ("what the token is worth right now"); it is NOT what the
/// engine settles at. PnL / liquidation use the slower on-chain mark
/// (`useMarketMark`). For majors there's no separate spot (Pyth IS the mark), so
/// this returns 0. 0 also until the first tick.
export function useSpotPrice(market: { oracleFeedId?: string; baseMint?: string }): number {
  const custom = market.oracleFeedId ? undefined : market.baseMint;
  const onchain = useMainnetPrice(custom);
  const dex = useDexStats(custom);
  if (!custom) return 0;
  if (onchain > 0) return onchain;
  return dex.data?.priceUsd ?? 0;
}

/// Live prices for many feeds over a SINGLE Hermes stream, keyed by bare hex
/// id. Lets the market list tick continuously without one socket per row.
export function useLivePrices(feedIds: (string | undefined)[]): Map<string, number> {
  const ids = feedIds.filter((x): x is string => !!x).map(normalizeFeedId);
  const key = [...new Set(ids)].sort().join(",");
  const [prices, setPrices] = useState<Map<string, number>>(new Map());
  const pending = useRef<Map<string, number>>(new Map());
  const lastEmit = useRef(0);

  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    const url =
      `${HERMES_STREAM}?` +
      list.map((i) => `ids[]=${i}`).join("&") +
      "&parsed=true&ignore_invalid_price_ids=true";
    let es: EventSource | null = null;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    es.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data) as {
          parsed?: { id?: string; price?: { price?: string; expo?: number } }[];
        };
        for (const it of j.parsed ?? []) {
          const p = it.price;
          if (!it.id || !p || p.price === undefined || p.expo === undefined) continue;
          const v = Number(p.price) * 10 ** p.expo;
          if (Number.isFinite(v) && v > 0) pending.current.set(normalizeFeedId(it.id), v);
        }
        const now = Date.now();
        if (now - lastEmit.current < 400) return; // batch ~2.5 updates/sec
        lastEmit.current = now;
        setPrices(new Map(pending.current));
      } catch {
        /* ignore */
      }
    };
    return () => es?.close();
  }, [key]);

  return prices;
}
