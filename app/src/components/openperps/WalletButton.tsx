import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wallet, Copy, Check, LogOut, ChevronDown } from "lucide-react";
import { fmtPubkey } from "@/lib/format";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/// Custom wallet control. Disconnected → a subtle "Connect" pill that opens the
/// adapter modal. Connected → a neon pill (wallet icon + truncated address)
/// with a copy / disconnect dropdown.
export function WalletButton() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const [copied, setCopied] = useState(false);

  if (!publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="flex h-9 items-center gap-2 rounded-full border border-neon/40 px-4 text-sm font-medium text-neon transition-colors hover:bg-neon/10 disabled:opacity-60"
        disabled={connecting}
      >
        <Wallet className="h-4 w-4" />
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  const address = publicKey.toBase58();
  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="group flex h-9 items-center gap-2 rounded-full bg-gradient-to-r from-neon to-[oklch(0.82_0.15_175)] px-3.5 font-mono text-sm font-semibold text-neon-foreground shadow-[0_0_16px_oklch(0.86_0.16_188_/_0.35)] transition-shadow hover:shadow-[0_0_22px_oklch(0.86_0.16_188_/_0.55)]">
          <Wallet className="h-4 w-4" />
          <span>{fmtPubkey(address)}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-70 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={copy}>
          {copied ? (
            <Check className="h-4 w-4 text-success" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied ? "Copied!" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => disconnect()}
          className="text-danger focus:text-danger"
        >
          <LogOut className="h-4 w-4" />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
