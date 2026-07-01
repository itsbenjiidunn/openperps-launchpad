import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";

/// RPC endpoint. The fast Helius devnet host (with the API key) is supplied via
/// the `VITE_OPENPERPS_RPC` env var from `.env.local` (gitignored) so the key is
/// no longer hard-coded in source. If unset, we fall back to the public,
/// keyless devnet host (heavily rate-limited — set the env var for real use).
/// NOTE: any value here is still inlined into the client bundle (a static dApp
/// can't truly hide its RPC URL); route through the indexer Worker for that.
const RPC_ENDPOINT =
  import.meta.env.VITE_OPENPERPS_RPC ?? "https://api.devnet.solana.com";

export function SolanaProviders({ children }: { children: ReactNode }) {
  // Empty list → wallet-adapter discovers installed wallets via the Wallet
  // Standard (Phantom, Solflare, Backpack, … all register themselves). This
  // avoids the deprecated explicit adapters double-registering with the
  // standard ones, which is a common cause of a stuck "connecting" state.
  const wallets = useMemo<Adapter[]>(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
