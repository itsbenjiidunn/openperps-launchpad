/// Pure formatting helpers — no React, no chain.

export function fmtUsd(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(d)}`;
}

export function fmtNum(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: d,
    minimumFractionDigits: d,
  });
}

export function fmtPct(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(d)}%`;
}

/// Truncate a Solana pubkey into the standard `abcd…wxyz` display form.
export function fmtPubkey(s: string, head = 4, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
