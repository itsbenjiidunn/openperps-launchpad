/// The network pill in the header: shows the live devnet slot, and opens a small
/// menu to switch clusters. Mainnet is not live yet, so choosing it sends the user
/// to app.openperps.fun (the gated mainnet app / coming-soon page).

import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown } from "lucide-react";

import { useSlot } from "@/hooks/useSlot";

const MAINNET_URL = "https://app.openperps.fun";

export function NetworkSelector({ className }: { className?: string }) {
  const slot = useSlot();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md panel-flat px-2.5 py-1.5 font-mono text-xs transition-colors hover:border-neon/40"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${slot ? "bg-success pulse-dot" : "bg-muted-foreground"}`} />
        <span className="text-muted-foreground">devnet</span>
        <span className="text-foreground/70">·</span>
        <span className="text-muted-foreground">slot</span>
        <span className="text-foreground">{slot ? slot.toLocaleString() : "—"}</span>
        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-44 overflow-hidden rounded-md border border-border bg-background shadow-xl">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs hover:bg-muted"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> Devnet
            </span>
            <Check className="h-3.5 w-3.5 text-neon" />
          </button>
          <a
            href={MAINNET_URL}
            className="flex w-full items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" /> Mainnet
            </span>
            <span className="rounded border border-border px-1 py-0.5 text-[9px] uppercase tracking-wide">Soon</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}
