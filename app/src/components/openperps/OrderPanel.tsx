/// Trader order panel. Size is entered in USDC margin; leverage scales it to
/// notional. The House Vault takes the opposite side, so the user signs one
/// transaction. Wired to the real placeOrderFlow.

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Link } from "@tanstack/react-router";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ExternalLink,
  Loader2,
  Wallet2,
  Zap,
} from "lucide-react";
import { Side } from "@opp-oss/sdk";

import { fmtPubkey } from "@/lib/format";
import { placeOrderFlow } from "@/lib/flows/placeOrderFlow";
import { depositFlow, initPortfolioFlow, withdrawFlow } from "@/lib/flows/portfolioFlows";
import { addTrade } from "@/lib/tradeLog";
import { userPortfolio as deriveUserPortfolio } from "@/lib/program";
import { QUOTE_DECIMALS, atomsToHuman } from "@/lib/decimals";
import { QUOTE_MINT, QUOTE_SYMBOL, collateralOf } from "@/lib/collateral";
import { usePortfolioPositions, usePortfolioState } from "@/lib/onchain";
import { useExecPrice } from "@/lib/livePrice";
import { disableSession, enableSession, sessionUsableFor } from "@/lib/sessionKey";
import { GROUP_MAX_FEE_BPS } from "@/lib/sharedMarket";
import type { Market } from "@/lib/types";

const DEFAULT_MARGIN_USDC = "100";

function fmtPrice(p: number): string {
  if (p <= 0) return "—";
  return p < 1 ? p.toFixed(6) : p.toFixed(2);
}

export function OrderPanel({ market }: { market: Market }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const owner = wallet.publicKey?.toBase58() ?? "";
  const [acctRefresh, setAcctRefresh] = useState(0);
  // Per-group: a custom SPL market is its own group, so the portfolio is the
  // deterministic PDA for (owner, that market). Derivable on any device.
  const portfolioPk = useMemo(
    () => (owner ? deriveUserPortfolio(owner, market.pubkey) : undefined),
    [owner, market.pubkey],
  );
  const portfolioStateQ = usePortfolioState(portfolioPk);
  // Existence = the account is present on-chain. `null` = confirmed absent
  // (prompt to open); while loading we stay optimistic so the panel doesn't
  // flash the open-account prompt.
  const userPortfolio =
    portfolioStateQ.data === null || !portfolioPk ? undefined : { pubkey: portfolioPk };
  // Re-check on-chain promptly after an inline open/deposit.
  const refetchState = portfolioStateQ.refetch;
  useEffect(() => {
    if (acctRefresh > 0) void refetchState();
  }, [acctRefresh, refetchState]);
  // Trading with zero collateral makes the engine divide by capital=0 and
  // revert with InvalidConfig (0x3e8). Gate the trade on confirmed collateral
  // and surface a deposit box instead (esp. for custom groups, whose account
  // may have been opened but not funded if the deposit half failed).
  const hasCollateral =
    portfolioStateQ.data != null && portfolioStateQ.data.capital > 0n;

  // Collateral is mUSDC for a normal market, the base token for a coin-margin one
  // (its own symbol + decimals). The engine accounts size/capital in COLLATERAL
  // atoms, so order sizing scales by collat.decimals; the price stays at the fixed
  // 1e6 USD scale.
  const collat = collateralOf(market);
  // Coin-margin is forced to 5x on-chain (reflexive collateral); cap the UI so an
  // order above 5x can't be built and revert at execution.
  const maxLev = market.coinMargin ? 5 : (market.maxLeverage ?? 20);
  // The engine caps the per-trade fee at the group's max_trading_fee_bps;
  // anything higher reverts as InvalidConfig ("Unexpected error"). Clamp the
  // market's advertised fee down to the on-chain cap before sending.
  const feeBps = Math.min(market.feeBps ?? 5, GROUP_MAX_FEE_BPS);

  const [side, setSide] = useState<Side>(Side.Long);
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [marginUsdc, setMarginUsdc] = useState(DEFAULT_MARGIN_USDC);
  const [lev, setLev] = useState(Math.min(5, maxLev));
  const [limitPrice, setLimitPrice] = useState("");
  const [running, setRunning] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  // 1-click trading status: a funded session key that is registered on-chain
  // as THIS portfolio's delegate (so the indicator can't falsely show "on" for
  // a stale session from another portfolio).
  const sessionQ = useQuery({
    queryKey: ["session", owner, userPortfolio?.pubkey, connection.rpcEndpoint],
    enabled: !!owner && !!userPortfolio,
    queryFn: () => sessionUsableFor(connection, owner, new PublicKey(userPortfolio!.pubkey)),
    refetchInterval: 20_000,
  });
  const oneClick = !!sessionQ.data;

  useEffect(() => {
    setSig(null);
    setError(null);
    setLimitPrice("");
    setLev((l) => Math.min(l, maxLev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.pubkey]);

  const isLong = side === Side.Long;

  // Size + execute at the ENGINE settlement price (Pyth for majors, on-chain
  // effective_price for custom). The position is valued at effective_price, so
  // sizing off the live DEX spot over-sizes it whenever spot ≠ effective_price
  // (a not-yet-converged custom market) and the open reverts past the margin
  // limit with InvalidConfig (0x3e8). The header still TICKS the live spot; only
  // order sizing uses the engine mark so what you open matches what settles.
  const liveMark = useExecPrice(market);

  const calc = useMemo(() => {
    const margin = Number(marginUsdc);
    const price =
      orderType === "limit" && Number(limitPrice) > 0 ? Number(limitPrice) : liveMark;
    const ok = Number.isFinite(margin) && margin > 0 && price > 0;
    const notional = ok ? margin * lev : 0;
    // The engine works in COLLATERAL atoms, so sizeQ scales by the collateral's
    // decimals (mUSDC 6, or the base token's decimals for coin-margin). The price
    // is always at the fixed 1e6 USD scale (PRICE_SCALE), regardless of collateral,
    // so it must NOT use collat.decimals.
    const sizeScale = 10 ** collat.decimals;
    const priceScale = 10 ** QUOTE_DECIMALS;
    const sizeQ = ok ? BigInt(Math.round((notional * sizeScale) / price)) : 0n;
    const execPrice = ok ? BigInt(Math.round(price * priceScale)) : 0n;
    const feeUsdc = (notional * feeBps) / 10_000;
    const liq = ok ? (isLong ? price * (1 - 1 / lev) : price * (1 + 1 / lev)) : 0;
    return { ok, price, notional, sizeQ, execPrice, feeUsdc, liq };
  }, [marginUsdc, lev, limitPrice, orderType, liveMark, feeBps, isLong, collat.decimals]);

  const canTrade =
    wallet.connected && !running && !!userPortfolio && hasCollateral && calc.ok && calc.sizeQ > 0n;

  const onTrade = async () => {
    if (!userPortfolio || !calc.ok) return;
    setError(null);
    setSig(null);
    setRunning(true);
    try {
      const r = await placeOrderFlow({
        wallet,
        connection,
        params: {
          // Custom SPL markets are their own isolated group → route to their
          // market + seeded House; majors fall back to the shared group.
          market: new PublicKey(market.pubkey),
          housePortfolio: market.house ? new PublicKey(market.house) : undefined,
          userPortfolioPubkey: new PublicKey(userPortfolio.pubkey),
          side,
          assetIndex: market.assetIndex,
          sizeQ: calc.sizeQ,
          execPrice: calc.execPrice,
          feeBps: BigInt(feeBps),
          oraclePool:
            market.oracleKind === "dex" && market.oraclePool
              ? new PublicKey(market.oraclePool)
              : undefined,
        },
      });
      setSig(r.signature);
      addTrade({
        market: market.symbol,
        side: isLong ? "buy" : "sell",
        price: calc.price,
        size: Number(calc.sizeQ) / 1_000_000,
        signature: r.signature,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const onToggleSession = async () => {
    if (!userPortfolio) return;
    setError(null);
    setSessionBusy(true);
    try {
      const portfolio = new PublicKey(userPortfolio.pubkey);
      if (oneClick) {
        await disableSession({ wallet, connection, portfolio });
      } else {
        await enableSession({ wallet, connection, portfolio });
      }
      await sessionQ.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionBusy(false);
    }
  };

  if (!wallet.connected) {
    return (
      <div className="panel p-3 text-xs text-muted-foreground">Connect your wallet to trade.</div>
    );
  }

  const refreshAccount = () => {
    setAcctRefresh((k) => k + 1);
    void portfolioStateQ.refetch();
  };

  // Shared majors group: deposit is managed on the Portfolio page, so prompt to
  // open the account there. Custom (own-group) markets fall through — their
  // funds are managed inline by AccountFundsBar (move to/from the main account),
  // which also opens the account on first use.
  if (!userPortfolio && !market.ownGroup) {
    return (
      <div className="panel p-3 space-y-2">
        <div className="text-xs font-medium">Open a trading account</div>
        <p className="text-[11px] text-muted-foreground">
          Deposit collateral once to start trading this market against the LP &amp; Insurance Vault.
        </p>
        <Link
          to="/portfolio"
          className="btn-primary w-full rounded-md py-2 text-xs font-medium inline-flex items-center justify-center gap-1.5"
        >
          <Wallet2 className="h-3.5 w-3.5" /> Open trading account
        </Link>
      </div>
    );
  }

  return (
    <div className="panel p-3 space-y-3">
      {/* Custom isolated market: manage this account's collateral inline — move
          in/out of the main account any time. */}
      {market.ownGroup && (
        <AccountFundsBar
          market={market}
          customPortfolio={userPortfolio?.pubkey ?? null}
          capital={portfolioStateQ.data?.capital ?? 0n}
          pnl={portfolioStateQ.data?.pnl ?? 0n}
          onDone={refreshAccount}
        />
      )}

      {/* Long / Short */}
      <div className="grid grid-cols-2 gap-1 p-1 bg-background/60 rounded-md border border-border">
        <button
          onClick={() => setSide(Side.Long)}
          className={`py-1.5 text-xs font-medium rounded ${
            isLong
              ? "bg-[oklch(0.82_0.18_160_/_0.18)] text-success shadow-[inset_0_0_0_1px_oklch(0.82_0.18_160_/_0.45)]"
              : "text-muted-foreground"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setSide(Side.Short)}
          className={`py-1.5 text-xs font-medium rounded ${
            !isLong
              ? "bg-[oklch(0.66_0.24_18_/_0.18)] text-danger shadow-[inset_0_0_0_1px_oklch(0.66_0.24_18_/_0.45)]"
              : "text-muted-foreground"
          }`}
        >
          Short
        </button>
      </div>

      {/* Market / Limit */}
      <div className="flex gap-1 text-[11px]">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setOrderType(t)}
            className={`px-2.5 py-1 rounded ${
              orderType === t
                ? "text-neon bg-[oklch(0.86_0.16_188_/_0.10)]"
                : "text-muted-foreground"
            }`}
          >
            {t === "market" ? "Market" : "Limit"}
          </button>
        ))}
      </div>

      {orderType === "limit" && (
        <Field label="Limit price" suffix="USD">
          <input
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder={fmtPrice(market.price)}
            inputMode="decimal"
            className="bg-transparent w-full text-right font-mono text-sm focus:outline-none"
          />
        </Field>
      )}

      <Field label="Size (margin)" suffix={collat.symbol}>
        <input
          value={marginUsdc}
          onChange={(e) => setMarginUsdc(e.target.value)}
          inputMode="decimal"
          className="bg-transparent w-full text-right font-mono text-sm focus:outline-none"
        />
      </Field>

      {/* Leverage */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
          <span>Leverage</span>
          <span className="font-mono text-neon">{lev}×</span>
        </div>
        <input
          type="range"
          min={1}
          max={maxLev}
          value={lev}
          onChange={(e) => setLev(+e.target.value)}
          className="w-full accent-[var(--neon)]"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono mt-1">
          <span>1×</span>
          <span>{Math.round(maxLev / 2)}×</span>
          <span>{maxLev}×</span>
        </div>
      </div>

      {market.coinMargin && (
        <div className="rounded border border-violet/40 bg-violet/[0.06] px-2 py-1 text-[10px] text-violet">
          Coin-margined · inverse. Collateral is {collat.symbol}; leverage forced to 5x.
        </div>
      )}

      <div className="text-[11px] space-y-1 pt-2 border-t border-border/60 font-mono">
        <Row k="Entry" v={fmtPrice(calc.price)} />
        <Row k="Liq. price" v={fmtPrice(calc.liq)} />
        <Row k="Notional" v={`${calc.notional.toFixed(2)} ${collat.symbol}`} />
        <Row k="Fee" v={`${(feeBps / 100).toFixed(2)}% · ${calc.feeUsdc.toFixed(2)} ${collat.symbol}`} />
        <Row k="Funding (1h)" v={`${(market.funding * 100).toFixed(4)}%`} />
      </div>

      {/* 1-click trading (session key) — on/off switch */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/60">
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <Zap
            className={`h-3.5 w-3.5 shrink-0 ${oneClick ? "text-neon" : "text-muted-foreground"}`}
          />
          <span className="leading-tight">
            <span
              className={`block text-xs font-medium ${oneClick ? "text-neon" : "text-foreground"}`}
            >
              1-click trading
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {oneClick ? "On · trades sign instantly" : "Off · wallet popup each trade"}
            </span>
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={oneClick}
          aria-label="Toggle 1-click trading"
          onClick={onToggleSession}
          disabled={sessionBusy}
          title={oneClick ? "Disable 1-click trading" : "Enable 1-click trading (1 approval)"}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            oneClick
              ? "bg-neon shadow-[0_0_10px_oklch(0.86_0.16_188_/_0.6)]"
              : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`absolute top-0.5 grid h-4 w-4 place-items-center rounded-full bg-white shadow transition-transform ${
              oneClick ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          >
            {sessionBusy && <Loader2 className="h-2.5 w-2.5 animate-spin text-neutral-600" />}
          </span>
        </button>
      </div>

      <button
        onClick={onTrade}
        disabled={!canTrade}
        className={`w-full py-2.5 rounded-md text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 ${
          isLong ? "btn-long" : "btn-short"
        }`}
      >
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {running ? "Placing…" : `Open ${isLong ? "Long" : "Short"} · ${market.symbol}`}
        {oneClick && !running && <Zap className="h-3.5 w-3.5" />}
      </button>

      {sig && (
        <a
          href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-success inline-flex items-center gap-1"
        >
          <Check className="h-3 w-3" />
          {fmtPubkey(sig, 6, 6)}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {error && <div className="text-[11px] text-danger break-words">{error}</div>}

      {portfolioStateQ.data && portfolioStateQ.data.capital === 0n && (
        <div className="text-[11px] text-muted-foreground">
          {market.ownGroup ? (
            <>Deposit to this account above to trade.</>
          ) : (
            <>
              Account has no collateral —{" "}
              <Link to="/portfolio" className="text-neon underline">
                deposit
              </Link>{" "}
              before trading.
            </>
          )}
        </div>
      )}
    </div>
  );
}

/// Inline collateral manager for a custom market's isolated account, always
/// visible in its order panel. Deposit collateral straight from the wallet and
/// withdraw it back, any number of times. The account is opened on the first
/// deposit. Withdraw requires the account to be flat (the engine won't release
/// collateral backing an open position) — checked up front and surfaced clearly.
function AccountFundsBar({
  market,
  customPortfolio,
  capital,
  pnl,
  onDone,
}: {
  market: Market;
  customPortfolio: string | null;
  capital: bigint;
  pnl: bigint;
  onDone: () => void;
}) {
  // Account balance = collateral + realized PnL (= equity when flat). The
  // withdraw tx settles realized PnL into capital first, so this whole balance
  // is withdrawable — show it, and let the user pull all of it.
  const equity = capital + pnl > 0n ? capital + pnl : 0n;
  // Collateral is mUSDC for a normal market, the base token for a coin-margin one.
  const collat = collateralOf(market);
  const wallet = useWallet();
  const { connection } = useConnection();
  const owner = wallet.publicKey?.toBase58() ?? "";
  const walletBalQ = useQuery({
    queryKey: ["wallet-collat", collat.mint.toBase58(), owner, connection.rpcEndpoint],
    enabled: !!owner,
    refetchInterval: 8_000,
    queryFn: async () => {
      try {
        const ata = getAssociatedTokenAddressSync(collat.mint, wallet.publicKey!);
        return (await getAccount(connection, ata)).amount;
      } catch {
        return 0n;
      }
    },
  });
  const walletAtoms = walletBalQ.data ?? 0n;
  // Withdraw needs the account flat — the engine won't release collateral while
  // it holds an open position.
  const customPosQ = usePortfolioPositions(customPortfolio ?? undefined);

  const [dir, setDir] = useState<"deposit" | "withdraw" | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isDeposit = dir === "deposit";
  // Source = wallet for a deposit, the full account balance (capital + realized
  // PnL, settled on withdraw) for a withdraw.
  const sourceAtoms = isDeposit ? walletAtoms : equity;
  const sourceUsd = Number(sourceAtoms) / 10 ** collat.decimals;
  const positionsLock = dir === "withdraw" && (customPosQ.data ?? []).length > 0;
  const amt = BigInt(Math.round((Number(amount) || 0) * 10 ** collat.decimals));
  const canSubmit =
    !busy &&
    !positionsLock &&
    amt > 0n &&
    amt <= sourceAtoms &&
    (dir !== "withdraw" || !!customPortfolio);

  const pick = (d: "deposit" | "withdraw") => {
    setErr(null);
    setAmount("");
    setDir((cur) => (cur === d ? null : d));
  };

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (amt <= 0n) {
        setErr("Enter an amount.");
        return;
      }
      const marketPubkey = new PublicKey(market.pubkey);
      const vaultPubkey = new PublicKey(market.vault);
      if (isDeposit) {
        // Open the account on the first deposit, then fund it from the wallet.
        let pf = customPortfolio ? new PublicKey(customPortfolio) : null;
        if (!pf) {
          const r = await initPortfolioFlow({
            wallet,
            connection,
            params: {
              marketPubkey,
              assetSlotCapacity: market.assetSlotCapacity,
              label: `${market.symbol} account`,
            },
          });
          pf = r.portfolio;
        }
        await depositFlow({
          wallet,
          connection,
          params: { marketPubkey, portfolioPubkey: pf, vaultPubkey, quoteMint: collat.mint, amount: amt },
        });
      } else {
        if (!customPortfolio) throw new Error("This account is empty.");
        await withdrawFlow({
          wallet,
          connection,
          params: {
            marketPubkey,
            portfolioPubkey: new PublicKey(customPortfolio),
            vaultPubkey,
            quoteMint: collat.mint,
            amount: amt,
          },
        });
      }
      setDir(null);
      setAmount("");
      onDone();
      void walletBalQ.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 0x3ed (V16 Stale) on a withdraw = the account still holds an open
      // position. Surface that plainly instead of the raw code.
      setErr(
        /0x3ed|custom program error: 1005/.test(msg)
          ? "Close this account's open positions before withdrawing."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-flat rounded-md p-2.5 space-y-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{market.symbol} account</span>
        <span className={`font-mono ${equity > 0n ? "text-neon" : "text-muted-foreground"}`}>
          {atomsToHuman(equity, collat.decimals, true)} {collat.symbol}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => pick("deposit")}
          className={`rounded py-1.5 text-[11px] inline-flex items-center justify-center gap-1 ${
            dir === "deposit" ? "btn-primary" : "btn-ghost-border"
          }`}
        >
          <ArrowDownToLine className="h-3 w-3" /> Deposit
        </button>
        <button
          onClick={() => pick("withdraw")}
          disabled={capital === 0n}
          className={`rounded py-1.5 text-[11px] inline-flex items-center justify-center gap-1 disabled:opacity-40 ${
            dir === "withdraw" ? "btn-primary" : "btn-ghost-border"
          }`}
        >
          <ArrowUpFromLine className="h-3 w-3" /> Withdraw
        </button>
      </div>

      {dir && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{isDeposit ? "From wallet · available" : "To wallet · available"}</span>
            <span className="font-mono">{atomsToHuman(sourceAtoms, collat.decimals, true)} {collat.symbol}</span>
          </div>
          {positionsLock && (
            <div className="text-[10px] text-danger">
              This account has an open position. Close it before withdrawing.
            </div>
          )}
          <div className="flex items-center gap-2 bg-background/60 border border-border rounded-md px-2.5 py-1.5">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="bg-transparent w-full font-mono text-sm focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setAmount(String(sourceUsd))}
              className="text-[10px] text-neon hover:underline"
            >
              MAX
            </button>
            <span className="text-[10px] text-muted-foreground font-mono">{collat.symbol}</span>
          </div>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="btn-primary w-full rounded-md py-1.5 text-[11px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {busy ? (isDeposit ? "Depositing…" : "Withdrawing…") : isDeposit ? "Deposit" : "Withdraw"}
          </button>
          {amt > sourceAtoms && (
            <div className="text-[10px] text-danger">Exceeds available balance.</div>
          )}
          {isDeposit && walletAtoms === 0n && !market.coinMargin && (
            <Link to="/faucet" className="text-[10px] text-neon underline inline-block">
              Get {QUOTE_SYMBOL} from the Faucet →
            </Link>
          )}
          {isDeposit && walletAtoms === 0n && market.coinMargin && (
            <div className="text-[10px] text-muted-foreground">
              Fund your wallet with {collat.symbol} to deposit (this market is
              collateralized in the token itself).
            </div>
          )}
        </div>
      )}
      {err && <div className="text-[11px] text-danger break-words">{err}</div>}
    </div>
  );
}

function Field({
  label,
  suffix,
  children,
}: {
  label: string;
  suffix: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground mb-1.5">{label}</div>
      <div className="flex items-center gap-2 bg-background/60 border border-border rounded-md px-2.5 py-2 focus-within:border-neon/60">
        {children}
        <span className="text-[10px] text-muted-foreground font-mono">{suffix}</span>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span>{v}</span>
    </div>
  );
}
