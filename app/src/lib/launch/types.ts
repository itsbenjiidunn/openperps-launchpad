/// Launch core types. OpenPerps mints the token and, in the same non-custodial flow,
/// stands up a coin-margin perp on it (and optionally a spot pool). A `LaunchProvider`
/// is the token-origin backend; the flow adds the markets. The dev's own wallet signs
/// everything; OpenPerps only orchestrates.

import type {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export type LaunchProviderId = "native";

/// One wallet-approved transaction in a provider's deploy plan, in order.
export interface DeployStep {
  label: string;
  /// A legacy `Transaction` (we set the blockhash) or a `VersionedTransaction` that the
  /// provider already built with a recent blockhash (we just co-sign + send).
  tx: Transaction | VersionedTransaction;
  /// Extra signers beyond the wallet (e.g. the fresh mint keypair).
  signers?: Keypair[];
}

/// What a provider produces: the new mint, the ordered steps to create it, where the
/// creator's resulting bag lands (it funds the coin-margin perp seed), and the decimals.
export interface DeployPlan {
  mint: PublicKey;
  creatorTokenAccount: PublicKey;
  decimals: number;
  steps: DeployStep[];
}

export interface DeployContext {
  connection: Connection;
  wallet: WalletContextState;
  /// The creator / payer (== wallet.publicKey).
  payer: PublicKey;
}

export interface TokenLaunchRequest {
  name: string;
  symbol: string;
  /// IPFS metadata JSON URI. External launchpads require it before the create tx; the
  /// aggregator fills it via the uploader when omitted.
  metadataUri?: string;
  /// External launchpads (pump/bonk): SOL spent dev-buying the creator's bag at create.
  devBuySol?: number;
  slippagePct?: number;
  priorityFeeSol?: number;
  /// Total supply (atoms) + decimals.
  totalSupply?: bigint;
  decimals?: number;
  /// Drop the mint authority after minting (fixed supply). Default true.
  revokeMintAuthority?: boolean;
  /// Pre-ground vanity mint keypair (the CA ends in "opp"). When omitted the provider
  /// generates a fresh random mint.
  mintKeypair?: Keypair;
}

export interface LaunchProvider {
  id: LaunchProviderId;
  label: string;
  /// True when the creator's stake comes from a dev-buy (pump/bonk) instead of holding
  /// the whole supply (native). Drives how the perp allocation is sized and whether a
  /// metadata upload is required up front.
  fromDevBuy: boolean;
  deployToken(req: TokenLaunchRequest, ctx: DeployContext): Promise<DeployPlan>;
}
