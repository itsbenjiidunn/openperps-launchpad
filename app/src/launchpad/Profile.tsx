/// Launchpad profile page (pump-style): a wallet's created coins, its creator
/// rewards (claim the fees earned on its coins), and its token balances. Works for
/// any wallet address (#/profile/<addr>) or the connected wallet (#/profile).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ArrowLeft, ArrowUpRight, Check, Copy, Coins, Gift, Wallet as WalletIcon, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WalletButton } from "@/components/openperps/WalletButton";
import { useLivePrice } from "@/lib/livePrice";
import { spotPriceSol, curvePda, decodeBondingCurve, buildClaimFeesIx } from "@/lib/curve";
import { fetchCreatedCoins, avatarGradient, shortCa, fmtUsdK, SOL_USD_FEED, type Coin } from "./lib";

type Tab = "created" | "rewards" | "wallet";
type Reward = { coin: Coin; claimable: number };
type Balances = { sol: number; tokens: { mint: string; amount: number }[] };

const mcOf = (c: Coin, solUsd: number) =>
  c.state ? spotPriceSol(c.state.virtualSolReserves, c.state.virtualTokenReserves, c.decimals) * 1e9 * solUsd : 0;

export function Profile({
  address,
  onOpen,
  onBack,
}: {
  address?: string;
  onOpen: (mint: string) => void;
  onBack: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const addr = address ?? wallet.publicKey?.toBase58() ?? "";
  const isSelf = !!wallet.publicKey && addr === wallet.publicKey.toBase58();
  const solUsd = useLivePrice(SOL_USD_FEED, 150);
  const [tab, setTab] = useState<Tab>("created");
  const [copied, setCopied] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<string | null>(null);

  const createdQ = useQuery({
    queryKey: ["lp-created", addr, connection.rpcEndpoint],
    enabled: !!addr,
    queryFn: () => fetchCreatedCoins(connection, addr),
    refetchInterval: 10000,
  });
  const created = createdQ.data ?? [];

  const rewardsQ = useQuery({
    queryKey: ["lp-rewards", addr, created.map((c) => c.mint).join(",")],
    enabled: !!addr && created.length > 0,
    queryFn: async (): Promise<Reward[]> => {
      const rent = await connection.getMinimumBalanceForRentExemption(160);
      return Promise.all(
        created.map(async (c): Promise<Reward> => {
          try {
            const [curve] = curvePda(new PublicKey(c.mint));
            const acc = await connection.getAccountInfo(curve, "confirmed");
            if (!acc) return { coin: c, claimable: 0 };
            const dec = decodeBondingCurve(new Uint8Array(acc.data));
            return { coin: c, claimable: Math.max(0, acc.lamports - rent - Number(dec.realSolReserves)) };
          } catch {
            return { coin: c, claimable: 0 };
          }
        }),
      );
    },
    refetchInterval: 8000,
  });
  const rewards = rewardsQ.data ?? [];
  const totalClaimable = rewards.reduce((a, r) => a + r.claimable, 0);

  const balancesQ = useQuery({
    queryKey: ["lp-wallet-bal", addr, connection.rpcEndpoint],
    enabled: !!addr,
    queryFn: async (): Promise<Balances> => {
      const [lamports, toks] = await Promise.all([
        connection.getBalance(new PublicKey(addr), "confirmed"),
        connection.getParsedTokenAccountsByOwner(new PublicKey(addr), { programId: TOKEN_PROGRAM_ID }, "confirmed"),
      ]);
      const tokens = toks.value
        .map((ta) => {
          const info = (ta.account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } }).parsed?.info;
          return { mint: info?.mint ?? "", amount: info?.tokenAmount?.uiAmount ?? 0 };
        })
        .filter((t) => t.mint && t.amount > 0)
        .sort((a, b) => b.amount - a.amount);
      return { sol: lamports / 1e9, tokens };
    },
    refetchInterval: 15000,
  });
  const bal = balancesQ.data;

  async function claim(mints: string[]) {
    setClaimMsg(null);
    if (!wallet.publicKey || !wallet.sendTransaction) return setClaimMsg("Connect a wallet first.");
    if (mints.length === 0) return;
    setClaiming(true);
    try {
      const ixs = mints.map((m) => buildClaimFeesIx({ creator: wallet.publicKey!, mint: new PublicKey(m) }));
      for (let i = 0; i < ixs.length; i += 12) {
        const tx = new Transaction().add(...ixs.slice(i, i + 12));
        const sig = await wallet.sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, "confirmed");
      }
      setClaimMsg("Claimed. Rewards updated.");
      await rewardsQ.refetch();
    } catch (e) {
      setClaimMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(false);
    }
  }

  function copyAddr() {
    void navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  if (!addr) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">Connect a wallet to view your profile.</p>
        <div className="flex justify-center">
          <WalletButton />
        </div>
        <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground">
          Back to coins
        </button>
      </div>
    );
  }

  const totalUsd = (bal?.sol ?? 0) * solUsd;

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>

      {/* header */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border p-4">
        <div className="h-16 w-16 shrink-0 rounded-full" style={{ background: avatarGradient(addr) }} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg font-semibold">{shortCa(addr)}</span>
            {isSelf ? (
              <span className="rounded border border-neon/40 px-1.5 py-0.5 text-[9px] uppercase text-neon">You</span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <button onClick={copyAddr} className="flex items-center gap-1 font-mono hover:text-foreground">
              {shortCa(addr)} {copied ? <Check className="h-3 w-3 text-neon" /> : <Copy className="h-3 w-3" />}
            </button>
            <a
              href={`https://explorer.solana.com/address/${addr}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-0.5 hover:text-foreground"
            >
              Explorer <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total value" value={fmtUsdK(totalUsd)} sub="USD" />
        <Stat label="Coins held" value={String(bal?.tokens.length ?? 0)} />
        <Stat label="Coins created" value={String(created.length)} />
        <Stat label="Creator rewards" value={(totalClaimable / 1e9).toFixed(4)} sub="SOL claimable" highlight />
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
        <TabBtn active={tab === "created"} onClick={() => setTab("created")} icon={<Coins className="h-3.5 w-3.5" />}>
          Created coins
        </TabBtn>
        <TabBtn active={tab === "rewards"} onClick={() => setTab("rewards")} icon={<Gift className="h-3.5 w-3.5" />}>
          Creator rewards
        </TabBtn>
        <TabBtn active={tab === "wallet"} onClick={() => setTab("wallet")} icon={<WalletIcon className="h-3.5 w-3.5" />}>
          Wallet
        </TabBtn>
      </div>

      {tab === "created" ? (
        <CreatedTab coins={created} solUsd={solUsd} loading={createdQ.isLoading} onOpen={onOpen} />
      ) : tab === "rewards" ? (
        <RewardsTab
          rewards={rewards}
          isSelf={isSelf}
          total={totalClaimable}
          claiming={claiming}
          claimMsg={claimMsg}
          onClaim={claim}
          onOpen={onOpen}
        />
      ) : (
        <WalletTab bal={bal} solUsd={solUsd} loading={balancesQ.isLoading} />
      )}
    </div>
  );
}

function CreatedTab({
  coins,
  solUsd,
  loading,
  onOpen,
}: {
  coins: Coin[];
  solUsd: number;
  loading: boolean;
  onOpen: (mint: string) => void;
}) {
  if (loading) return <Empty>Loading coins…</Empty>;
  if (coins.length === 0) return <Empty>No coins created yet.</Empty>;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {coins.map((c) => (
        <button
          key={c.mint}
          type="button"
          onClick={() => onOpen(c.mint)}
          className="lp-card flex items-center gap-2.5 rounded-xl border border-border p-2 text-left"
        >
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg">
            {c.image ? (
              <img src={c.image} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full" style={{ background: avatarGradient(c.mint) }} />
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{c.symbol}</div>
            <div className="font-mono text-[11px] text-neon">{mcOf(c, solUsd) > 0 ? fmtUsdK(mcOf(c, solUsd)) : "—"}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function RewardsTab({
  rewards,
  isSelf,
  total,
  claiming,
  claimMsg,
  onClaim,
  onOpen,
}: {
  rewards: Reward[];
  isSelf: boolean;
  total: number;
  claiming: boolean;
  claimMsg: string | null;
  onClaim: (mints: string[]) => void;
  onOpen: (mint: string) => void;
}) {
  if (rewards.length === 0) return <Empty>No coins with fees yet.</Empty>;
  const claimable = rewards.filter((r) => r.claimable > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neon/30 p-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total claimable</div>
          <div className="font-mono text-lg font-semibold text-neon">{(total / 1e9).toFixed(4)} SOL</div>
        </div>
        {isSelf ? (
          <Button size="sm" disabled={claiming || claimable.length === 0} onClick={() => onClaim(claimable.map((r) => r.coin.mint))}>
            {claiming ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Claiming…
              </>
            ) : (
              "Claim all"
            )}
          </Button>
        ) : null}
      </div>
      {claimMsg ? <p className="text-xs text-muted-foreground">{claimMsg}</p> : null}
      <ul className="space-y-2">
        {rewards.map((r) => (
          <li key={r.coin.mint} className="flex items-center gap-3 rounded-xl border border-border p-2.5">
            <button type="button" onClick={() => onOpen(r.coin.mint)} className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
              {r.coin.image ? (
                <img src={r.coin.image} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full" style={{ background: avatarGradient(r.coin.mint) }} />
              )}
            </button>
            <button type="button" onClick={() => onOpen(r.coin.mint)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm font-semibold">{r.coin.symbol}</div>
              <div className="truncate text-[11px] text-muted-foreground">{r.coin.name}</div>
            </button>
            <div className="text-right">
              <div className="font-mono text-sm text-neon">{(r.claimable / 1e9).toFixed(4)} SOL</div>
              {isSelf ? (
                <button
                  type="button"
                  disabled={claiming || r.claimable <= 0}
                  onClick={() => onClaim([r.coin.mint])}
                  className="text-[11px] text-neon hover:underline disabled:text-muted-foreground disabled:opacity-50"
                >
                  Claim
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WalletTab({ bal, solUsd, loading }: { bal?: Balances; solUsd: number; loading: boolean }) {
  if (loading) return <Empty>Loading balances…</Empty>;
  if (!bal) return <Empty>No balances.</Empty>;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-xl border border-border p-3">
        <span className="text-sm font-semibold">SOL</span>
        <div className="text-right">
          <div className="font-mono text-sm">{bal.sol.toFixed(4)}</div>
          <div className="text-[10px] text-muted-foreground">{fmtUsdK(bal.sol * solUsd)}</div>
        </div>
      </div>
      {bal.tokens.length === 0 ? (
        <Empty>No token holdings.</Empty>
      ) : (
        <ul className="space-y-2">
          {bal.tokens.map((t) => (
            <li key={t.mint} className="flex items-center justify-between rounded-xl border border-border p-3">
              <span className="flex items-center gap-2">
                <span className="h-7 w-7 rounded-full" style={{ background: avatarGradient(t.mint) }} />
                <span className="font-mono text-xs">{shortCa(t.mint)}</span>
              </span>
              <span className="font-mono text-sm">
                {t.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${highlight ? "border-neon/30" : "border-border"}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${highlight ? "text-neon" : ""}`}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
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
      className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
