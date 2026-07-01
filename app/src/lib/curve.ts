/// Client SDK for the OPP bonding-curve program (pump.fun-style constant-product
/// curve), deployed on devnet at the id below. Mirrors `crates/curve/src/lib.rs`:
/// the same PDA seeds, the same 160-byte `BondingCurve` layout, the same tag/LE
/// instruction encoding, and the same curve-favoring (ceil) rounding in the
/// quote helpers, so an on-chain buy/sell never disagrees with the UI preview.

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/// The deployed curve program (devnet). Authority = the launch deployer.
export const CURVE_PROGRAM_ID = new PublicKey(
  "3r69jC4xCmJTa2Rron5u6MrFkpwaU5771hPzE1Ht2wxC",
);

export const CURVE_SEED = new TextEncoder().encode("curve");
export const CURVE_VAULT_SEED = new TextEncoder().encode("vault");
/// "OPPCURVE" magic at the head of a curve account.
const CURVE_DISCRIMINATOR = new TextEncoder().encode("OPPCURVE");
const CURVE_ACCOUNT_LEN = 160;

const TAG_CREATE = 0;
const TAG_BUY = 1;
const TAG_SELL = 2;
const TAG_WITHDRAW = 3;
const TAG_CLAIM_FEES = 4;

/// Max creator fee in basis points (2%), matching the on-chain cap.
export const CURVE_FEE_BPS_MAX = 200;

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

export function curvePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CURVE_SEED, mint.toBytes()], CURVE_PROGRAM_ID);
}

export function curveVaultPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CURVE_VAULT_SEED, mint.toBytes()], CURVE_PROGRAM_ID);
}

// ---------------------------------------------------------------------------
// LE encoding helpers
// ---------------------------------------------------------------------------

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function ixData(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Curve math (mirror of the Rust quote_* functions, ceil-rounded toward the curve)
// ---------------------------------------------------------------------------

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export interface BuyQuote {
  solIn: bigint;
  tokensOut: bigint;
  newVsol: bigint;
  newVtok: bigint;
  drains: boolean;
}

/// Quote a buy of `solIn` lamports against virtual reserves, capped by `realTok`
/// for-sale tokens. Identical rounding to the program (ceil on the remaining
/// reserve), so the preview equals the executed trade.
export function quoteBuy(
  vsol: bigint,
  vtok: bigint,
  realTok: bigint,
  solIn: bigint,
): BuyQuote {
  if (solIn <= 0n) throw new Error("Amount must be positive.");
  const k = vsol * vtok;
  let newVsol = vsol + solIn;
  let newVtok = ceilDiv(k, newVsol);
  let tokensOut = vtok - newVtok;
  let charged = solIn;
  let drains = false;
  if (tokensOut >= realTok) {
    tokensOut = realTok;
    newVtok = vtok - tokensOut;
    newVsol = ceilDiv(k, newVtok > 0n ? newVtok : 1n);
    charged = newVsol - vsol;
    drains = true;
  }
  if (tokensOut <= 0n) throw new Error("Buy too small for one token unit.");
  return { solIn: charged, tokensOut, newVsol, newVtok, drains };
}

export interface SellQuote {
  solOut: bigint;
  newVsol: bigint;
  newVtok: bigint;
}

/// Quote a sell of `tokensIn`. The caller must also bound `solOut` by the real
/// SOL reserves (the program rejects a sell that would over-draw).
export function quoteSell(vsol: bigint, vtok: bigint, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) throw new Error("Amount must be positive.");
  const k = vsol * vtok;
  const newVtok = vtok + tokensIn;
  const newVsol = ceilDiv(k, newVtok);
  const solOut = vsol - newVsol;
  return { solOut, newVsol, newVtok };
}

/// Spot price in lamports per base-unit token (`vsol / vtok`), scaled to a float
/// for display. Returns SOL per whole token at the given decimals.
export function spotPriceSol(vsol: bigint, vtok: bigint, decimals: number): number {
  if (vtok === 0n) return 0;
  // (vsol / 1e9) / (vtok / 10^dec) = vsol * 10^dec / (vtok * 1e9)
  const num = Number(vsol) * 10 ** decimals;
  const den = Number(vtok) * 1e9;
  return den === 0 ? 0 : num / den;
}

// ---------------------------------------------------------------------------
// Default curve shape
// ---------------------------------------------------------------------------

export interface CurveParams {
  /// Virtual SOL reserves (lamports): the starting-price anchor.
  virtualSol: bigint;
  /// Virtual token reserves (base units): the curve invariant denominator.
  virtualTokens: bigint;
  /// Real tokens parked on the curve and sellable to buyers (base units).
  tokenForSale: bigint;
  /// Real SOL raised at which the curve graduates and freezes (lamports).
  graduateSol: bigint;
  /// Creator fee in basis points (0 to [`CURVE_FEE_BPS_MAX`]), charged on every
  /// buy/sell and claimable by the creator. Omitted or 0 means no fee.
  feeBps?: number;
}

/// A pump.fun-shaped default: ~80% of supply on the curve, 30 virtual SOL, and a
/// graduation target scaled so the average buyer pays a sane entry. `virtualTokens`
/// is set above `tokenForSale` (the unsold remainder backs the post-graduation
/// price) so the curve never fully empties its virtual side.
export function defaultCurveParams(totalSupply: bigint, graduateSolUi = 50): CurveParams {
  const tokenForSale = (totalSupply * 80n) / 100n;
  // Virtual token reserve a touch above the for-sale slug, like pump.fun's 1.073B
  // virtual vs ~0.8B real, so price starts low and rises smoothly.
  const virtualTokens = (totalSupply * 107n) / 100n;
  return {
    virtualSol: 30_000_000_000n, // 30 SOL
    virtualTokens,
    tokenForSale,
    graduateSol: BigInt(Math.round(graduateSolUi * 1e9)),
  };
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

export interface CreateCurveResult {
  ix: TransactionInstruction;
  curve: PublicKey;
  vault: PublicKey;
}

/// `Create`: stand up the curve PDA + a vault token account holding `tokenForSale`,
/// pulled from `creatorTokenAccount`. The mint must already exist with the supply
/// in `creatorTokenAccount`.
export function buildCreateCurveIx(args: {
  creator: PublicKey;
  mint: PublicKey;
  creatorTokenAccount: PublicKey;
  params: CurveParams;
}): CreateCurveResult {
  const { creator, mint, creatorTokenAccount, params } = args;
  const [curve, curveBump] = curvePda(mint);
  const [vault, vaultBump] = curveVaultPda(mint);
  const data = concat([
    new Uint8Array([TAG_CREATE]),
    u64le(params.virtualSol),
    u64le(params.virtualTokens),
    u64le(params.tokenForSale),
    u64le(params.graduateSol),
    new Uint8Array([curveBump, vaultBump]),
    u16le(Math.max(0, Math.min(CURVE_FEE_BPS_MAX, Math.round(params.feeBps ?? 0)))),
  ]);
  const ix = new TransactionInstruction({
    programId: CURVE_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: ixData(data),
  });
  return { ix, curve, vault };
}

/// `Buy`: SOL in, tokens out. `buyerTokenAccount` must be the buyer's ATA for the mint.
export function buildBuyIx(args: {
  buyer: PublicKey;
  mint: PublicKey;
  buyerTokenAccount: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
}): TransactionInstruction {
  const { buyer, mint, buyerTokenAccount, solIn, minTokensOut } = args;
  const [curve] = curvePda(mint);
  const [vault] = curveVaultPda(mint);
  const data = concat([new Uint8Array([TAG_BUY]), u64le(solIn), u64le(minTokensOut)]);
  return new TransactionInstruction({
    programId: CURVE_PROGRAM_ID,
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData(data),
  });
}

/// `Sell`: tokens in, SOL out.
export function buildSellIx(args: {
  seller: PublicKey;
  mint: PublicKey;
  sellerTokenAccount: PublicKey;
  tokensIn: bigint;
  minSolOut: bigint;
}): TransactionInstruction {
  const { seller, mint, sellerTokenAccount, tokensIn, minSolOut } = args;
  const [curve] = curvePda(mint);
  const [vault] = curveVaultPda(mint);
  const data = concat([new Uint8Array([TAG_SELL]), u64le(tokensIn), u64le(minSolOut)]);
  return new TransactionInstruction({
    programId: CURVE_PROGRAM_ID,
    keys: [
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: ixData(data),
  });
}

/// `WithdrawGraduated`: creator-only, post-graduation. Sweeps raised SOL to
/// `solDest` and remaining vault tokens to `tokenDest` (for Raydium seeding).
export function buildWithdrawIx(args: {
  creator: PublicKey;
  mint: PublicKey;
  solDest: PublicKey;
  tokenDest: PublicKey;
}): TransactionInstruction {
  const { creator, mint, solDest, tokenDest } = args;
  const [curve] = curvePda(mint);
  const [vault] = curveVaultPda(mint);
  return new TransactionInstruction({
    programId: CURVE_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: solDest, isSigner: false, isWritable: true },
      { pubkey: tokenDest, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: ixData(new Uint8Array([TAG_WITHDRAW])),
  });
}

/// `ClaimFees`: creator-only. Sweeps the creator fees accrued in the curve
/// account (lamports beyond rent + withdrawable raised SOL) to the creator.
export function buildClaimFeesIx(args: { creator: PublicKey; mint: PublicKey }): TransactionInstruction {
  const { creator, mint } = args;
  const [curve] = curvePda(mint);
  return new TransactionInstruction({
    programId: CURVE_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: curve, isSigner: false, isWritable: true },
    ],
    data: ixData(new Uint8Array([TAG_CLAIM_FEES])),
  });
}

// ---------------------------------------------------------------------------
// Account reader
// ---------------------------------------------------------------------------

export interface BondingCurveState {
  mint: PublicKey;
  creator: PublicKey;
  vault: PublicKey;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalForSale: bigint;
  graduateSolThreshold: bigint;
  complete: boolean;
  bump: number;
  vaultBump: number;
  /// Creator fee in basis points (0 for legacy curves created before fees).
  feeBps: number;
}

function readU64(view: DataView, off: number): bigint {
  return view.getBigUint64(off, true);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/// Parse a 160-byte `BondingCurve` account buffer.
export function decodeBondingCurve(data: Uint8Array): BondingCurveState {
  if (data.length < CURVE_ACCOUNT_LEN) throw new Error("Curve account too small.");
  if (!bytesEqual(data.slice(0, 8), CURVE_DISCRIMINATOR)) {
    throw new Error("Not a curve account (bad discriminator).");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: new PublicKey(data.slice(8, 40)),
    creator: new PublicKey(data.slice(40, 72)),
    vault: new PublicKey(data.slice(72, 104)),
    virtualSolReserves: readU64(view, 104),
    virtualTokenReserves: readU64(view, 112),
    realSolReserves: readU64(view, 120),
    realTokenReserves: readU64(view, 128),
    tokenTotalForSale: readU64(view, 136),
    graduateSolThreshold: readU64(view, 144),
    complete: data[152] !== 0,
    bump: data[153],
    vaultBump: data[154],
    feeBps: data.length >= 157 ? view.getUint16(155, true) : 0,
  };
}

/// Fetch + decode the curve for a mint, or null if it does not exist yet.
export async function fetchBondingCurve(
  connection: Connection,
  mint: PublicKey,
): Promise<BondingCurveState | null> {
  const [curve] = curvePda(mint);
  const acc = await connection.getAccountInfo(curve, "confirmed");
  if (!acc) return null;
  return decodeBondingCurve(acc.data);
}

/// Bonding progress in [0,1]: how close the real SOL raised is to graduation.
export function bondingProgress(state: BondingCurveState): number {
  if (state.graduateSolThreshold === 0n) return 0;
  const p = Number(state.realSolReserves) / Number(state.graduateSolThreshold);
  return Math.max(0, Math.min(1, p));
}
