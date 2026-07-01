/// Native launch provider: OpenPerps mints the SPL token itself (full supply to the
/// creator), so the dev can then add a real spot pool (any venue) AND a coin-margin perp
/// in the same aggregator flow. Unlike Pump/Bonk, the creator holds the whole supply, so
/// the perp seed + LP both come out of that bag.

import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
} from "@solana/spl-token";
import { buildTokenMetadataIx } from "@opp-oss/sdk";

import type { DeployContext, DeployPlan, LaunchProvider, TokenLaunchRequest } from "./types";

export const nativeProvider: LaunchProvider = {
  id: "native",
  label: "Native (OpenPerps mint)",
  fromDevBuy: false,
  async deployToken(req: TokenLaunchRequest, ctx: DeployContext): Promise<DeployPlan> {
    const decimals = req.decimals ?? 6;
    const totalSupply = req.totalSupply ?? 0n;
    if (totalSupply <= 0n) throw new Error("Native launch needs a positive totalSupply.");

    // Use the pre-ground vanity mint (CA ends in "opp") when provided, else a fresh one.
    const mintKp = req.mintKeypair ?? Keypair.generate();
    const mint = mintKp.publicKey;
    const ata = getAssociatedTokenAddressSync(mint, ctx.payer);
    const mintRent = await ctx.connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    const ixs = [
      SystemProgram.createAccount({
        fromPubkey: ctx.payer,
        newAccountPubkey: mint,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      // No freeze authority: a launch token must not be freezable.
      createInitializeMint2Instruction(mint, decimals, ctx.payer, null),
    ];
    // Optional Metaplex metadata (the creator is still the mint authority here).
    if (req.metadataUri) {
      ixs.push(
        buildTokenMetadataIx({
          mint,
          mintAuthority: ctx.payer,
          payer: ctx.payer,
          name: req.name,
          symbol: req.symbol,
          uri: req.metadataUri,
        }),
      );
    }
    ixs.push(
      createAssociatedTokenAccountInstruction(ctx.payer, ata, ctx.payer, mint),
      createMintToInstruction(mint, ata, ctx.payer, totalSupply),
    );
    // Fixed supply (a launch trust signal): drop the mint authority after minting.
    if (req.revokeMintAuthority ?? true) {
      ixs.push(createSetAuthorityInstruction(mint, ctx.payer, AuthorityType.MintTokens, null));
    }

    return {
      mint,
      creatorTokenAccount: ata,
      decimals,
      steps: [{ label: "Mint token + supply", tx: new Transaction().add(...ixs), signers: [mintKp] }],
    };
  },
};
