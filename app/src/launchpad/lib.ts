/// Shared helpers for the standalone launchpad app (launchpad.openperps.fun). Reuses
/// the main app's curve SDK + registry/indexer so a coin launched here shows up
/// everywhere, and links back to the main app for perp trading.

import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import {
  curvePda,
  curveVaultPda,
  decodeBondingCurve,
  fetchBondingCurve,
  CURVE_PROGRAM_ID,
  type BondingCurveState,
} from "@/lib/curve";
import { listMarkets, type RegistryEntry } from "@/lib/registry";
import { fetchCustomMarkets } from "@/lib/indexer";

/// One launchpad coin = a curve-backed launch (curve PDA + the paired perp market).
export interface Coin {
  mint: string; // the SPL mint / contract address
  symbol: string;
  name: string;
  curve: string; // bonding-curve PDA
  market: string; // paired coin-margin perp market pubkey
  decimals: number;
  createdAt: number;
  creator?: string;
  image?: string; // token image (from metadata), for the card art
  state: BondingCurveState | null; // live curve reserves, null until loaded
}

function entryToCoin(e: RegistryEntry): Coin | null {
  if (e.spotKind !== "curve" || !e.baseMint) return null;
  return {
    mint: e.baseMint,
    symbol: e.symbol,
    name: e.base || e.symbol,
    curve: e.curve ?? curvePda(new PublicKey(e.baseMint))[0].toBase58(),
    market: e.pubkey,
    decimals: e.quoteDecimals ?? 6,
    createdAt: e.addedAt ?? 0,
    state: null,
  };
}

/// All curve-backed coins (global indexer list merged with this browser's local
/// registry), each enriched with its live curve reserves + metadata image. Reads are
/// single requests (the free Helius plan rejects the getMultipleAccounts batch).
export async function fetchCoins(connection: Connection): Promise<Coin[]> {
  const [remote, local] = await Promise.all([
    fetchCustomMarkets().catch(() => [] as RegistryEntry[]),
    Promise.resolve(listMarkets()),
  ]);
  const byMint = new Map<string, Coin>();
  for (const e of [...remote, ...local]) {
    const c = entryToCoin(e);
    if (c && !byMint.has(c.mint)) byMint.set(c.mint, c);
  }
  const coins = [...byMint.values()];
  if (coins.length === 0) return coins;

  await Promise.all(
    coins.map(async (c) => {
      const [info, meta] = await Promise.all([
        connection.getAccountInfo(new PublicKey(c.curve), "confirmed").catch(() => null),
        fetchTokenMeta(connection, c.mint).catch(() => null),
      ]);
      if (info?.data) {
        try {
          c.state = decodeBondingCurve(info.data);
          c.creator = c.state.creator.toBase58();
        } catch {
          /* not a curve account / stale */
        }
      }
      if (meta?.image) c.image = meta.image;
      if (meta?.name) c.name = meta.name;
      if (meta?.symbol) c.symbol = meta.symbol;
    }),
  );
  return coins.sort((a, b) => b.createdAt - a.createdAt);
}

/// Coins launched by a given wallet (creator), newest first. Reuses fetchCoins and
/// filters on the on-chain creator recorded in each curve.
export async function fetchCreatedCoins(connection: Connection, creator: string): Promise<Coin[]> {
  const all = await fetchCoins(connection);
  return all.filter((c) => c.creator === creator);
}

/// One coin by mint: its registry meta (symbol/name/perp market) plus a fresh read
/// of its live curve reserves. Falls back to a minimal synthetic meta when the coin
/// is not in any registry yet (e.g. just launched, indexer not caught up), so the
/// page still renders from the on-chain curve alone.
export async function fetchCoin(connection: Connection, mint: string): Promise<Coin> {
  const [remote, local] = await Promise.all([
    fetchCustomMarkets().catch(() => [] as RegistryEntry[]),
    Promise.resolve(listMarkets()),
  ]);
  const e = [...local, ...remote].find((x) => x.baseMint === mint && x.spotKind === "curve");
  const coin: Coin =
    (e && entryToCoin(e)) ?? {
      mint,
      symbol: shortCa(mint),
      name: "Coin",
      curve: curvePda(new PublicKey(mint))[0].toBase58(),
      market: "",
      decimals: 6,
      createdAt: 0,
      state: null,
    };
  coin.state = await fetchBondingCurve(connection, new PublicKey(mint));
  return coin;
}

/// URL of the main trading app for cross-linking (perp trading). On the
/// `launchpad.` subdomain this strips the prefix; locally it stays same-origin.
export function mainAppUrl(path = "/"): string {
  if (typeof window === "undefined") return path;
  const { hostname, protocol, port } = window.location;
  if (hostname.startsWith("launchpad.")) {
    const base = hostname.slice("launchpad.".length);
    return `${protocol}//${base}${port ? ":" + port : ""}${path}`;
  }
  return path;
}

/// Deterministic two-stop gradient from a mint address, for a coin avatar when no
/// image is set. Hue derived from the address bytes so each coin is recognisable.
export function avatarGradient(mint: string): string {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) % 360;
  const h2 = (h + 48) % 360;
  return `linear-gradient(135deg, oklch(0.72 0.16 ${h}), oklch(0.62 0.17 ${h2}))`;
}

/// Short CA display: first 4 + last 4.
export function shortCa(mint: string): string {
  return mint.length <= 10 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/// Compact USD: $4.20K, $189.41K, $1.20M.
export function fmtUsdK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

/// The canonical Pyth SOL/USD feed id, for pricing market caps in USD.
export const SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// ---------------------------------------------------------------------------
// Holders + trades (read on-chain; no curve-trade index yet)
// ---------------------------------------------------------------------------

export interface Holder {
  account: string;
  owner?: string;
  amount: number;
  pct: number;
  tag?: string;
}

/// Top token holders (largest token accounts) with their share of supply and the
/// resolved wallet owner. `labels` tags known accounts (the curve vault, the perp
/// House vault). Owners are read with single requests (the free Helius plan rejects
/// the getMultipleAccounts batch).
export async function fetchHolders(
  connection: Connection,
  mint: string,
  decimals: number,
  labels: Record<string, string> = {},
): Promise<Holder[]> {
  const mintPk = new PublicKey(mint);
  let supply = 1_000_000_000;
  try {
    const s = await connection.getTokenSupply(mintPk, "confirmed");
    supply = s.value.uiAmount ?? supply;
  } catch {
    /* fall back to the launch-fixed 1B */
  }
  const res = await connection.getTokenLargestAccounts(mintPk, "confirmed");
  const top = res.value.slice(0, 12);
  const owners = await Promise.all(
    top.map((a) =>
      connection
        .getParsedAccountInfo(a.address, "confirmed")
        .then((r) => {
          const d = r.value?.data;
          return d && "parsed" in d ? (d.parsed.info?.owner as string | undefined) : undefined;
        })
        .catch(() => undefined),
    ),
  );
  return top.map((a, i) => {
    const amount = a.uiAmount ?? Number(a.amount) / 10 ** decimals;
    return {
      account: a.address.toBase58(),
      owner: owners[i],
      amount,
      pct: supply > 0 ? (amount / supply) * 100 : 0,
      tag: labels[a.address.toBase58()],
    };
  });
}

/// Metaplex Token Metadata program.
const META_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export interface TokenMeta {
  name: string;
  symbol: string;
  image?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/// On-chain Metaplex metadata for a mint, plus the off-chain JSON it points to
/// (image + socials). Returns null if the token has no metadata account.
export async function fetchTokenMeta(connection: Connection, mint: string): Promise<TokenMeta | null> {
  const mintPk = new PublicKey(mint);
  const [metaPda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), META_PROGRAM.toBytes(), mintPk.toBytes()],
    META_PROGRAM,
  );
  const acc = await connection.getAccountInfo(metaPda, "confirmed");
  if (!acc) return null;
  const data = acc.data;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 1 + 32 + 32; // key + updateAuthority + mint
  const readStr = (): string => {
    if (off + 4 > data.length) return "";
    const len = dv.getUint32(off, true);
    off += 4;
    const bytes = data.slice(off, off + len);
    off += len;
    return new TextDecoder().decode(bytes).replace(/\0+$/, "").trim();
  };
  const name = readStr();
  const symbol = readStr();
  const uri = readStr();
  if (!uri) return { name, symbol };
  try {
    const json = (await (await fetch(uri)).json()) as Partial<TokenMeta>;
    return {
      name,
      symbol,
      image: json.image,
      description: json.description,
      twitter: json.twitter,
      telegram: json.telegram,
      website: json.website,
    };
  } catch {
    return { name, symbol };
  }
}

export interface CurveTrade {
  type: "buy" | "sell";
  trader: string;
  sol: number;
  tokens: number;
  ts: number;
  sig: string;
}

/// Recent buys/sells on a coin's curve, reconstructed from the curve account's
/// transaction history: the curve instruction's tag byte gives buy vs sell, the
/// curve PDA's lamport delta gives the SOL, the vault's token-balance delta gives
/// the token amount. Best-effort (two RPC calls); a server-side index would give
/// full history + volume.
export async function fetchCurveTrades(
  connection: Connection,
  mint: string,
): Promise<CurveTrade[]> {
  const mintPk = new PublicKey(mint);
  const [curve] = curvePda(mintPk);
  const [vault] = curveVaultPda(mintPk);
  const sigs = await connection.getSignaturesForAddress(curve, { limit: 20 }, "confirmed");
  if (sigs.length === 0) return [];
  // Fetch each tx individually, NOT via getParsedTransactions (a JSON-RPC batch,
  // which the free Helius plan rejects with 403). Cap the count so it stays a
  // handful of parallel single requests.
  const recent = sigs.slice(0, 15);
  const txs = await Promise.all(
    recent.map((s) =>
      connection
        .getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        })
        .catch(() => null),
    ),
  );
  const curveStr = curve.toBase58();
  const vaultStr = vault.toBase58();
  const pid = CURVE_PROGRAM_ID.toBase58();
  const out: CurveTrade[] = [];

  txs.forEach((tx, i) => {
    if (!tx || !tx.meta || tx.meta.err) return;
    const meta = tx.meta;
    const msg = tx.transaction.message;
    // Only curve-program txs.
    if (!msg.instructions.some((x) => x.programId.toBase58() === pid)) return;

    const keys = msg.accountKeys;
    const curveIdx = keys.findIndex((k) => k.pubkey.toBase58() === curveStr);
    if (curveIdx < 0) return;

    // Buy vs sell from the signed deltas (no instruction-data decode needed):
    // a buy adds SOL to the curve and removes tokens from the vault; a sell does
    // the reverse. The create tx has no pre-existing vault balance (skip), and a
    // withdraw moves both out (both deltas negative -> skip).
    const solDelta = (meta.postBalances[curveIdx] - meta.preBalances[curveIdx]) / 1e9;
    const findVault = (arr: typeof meta.preTokenBalances) =>
      arr?.find((b) => keys[b.accountIndex]?.pubkey.toBase58() === vaultStr);
    const pre = findVault(meta.preTokenBalances);
    const post = findVault(meta.postTokenBalances);
    if (!pre || !post) return; // vault absent on one side -> create -> skip
    const tokenDelta = (post.uiTokenAmount.uiAmount ?? 0) - (pre.uiTokenAmount.uiAmount ?? 0);

    let type: "buy" | "sell";
    if (solDelta > 0 && tokenDelta < 0) type = "buy";
    else if (solDelta < 0 && tokenDelta > 0) type = "sell";
    else return; // not a buy/sell (create / withdraw / no-op)

    out.push({
      type,
      trader: keys[0]?.pubkey.toBase58() ?? "",
      sol: Math.abs(solDelta),
      tokens: Math.abs(tokenDelta),
      ts: (recent[i].blockTime ?? 0) * 1000,
      sig: recent[i].signature,
    });
  });

  return out;
}

export interface TickerTrade extends CurveTrade {
  coinMint: string;
  coinSymbol: string;
  coinImage?: string;
}

/// Recent trades across the top coins, merged + sorted newest-first, for the live
/// scrolling ticker. Caps the coin count so it stays a handful of parallel reads.
export async function fetchTickerTrades(connection: Connection, coins: Coin[]): Promise<TickerTrade[]> {
  const top = coins.slice(0, 6);
  const per = await Promise.all(
    top.map((c) =>
      fetchCurveTrades(connection, c.mint)
        .then((tr) => tr.map((t) => ({ ...t, coinMint: c.mint, coinSymbol: c.symbol, coinImage: c.image })))
        .catch(() => [] as TickerTrade[]),
    ),
  );
  return per.flat().sort((a, b) => b.ts - a.ts).slice(0, 25);
}

/// Per-coin sparkline points (market cap in SOL over recent trades). Cheap: reuses
/// the trade reader. Multiply by the live SOL price for USD in the component.
export async function fetchCoinSpark(connection: Connection, mint: string, supply = 1_000_000_000): Promise<number[]> {
  const trades = await fetchCurveTrades(connection, mint).catch(() => []);
  return trades
    .slice()
    .reverse()
    .filter((t) => t.tokens > 0)
    .map((t) => (t.sol / t.tokens) * supply);
}
