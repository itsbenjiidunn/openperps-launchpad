/// User-facing single-button trade against the shared market group. The
/// counterparty is the shared House Vault; the user signs once.

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  type Commitment,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  accrueAssetIx,
  placeOrderIx,
  readU64LE,
  slotEffectivePriceOffset,
  slotOffset,
  Side,
} from "@opp-oss/sdk";
import type { TransactionInstruction } from "@solana/web3.js";

import { PROGRAM_ID } from "../program";
import { ingestTrade } from "../indexer";
import { SHARED_HOUSE, SHARED_MARKET, SHARED_SLOT_CAPACITY } from "../sharedMarket";
import { delegatePda, sessionUsableFor } from "../sessionKey";

// `oi_eff_long_q` / `oi_eff_short_q` within an engine asset slot (32-byte slot
// wrapper + in-asset offsets 273 / 289). Used to find which slots carry open
// interest. `slot_last` sits at in-slot offset 73.
const SLOT_OI_LONG_IN_SLOT = 32 + 273;
const SLOT_OI_SHORT_IN_SLOT = 32 + 289;
const SLOT_LAST_IN_SLOT = 73;
// Each AccrueAsset advances `slot_last` by at most the engine's
// `max_accrual_dt_slots` (1000). To clear a slot that has fallen far behind we
// must burst ceil(behind / 1000) of them; cap the burst so the tx still fits.
const MAX_ACCRUAL_DT = 1000;
const MAX_CATCHUP_STEPS = 8;

/// The percolator engine raises a group-wide stale-loss lock (LockActive) for
/// any risk-increasing trade whenever ANY asset slot that has open interest has
/// `slot_last < now_slot`. Worse, opening on a slot whose `slot_last` lags by
/// more than `max_accrual_dt_slots` makes the engine accrue over a `dt` outside
/// the validated solvency envelope and reject with InvalidConfig (0x3e8). Both
/// are fixed the same way: inside the trade tx, prepend delta-0 AccrueAsset
/// (current price, zero funding) to bump `slot_last` up to `now_slot` BEFORE
/// PlaceOrder. We do this for every OI-bearing slot AND the slot we're about to
/// trade (which may have no OI yet on its first fill), bursting enough accruals
/// to cover however far each has fallen behind. AccrueAsset is permissionless,
/// so the trade signer authorizes it.
export async function staleClearAccrues(
  connection: Connection,
  signer: PublicKey,
  market: PublicKey,
  tradedAssetIndex: number,
): Promise<TransactionInstruction[]> {
  const [info, nowSlot] = await Promise.all([
    connection.getAccountInfo(market),
    connection.getSlot(CONFIRM_COMMITMENT),
  ]);
  const data = info?.data;
  if (!data) return [];
  const u = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const ixs: TransactionInstruction[] = [];
  for (let i = 0; i < SHARED_SLOT_CAPACITY; i++) {
    const base = slotOffset(i);
    const shortOff = base + SLOT_OI_SHORT_IN_SLOT;
    if (shortOff + 8 > data.length) break; // past this group's capacity
    const oiLong = readU64LE(u, base + SLOT_OI_LONG_IN_SLOT);
    const oiShort = readU64LE(u, base + SLOT_OI_SHORT_IN_SLOT);
    const hasOi = oiLong !== 0n || oiShort !== 0n;
    // OI slots can lock the whole group; the traded slot must be fresh so its
    // first fill doesn't accrue over an out-of-envelope dt. Skip the rest.
    if (!hasOi && i !== tradedAssetIndex) continue;
    const eff = readU64LE(u, slotEffectivePriceOffset(i));
    if (eff === 0n) continue;
    const slotLast = Number(readU64LE(u, base + SLOT_LAST_IN_SLOT));
    const behind = nowSlot > slotLast ? nowSlot - slotLast : 0;
    const steps = Math.min(Math.max(1, Math.ceil(behind / MAX_ACCRUAL_DT)), MAX_CATCHUP_STEPS);
    for (let k = 0; k < steps; k++) {
      ixs.push(
        accrueAssetIx({
          programId: PROGRAM_ID,
          market,
          authority: signer,
          assetIndex: i,
          effectivePrice: eff, // delta-0: only advances slot_last, no price move
          fundingRateE9: 0n,
        }),
      );
    }
  }
  return ixs;
}

export type PlaceOrderParams = {
  /// The market group this trade targets. Defaults to the shared majors group;
  /// custom SPL markets pass their own isolated group account.
  market?: PublicKey;
  /// House portfolio that takes the other side. Defaults to the shared House;
  /// custom groups pass their own seeded House.
  housePortfolio?: PublicKey;
  userPortfolioPubkey: PublicKey;
  side: Side;
  assetIndex: number;
  sizeQ: bigint;
  execPrice: bigint;
  feeBps: bigint;
  /// Kept for call-site compatibility; no longer used (CrankOracle removed).
  oraclePool?: PublicKey;
};

const marketOf = (p: PlaceOrderParams) => p.market ?? SHARED_MARKET;
const houseOf = (p: PlaceOrderParams) => p.housePortfolio ?? SHARED_HOUSE;

/// The trade instruction. No CrankOracle: the on-chain mark is maintained by the
/// relayer pushing the live mainnet price via AccrueAsset (plus the in-tx
/// stale-clear). CrankOracle reads the SEEDED mock pool and would drag the mark
/// back toward the seed price — a huge move that reverts the trade with
/// InvalidConfig (0x3e8) once the relayer has converged the mark to the real
/// price. `signer` is whoever pays/signs (wallet or session key).
function tradeIxs(
  params: PlaceOrderParams,
  signer: PublicKey,
  delegate?: PublicKey,
): TransactionInstruction[] {
  return [
    placeOrderIx({
      programId: PROGRAM_ID,
      market: marketOf(params),
      userPortfolio: params.userPortfolioPubkey,
      housePortfolio: houseOf(params),
      user: signer,
      delegate,
      side: params.side,
      assetIndex: params.assetIndex,
      sizeQ: params.sizeQ,
      execPrice: params.execPrice,
      feeBps: params.feeBps,
    }),
  ];
}

export type PlaceOrderResult = {
  signature: string;
  /// True when the trade was signed by the session key (no wallet popup).
  viaSession: boolean;
};

const CONFIRM_COMMITMENT: Commitment = "confirmed";

/// Map a known on-chain program error code to a plain-English, actionable
/// message. Returns null for codes we don't have specific copy for (caller
/// falls back to the raw log line).
function tradeErrorMessage(code: number): string | null {
  switch (code) {
    case 1000: // InvalidConfig — in the trade path this is the margin/leverage gate
      return "Order too large for your collateral — it exceeds this market's max leverage. Lower the size or leverage and try again.";
    case 1007: // LockActive — stale-loss lock / price refresh pending
      return "Market is briefly locked while its price refreshes. Wait a few seconds and try again.";
    case 1001: // InvalidLeg / position shape
      return "This order can't be placed against your current position. Try closing first, or use a smaller size.";
    default:
      return null;
  }
}

/// Simulate the trade first so an on-chain revert surfaces a clear, actionable
/// message instead of the wallet adapter's generic "Unexpected error". Throws a
/// descriptive Error if the simulation fails.
export async function preflight(connection: Connection, tx: Transaction): Promise<void> {
  let sim;
  try {
    sim = await connection.simulateTransaction(tx);
  } catch {
    return; // simulation itself unavailable — let the send path try.
  }
  if (!sim.value.err) return;
  // Translate the program's custom error code into friendly copy when we can.
  const err = sim.value.err as { InstructionError?: [number, { Custom?: number }] } | null;
  const code = err?.InstructionError?.[1]?.Custom;
  if (typeof code === "number") {
    const friendly = tradeErrorMessage(code);
    if (friendly) throw new Error(friendly);
  }
  // Unknown error: surface the most telling log line (the program's own
  // error/panic), else the raw err object.
  const logs = sim.value.logs ?? [];
  const hint =
    logs.find((l) => /error|failed|panicked|insufficient|custom/i.test(l)) ??
    logs[logs.length - 1] ??
    JSON.stringify(sim.value.err);
  throw new Error(`Trade rejected: ${hint}`);
}

export async function placeOrderFlow(args: {
  wallet: WalletContextState;
  connection: Connection;
  params: PlaceOrderParams;
}): Promise<PlaceOrderResult> {
  const { wallet, connection, params } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet is not connected.");
  }
  const owner = wallet.publicKey.toBase58();

  // 1-click path: only if a funded session key is registered on-chain as THIS
  // portfolio's delegate (otherwise PlaceOrder would fail with
  // MissingRequiredSignature — e.g. a stale session from another portfolio).
  // Falls back to the wallet popup when not authorized.
  const session = await sessionUsableFor(connection, owner, params.userPortfolioPubkey);
  const signer = session ? session.publicKey : wallet.publicKey;
  // Clear the group stale-loss lock atomically (see staleClearAccrues) + give
  // the tx headroom for the extra accrual instructions.
  const accrues = await staleClearAccrues(
    connection,
    signer,
    marketOf(params),
    params.assetIndex,
  );
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 });
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(CONFIRM_COMMITMENT);

  if (session) {
    const [pda] = delegatePda(params.userPortfolioPubkey);
    const tx = new Transaction().add(
      budget,
      ...accrues,
      ...tradeIxs(params, session.publicKey, pda),
    );
    tx.recentBlockhash = blockhash;
    tx.feePayer = session.publicKey;
    tx.sign(session);
    await preflight(connection, tx);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      CONFIRM_COMMITMENT,
    );
    ingestTrade(sig); // durable cross-device entry/history within seconds
    return { signature: sig, viaSession: true };
  }

  // Wallet path (one popup).
  const tx = new Transaction().add(
    budget,
    ...accrues,
    ...tradeIxs(params, wallet.publicKey),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  await preflight(connection, tx);
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    CONFIRM_COMMITMENT,
  );
  ingestTrade(sig); // durable cross-device entry/history within seconds
  return { signature: sig, viaSession: false };
}
