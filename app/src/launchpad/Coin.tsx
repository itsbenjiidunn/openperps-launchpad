/// Coin detail: identity + a candlestick market-cap chart +
/// a Trades/Holders feed on the left; a Spot|Perp trade widget, the bonding-curve meter,
/// an Information panel (price, market cap, live txn/volume/maker stats from recent
/// trades) and an Other-Info panel (creator, contract, pool, time) on the right. Both
/// venues live here; the main terminal stays perp-only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createTransferInstruction } from "@solana/spl-token";
import { VAULT_SEED } from "@opp-oss/sdk";
import { ArrowLeft, Check, Copy, TrendingUp, Coins, Loader2, Globe, Send, Twitter, Gift } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchComments, postComment } from "@/lib/indexer";
import { CurvePanel } from "@/components/openperps/CurvePanel";
import { OrderPanel } from "@/components/openperps/OrderPanel";
import { useMarkets } from "@/lib/onchain";
import { useLivePrice } from "@/lib/livePrice";
import { PROGRAM_ID } from "@/lib/program";
import { spotPriceSol, bondingProgress, curveVaultPda, curvePda, decodeBondingCurve, buildClaimFeesIx } from "@/lib/curve";
import {
  fetchCoin,
  fetchCurveTrades,
  fetchHolders,
  fetchTokenMeta,
  avatarGradient,
  shortCa,
  fmtUsdK,
  SOL_USD_FEED,
  type CurveTrade,
  type Holder,
} from "./lib";
import { CoinChart } from "./CoinChart";

const TOTAL_SUPPLY = 1_000_000_000; // launch-fixed; market cap = price x supply

type Tab = "spot" | "perp";
type FeedTab = "trades" | "holders" | "comments";

export function Coin({ mint, onBack }: { mint: string; onBack: () => void }) {
  const { connection } = useConnection();
  const [tab, setTab] = useState<Tab>("spot");
  const [feed, setFeed] = useState<FeedTab>("trades");

  const coinQ = useQuery({
    queryKey: ["lp-coin", mint, connection.rpcEndpoint],
    queryFn: () => fetchCoin(connection, mint),
    refetchInterval: 3000,
  });
  const coin = coinQ.data;
  const st = coin?.state ?? null;
  const decimals = coin?.decimals ?? 6;

  // Creator-fee claim: the creator can sweep accrued fees (lamports in the curve
  // account beyond rent + the withdrawable raised SOL) anytime.
  const wallet = useWallet();
  const isCreator = !!wallet.publicKey && !!st && wallet.publicKey.equals(st.creator);
  const [claiming, setClaiming] = useState(false);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const claimQ = useQuery({
    queryKey: ["lp-claimable", mint, connection.rpcEndpoint],
    enabled: !!st,
    queryFn: async () => {
      const [curve] = curvePda(new PublicKey(mint));
      const [acc, rent] = await Promise.all([
        connection.getAccountInfo(curve, "confirmed"),
        connection.getMinimumBalanceForRentExemption(160),
      ]);
      if (!acc) return 0;
      const decoded = decodeBondingCurve(new Uint8Array(acc.data));
      return Math.max(0, acc.lamports - rent - Number(decoded.realSolReserves));
    },
    refetchInterval: 6000,
  });
  const claimable = claimQ.data ?? 0;

  async function onClaim() {
    setClaimErr(null);
    if (!wallet.publicKey || !wallet.sendTransaction) return setClaimErr("Connect a wallet first.");
    setClaiming(true);
    try {
      const ix = buildClaimFeesIx({ creator: wallet.publicKey, mint: new PublicKey(mint) });
      const sig = await wallet.sendTransaction(new Transaction().add(ix), connection);
      await connection.confirmTransaction(sig, "confirmed");
      await claimQ.refetch();
    } catch (e) {
      setClaimErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(false);
    }
  }

  // Holder rewards: the creator airdrops tokens from their wallet to current
  // holders, split pro-rata by how much each one holds (batched transfers).
  const [airdropAmt, setAirdropAmt] = useState("");
  const [airdropping, setAirdropping] = useState(false);
  const [airdropMsg, setAirdropMsg] = useState<string | null>(null);

  async function onAirdrop() {
    setAirdropMsg(null);
    if (!wallet.publicKey || !wallet.sendTransaction) return setAirdropMsg("Connect a wallet first.");
    const ui = Number(airdropAmt);
    if (!(ui > 0)) return setAirdropMsg("Enter a token amount.");
    setAirdropping(true);
    try {
      const mintPk = new PublicKey(mint);
      const holders = (await fetchHolders(connection, mint, decimals))
        .filter((h) => h.owner && !h.tag && h.owner !== wallet.publicKey!.toBase58() && h.amount > 0)
        .slice(0, 15);
      if (holders.length === 0) throw new Error("No eligible holders yet.");
      const total = holders.reduce((a, h) => a + h.amount, 0);
      const src = getAssociatedTokenAddressSync(mintPk, wallet.publicKey);
      const scale = 10 ** decimals;
      const ixs = holders
        .map((h) => {
          const share = Math.floor((h.amount / total) * ui * scale);
          return share > 0
            ? createTransferInstruction(src, new PublicKey(h.account), wallet.publicKey!, BigInt(share))
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (ixs.length === 0) throw new Error("Amount too small to split across holders.");
      for (let i = 0; i < ixs.length; i += 8) {
        const tx = new Transaction().add(...ixs.slice(i, i + 8));
        const sig = await wallet.sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, "confirmed");
      }
      setAirdropMsg(`Airdropped to ${ixs.length} holders.`);
      setAirdropAmt("");
    } catch (e) {
      setAirdropMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAirdropping(false);
    }
  }

  const marketsQ = useMarkets();
  const perpMarket = coin?.market ? marketsQ.data?.find((m) => m.pubkey === coin.market) : undefined;

  // Live SOL/USD (Pyth Hermes) so the market cap shows in USD.
  const solUsd = useLivePrice(SOL_USD_FEED, 150);
  const metaQ = useQuery({
    queryKey: ["lp-meta", mint],
    queryFn: () => fetchTokenMeta(connection, mint),
    staleTime: 60_000,
  });
  const meta = metaQ.data ?? null;

  const tradesQ = useQuery({
    queryKey: ["lp-trades", mint, connection.rpcEndpoint],
    queryFn: () => fetchCurveTrades(connection, mint),
    refetchInterval: 10_000,
  });
  const holdersQ = useQuery({
    queryKey: ["lp-holders", mint, coin?.market, connection.rpcEndpoint],
    enabled: feed === "holders",
    queryFn: () => {
      const labels: Record<string, string> = {
        [curveVaultPda(new PublicKey(mint))[0].toBase58()]: "Bonding curve",
      };
      if (coin?.market) {
        const house = PublicKey.findProgramAddressSync(
          [VAULT_SEED, new PublicKey(coin.market).toBuffer()],
          PROGRAM_ID,
        )[0].toBase58();
        labels[house] = "Perp House";
      }
      return fetchHolders(connection, mint, decimals, labels);
    },
    refetchInterval: 20_000,
  });

  const price = st ? spotPriceSol(st.virtualSolReserves, st.virtualTokenReserves, decimals) : 0;
  const mcSol = price * TOTAL_SUPPLY;
  const mcUsd = mcSol * solUsd; // market cap in USD at the live SOL price
  const progress = st ? bondingProgress(st) : 0;
  const raised = st ? Number(st.realSolReserves) / 1e9 : 0;
  const target = st ? Number(st.graduateSolThreshold) / 1e9 : 0;

  // Live stats from the recent trades (no all-time index yet).
  const trades = tradesQ.data ?? [];
  const buys = trades.filter((t) => t.type === "buy");
  const sells = trades.filter((t) => t.type === "sell");
  const buyVol = buys.reduce((s, t) => s + t.sol, 0);
  const sellVol = sells.reduce((s, t) => s + t.sol, 0);
  const makers = new Set(trades.map((t) => t.trader)).size;

  // Chart history (market cap, USD) from each trade's avg execution price x the live
  // SOL price, plus the all-time-high and the change since the oldest tracked trade.
  // (Recent trades only; historical SOL price is approximated by the current one.)
  const chartHistory = trades
    .map((t) => ({
      time: Math.floor(t.ts / 1000),
      value: t.tokens > 0 ? (t.sol / t.tokens) * TOTAL_SUPPLY * solUsd : 0,
    }))
    .filter((p) => p.value > 0);
  const ath = Math.max(mcUsd, ...chartHistory.map((p) => p.value), 0);
  const oldest = chartHistory.length
    ? chartHistory.reduce((a, b) => (a.time < b.time ? a : b)).value
    : mcUsd;
  const changePct = oldest > 0 ? ((mcUsd - oldest) / oldest) * 100 : 0;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All coins
      </button>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* LEFT: identity + chart + feed */}
        <div className="space-y-4">
          <div className="flex items-center gap-4 rounded-xl border border-border p-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl" style={{ background: avatarGradient(mint) }}>
              {meta?.image ? <img src={meta.image} alt="" className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate font-display text-xl font-semibold">{meta?.symbol || coin?.symbol || "…"}</h1>
                {st?.complete ? (
                  <span className="rounded bg-neon/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neon">
                    Graduated
                  </span>
                ) : (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    Perp 5x
                  </span>
                )}
              </div>
              <div className="truncate text-sm text-muted-foreground">{meta?.name || coin?.name}</div>
              <div className="mt-0.5 flex items-center gap-2">
                <CopyText text={mint} display={`${mint.slice(0, 6)}…${mint.slice(-6)}`} />
              </div>
              {meta?.twitter || meta?.telegram || meta?.website ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {meta?.twitter ? (
                    <Social href={meta.twitter} icon={<Twitter className="h-3 w-3" />} label={socialLabel(meta.twitter, "twitter")} />
                  ) : null}
                  {meta?.telegram ? (
                    <Social href={meta.telegram} icon={<Send className="h-3 w-3" />} label={socialLabel(meta.telegram, "telegram")} />
                  ) : null}
                  {meta?.website ? (
                    <Social href={meta.website} icon={<Globe className="h-3 w-3" />} label={socialLabel(meta.website, "website")} />
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="ml-auto text-right">
              <div className="text-[11px] text-muted-foreground">Price</div>
              <div className="font-mono text-base">{price > 0 ? fmtUsdK(price * solUsd) : "—"}</div>
            </div>
          </div>

          {/* candlestick chart (market cap, SOL) */}
          <div className="rounded-xl border border-border p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium">Market cap</span>
              <span className="font-mono text-sm text-neon">{mcUsd > 0 ? fmtUsdK(mcUsd) : "—"}</span>
              {changePct !== 0 ? (
                <span className={`font-mono text-xs ${changePct >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {changePct >= 0 ? "+" : ""}
                  {changePct.toFixed(2)}%
                </span>
              ) : null}
            </div>
            <AthBar current={mcUsd} ath={ath} />
            {st ? (
              <CoinChart history={chartHistory} value={mcUsd} className="h-64 w-full" />
            ) : (
              <div className="h-64 animate-pulse rounded bg-muted/30" />
            )}
            <div className="mt-3 space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-neon transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{raised.toFixed(2)} SOL raised</span>
                <span>{target.toFixed(0)} SOL to graduate</span>
              </div>
            </div>
          </div>

          {/* trades / holders feed */}
          <div className="rounded-xl border border-border">
            <div className="flex items-center gap-1 border-b border-border p-1">
              <FeedTabBtn active={feed === "trades"} onClick={() => setFeed("trades")}>
                Trades
              </FeedTabBtn>
              <FeedTabBtn active={feed === "holders"} onClick={() => setFeed("holders")}>
                Holders
              </FeedTabBtn>
              <FeedTabBtn active={feed === "comments"} onClick={() => setFeed("comments")}>
                Comments
              </FeedTabBtn>
            </div>
            {feed === "trades" ? (
              <TradesTable loading={tradesQ.isLoading} trades={trades} />
            ) : feed === "holders" ? (
              <HoldersTable loading={holdersQ.isLoading} holders={holdersQ.data ?? []} />
            ) : (
              <CommentsPanel mint={mint} />
            )}
          </div>
        </div>

        {/* RIGHT: trade widget + meters + info */}
        <div className="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
            <TabBtn active={tab === "spot"} onClick={() => setTab("spot")} icon={<TrendingUp className="h-3.5 w-3.5" />}>
              Spot
            </TabBtn>
            <TabBtn active={tab === "perp"} onClick={() => setTab("perp")} icon={<Coins className="h-3.5 w-3.5" />}>
              Perp
            </TabBtn>
          </div>

          {tab === "spot" ? (
            <CurvePanel mint={mint} decimals={decimals} market={coin?.market || undefined} />
          ) : perpMarket ? (
            <OrderPanel market={perpMarket} />
          ) : (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-border p-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the perp…
            </div>
          )}

          {/* bonding meter */}
          <div className="rounded-xl border border-border p-3">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-medium">Bonding curve</span>
              <span className="font-mono text-neon">{(progress * 100).toFixed(1)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-neon transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {st?.complete
                ? "Graduated to a spot pool."
                : `${raised.toFixed(2)} / ${target.toFixed(0)} SOL raised. At graduation the curve seeds a spot pool; the perp House stays.`}
            </p>
          </div>

          {/* information */}
          <div className="space-y-2 rounded-xl border border-border p-3">
            <div className="text-xs font-medium">Information</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Mini label="Price" value={price > 0 ? fmtUsdK(price * solUsd) : "—"} sub="USD" />
              <Mini label="Mkt cap" value={mcUsd > 0 ? fmtUsdK(mcUsd) : "—"} sub="USD" />
              <Mini label="FDV" value={mcUsd > 0 ? fmtUsdK(mcUsd) : "—"} sub="USD" />
            </div>
            <div className="border-t border-border pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Recent ({trades.length} trades)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <BarStat label="Txns" total={trades.length} a={buys.length} b={sells.length} aLabel="buys" bLabel="sells" />
              <BarStat label="Volume" total={buyVol + sellVol} a={buyVol} b={sellVol} aLabel="buy" bLabel="sell" fmt={(n) => `${n.toFixed(2)} SOL`} />
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Makers</span>
              <span className="font-mono">{makers}</span>
            </div>
          </div>

          {/* creator fee */}
          {st && st.feeBps > 0 ? (
            <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Coins className="h-3.5 w-3.5 text-neon" /> Creator fee
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Fee per trade</span>
                <span className="font-mono text-neon">{(st.feeBps / 100).toFixed(2)}%</span>
              </div>
              {isCreator ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Claimable</span>
                    <span className="font-mono">{(claimable / 1e9).toFixed(4)} SOL</span>
                  </div>
                  <Button size="sm" className="w-full" disabled={claiming || claimable <= 0} onClick={onClaim}>
                    {claiming ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Claiming…
                      </>
                    ) : (
                      "Claim fees"
                    )}
                  </Button>
                  {claimErr ? <p className="text-red-500">{claimErr}</p> : null}
                </>
              ) : null}
            </div>
          ) : null}

          {/* reward holders (creator airdrop) */}
          {isCreator ? (
            <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Gift className="h-3.5 w-3.5 text-neon" /> Reward holders
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Airdrop tokens from your wallet to current holders, split by how much each one holds.
              </p>
              <div className="flex gap-2">
                <Input
                  value={airdropAmt}
                  onChange={(e) => setAirdropAmt(e.target.value)}
                  placeholder="Token amount"
                  inputMode="decimal"
                  disabled={airdropping}
                />
                <Button size="sm" disabled={airdropping || !airdropAmt} onClick={onAirdrop}>
                  {airdropping ? <Loader2 className="h-4 w-4 animate-spin" /> : "Airdrop"}
                </Button>
              </div>
              {airdropMsg ? <p className="text-[11px] text-muted-foreground">{airdropMsg}</p> : null}
            </div>
          ) : null}

          {/* other info */}
          <div className="space-y-2 rounded-xl border border-border p-3 text-xs">
            <div className="text-xs font-medium">Other info</div>
            <InfoRow label="Creator" value={st ? st.creator.toBase58() : "—"} copy />
            <InfoRow label="Contract" value={mint} copy />
            <InfoRow label="Curve" value={coin?.curve ?? "—"} copy={!!coin?.curve} />
            <InfoRow label="Perp market" value={coin?.market || "—"} copy={!!coin?.market} />
            {coin?.createdAt ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Created</span>
                <span className="font-mono">
                  {new Date(coin.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- feed tables ----------

function TradesTable({ loading, trades }: { loading: boolean; trades: CurveTrade[] }) {
  if (loading) return <Empty>Loading trades…</Empty>;
  if (trades.length === 0) return <Empty>No trades yet. Be the first to buy.</Empty>;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-background text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="p-2 text-left font-normal">Account</th>
            <th className="p-2 text-left font-normal">Type</th>
            <th className="p-2 text-right font-normal">SOL</th>
            <th className="p-2 text-right font-normal">Tokens</th>
            <th className="p-2 text-right font-normal">Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.sig} className="border-t border-border/50">
              <td className="p-2 font-mono text-muted-foreground">{shortCa(t.trader)}</td>
              <td className={`p-2 font-medium ${t.type === "buy" ? "text-green-500" : "text-red-500"}`}>
                {t.type.toUpperCase()}
              </td>
              <td className="p-2 text-right font-mono">{t.sol.toFixed(3)}</td>
              <td className="p-2 text-right font-mono">{compact(t.tokens)}</td>
              <td className="p-2 text-right text-muted-foreground">{timeAgo(t.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldersTable({ loading, holders }: { loading: boolean; holders: Holder[] }) {
  if (loading) return <Empty>Loading holders…</Empty>;
  if (holders.length === 0) return <Empty>No holders yet.</Empty>;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-background text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="p-2 text-left font-normal">Holder</th>
            <th className="p-2 text-right font-normal">Amount</th>
            <th className="p-2 text-right font-normal">Share</th>
          </tr>
        </thead>
        <tbody>
          {holders.map((h) => (
            <tr key={h.account} className="border-t border-border/50">
              <td className="p-2">
                {h.tag ? (
                  <span className="rounded bg-neon/10 px-1.5 py-0.5 text-[10px] text-neon">{h.tag}</span>
                ) : (
                  <span className="font-mono text-muted-foreground">{shortCa(h.owner ?? h.account)}</span>
                )}
              </td>
              <td className="p-2 text-right font-mono">{compact(h.amount)}</td>
              <td className="p-2 text-right font-mono">{h.pct.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- small bits ----------

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-xs text-muted-foreground">{children}</div>;
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
      {sub ? <div className="text-[9px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function BarStat({
  label,
  total,
  a,
  b,
  aLabel,
  bLabel,
  fmt = (n: number) => String(n),
}: {
  label: string;
  total: number;
  a: number;
  b: number;
  aLabel: string;
  bLabel: string;
  fmt?: (n: number) => string;
}) {
  const ap = total > 0 ? (a / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{fmt(total)}</span>
      </div>
      <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="bg-green-500" style={{ width: `${ap}%` }} title={`${aLabel}: ${fmt(a)}`} />
        <div className="bg-red-500" style={{ width: `${100 - ap}%` }} title={`${bLabel}: ${fmt(b)}`} />
      </div>
    </div>
  );
}

function InfoRow({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      {copy && value !== "—" ? (
        <CopyText text={value} display={shortCa(value)} />
      ) : (
        <span className="font-mono">{value}</span>
      )}
    </div>
  );
}

function TabBtn({
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
      className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function FeedTabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function CopyText({ text, display }: { text: string; display: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      title={text}
    >
      {display}
      {copied ? <Check className="h-3 w-3 text-neon" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Social({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-neon/40 hover:text-foreground"
    >
      {icon}
      <span className="max-w-[130px] truncate">{label}</span>
    </a>
  );
}

/// Short human label for a social link: @handle for X, the path for Telegram, the
/// bare domain for a website.
function socialLabel(url: string, kind: "twitter" | "telegram" | "website"): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (kind === "website") return u.hostname.replace(/^www\./, "");
    const handle = u.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
    if (kind === "twitter") return handle ? `@${handle}` : "X";
    return handle || "Telegram";
  } catch {
    return kind === "twitter" ? "X" : kind === "telegram" ? "Telegram" : "Website";
  }
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

/// All-time-high meter: a gold bar filled to current/ATH. When the price is at a
/// new all-time high the tip throws off sparks.
function AthBar({ current, ath }: { current: number; ath: number }) {
  const progress = ath > 0 ? Math.max(0, Math.min(1, current / ath)) : 0;
  const atAth = ath > 0 && current > 0 && current >= ath - Math.max(1, ath * 1e-6);
  const sparks = [
    { dx: 13, dy: -9 },
    { dx: 18, dy: -3 },
    { dx: 16, dy: 5 },
    { dx: 11, dy: 10 },
    { dx: 20, dy: 1 },
  ];
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className="relative h-2 flex-1 rounded-full bg-muted">
        <div
          className="relative h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.max(3, progress * 100)}%`,
            background: "linear-gradient(90deg, #16a98e, #2ee6c2, #9fffec)",
            boxShadow: atAth ? "0 0 10px 1px rgba(46,230,194,0.65)" : "none",
          }}
        >
          {atAth ? (
            <span aria-hidden className="pointer-events-none absolute right-0 top-1/2">
              <span className="lp-ath-core" />
              {sparks.map((s, i) => (
                <span
                  key={i}
                  className="lp-ath-spark"
                  style={
                    { "--dx": `${s.dx}px`, "--dy": `${s.dy}px`, animationDelay: `${i * 0.14}s` } as React.CSSProperties
                  }
                />
              ))}
            </span>
          ) : null}
        </div>
      </div>
      <span className={`shrink-0 font-mono text-xs ${atAth ? "text-neon" : "text-muted-foreground"}`}>
        ATH {ath > 0 ? fmtUsdK(ath) : "—"}
      </span>
    </div>
  );
}

function CommentsPanel({ mint }: { mint: string }) {
  const wallet = useWallet();
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const q = useQuery({
    queryKey: ["lp-comments", mint],
    queryFn: () => fetchComments(mint),
    refetchInterval: 8000,
  });
  const comments = q.data ?? [];

  async function submit() {
    if (!wallet.publicKey || !text.trim() || posting) return;
    setPosting(true);
    const ok = await postComment(mint, wallet.publicKey.toBase58(), text.trim());
    setPosting(false);
    if (ok) {
      setText("");
      await q.refetch();
    }
  }

  return (
    <div className="space-y-3 p-3">
      {wallet.publicKey ? (
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Post a comment"
            maxLength={500}
            disabled={posting}
          />
          <Button size="sm" disabled={posting || !text.trim()} onClick={submit}>
            {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Post"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Connect a wallet to join the conversation.</p>
      )}
      {q.isLoading ? (
        <Empty>Loading comments…</Empty>
      ) : comments.length === 0 ? (
        <Empty>No comments yet. Say gm.</Empty>
      ) : (
        <ul className="max-h-80 space-y-2 overflow-auto">
          {comments.map((c) => (
            <li key={c.id} className="rounded-lg border border-border p-2">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span className="font-mono">{shortCa(c.author)}</span>
                <span>{timeAgo(c.ts)}</span>
              </div>
              <p className="mt-1 break-words text-xs">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function timeAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
