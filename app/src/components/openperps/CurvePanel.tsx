/// Spot trading on a token's bonding curve (pump.fun / nad.fun-style): buy with SOL,
/// sell tokens for SOL, with quick-amount buttons, a slippage selector and USD-priced
/// previews (the bonding curve is an instant AMM — slippage is the price guard; limit
/// orders live on the Perp tab). Quotes mirror the on-chain curve-favoring rounding so
/// the preview equals the executed fill.

import { useState, useEffect, useCallback } from "react";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { Loader2, TrendingUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLivePrice } from "@/lib/livePrice";
import {
  fetchBondingCurve,
  quoteBuy,
  quoteSell,
  buildBuyIx,
  buildSellIx,
  spotPriceSol,
  bondingProgress,
  type BondingCurveState,
} from "@/lib/curve";
import { graduateCurve } from "@/lib/launch/curveGraduate";

const POLL_MS = 2000;
const SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SLIPPAGE_PRESETS = [1, 5, 10, 15];
const SELL_PCTS = [25, 50, 75, 100];

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

export function CurvePanel({
  mint,
  decimals = 6,
  market,
}: {
  mint: string;
  decimals?: number;
  market?: string;
}) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const mintPk = new PublicKey(mint);
  const solUsd = useLivePrice(SOL_USD_FEED, 150);

  const [state, setState] = useState<BondingCurveState | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(10); // percent
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchBondingCurve(connection, mintPk));
    } catch {
      /* transient RPC error; keep the last state */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, mint]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // The seller's token balance, for the % quick amounts.
  const balanceQ = useQuery({
    queryKey: ["curve-bal", mint, wallet.publicKey?.toBase58()],
    enabled: !!wallet.publicKey,
    queryFn: async () => {
      const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey!);
      try {
        const b = await connection.getTokenAccountBalance(ata, "confirmed");
        return BigInt(b.value.amount);
      } catch {
        return 0n;
      }
    },
    refetchInterval: 4000,
  });
  const tokenBalanceUi = Number(balanceQ.data ?? 0n) / 10 ** decimals;

  const slipBps = BigInt(Math.round(slippage * 100));

  // Live preview against the current reserves, priced in USD.
  let preview: string | null = null;
  let previewErr: string | null = null;
  if (state && amount && Number(amount) > 0) {
    try {
      if (side === "buy") {
        const solIn = BigInt(Math.round(Number(amount) * 1e9));
        const q = quoteBuy(state.virtualSolReserves, state.virtualTokenReserves, state.realTokenReserves, solIn);
        const tokens = Number(q.tokensOut) / 10 ** decimals;
        preview = `Get ≈ ${tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${fmtUsd(Number(amount) * solUsd)}${q.drains ? " (graduates)" : ""}`;
      } else {
        const tokensIn = BigInt(Math.round(Number(amount) * 10 ** decimals));
        const q = quoteSell(state.virtualSolReserves, state.virtualTokenReserves, tokensIn);
        const capped = q.solOut > state.realSolReserves ? state.realSolReserves : q.solOut;
        preview = `Get ≈ ${fmtUsd((Number(capped) / 1e9) * solUsd)}`;
      }
    } catch (e) {
      previewErr = e instanceof Error ? e.message : "Invalid amount";
    }
  }

  async function send(ixs: TransactionInstruction[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey!;
    const sig = await wallet.sendTransaction!(tx, connection);
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }

  async function onTrade() {
    setErr(null);
    setMsg(null);
    if (!wallet.publicKey || !wallet.sendTransaction) return setErr("Connect a wallet first.");
    if (!state) return setErr("Curve not loaded yet.");
    if (state.complete) return setErr("This curve has graduated; trade the spot pool instead.");
    const n = Number(amount);
    if (!(n > 0)) return setErr("Enter an amount.");

    const payer = wallet.publicKey;
    const ata = getAssociatedTokenAddressSync(mintPk, payer);
    setBusy(true);
    try {
      const ixs: TransactionInstruction[] = [];
      if (side === "buy") {
        const solIn = BigInt(Math.round(n * 1e9));
        const q = quoteBuy(state.virtualSolReserves, state.virtualTokenReserves, state.realTokenReserves, solIn);
        const minOut = (q.tokensOut * (10000n - slipBps)) / 10000n;
        const ataInfo = await connection.getAccountInfo(ata, "confirmed");
        if (!ataInfo) ixs.push(createAssociatedTokenAccountInstruction(payer, ata, payer, mintPk));
        ixs.push(buildBuyIx({ buyer: payer, mint: mintPk, buyerTokenAccount: ata, solIn, minTokensOut: minOut }));
      } else {
        const tokensIn = BigInt(Math.round(n * 10 ** decimals));
        const q = quoteSell(state.virtualSolReserves, state.virtualTokenReserves, tokensIn);
        const capped = q.solOut > state.realSolReserves ? state.realSolReserves : q.solOut;
        const minSol = (capped * (10000n - slipBps)) / 10000n;
        ixs.push(buildSellIx({ seller: payer, mint: mintPk, sellerTokenAccount: ata, tokensIn, minSolOut: minSol }));
      }
      const sig = await send(ixs);
      setMsg(`${side === "buy" ? "Bought" : "Sold"} - ${sig.slice(0, 8)}...`);
      setAmount("");
      await refresh();
      void balanceQ.refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const isCreator = !!(state && wallet.publicKey && state.creator.equals(wallet.publicKey));

  async function onGraduate() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const res = await graduateCurve({
        wallet,
        connection,
        mint: mintPk,
        decimals,
        ...(market ? { market } : {}),
        onProgress: (d) => setMsg(`${d}...`),
      });
      setMsg(`Graduated to pool ${res.poolId.toBase58().slice(0, 8)}...`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const price = state ? spotPriceSol(state.virtualSolReserves, state.virtualTokenReserves, decimals) : 0;
  const priceUsd = price * solUsd;
  const progress = state ? bondingProgress(state) : 0;
  const raised = state ? Number(state.realSolReserves) / 1e9 : 0;
  const target = state ? Number(state.graduateSolThreshold) / 1e9 : 0;
  const disabled = busy || state?.complete;

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <TrendingUp className="h-4 w-4" /> Bonding curve
        </div>
        <div className="text-xs text-muted-foreground">{priceUsd > 0 ? fmtUsd(priceUsd) : "—"}</div>
      </div>

      {/* bonding progress */}
      <div className="space-y-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-neon transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{state?.complete ? "Graduated" : `${(progress * 100).toFixed(1)}% to graduation`}</span>
          <span>
            {raised.toFixed(2)} / {target.toFixed(0)} SOL
          </span>
        </div>
      </div>

      {/* buy / sell toggle */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => setSide("buy")}
          className={`rounded-md border py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            side === "buy" ? "border-green-500 bg-green-500/10 text-green-500" : "border-border"
          }`}
        >
          Buy
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setSide("sell")}
          className={`rounded-md border py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            side === "sell" ? "border-red-500 bg-red-500/10 text-red-500" : "border-border"
          }`}
        >
          Sell
        </button>
      </div>

      {/* balance line (sell) */}
      {side === "sell" ? (
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>Balance</span>
          <span className="font-mono">
            {tokenBalanceUi.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={side === "buy" ? "Amount in SOL" : "Amount in tokens"}
          disabled={disabled}
          inputMode="decimal"
        />

        {/* quick amounts */}
        {side === "buy" ? (
          <div className="flex gap-1">
            {["0.1", "0.5", "1", "5"].map((v) => (
              <QuickBtn key={v} disabled={disabled} onClick={() => setAmount(v)}>
                {v}
              </QuickBtn>
            ))}
          </div>
        ) : (
          <div className="flex gap-1">
            <QuickBtn disabled={disabled} onClick={() => setAmount("")}>
              Reset
            </QuickBtn>
            {SELL_PCTS.map((p) => (
              <QuickBtn
                key={p}
                disabled={disabled || tokenBalanceUi <= 0}
                onClick={() => setAmount(String((tokenBalanceUi * p) / 100))}
              >
                {p === 100 ? "Max" : `${p}%`}
              </QuickBtn>
            ))}
          </div>
        )}

        <div className="min-h-[16px] text-[11px] text-muted-foreground">
          {previewErr ? <span className="text-red-500">{previewErr}</span> : preview}
        </div>
      </div>

      {/* slippage */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Slippage</span>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {SLIPPAGE_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => setSlippage(s)}
              className={`rounded px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                slippage === s ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}%
            </button>
          ))}
          <div
            className={`flex items-center rounded px-1 ${
              SLIPPAGE_PRESETS.includes(slippage) ? "" : "bg-neon/15"
            }`}
          >
            <input
              type="text"
              inputMode="decimal"
              disabled={busy}
              value={SLIPPAGE_PRESETS.includes(slippage) ? "" : String(slippage)}
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === "") return setSlippage(10);
                const v = parseFloat(raw);
                if (Number.isFinite(v)) setSlippage(Math.max(0.1, Math.min(50, v)));
              }}
              placeholder="Custom"
              className={`w-12 bg-transparent text-right text-[11px] outline-none placeholder:text-muted-foreground disabled:opacity-50 ${
                SLIPPAGE_PRESETS.includes(slippage) ? "text-muted-foreground" : "text-neon"
              }`}
            />
            <span className="text-[11px] text-muted-foreground">%</span>
          </div>
        </div>
      </div>

      <Button onClick={onTrade} disabled={disabled || !wallet.publicKey} className="w-full">
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting...
          </>
        ) : state?.complete ? (
          "Graduated"
        ) : side === "buy" ? (
          "Buy on curve"
        ) : (
          "Sell on curve"
        )}
      </Button>

      {/* Graduation: once complete, the creator migrates curve liquidity to a pool. */}
      {state?.complete && isCreator ? (
        <Button onClick={onGraduate} disabled={busy} variant="secondary" className="w-full">
          {busy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Graduating...
            </>
          ) : (
            "Graduate to spot pool"
          )}
        </Button>
      ) : null}

      {msg ? <p className="text-xs text-green-500">{msg}</p> : null}
      {err ? <p className="text-xs text-red-500">{err}</p> : null}
    </div>
  );
}

function QuickBtn({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex-1 rounded border border-border py-1 text-[11px] text-muted-foreground transition-colors hover:border-neon/50 hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}
