/// Launchpad home: a live scrolling trades ticker, a hero,
/// a trending row, filter tabs, and a rich grid of coin cards, each with the token
/// image, a live market-cap in USD, a trade sparkline, change %, creator + age and
/// bonding progress. Hover lift + fade-in effects keep it lively.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { Rocket, Search, Sparkles, TrendingUp, Flame, Clock, Coins, Crown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLivePrice } from "@/lib/livePrice";
import { spotPriceSol, bondingProgress } from "@/lib/curve";
import {
  fetchCoins,
  fetchTickerTrades,
  avatarGradient,
  shortCa,
  fmtUsdK,
  SOL_USD_FEED,
  type Coin,
  type TickerTrade,
} from "./lib";

type Sort = "trending" | "new" | "mcap" | "oldest";

const mcOf = (c: Coin, solUsd: number) =>
  c.state ? spotPriceSol(c.state.virtualSolReserves, c.state.virtualTokenReserves, c.decimals) * 1e9 * solUsd : 0;

export function Home({ onOpen, onCreate }: { onOpen: (mint: string) => void; onCreate: () => void }) {
  const { connection } = useConnection();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("trending");
  const solUsd = useLivePrice(SOL_USD_FEED, 150);

  const coinsQ = useQuery({
    queryKey: ["lp-coins", connection.rpcEndpoint],
    queryFn: () => fetchCoins(connection),
    refetchInterval: 8000,
  });
  const allCoins = coinsQ.data ?? [];

  const coins = useMemo(() => {
    let list = allCoins;
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (c) =>
          c.symbol.toLowerCase().includes(needle) ||
          c.name.toLowerCase().includes(needle) ||
          c.mint.toLowerCase().includes(needle),
      );
    }
    const s = [...list];
    if (sort === "new") s.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === "oldest") s.sort((a, b) => a.createdAt - b.createdAt);
    else s.sort((a, b) => mcOf(b, solUsd) - mcOf(a, solUsd)); // trending / mcap
    return s;
  }, [allCoins, q, sort, solUsd]);

  const trending = useMemo(
    () => [...allCoins].sort((a, b) => mcOf(b, solUsd) - mcOf(a, solUsd)).slice(0, 6),
    [allCoins, solUsd],
  );

  return (
    <div className="space-y-5">
      <TradesTicker coins={allCoins} solUsd={solUsd} />

      {/* hero */}
      <section className="hero-bg relative isolate overflow-hidden rounded-2xl border border-border px-6 py-7 sm:px-10 sm:py-9">
        {/* layer 1: hand-authored illustrated background (trading wheel + curve + glyphs) */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-20">
          <svg
            aria-hidden="true"
            className="lp-hero-svg h-full w-full"
            viewBox="0 0 1200 460"
            preserveAspectRatio="xMidYMid slice"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <radialGradient id="lpGlow" cx="50%" cy="42%" r="60%">
                <stop offset="0%" stopColor="#2ee6c2" stopOpacity="0.20" />
                <stop offset="45%" stopColor="#2ee6c2" stopOpacity="0.06" />
                <stop offset="100%" stopColor="#2ee6c2" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="lpGlowViolet" cx="82%" cy="14%" r="42%">
                <stop offset="0%" stopColor="#7567ff" stopOpacity="0.14" />
                <stop offset="100%" stopColor="#7567ff" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="lpCurve" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#2ee6c2" stopOpacity="0" />
                <stop offset="50%" stopColor="#2ee6c2" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.9" />
              </linearGradient>
              <radialGradient id="lpNode" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#2ee6c2" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#2ee6c2" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* soft neon + violet ambience */}
            <rect x="0" y="0" width="1200" height="460" fill="url(#lpGlow)" />
            <rect x="0" y="0" width="1200" height="460" fill="url(#lpGlowViolet)" />

            {/* central trading wheel: concentric rings + spokes (drifts) */}
            <g className="lp-wheel" style={{ transformOrigin: "600px 230px" }} stroke="#2ee6c2" fill="none">
              <circle cx="600" cy="230" r="70" strokeOpacity="0.28" strokeWidth="1" />
              <circle cx="600" cy="230" r="118" strokeOpacity="0.18" strokeWidth="1" />
              <circle cx="600" cy="230" r="172" strokeOpacity="0.12" strokeWidth="1" />
              <circle cx="600" cy="230" r="232" strokeOpacity="0.08" strokeWidth="1" strokeDasharray="2 8" />
              <circle cx="600" cy="230" r="300" strokeOpacity="0.06" strokeWidth="1" strokeDasharray="1 12" />
              <g strokeOpacity="0.10" strokeWidth="1">
                <line x1="600" y1="10" x2="600" y2="450" />
                <line x1="360" y1="230" x2="840" y2="230" />
                <line x1="430" y1="60" x2="770" y2="400" />
                <line x1="770" y1="60" x2="430" y2="400" />
                <line x1="470" y1="35" x2="730" y2="425" />
                <line x1="730" y1="35" x2="470" y2="425" />
              </g>
              <g stroke="#2ee6c2" strokeOpacity="0.30" strokeWidth="1.4">
                <line x1="600" y1="152" x2="600" y2="164" />
                <line x1="678" y1="230" x2="666" y2="230" />
                <line x1="600" y1="308" x2="600" y2="296" />
                <line x1="522" y1="230" x2="534" y2="230" />
                <line x1="655" y1="175" x2="647" y2="183" />
                <line x1="655" y1="285" x2="647" y2="277" />
                <line x1="545" y1="285" x2="553" y2="277" />
                <line x1="545" y1="175" x2="553" y2="183" />
              </g>
            </g>

            {/* counter-rotating dotted ring for parallax */}
            <circle className="lp-wheel-rev" style={{ transformOrigin: "600px 230px" }}
              cx="600" cy="230" r="200" fill="none" stroke="#38bdf8" strokeOpacity="0.10" strokeWidth="1" strokeDasharray="3 14" />

            {/* bonding-curve arc rising through the frame */}
            <path d="M 150 400 C 360 396 470 340 560 250 S 760 96 1050 70"
              fill="none" stroke="url(#lpCurve)" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
            <path d="M 150 420 C 380 416 500 372 600 292 S 800 150 1060 118"
              fill="none" stroke="#7567ff" strokeOpacity="0.14" strokeWidth="1.5" strokeLinecap="round" />

            {/* faint scattered candlestick marks */}
            <g strokeWidth="4" strokeLinecap="round">
              <g stroke="#16f2b3" strokeOpacity="0.30">
                <line x1="205" y1="150" x2="205" y2="196" />
                <line x1="205" y1="140" x2="205" y2="206" strokeWidth="1" />
              </g>
              <g stroke="#16f2b3" strokeOpacity="0.24">
                <line x1="240" y1="130" x2="240" y2="182" />
                <line x1="240" y1="120" x2="240" y2="192" strokeWidth="1" />
              </g>
              <g stroke="#ff5d6c" strokeOpacity="0.22">
                <line x1="978" y1="270" x2="978" y2="316" />
                <line x1="978" y1="260" x2="978" y2="326" strokeWidth="1" />
              </g>
              <g stroke="#16f2b3" strokeOpacity="0.26">
                <line x1="1012" y1="238" x2="1012" y2="292" />
                <line x1="1012" y1="228" x2="1012" y2="302" strokeWidth="1" />
              </g>
              <g stroke="#16f2b3" strokeOpacity="0.20">
                <line x1="1046" y1="206" x2="1046" y2="256" />
                <line x1="1046" y1="196" x2="1046" y2="266" strokeWidth="1" />
              </g>
            </g>

            {/* crosshair / target glyphs (twinkle) */}
            <g className="lp-twinkle" stroke="#2ee6c2" fill="none">
              <g transform="translate(150 96)" strokeOpacity="0.34">
                <circle r="15" strokeWidth="1.2" />
                <circle r="6" strokeWidth="1" />
                <line x1="-22" y1="0" x2="-17" y2="0" strokeWidth="1.2" />
                <line x1="17" y1="0" x2="22" y2="0" strokeWidth="1.2" />
                <line x1="0" y1="-22" x2="0" y2="-17" strokeWidth="1.2" />
                <line x1="0" y1="17" x2="0" y2="22" strokeWidth="1.2" />
              </g>
              <g transform="translate(1064 372)" strokeOpacity="0.26">
                <circle r="12" strokeWidth="1.2" />
                <line x1="-18" y1="0" x2="18" y2="0" strokeWidth="0.8" strokeOpacity="0.6" />
                <line x1="0" y1="-18" x2="0" y2="18" strokeWidth="0.8" strokeOpacity="0.6" />
              </g>
            </g>

            {/* crossed-circle + hatched-circle glyphs */}
            <g stroke="#7567ff" fill="none" strokeOpacity="0.22">
              <g transform="translate(1080 150)">
                <circle r="16" strokeWidth="1.2" />
                <line x1="-11" y1="-11" x2="11" y2="11" strokeWidth="1" />
                <line x1="-11" y1="11" x2="11" y2="-11" strokeWidth="1" />
              </g>
              <g transform="translate(120 300)" stroke="#2ee6c2" strokeOpacity="0.20">
                <circle r="14" strokeWidth="1.2" />
                <line x1="-14" y1="-4" x2="14" y2="-4" strokeWidth="0.7" />
                <line x1="-14" y1="2" x2="14" y2="2" strokeWidth="0.7" />
                <line x1="-14" y1="8" x2="14" y2="8" strokeWidth="0.7" />
              </g>
            </g>

            {/* small dial / gauge glyph */}
            <g transform="translate(300 350)" stroke="#38bdf8" fill="none" strokeOpacity="0.22">
              <path d="M -16 6 A 18 18 0 0 1 16 6" strokeWidth="1.4" />
              <line x1="0" y1="6" x2="9" y2="-7" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="0" cy="6" r="2" fill="#38bdf8" fillOpacity="0.5" stroke="none" />
            </g>

            {/* node network dots + faint links */}
            <g stroke="#2ee6c2" strokeOpacity="0.10" strokeWidth="1">
              <line x1="360" y1="120" x2="460" y2="180" />
              <line x1="460" y1="180" x2="410" y2="300" />
              <line x1="740" y1="300" x2="860" y2="240" />
              <line x1="860" y1="240" x2="820" y2="130" />
            </g>
            <g className="lp-twinkle" fill="url(#lpNode)">
              <circle cx="360" cy="120" r="7" />
              <circle cx="460" cy="180" r="5" />
              <circle cx="410" cy="300" r="6" />
              <circle cx="740" cy="300" r="6" />
              <circle cx="860" cy="240" r="5" />
              <circle cx="820" cy="130" r="7" />
              <circle cx="690" cy="90" r="4" />
              <circle cx="520" cy="380" r="4" />
            </g>

            {/* scattered particle dots */}
            <g fill="#2ee6c2">
              <circle cx="180" cy="240" r="1.6" fillOpacity="0.5" />
              <circle cx="270" cy="90" r="1.3" fillOpacity="0.4" />
              <circle cx="330" cy="410" r="1.6" fillOpacity="0.45" />
              <circle cx="900" cy="380" r="1.4" fillOpacity="0.4" />
              <circle cx="960" cy="120" r="1.7" fillOpacity="0.5" />
              <circle cx="1120" cy="260" r="1.3" fillOpacity="0.4" />
              <circle cx="640" cy="420" r="1.4" fillOpacity="0.4" />
              <circle cx="560" cy="70" r="1.5" fillOpacity="0.45" />
              <circle cx="1010" cy="330" r="1.2" fillOpacity="0.35" />
              <circle cx="230" cy="330" r="1.3" fillOpacity="0.4" />
            </g>

            {/* 4-point sparkle accents */}
            <g className="lp-twinkle" fill="#2ee6c2">
              <path d="M 828 92 L 831 100 L 839 103 L 831 106 L 828 114 L 825 106 L 817 103 L 825 100 Z" fillOpacity="0.7" />
              <path d="M 372 372 L 374 378 L 380 380 L 374 382 L 372 388 L 370 382 L 364 380 L 370 378 Z" fillOpacity="0.55" />
            </g>
          </svg>
          {/* top + bottom OLED fade so the art melts into the base */}
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(180deg, rgba(5,7,10,0.55) 0%, transparent 24%, transparent 70%, rgba(5,7,10,0.92) 100%)" }}
          />
        </div>

        {/* layer 2: radial spotlight behind the glass */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(620px 320px at 50% 30%, rgba(46,230,194,0.10), transparent 65%), radial-gradient(460px 260px at 74% 8%, rgba(117,103,255,0.08), transparent 60%)",
          }}
        />
        {/* layer 3: subtle diagonal sheen sweeping the whole band */}
        <div aria-hidden className="lp-hero-sheen pointer-events-none absolute inset-0 -z-10" />

        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <span
            className="lp-fade-up mb-3 inline-flex items-center gap-1.5 rounded-full border border-neon/25 bg-neon/5 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-neon backdrop-blur"
            style={{ animationDelay: "40ms" }}
          >
            <Sparkles className="h-3 w-3" /> Curve plus perp, one token
          </span>

          <h1
            className="lp-fade-up font-display text-2xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-4xl"
            style={{ animationDelay: "120ms" }}
          >
            Every coin ships with{" "}
            <span className="relative whitespace-nowrap text-neon">
              leverage
              <span aria-hidden className="lph-underline absolute inset-x-0 -bottom-1 h-px bg-neon/70" />
            </span>{" "}
            on day one
          </h1>

          <p
            className="lp-fade-up mt-2.5 max-w-2xl text-xs text-muted-foreground sm:text-sm"
            style={{ animationDelay: "200ms" }}
          >
            Trade the launch curve and open a leveraged position on the same token from the very first block.
          </p>

          {/* glassy glowing CTA (the hero) */}
          <div className="lp-fade-up relative mt-6" style={{ animationDelay: "300ms" }}>
            <Sparkles
              aria-hidden
              className="lph-sparkle absolute -right-3 -top-4 h-5 w-5 text-neon"
              style={{ filter: "drop-shadow(0 0 6px rgba(46,230,194,0.9))" }}
            />
            <div
              aria-hidden
              className="lph-breathe pointer-events-none absolute -inset-3 -z-10 rounded-full blur-xl"
              style={{
                background:
                  "radial-gradient(closest-side, rgba(46,230,194,0.45), transparent 70%), radial-gradient(closest-side at 70% 60%, rgba(117,103,255,0.35), transparent 70%)",
              }}
            />
            <button
              type="button"
              onClick={onCreate}
              className="group relative inline-flex items-center gap-2.5 overflow-hidden rounded-full border border-neon/40 bg-neon/10 px-7 py-3 font-display text-base font-semibold text-foreground backdrop-blur-md transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
              style={{
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 22px rgba(46,230,194,0.16), 0 0 0 1px rgba(46,230,194,0.35), 0 18px 48px -14px rgba(46,230,194,0.6), 0 8px 30px -12px rgba(117,103,255,0.45)",
              }}
            >
              <span aria-hidden className="pointer-events-none absolute inset-x-4 top-0 h-1/2 rounded-b-full bg-gradient-to-b from-white/15 to-transparent" />
              <span aria-hidden className="lph-streak pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 skew-x-[-20deg] bg-gradient-to-r from-transparent via-white/25 to-transparent" />
              <Rocket className="relative h-5 w-5 text-neon transition-transform duration-200 group-hover:rotate-6" style={{ filter: "drop-shadow(0 0 5px rgba(46,230,194,0.8))" }} />
              <span className="relative text-neon">Launch your coin</span>
            </button>
          </div>

          {/* trust line (no counts) */}
          <p
            className="lp-fade-up mt-3.5 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
            style={{ animationDelay: "380ms" }}
          >
            Permissionless, on-chain, live from launch
          </p>
        </div>
      </section>

      {/* king of the hill + trending leaderboard, right under the banner */}
      {trending.length > 0 ? (
        <section className="space-y-3">
          <KingOfHill coin={trending[0]} solUsd={solUsd} onClick={() => onOpen(trending[0].mint)} />
          {trending.length > 1 ? (
            <>
              <div className="flex items-center gap-1.5 text-base font-semibold text-foreground">
                <Flame className="h-4 w-4 text-neon" /> Trending Now
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {trending.slice(1).map((c, i) => (
                  <TrendingCard key={c.mint} coin={c} solUsd={solUsd} rank={i + 2} onClick={() => onOpen(c.mint)} />
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative grow">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, symbol or address" className="pl-9" />
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <SortTab active={sort === "trending"} onClick={() => setSort("trending")} icon={<Flame className="h-3.5 w-3.5" />}>Trending</SortTab>
          <SortTab active={sort === "new"} onClick={() => setSort("new")} icon={<Sparkles className="h-3.5 w-3.5" />}>New</SortTab>
          <SortTab active={sort === "mcap"} onClick={() => setSort("mcap")} icon={<Coins className="h-3.5 w-3.5" />}>Market cap</SortTab>
          <SortTab active={sort === "oldest"} onClick={() => setSort("oldest")} icon={<Clock className="h-3.5 w-3.5" />}>Oldest</SortTab>
        </div>
      </div>

      {/* grid */}
      {coinsQ.isLoading ? (
        <Skeletons />
      ) : coins.length === 0 ? (
        <Empty onCreate={onCreate} hasQuery={!!q.trim()} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {coins.map((c, i) => (
            <CoinCard key={c.mint} coin={c} solUsd={solUsd} index={i} onClick={() => onOpen(c.mint)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- trades ticker ----------

function TradesTicker({ coins, solUsd }: { coins: Coin[]; solUsd: number }) {
  const { connection } = useConnection();
  const q = useQuery({
    queryKey: ["lp-ticker", coins.map((c) => c.mint).join(",")],
    enabled: coins.length > 0,
    queryFn: () => fetchTickerTrades(connection, coins),
    refetchInterval: 15000,
  });
  const trades = q.data ?? [];
  if (trades.length === 0) return null;
  const loop = [...trades, ...trades];
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background/60">
      <div className="lp-marquee gap-2 py-1.5">
        {loop.map((t, i) => (
          <TickerItem key={i} t={t} solUsd={solUsd} />
        ))}
      </div>
    </div>
  );
}

function TickerItem({ t, solUsd }: { t: TickerTrade; solUsd: number }) {
  const usd = t.sol * solUsd;
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[11px]">
      {t.coinImage ? (
        <img src={t.coinImage} alt="" className="h-3.5 w-3.5 rounded-full object-cover" />
      ) : (
        <span className="h-3.5 w-3.5 rounded-full" style={{ background: avatarGradient(t.coinMint) }} />
      )}
      <span className={t.type === "buy" ? "font-medium text-green-500" : "font-medium text-red-500"}>
        {t.type === "buy" ? "BUY" : "SELL"}
      </span>
      <span className="font-mono">{fmtUsd(usd)}</span>
      <span className="text-muted-foreground">of</span>
      <span className="font-semibold">{t.coinSymbol}</span>
    </span>
  );
}

// ---------- cards ----------

function KingOfHill({ coin, solUsd, onClick }: { coin: Coin; solUsd: number; onClick: () => void }) {
  const mc = mcOf(coin, solUsd);
  const progress = coin.state ? bondingProgress(coin.state) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="lp-card group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border border-neon/30 p-4 text-left"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: "radial-gradient(420px 160px at 15% 0%, rgba(46,230,194,0.14), transparent 70%)" }}
      />
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl">
        {coin.image ? (
          <img src={coin.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full" style={{ background: avatarGradient(coin.mint) }} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] text-neon">
          <Crown className="h-4 w-4" /> King of the hill
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="truncate text-lg font-semibold">{coin.symbol}</span>
          <span className="truncate text-sm text-muted-foreground">{coin.name}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-base font-semibold text-neon">{mc > 0 ? fmtUsdK(mc) : "—"}</span>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-neon" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="text-[10px] text-muted-foreground">{Math.round(progress * 100)}% bonded</span>
        </div>
      </div>
    </button>
  );
}

function TrendingCard({ coin, solUsd, rank, onClick }: { coin: Coin; solUsd: number; rank?: number; onClick: () => void }) {
  const mc = mcOf(coin, solUsd);
  return (
    <button
      type="button"
      onClick={onClick}
      className="lp-card flex w-52 shrink-0 items-center gap-2.5 rounded-xl border border-border p-2 text-left"
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
        {coin.image ? (
          <img src={coin.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full" style={{ background: avatarGradient(coin.mint) }} />
        )}
        {rank ? (
          <span className="absolute left-0 top-0 rounded-br-md bg-background/80 px-1 text-[9px] font-semibold text-neon backdrop-blur">
            #{rank}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-tight">{coin.symbol}</div>
        <div className="truncate text-[11px] leading-tight text-muted-foreground">{coin.name}</div>
        <div className="mt-0.5 font-mono text-[11px] text-neon">MCap {mc > 0 ? fmtUsdK(mc) : "—"}</div>
      </div>
    </button>
  );
}

function CoinCard({
  coin,
  solUsd,
  index,
  onClick,
}: {
  coin: Coin;
  solUsd: number;
  index: number;
  onClick: () => void;
}) {
  const st = coin.state;
  const mc = mcOf(coin, solUsd);
  const progress = st ? bondingProgress(st) : 0;
  const graduated = !!st?.complete;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
      className="lp-card lp-fade-up flex gap-3 rounded-xl border border-border p-2.5 text-left"
    >
      <div className="relative h-[84px] w-[84px] shrink-0 overflow-hidden rounded-lg bg-muted">
        {coin.image ? (
          <img src={coin.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full" style={{ background: avatarGradient(coin.mint) }} />
        )}
        <span className="absolute left-1 top-1 rounded bg-background/70 px-1 py-0.5 text-[8px] font-medium uppercase text-muted-foreground backdrop-blur">
          {graduated ? "Live" : "Perp 5x"}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between gap-1">
          <span className="truncate text-sm font-semibold">{coin.symbol}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(coin.createdAt)}</span>
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{coin.name}</div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{shortCa(coin.mint)}</div>
        <div className="mt-auto space-y-1 pt-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Market cap</span>
            <span className="font-mono text-xs font-semibold text-neon">{mc > 0 ? fmtUsdK(mc) : "—"}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-neon transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="shrink-0 text-[9px] text-muted-foreground">{Math.round(progress * 100)}%</span>
          </div>
        </div>
      </div>
    </button>
  );
}

// ---------- bits ----------

function SortTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function Skeletons() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-52 animate-pulse rounded-xl border border-border bg-muted/30" />
      ))}
    </div>
  );
}

function Empty({ onCreate, hasQuery }: { onCreate: () => void; hasQuery: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
      <p className="text-sm text-muted-foreground">
        {hasQuery ? "No coins match your search." : "Nothing here yet. Be the first to launch."}
      </p>
      {!hasQuery ? (
        <Button onClick={onCreate} className="gap-1.5">
          <Rocket className="h-4 w-4" /> Create the first coin
        </Button>
      ) : null}
    </div>
  );
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

function timeAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
