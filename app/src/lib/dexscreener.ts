/// DexScreener token stats for a mainnet SPL mint — real on-chain 24h volume,
/// liquidity, 24h change and FDV from the deepest pair. CORS-open and free
/// (300 req/min), so we read it straight from the browser. Used for custom
/// markets, whose numbers our devnet indexer can't report honestly (every
/// custom group is asset slot 0, so indexed volume/OI would collide).

import { useQuery } from "@tanstack/react-query";

import { geckoProxy } from "./indexer";

export type DexStats = {
  priceUsd: number;
  volume24h: number;
  liquidityUsd: number;
  change24h: number;
  fdv: number;
};

export async function fetchDexStats(mint: string): Promise<DexStats | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      pairs?: {
        chainId?: string;
        priceUsd?: string;
        volume?: { h24?: number };
        liquidity?: { usd?: number };
        priceChange?: { h24?: number };
        fdv?: number;
      }[];
    };
    // Deepest Solana pair = the reference market.
    const p = (j.pairs ?? [])
      .filter((x) => x.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!p) return null;
    return {
      priceUsd: Number(p.priceUsd) || 0,
      volume24h: Number(p.volume?.h24) || 0,
      liquidityUsd: Number(p.liquidity?.usd) || 0,
      change24h: Number(p.priceChange?.h24) || 0,
      fdv: Number(p.fdv) || 0,
    };
  } catch {
    return null;
  }
}

export function useDexStats(mint: string | undefined) {
  return useQuery({
    queryKey: ["dexstats", mint],
    enabled: !!mint,
    queryFn: () => fetchDexStats(mint!),
    refetchInterval: 12_000,
  });
}

/// GeckoTerminal fallback for a single mint, via the indexer's CORS-safe,
/// edge-cached `/gecko` proxy. GeckoTerminal often indexes a brand-new pool
/// before DexScreener does, so a freshly launched market can still show 24h
/// volume / change / liquidity instead of "—". Picks the deepest pool. Null
/// when GeckoTerminal has no pool for the mint yet either.
export async function fetchGeckoStats(mint: string): Promise<DexStats | null> {
  try {
    const res = await fetch(geckoProxy(`networks/solana/tokens/${mint}/pools?page=1`));
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: {
        attributes?: {
          reserve_in_usd?: string | number;
          base_token_price_usd?: string | number;
          volume_usd?: { h24?: string | number };
          price_change_percentage?: { h24?: string | number };
        };
      }[];
    };
    const best = (j.data ?? [])
      .map((d) => d.attributes ?? {})
      .sort((a, b) => (Number(b.reserve_in_usd) || 0) - (Number(a.reserve_in_usd) || 0))[0];
    if (!best) return null;
    const liq = Number(best.reserve_in_usd) || 0;
    const px = Number(best.base_token_price_usd) || 0;
    const vol = Number(best.volume_usd?.h24) || 0;
    const ch = Number(best.price_change_percentage?.h24) || 0;
    if (liq <= 0 && vol <= 0 && px <= 0) return null;
    return { priceUsd: px, volume24h: vol, liquidityUsd: liq, change24h: ch, fdv: 0 };
  } catch {
    return null;
  }
}

/// Batched DexScreener stats for many mints in ONE request (the endpoint takes
/// a comma-separated list, up to ~30). Returns a Map keyed by mint → deepest
/// Solana pair's stats. Lets the market list show real per-token volume / 24h
/// change without one request per row and without the asset-slot collision the
/// devnet indexer suffers (every custom group is slot 0). Any mint DexScreener
/// hasn't indexed yet (typical for a just-launched token) is retried against
/// GeckoTerminal so new markets populate their stats as soon as ANY aggregator
/// sees the pool.
export async function fetchDexStatsMany(mints: string[]): Promise<Map<string, DexStats>> {
  const out = new Map<string, DexStats>();
  if (mints.length === 0) return out;
  // De-dupe and chunk to 30 per call (DexScreener's cap).
  const uniq = [...new Set(mints)];
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += 30) chunks.push(uniq.slice(i, i + 30));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`,
        );
        if (!res.ok) return;
        const j = (await res.json()) as {
          pairs?: {
            chainId?: string;
            baseToken?: { address?: string };
            priceUsd?: string;
            volume?: { h24?: number };
            liquidity?: { usd?: number };
            priceChange?: { h24?: number };
            fdv?: number;
          }[];
        };
        // Keep the deepest Solana pair per base mint.
        const best = new Map<string, { liq: number; stats: DexStats }>();
        for (const p of j.pairs ?? []) {
          if (p.chainId !== "solana") continue;
          const mint = p.baseToken?.address;
          if (!mint) continue;
          const liq = Number(p.liquidity?.usd) || 0;
          const prev = best.get(mint);
          if (prev && prev.liq >= liq) continue;
          best.set(mint, {
            liq,
            stats: {
              priceUsd: Number(p.priceUsd) || 0,
              volume24h: Number(p.volume?.h24) || 0,
              liquidityUsd: liq,
              change24h: Number(p.priceChange?.h24) || 0,
              fdv: Number(p.fdv) || 0,
            },
          });
        }
        for (const [mint, v] of best) out.set(mint, v.stats);
      } catch {
        /* skip this chunk */
      }
    }),
  );
  // Fill gaps from GeckoTerminal: mints DexScreener didn't return (or returned
  // with no usable liquidity/price yet) — common right after a launch. One
  // proxied request per missing mint; capped so a long list can't fan out.
  const missing = uniq
    .filter((m) => {
      const s = out.get(m);
      return !s || (s.liquidityUsd <= 0 && s.volume24h <= 0);
    })
    .slice(0, 12);
  await Promise.all(
    missing.map(async (m) => {
      const g = await fetchGeckoStats(m);
      if (g) out.set(m, g);
    }),
  );
  return out;
}

export function useDexStatsMany(mints: string[]) {
  const key = [...new Set(mints)].sort().join(",");
  return useQuery({
    queryKey: ["dexstats-many", key],
    enabled: mints.length > 0,
    queryFn: () => fetchDexStatsMany(mints),
    refetchInterval: 30_000,
  });
}
