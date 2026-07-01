/// Realtime on-chain price + pool liquidity for a mainnet SPL token, received
/// from the indexer's PriceFeed Durable Object over a WebSocket. The DO holds
/// ONE upstream Helius connection per token and fans it out, so every
/// user/component sharing a mint rides one server feed instead of each opening
/// its own Helius socket. In the browser we additionally share one DO connection
/// per mint across components. Price/liquidity are 0 until the first tick (or
/// when the token has no decodable AMM pool — the caller then falls back to the
/// GeckoTerminal/DexScreener poll).

import { useEffect, useState } from "react";

const INDEXER =
  (import.meta.env.VITE_OPENPERPS_INDEXER as string | undefined) ??
  "https://openperps-indexer.denath1707.workers.dev";
const FEED_WS = INDEXER.replace(/^http/, "ws") + "/pricefeed";

type Snapshot = { price: number; liquidity: number };
type Feed = { snap: Snapshot; subs: Set<(s: Snapshot) => void>; stop: () => void };
const feeds = new Map<string, Feed>();

function startFeed(mint: string, feed: Feed): void {
  let alive = true;
  let ws: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (!alive) return;
    try {
      ws = new WebSocket(`${FEED_WS}?mint=${mint}`);
    } catch {
      reconnect = setTimeout(connect, 3_000);
      return;
    }
    ws.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data as string) as { price?: number; liquidity?: number };
        const p = Number(j.price);
        const liq = Number(j.liquidity);
        const next: Snapshot = {
          price: p > 0 && Number.isFinite(p) ? p : feed.snap.price,
          liquidity: liq > 0 && Number.isFinite(liq) ? liq : feed.snap.liquidity,
        };
        if (next.price === feed.snap.price && next.liquidity === feed.snap.liquidity) return;
        feed.snap = next;
        feed.subs.forEach((cb) => cb(next));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (alive) reconnect = setTimeout(connect, 3_000);
    };
    ws.onerror = () => ws?.close();
  };

  feed.stop = () => {
    alive = false;
    ws?.close();
    if (reconnect) clearTimeout(reconnect);
  };
  connect();
}

/// Subscribe to the shared per-mint feed and return its latest snapshot.
function useMainnetFeed(mint: string | undefined): Snapshot {
  const [snap, setSnap] = useState<Snapshot>({ price: 0, liquidity: 0 });
  useEffect(() => {
    if (!mint) {
      setSnap({ price: 0, liquidity: 0 });
      return;
    }
    let feed = feeds.get(mint);
    if (!feed) {
      feed = { snap: { price: 0, liquidity: 0 }, subs: new Set(), stop: () => {} };
      feeds.set(mint, feed);
      startFeed(mint, feed);
    }
    setSnap(feed.snap);
    const cb = (s: Snapshot) => setSnap(s);
    feed.subs.add(cb);
    return () => {
      feed!.subs.delete(cb);
      if (feed!.subs.size === 0) {
        feed!.stop();
        feeds.delete(mint);
      }
    };
  }, [mint]);
  return snap;
}

/// Latest realtime on-chain USD price for `mint`. 0 until the first tick.
export function useMainnetPrice(mint: string | undefined): number {
  return useMainnetFeed(mint).price;
}

/// Latest on-chain pool liquidity (USD) for `mint`, computed from the live vault
/// balances — available immediately, before DexScreener/GeckoTerminal index a
/// just-launched pool. 0 until the first tick or when there's no decodable pool.
export function useMainnetLiquidity(mint: string | undefined): number {
  return useMainnetFeed(mint).liquidity;
}
