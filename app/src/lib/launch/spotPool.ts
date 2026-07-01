/// Spot-LP abstraction for the launch aggregator. When a dev mints a token natively,
/// OpenPerps can also add a real spot pool so the token is instantly spot-tradeable, and
/// so the pool's on-chain EWMA can later become the perp's verifiable DEX-EWMA oracle (via
/// SetDexPool). Pool creation is mainnet-only and live-unverified here.

import type { PublicKey } from "@solana/web3.js";
import type { DeployContext } from "./types";
import { raydiumCpmmProvider } from "./raydiumCpmm";

export type SpotPoolVenueId = "raydium-cpmm" | "meteora-dlmm" | "orca-whirlpool";

export interface SpotPoolRequest {
  mint: PublicKey;
  decimals: number;
  /// Quote side of the pair. Only SOL for now (token/SOL).
  pair: "sol";
  /// Base liquidity: token atoms to deposit.
  tokenAmount: bigint;
  /// Quote liquidity: lamports of SOL to deposit. Together with tokenAmount this sets the
  /// pool's opening price (solLamports / tokenAmount, scaled by decimals).
  solLamports: bigint;
}

export interface SpotPoolResult {
  venue: SpotPoolVenueId;
  poolId: PublicKey;
  signature: string;
}

export interface SpotPoolProvider {
  id: SpotPoolVenueId;
  label: string;
  /// False = the venue is recognised + selectable but its SDK is not wired yet (createPool
  /// throws with a clear message). Lets the UI show the option honestly.
  available: boolean;
  createPool(req: SpotPoolRequest, ctx: DeployContext): Promise<SpotPoolResult>;
}

export const SPOT_POOL_VENUES: SpotPoolProvider[] = [raydiumCpmmProvider];

export function getSpotPoolProvider(id: SpotPoolVenueId): SpotPoolProvider {
  const provider = SPOT_POOL_VENUES.find((v) => v.id === id);
  if (!provider) throw new Error(`Unknown spot-pool venue: ${id}`);
  return provider;
}
