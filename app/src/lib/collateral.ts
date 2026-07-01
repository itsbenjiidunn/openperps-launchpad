/// Shared devnet collateral mint. EVERY OpenPerps market quotes against
/// this single mock-USDC mint, so a trader funds their wallet once (via the
/// Faucet) and can deposit into any market. This is the decoupling that
/// makes "launch a market" mean *bind an existing asset to an oracle*, not
/// *mint a brand-new token*.
///
/// The mint authority secret below is intentionally public. It is a
/// throwaway devnet keypair that only ever signs `MintTo` for the faucet;
/// it holds no SOL and controls nothing of value. NEVER reuse this pattern
/// on mainnet — there, collateral is real USDC with no app-held authority.

import { PublicKey } from "@solana/web3.js";

import { QUOTE_DECIMALS } from "./decimals";

export const QUOTE_SYMBOL = "mUSDC";

/// Shared mock-USDC mint, created once on devnet via
/// `ts/sdk/scripts/create-musdc.ts`. Override per-cluster with
/// `VITE_OPENPERPS_QUOTE_MINT`.
const QUOTE_MINT_STRING =
  import.meta.env.VITE_OPENPERPS_QUOTE_MINT ??
  "9r6k1R6tLsMJhvsU4RVNunbpWcTqivudCRYCJGP9Urat";

export const QUOTE_MINT = new PublicKey(QUOTE_MINT_STRING);

/// Default faucet drip: 10,000 mUSDC in atoms. The mint authority is no longer
/// shipped in the client — the faucet is a server-side indexer endpoint (see
/// `requestFaucet` / `faucetFlow`). This is only for the UI's "Mint X" label.
export const FAUCET_DRIP_ATOMS = 10_000n * 10n ** BigInt(QUOTE_DECIMALS);

/// The collateral a market is denominated in. Normal markets quote mUSDC; a
/// coin-margined (inverse) market uses the base token itself. The whole trading
/// UI reads the deposit mint, display symbol and decimals from HERE, so a
/// coin-margin market funds and shows in its own token instead of mUSDC.
export type Collateral = { mint: PublicKey; symbol: string; decimals: number };

export function collateralOf(market: {
  coinMargin?: boolean;
  quoteMint?: string;
  baseMint?: string;
  base?: string;
  quoteDecimals?: number;
}): Collateral {
  if (market.coinMargin && (market.quoteMint || market.baseMint)) {
    return {
      mint: new PublicKey(market.quoteMint ?? market.baseMint!),
      symbol: market.base || "token",
      decimals: market.quoteDecimals ?? QUOTE_DECIMALS,
    };
  }
  return { mint: QUOTE_MINT, symbol: QUOTE_SYMBOL, decimals: QUOTE_DECIMALS };
}
