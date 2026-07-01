/// Raydium CPMM (constant-product) spot-pool adapter for the native launch path. Creates a
/// token/SOL pool so a freshly launched token is instantly spot-tradeable + routable, and
/// so the pool can become the perp's verifiable DEX-EWMA oracle via SetDexPool.
///
/// `@raydium-io/raydium-sdk-v2` + `bn.js` are heavy deps, imported LAZILY so the app builds
/// without loading them until a pool is actually created.
///
/// CLUSTER-AWARE: works on devnet AND mainnet. The cluster is detected from the RPC
/// endpoint (devnet hosts contain "devnet"). On devnet we use the devnet CPMM program ids
/// and derive the fee-config PDA from them (the token-list / fee-config API has no devnet
/// data for a fresh mint), exactly the recipe verified end to end on devnet. Pool creation
/// costs a Raydium protocol fee (~0.15 SOL on mainnet, ~1 SOL on devnet) plus the deposited
/// liquidity, so the creator wallet needs spare SOL.

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { DeployContext } from "./types";
import type { SpotPoolProvider, SpotPoolRequest, SpotPoolResult } from "./spotPool";

/// Wrapped SOL mint, the quote side of a token/SOL pool.
const WSOL = "So11111111111111111111111111111111111111112";

/// Lazily load the optional Raydium SDK + BN. Throws a clear, actionable error if absent.
async function loadRaydium(): Promise<{ sdk: any; BN: any }> {
  try {
    // @ts-ignore optional peer dependency; may not be installed
    const sdk = await import("@raydium-io/raydium-sdk-v2");
    // @ts-ignore optional peer dependency; may not be installed
    const bn = await import("bn.js");
    return { sdk, BN: (bn as any).default ?? bn };
  } catch {
    throw new Error(
      "Spot pool needs `@raydium-io/raydium-sdk-v2` + `bn.js` installed (npm i @raydium-io/raydium-sdk-v2 bn.js).",
    );
  }
}

/// Minimal token info for the pool builder. The token-list API has no data for a freshly
/// launched mint on either cluster, so we construct it from what we already know.
function mintInfo(address: string, symbol: string, decimals: number) {
  return {
    chainId: 101,
    address,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    logoURI: "",
    symbol,
    name: symbol,
    decimals,
    tags: [] as string[],
    extensions: {},
  };
}

export const raydiumCpmmProvider: SpotPoolProvider = {
  id: "raydium-cpmm",
  label: "Spot pool",
  available: true,
  async createPool(req: SpotPoolRequest, ctx: DeployContext): Promise<SpotPoolResult> {
    if (req.pair !== "sol") throw new Error("Spot pool adapter pairs token/SOL only.");
    const { wallet, connection, payer } = ctx;
    if (!wallet.signAllTransactions) {
      throw new Error("This wallet cannot create a spot pool (no signAllTransactions).");
    }

    const { sdk, BN } = await loadRaydium();
    const {
      Raydium,
      TxVersion,
      CREATE_CPMM_POOL_PROGRAM,
      CREATE_CPMM_POOL_FEE_ACC,
      DEVNET_PROGRAM_ID,
      getCpmmPdaAmmConfigId,
    } = sdk;

    const isDevnet = connection.rpcEndpoint.includes("devnet");
    const cluster: "devnet" | "mainnet" = isDevnet ? "devnet" : "mainnet";
    const cpmmProgram = isDevnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : CREATE_CPMM_POOL_PROGRAM;
    const cpmmFeeAcc = isDevnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC : CREATE_CPMM_POOL_FEE_ACC;

    // Browser wallet flow: load with the wallet's public key + signAllTransactions, so the
    // SDK's execute() delegates signing to the wallet instead of a server keypair.
    const raydium = await Raydium.load({
      connection,
      owner: payer,
      signAllTransactions: wallet.signAllTransactions,
      cluster,
      disableFeatureCheck: true,
      blockhashCommitment: "confirmed",
    });

    const mintA = mintInfo(req.mint.toBase58(), "TOKEN", req.decimals);
    const mintB = mintInfo(WSOL, "WSOL", 9);

    // Fee configs: remap each config id to the PDA derived from THIS cluster's CPMM program
    // (the API returns mainnet ids; on devnet the real config PDA differs).
    const feeConfigs = await raydium.api.getCpmmConfigs();
    feeConfigs.forEach((c: any) => {
      c.id = getCpmmPdaAmmConfigId(cpmmProgram, c.index).publicKey.toBase58();
    });

    const { execute, extInfo } = await raydium.cpmm.createPool({
      programId: cpmmProgram,
      poolFeeAccount: cpmmFeeAcc,
      mintA,
      mintB,
      mintAAmount: new BN(req.tokenAmount.toString()),
      mintBAmount: new BN(req.solLamports.toString()),
      startTime: new BN(0),
      feeConfig: feeConfigs[0],
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.V0,
    });

    const { txId } = await execute({ sendAndConfirm: true });
    return {
      venue: "raydium-cpmm",
      poolId: new PublicKey(extInfo.address.poolId),
      signature: txId,
    };
  },
};
