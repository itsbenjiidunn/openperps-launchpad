/// Per-portfolio transaction orchestrators: InitPortfolio, Deposit, and
/// Withdraw. Each one is a single tx (no multi-step chain like Launch),
/// so the UI just toggles a loading state and renders the resulting
/// signature when it lands.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  accrueAssetIx,
  crankRefreshIx,
  depositIx,
  depositCapPda,
  initPortfolioIx,
  liquidateIx,
  portfolioPda,
  settlePnlIx,
  tradeIx,
  withdrawIx,
} from "@opp-oss/sdk";

import { PROGRAM_ID } from "../program";
import { addPortfolio } from "../portfolioRegistry";
import { preflight, staleClearAccrues } from "./placeOrderFlow";

const CONFIRM_COMMITMENT: Commitment = "confirmed";

export type InitPortfolioParams = {
  marketPubkey: PublicKey;
  assetSlotCapacity: number;
  label?: string;
};

export type InitPortfolioResult = {
  portfolio: PublicKey;
  signature: string;
};

export async function initPortfolioFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: InitPortfolioParams;
}): Promise<InitPortfolioResult> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const owner = wallet.publicKey;
  // Deterministic PDA [PORTFOLIO_SEED, owner, market]: one account per (wallet,
  // market), derivable on any device — no client keypair, no localStorage
  // dependency. The program creates the account itself (it signs as the PDA).
  const [portfolio, bump] = portfolioPda(PROGRAM_ID, owner, params.marketPubkey);

  const tx = new Transaction().add(
    initPortfolioIx({
      programId: PROGRAM_ID,
      portfolio,
      market: params.marketPubkey,
      owner,
      bump,
    }),
  );

  const sig = await sendAndConfirm(connection, wallet, tx, []);

  // Still cache locally for instant same-device UX; discovery no longer depends
  // on it (the address is re-derivable anywhere).
  addPortfolio({
    pubkey: portfolio.toBase58(),
    marketPubkey: params.marketPubkey.toBase58(),
    owner: owner.toBase58(),
    label: params.label,
  });

  return { portfolio, signature: sig };
}

export type DepositParams = {
  marketPubkey: PublicKey;
  portfolioPubkey: PublicKey;
  vaultPubkey: PublicKey;
  quoteMint: PublicKey;
  amount: bigint;
};

export async function depositFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: DepositParams;
}): Promise<{ signature: string; userToken: PublicKey }> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const owner = wallet.publicKey;
  const userToken = getAssociatedTokenAddressSync(params.quoteMint, owner);
  // Pass the per-market deposit-cap PDA so the program applies the raised,
  // pool-depth-scaled cap set at launch (without it the program falls back to
  // the fixed floor, which for a coin-margin token is a tiny token count). The
  // PDA is always derivable; if it was never set the program ignores it and
  // keeps the floor, so passing it is safe for every market.
  const [depositCap] = depositCapPda(PROGRAM_ID, params.marketPubkey);
  const tx = new Transaction().add(
    depositIx({
      programId: PROGRAM_ID,
      market: params.marketPubkey,
      portfolio: params.portfolioPubkey,
      owner,
      userToken,
      vaultToken: params.vaultPubkey,
      amount: params.amount,
      depositCap,
    }),
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  // Surface the memecoin collateral cap (DepositCapExceeded = custom 0xa) as a
  // clear message instead of the wallet's generic "Unexpected error".
  await preflightDeposit(connection, tx);
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  return { signature: sig, userToken };
}

/// The on-chain per-account collateral cap on memecoin (DEX-priced) markets,
/// in USD — must match the program's `MAX_CUSTOM_PORTFOLIO_CAPITAL`.
export const MEMECOIN_COLLATERAL_CAP_USD = 1_000;

/// Simulate a deposit and translate the program's cap rejection into a friendly
/// error. Other failures fall through to the normal send path.
async function preflightDeposit(connection: Connection, tx: Transaction): Promise<void> {
  let sim;
  try {
    sim = await connection.simulateTransaction(tx);
  } catch {
    return; // simulation unavailable — let the send path try.
  }
  const err = sim.value.err as { InstructionError?: [number, { Custom?: number }] } | null;
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom === 10) {
    throw new Error(
      `Memecoin markets cap each account at ${MEMECOIN_COLLATERAL_CAP_USD.toLocaleString()} mUSDC of collateral (anti-manipulation). Deposit a smaller amount.`,
    );
  }
  // Any other on-chain error: surface the most telling log line.
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const hint =
      logs.find((l) => /error|failed|insufficient|custom/i.test(l)) ??
      logs[logs.length - 1] ??
      JSON.stringify(sim.value.err);
    throw new Error(`Deposit rejected on-chain: ${hint}`);
  }
}

/// SettlePnl converts released positive PnL into withdrawable `capital` via the
/// engine's native primitive (no House account, no drain surface). It's a safe
/// no-op unless there's convertible profit, so callers append it unconditionally
/// — before a withdraw (you withdraw the profit too).
export function settleIxFor(
  market: PublicKey,
  portfolio: PublicKey,
  signer: PublicKey,
): ReturnType<typeof settlePnlIx> {
  return settlePnlIx({ programId: PROGRAM_ID, market, userPortfolio: portfolio, signer });
}

export type WithdrawParams = DepositParams;

export async function withdrawFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: WithdrawParams;
}): Promise<{ signature: string; userToken: PublicKey }> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const owner = wallet.publicKey;
  const userToken = getAssociatedTokenAddressSync(params.quoteMint, owner);
  // Withdraw lowers account health, so it's subject to the group stale-loss
  // lock just like a trade: clear it in-tx for the group's OI-bearing slots.
  // Preflight surfaces the real error (e.g. open positions → 0x3ed) instead of
  // the wallet's generic "Unexpected error".
  const accrues = await staleClearAccrues(connection, owner, params.marketPubkey, -1);
  const withdraw = withdrawIx({
    programId: PROGRAM_ID,
    market: params.marketPubkey,
    portfolio: params.portfolioPubkey,
    owner,
    vaultToken: params.vaultPubkey,
    userToken,
    amount: params.amount,
  });
  // Realize positive PnL into withdrawable capital FIRST, so you withdraw the
  // profit too (percolator parks it in a separate `pnl` ledger that withdraw
  // ignores; SettlePnl, the House paying, folds it into `capital`). On some
  // market states settle's validate raises LockActive — if the settle+withdraw
  // bundle fails preflight, fall back to a plain withdraw so settling can never
  // BLOCK a withdrawal that would otherwise succeed.
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);
  const build = (withSettle: boolean) => {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ...accrues,
    );
    if (withSettle) tx.add(settleIxFor(params.marketPubkey, params.portfolioPubkey, owner));
    tx.add(withdraw);
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    return tx;
  };
  let tx = build(true);
  try {
    await preflight(connection, tx);
  } catch {
    tx = build(false);
    await preflight(connection, tx); // surface the real withdraw error if any
  }
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  return { signature: sig, userToken };
}

export type TradeParams = {
  marketPubkey: PublicKey;
  longPortfolioPubkey: PublicKey;
  shortPortfolioPubkey: PublicKey;
  assetIndex: number;
  sizeQ: bigint;
  execPrice: bigint;
  feeBps: bigint;
};

export async function tradeFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: TradeParams;
}): Promise<{ signature: string }> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const owner = wallet.publicKey;
  const tx = new Transaction().add(
    tradeIx({
      programId: PROGRAM_ID,
      market: params.marketPubkey,
      longPortfolio: params.longPortfolioPubkey,
      shortPortfolio: params.shortPortfolioPubkey,
      authority: owner,
      assetIndex: params.assetIndex,
      sizeQ: params.sizeQ,
      execPrice: params.execPrice,
      feeBps: params.feeBps,
    }),
  );
  const sig = await sendAndConfirm(connection, wallet, tx);
  return { signature: sig };
}

// ---------- Operator / keeper actions ----------

export type AccrueAssetParams = {
  marketPubkey: PublicKey;
  assetIndex: number;
  effectivePrice: bigint;
  fundingRateE9: bigint;
};

/// Authority-pinned: refresh the engine's oracle price + funding rate for
/// one asset slot.
export async function accrueAssetFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: AccrueAssetParams;
}): Promise<{ signature: string }> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const tx = new Transaction().add(
    accrueAssetIx({
      programId: PROGRAM_ID,
      market: params.marketPubkey,
      authority: wallet.publicKey,
      assetIndex: params.assetIndex,
      effectivePrice: params.effectivePrice,
      fundingRateE9: params.fundingRateE9,
    }),
  );
  const sig = await sendAndConfirm(connection, wallet, tx);
  return { signature: sig };
}

export type CrankRefreshParams = {
  marketPubkey: PublicKey;
  portfolioPubkey: PublicKey;
  assetIndex: number;
  effectivePrice: bigint;
  fundingRateE9: bigint;
};

/// Permissionless: any signer can refresh a portfolio's health
/// certificate against fresh oracle + funding inputs.
export async function crankRefreshFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: CrankRefreshParams;
}): Promise<{ signature: string }> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const tx = new Transaction().add(
    crankRefreshIx({
      programId: PROGRAM_ID,
      market: params.marketPubkey,
      portfolio: params.portfolioPubkey,
      cranker: wallet.publicKey,
      assetIndex: params.assetIndex,
      effectivePrice: params.effectivePrice,
      fundingRateE9: params.fundingRateE9,
    }),
  );
  const sig = await sendAndConfirm(connection, wallet, tx);
  return { signature: sig };
}

export type LiquidateParams = {
  marketPubkey: PublicKey;
  portfolioPubkey: PublicKey;
  assetIndex: number;
  closeQ: bigint;
  feeBps: bigint;
};

/// Permissionless: any signer can call. Engine refuses with `NonProgress`
/// when the target portfolio's certified liquidation deficit is zero.
export async function liquidateFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: LiquidateParams;
}): Promise<{ signature: string }> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const tx = new Transaction().add(
    liquidateIx({
      programId: PROGRAM_ID,
      market: params.marketPubkey,
      portfolio: params.portfolioPubkey,
      liquidator: wallet.publicKey,
      assetIndex: params.assetIndex,
      closeQ: params.closeQ,
      feeBps: params.feeBps,
    }),
  );
  const sig = await sendAndConfirm(connection, wallet, tx);
  return { signature: sig };
}

// ---------- internals ----------

async function sendAndConfirm(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey!;
  const sig = await wallet.sendTransaction(tx, connection, {
    signers: extraSigners,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  return sig;
}

