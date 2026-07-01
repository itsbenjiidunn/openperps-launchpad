/// Local trade log + tiny reactive store. Without an indexer we can't show a
/// global trade feed, so we record the connected wallet's own fills in
/// localStorage and surface them in the Terminal's "Recent trades" tab. The
/// store notifies subscribers on every `addTrade`, so the feed updates live
/// (no refresh needed).

import { useSyncExternalStore } from "react";

const KEY = "openperps:trades";
const MAX = 60;

export type TradeRecord = {
  ts: number;
  market: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  signature: string;
};

function read(): TradeRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TradeRecord[]) : [];
  } catch {
    return [];
  }
}

// Cached, sorted snapshot for useSyncExternalStore (stable reference until a
// trade is added, so React doesn't loop).
let snapshot: TradeRecord[] = read().sort((a, b) => b.ts - a.ts);
const listeners = new Set<() => void>();

function refresh(): void {
  snapshot = read().sort((a, b) => b.ts - a.ts);
  listeners.forEach((l) => l());
}

export function listTrades(): TradeRecord[] {
  return snapshot;
}

export function addTrade(t: Omit<TradeRecord, "ts">): void {
  if (typeof window === "undefined") return;
  const next = [{ ...t, ts: Date.now() }, ...read()].slice(0, MAX);
  window.localStorage.setItem(KEY, JSON.stringify(next));
  refresh();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/// VWAP entry of the current net position for `market` (symbol), replayed from
/// THIS device's local fills — the same blend rule the indexer uses (increase
/// blends, partial reduce keeps, flip resets). Used as a stable entry fallback
/// the instant a position opens, before the indexer records the fill, so the
/// entry shows the real execution price instead of tracking the live mark (which
/// would zero out PnL for the first minute or two). Null when the local log
/// can't reconstruct a net position (e.g. the trade was made on another device).
export function localVwapEntry(market: string, trades: TradeRecord[]): number | null {
  const rows = trades.filter((t) => t.market === market).sort((a, b) => a.ts - b.ts);
  let pos = 0;
  let entry = 0;
  for (const r of rows) {
    const signed = (r.side === "buy" ? 1 : -1) * r.size;
    if (pos === 0 || Math.sign(pos) === Math.sign(signed)) {
      const newAbs = Math.abs(pos) + Math.abs(signed);
      entry = newAbs > 0 ? (Math.abs(pos) * entry + Math.abs(signed) * r.price) / newAbs : 0;
      pos += signed;
    } else if (Math.abs(signed) < Math.abs(pos)) {
      pos += signed; // partial close — entry unchanged
    } else {
      const rem = Math.abs(signed) - Math.abs(pos);
      pos = Math.sign(signed) * rem;
      entry = rem > 0 ? r.price : 0;
    }
  }
  return Math.abs(pos) > 1e-9 ? entry : null;
}

/// React hook: live list of your trades, re-renders on every new fill.
export function useTrades(): TradeRecord[] {
  return useSyncExternalStore(subscribe, listTrades, listTrades);
}
