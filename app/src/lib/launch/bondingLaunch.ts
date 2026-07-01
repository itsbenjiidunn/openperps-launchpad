/// Two-approval launch for the launchpad: mint + bonding curve (+ optional dev-buy) +
/// coin-margin perp. The mint is sent and CONFIRMED first (approval 1), then the curve
/// and perp are signed together and sent (approval 2). Confirming the mint before the
/// rest are built lets the wallet simulate them against a real on-chain mint, so it no
/// longer warns that it cannot simulate the launch. This trades one extra popup for a
/// clean wallet simulation with no scary red warning.

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildLaunchpadPerp, marketAccountSize, VAULT_SEED, HOUSE_SEED } from "@opp-oss/sdk";

import { PROGRAM_ID } from "../program";
import { addMarket } from "../registry";
import { postMarket } from "../indexer";
import { buildCreateCurveIx, buildBuyIx, type CurveParams } from "../curve";
import { getLaunchProvider } from "./providers";
import type { TokenLaunchRequest } from "./types";

export interface BondingLaunchResult {
  mint: PublicKey;
  market: PublicKey;
  curve: PublicKey;
  signatures: string[];
}

export async function bondingLaunch(args: {
  wallet: WalletContextState;
  connection: Connection;
  request: TokenLaunchRequest;
  curve: CurveParams;
  /// Perp manual-oracle seed price (USD). The curve is the live spot until graduation.
  launchPriceUsd: number;
  /// Optional dev-buy folded into the curve transaction.
  initialBuyLamports?: bigint;
  onProgress?: (detail: string) => void;
}): Promise<BondingLaunchResult> {
  const { wallet, connection, request, curve, launchPriceUsd, initialBuyLamports, onProgress } = args;
  if (!wallet.publicKey) throw new Error("Wallet is not connected.");
  const payer = wallet.publicKey;
  const progress = (d: string) => onProgress?.(d);

  // 1) Mint transaction (mint + supply + optional metadata) via the native provider.
  const plan = await getLaunchProvider("native").deployToken(request, { connection, wallet, payer });
  const mintStep = plan.steps[0];
  if (plan.steps.length !== 1 || !(mintStep.tx instanceof Transaction)) {
    throw new Error("Unexpected mint plan shape for a one-shot launch.");
  }
  const mintTx = mintStep.tx;
  const mintSigners = mintStep.signers ?? [];
  const { mint, creatorTokenAccount: creatorAta, decimals } = plan;

  // 2) Curve transaction (+ optional dev-buy folded in; the buy ix runs after create).
  const built = buildCreateCurveIx({ creator: payer, mint, creatorTokenAccount: creatorAta, params: curve });
  // An explicit compute budget keeps strict wallet simulators from tripping a
  // per-ix units ceiling on the multi-ix listing txs.
  const curveTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), built.ix);
  if (initialBuyLamports && initialBuyLamports > 0n) {
    const buyerAta = getAssociatedTokenAddressSync(mint, payer);
    curveTx.add(
      buildBuyIx({ buyer: payer, mint, buyerTokenAccount: buyerAta, solIn: initialBuyLamports, minTokensOut: 0n }),
    );
  }

  // 3) Perp transaction (whole listing in one tx), seeded by the non-curve remainder.
  const allocationAtoms = (request.totalSupply ?? 0n) - curve.tokenForSale;
  if (allocationAtoms <= 0n) throw new Error("Perp allocation is zero; the curve takes the whole supply.");
  const market = Keypair.generate();
  const marketRent = await connection.getMinimumBalanceForRentExemption(marketAccountSize(1));
  const listing = buildLaunchpadPerp({
    programId: PROGRAM_ID,
    authority: payer,
    market: market.publicKey,
    marketRentLamports: marketRent,
    token: mint,
    symbol: request.symbol,
    name: request.name,
    launchPriceUsd,
    allocationAtoms,
    authorityTokenAccount: creatorAta,
  });
  const perpTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...listing.instructions,
  );

  // 4) Approval 1 of 2: create the coin, then CONFIRM it before building the rest.
  //    Confirming the mint on-chain first means the wallet can actually simulate
  //    the curve + perp (they reference an existing mint), so it no longer warns
  //    "cannot simulate" / "funds may be lost".
  if (!wallet.sendTransaction) {
    throw new Error("This wallet cannot sign the launch. Use Phantom or Solflare.");
  }
  const signatures: string[] = [];
  progress("Approve 1 of 2: create the coin");
  {
    const bh = await connection.getLatestBlockhash("confirmed");
    mintTx.recentBlockhash = bh.blockhash;
    mintTx.feePayer = payer;
    const sig = await wallet.sendTransaction(mintTx, connection, { signers: mintSigners });
    await connection.confirmTransaction(
      { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed",
    );
    signatures.push(sig);
  }

  // Poll until the mint is actually visible before building approval 2, so the
  // wallet's own simulator (which may hit a devnet node lagging our confirmation)
  // can see the mint and does not warn it cannot simulate the launch.
  for (let i = 0; i < 10; i++) {
    const info = await connection.getAccountInfo(mint, "confirmed").catch(() => null);
    if (info) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  // 5) Approval 2 of 2: the mint now exists, so sign the curve (+ optional dev-buy)
  //    and the perp together (one popup) and send them in order. Both simulate
  //    cleanly against the live mint, so the wallet shows no red warning.
  progress("Approve 2 of 2: list the curve and perp");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const rest = [curveTx, perpTx];
  for (const tx of rest) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;
  }
  perpTx.partialSign(market);
  let signed: Transaction[];
  if (wallet.signAllTransactions) {
    signed = await wallet.signAllTransactions(rest);
  } else if (wallet.signTransaction) {
    signed = [];
    for (const tx of rest) signed.push(await wallet.signTransaction(tx));
  } else {
    throw new Error("This wallet cannot sign the launch. Use Phantom or Solflare.");
  }

  const labels = ["curve", "perp"];
  for (let i = 0; i < signed.length; i++) {
    progress(`Confirming ${labels[i]}`);
    const sig = await connection.sendRawTransaction(signed[i].serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    signatures.push(sig);
  }

  // 7) Register the market so it shows in the grid + on every device.
  const vault = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  )[0].toBase58();
  // The canonical House PDA of this launch's own group. It MUST be in the registry
  // so trades wire the right House account; a missing house reverts on-chain (0x6).
  const [housePda, houseBump] = PublicKey.findProgramAddressSync(
    [HOUSE_SEED, market.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const entry = {
    pubkey: market.publicKey.toBase58(),
    symbol: request.symbol,
    base: request.symbol,
    quoteMint: mint.toBase58(),
    vault,
    assetSlotCapacity: 1,
    assetIndex: 0,
    baseMint: mint.toBase58(),
    oracleKind: "manual" as const,
    maxLeverage: 5,
    seedPriceUsd: launchPriceUsd,
    ownGroup: true,
    house: housePda.toBase58(),
    houseBump,
    coinMargin: true,
    quoteDecimals: decimals,
    seedLp: Number(allocationAtoms) / 10 ** decimals,
    launchpad: "native",
    curve: built.curve.toBase58(),
    spotKind: "curve" as const,
  };
  addMarket(entry);
  void postMarket(entry);

  return { mint, market: market.publicKey, curve: built.curve, signatures };
}
