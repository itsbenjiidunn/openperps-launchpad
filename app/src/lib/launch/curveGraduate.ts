/// Graduate a completed bonding curve: the creator sweeps the raised SOL and the
/// unsold tokens out of the curve, then seeds a spot pool (Raydium CPMM token/SOL)
/// with them, so trading moves from the curve to a real AMM. The registry entry
/// flips `spotKind` from "curve" to "pool". Mirrors pump.fun's migration: unsold
/// curve tokens + raised SOL become the opening pool liquidity.
///
/// Oracle note: a token/SOL pool prices in SOL, not USD, so it is NOT auto-bound as
/// the perp's mark. Pinning the perp oracle (SetDexPool) stays a deliberate, separate
/// step that needs a USDC-quote pool to yield a USD mark.

import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { fetchBondingCurve, buildWithdrawIx } from "../curve";
import { updateMarket } from "../registry";
import { getSpotPoolProvider } from "./spotPool";

/// SOL held back from the raised amount to cover the pool-creation rents + fees.
const SOL_BUFFER_LAMPORTS = 100_000_000n; // 0.1 SOL

export interface GraduateResult {
  withdrawSig: string;
  poolId: PublicKey;
  poolSig: string;
}

export async function graduateCurve(args: {
  wallet: WalletContextState;
  connection: Connection;
  mint: PublicKey;
  decimals: number;
  /// Registry market pubkey to flip to a pool once graduated; optional.
  market?: string;
  onProgress?: (detail: string) => void;
}): Promise<GraduateResult> {
  const { wallet, connection, mint, decimals, market, onProgress } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Wallet is not connected.");
  const payer = wallet.publicKey;
  const progress = (d: string) => onProgress?.(d);

  const state = await fetchBondingCurve(connection, mint);
  if (!state) throw new Error("No bonding curve exists for this token.");
  if (!state.complete) throw new Error("The curve has not graduated yet.");
  if (!state.creator.equals(payer)) throw new Error("Only the launch creator can graduate the curve.");
  if (state.realSolReserves <= SOL_BUFFER_LAMPORTS) {
    throw new Error("Raised SOL is too low to seed a pool.");
  }

  // 1) Sweep raised SOL (to the wallet) + unsold tokens (to the creator ATA).
  progress("Withdrawing curve liquidity");
  const ata = getAssociatedTokenAddressSync(mint, payer);
  const ixs: TransactionInstruction[] = [];
  const ataInfo = await connection.getAccountInfo(ata, "confirmed");
  if (!ataInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(payer, ata, payer, mint));
  }
  ixs.push(buildWithdrawIx({ creator: payer, mint, solDest: payer, tokenDest: ata }));
  const withdrawSig = await send(connection, wallet, ixs);

  // 2) Seed the spot pool from the withdrawn liquidity.
  progress("Creating the spot pool");
  const tokenAmount = state.realTokenReserves;
  const solLamports = state.realSolReserves - SOL_BUFFER_LAMPORTS;
  const pool = await getSpotPoolProvider("raydium-cpmm").createPool(
    { mint, decimals, pair: "sol", tokenAmount, solLamports },
    { connection, wallet, payer },
  );

  // 3) Flip the market to a pool in the local registry.
  if (market) {
    updateMarket(market, { spotKind: "pool", spotPool: pool.poolId.toBase58() });
  }
  progress("Graduated to a spot pool");

  return { withdrawSig, poolId: pool.poolId, poolSig: pool.signature };
}

async function send(
  connection: Connection,
  wallet: WalletContextState,
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey!;
  const sig = await wallet.sendTransaction!(tx, connection);
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
