// MUST be the very first import: it installs the global `Buffer` before any
// Solana/web3 dependency is evaluated. See polyfills.ts for why it cannot be
// inline here (ES modules evaluate imports before the module body).
import "./polyfills";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SolanaProviders } from "./wallet/SolanaProviders";
import { LaunchpadApp } from "./launchpad/LaunchpadApp";

// Components poll via their own `refetchInterval`, so window-focus refetching only
// contends with the wallet popup round-trip. Disable it and cap retries.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SolanaProviders>
        <LaunchpadApp />
      </SolanaProviders>
    </QueryClientProvider>
  </StrictMode>,
);
