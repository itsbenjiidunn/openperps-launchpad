/// localStorage-backed registry of portfolios the user has initialized.
/// Each portfolio is keyed by its account pubkey and tagged with the
/// owner wallet + the market it lives under, so a single wallet can hold
/// multiple portfolios across markets.

const KEY = "openperps:portfolios";

export type PortfolioEntry = {
  pubkey: string;
  marketPubkey: string;
  owner: string;
  label?: string;
  addedAt: number;
};

function readRaw(): PortfolioEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PortfolioEntry[];
  } catch {
    return [];
  }
}

function writeRaw(entries: PortfolioEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(entries));
}

export function listPortfolios(): PortfolioEntry[] {
  return readRaw().sort((a, b) => b.addedAt - a.addedAt);
}

export function listPortfoliosFor(owner: string, marketPubkey?: string): PortfolioEntry[] {
  return readRaw()
    .filter(
      (p) =>
        p.owner === owner &&
        (marketPubkey === undefined || p.marketPubkey === marketPubkey),
    )
    .sort((a, b) => b.addedAt - a.addedAt);
}

export function addPortfolio(entry: Omit<PortfolioEntry, "addedAt">): void {
  const existing = readRaw();
  const without = existing.filter((p) => p.pubkey !== entry.pubkey);
  without.push({ ...entry, addedAt: Date.now() });
  writeRaw(without);
}

export function removePortfolio(pubkey: string): void {
  writeRaw(readRaw().filter((p) => p.pubkey !== pubkey));
}
