/// Live on-chain data hooks. These intentionally only surface what the
/// program actually knows about — market header, vault TokenAccount balance,
/// portfolio capital — and leave display-only metrics (24h volume, funding
/// rate history, recent trades) `undefined` until an indexer or Pyth feed
/// fills them in.

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  OFFSET_CAPITAL,
  OFFSET_C_TOT,
  OFFSET_PNL,
  OFFSET_VAULT,
  PRICE_SCALE,
  readI128LE,
  readU128LE,
  readU64LE,
  slotEffectivePriceOffset,
  slotOffset,
  decodePortfolioPositions,
  HOUSE_SEED,
  type DecodedPosition,
} from "@opp-oss/sdk";

import { listMarkets, type RegistryEntry } from "./registry";
import { PROGRAM_ID } from "./program";
import { ASSET_PRESETS } from "./assets";
import { registerMarket, fetchCustomMarkets } from "./indexer";
import { OFFICIAL_MARKETS, isOfficialSlot } from "./officialMarkets";
import { SHARED_MARKET, SHARED_SLOT_CAPACITY } from "./sharedMarket";
import type { Market } from "./types";

// Slots already synced to the relayer this session (so it knows the price
// source) — fire-and-forget once per slot.
const registeredSlots = new Set<number>();
function syncRelayer(m: Market): void {
  if (registeredSlots.has(m.assetIndex)) return;
  registeredSlots.add(m.assetIndex);
  const preset = ASSET_PRESETS.find((p) => p.ticker === m.base);
  void registerMarket({
    assetIndex: m.assetIndex,
    symbol: m.symbol,
    pythFeedId: preset?.pythFeedId ?? m.oracleFeedId,
    baseMint: m.baseMint,
  });
}

/// Returns the registry-known markets enriched with whatever live state we
/// can decode from their on-chain accounts. Display-only fields stay
/// `undefined` for components to render as "—".
export function useMarkets(): UseQueryResult<Market[]> {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["markets", connection.rpcEndpoint],
    queryFn: async () => {
      // Two sources of markets: the built-in official majors (SOL/BTC/ETH/JUP,
      // pinned to fixed slots and shown to everyone) and custom SPL launches.
      // Official slots are authoritative — a custom registry entry can never
      // shadow one. Custom own-group launches are discovered GLOBALLY from the
      // shared indexer (so every wallet/device sees the same list), merged with
      // this browser's local registry as a fallback.
      const info = await connection.getAccountInfo(SHARED_MARKET);
      const data = info?.data ?? null;

      const byIndex = new Map<number, RegistryEntry>();
      for (const e of listMarkets()) {
        if (e.pubkey === SHARED_MARKET.toBase58() && !isOfficialSlot(e.assetIndex))
          byIndex.set(e.assetIndex, e);
      }
      for (const e of OFFICIAL_MARKETS) byIndex.set(e.assetIndex, e);

      const out: Market[] = [];
      for (const [i, entry] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
        // Official markets always render (the homepage is never empty even if
        // the RPC hiccups); custom ones only when their slot is live on-chain.
        if (!isOfficialSlot(i)) {
          if (!data) continue;
          const off = slotOffset(i);
          const live =
            off + 32 <= data.length &&
            (!slotIsZero(data, off) || decodeSlotPriceUsd(data, i) !== null);
          if (!live) continue;
        }
        const mkt = registryToMarket(entry, data);
        // Keep the relayer's slot → price-source mapping warm so it pushes
        // live prices on-chain (idempotent; once per session per slot).
        syncRelayer(mkt);
        out.push(mkt);
      }

      // Custom SPL markets are their OWN isolated group (separate account), so
      // decode each from its own market account rather than the shared one.
      // Source = the shared indexer (global) merged with the local registry;
      // local entries override remote so a fresh launch shows instantly even
      // before the indexer round-trips.
      const remote = await fetchCustomMarkets();
      const ownByPubkey = new Map<string, RegistryEntry>();
      for (const e of remote) if (e.ownGroup) ownByPubkey.set(e.pubkey, e);
      for (const e of listMarkets()) if (e.ownGroup) ownByPubkey.set(e.pubkey, e);
      const ownGroups = [...ownByPubkey.values()];
      if (ownGroups.length > 0) {
        const infos = await connection.getMultipleAccountsInfo(
          ownGroups.map((e) => new PublicKey(e.pubkey)),
        );
        ownGroups.forEach((e, idx) => {
          const acct = infos[idx];
          if (!acct) return; // group account gone / not on this cluster
          out.push(registryToMarket(e, acct.data as Buffer));
        });
      }
      return out;
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

function slotIsZero(data: Buffer, off: number): boolean {
  for (let b = 0; b < 32; b++) if (data[off + b] !== 0) return false;
  return true;
}

/// Account-data decode of a single market — returns engine vault / c_tot
/// (u128) so callers can show the live collateral pool size.
export function useMarketState(pubkey: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["market-state", pubkey, connection.rpcEndpoint],
    enabled: !!pubkey,
    queryFn: async () => {
      const info = await connection.getAccountInfo(new PublicKey(pubkey!));
      if (!info) return null;
      return decodeMarketState(info);
    },
    refetchInterval: 5_000,
  });
}

/// SPL Token balance of a market's vault TokenAccount.
export function useVaultBalance(vault: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["vault", vault, connection.rpcEndpoint],
    enabled: !!vault,
    queryFn: async () => {
      const acct = await getAccount(connection, new PublicKey(vault!));
      return acct.amount;
    },
    refetchInterval: 5_000,
  });
}

/// Portfolio header decode for the connected wallet's portfolio account.
/// Caller supplies the portfolio pubkey (we don't yet have a registry of
/// portfolios — that's wired in Phase 4 alongside InitPortfolio).
export function usePortfolioState(pubkey: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["portfolio-state", pubkey, connection.rpcEndpoint],
    enabled: !!pubkey,
    queryFn: async () => {
      const info = await connection.getAccountInfo(new PublicKey(pubkey!));
      if (!info) return null;
      return {
        capital: readU128LE(info.data, OFFSET_CAPITAL),
        pnl: readI128LE(info.data, OFFSET_PNL),
      };
    },
    refetchInterval: 5_000,
  });
}

/// Decode the open positions (active legs) of a portfolio account.
export function usePortfolioPositions(pubkey: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["portfolio-positions", pubkey, connection.rpcEndpoint],
    enabled: !!pubkey,
    queryFn: async (): Promise<DecodedPosition[]> => {
      const info = await connection.getAccountInfo(new PublicKey(pubkey!));
      if (!info) return [];
      return decodePortfolioPositions(new Uint8Array(info.data));
    },
    refetchInterval: 5_000,
  });
}

/// Whether the user is connected. Used by route guards.
export function useWalletConnected(): boolean {
  const { connected } = useWallet();
  return connected;
}

// ---------- internals ----------

function decodeMarketState(info: AccountInfo<Buffer> | { data: Buffer }) {
  const data = info.data as Buffer;
  return {
    vault: readU128LE(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), OFFSET_VAULT),
    cTot: readU128LE(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), OFFSET_C_TOT),
  };
}

/// No real token trades above this USD/unit. A near-`u64::MAX` mark (a dead /
/// duplicate market, or a crater-priced pool whose reserves rounded to ~0)
/// decodes to ~$1.8e13, which smears across the price column; treat anything
/// past this as a corrupt slot and fall back to the registry seed price.
const MAX_SANE_PRICE_USD = 1_000_000_000; // $1B / unit

/// The EWMA mark (effective_price) of asset slot `i` as a USD number, or null
/// if the slot is unset / account too small / reads an implausible (corrupt) mark.
function decodeSlotPriceUsd(data: Buffer, i: number): number | null {
  const off = slotEffectivePriceOffset(i);
  if (data.length < off + 8) return null;
  const atoms = readU64LE(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), off);
  if (atoms === 0n) return null;
  const usd = Number(atoms) / Number(PRICE_SCALE);
  if (!Number.isFinite(usd) || usd > MAX_SANE_PRICE_USD) return null;
  return usd;
}

// `oi_eff_long_q` within an engine asset slot: 32-byte slot wrapper + the asset
// struct's in-field offset 273 (see AssetStateV16Account). Open interest is
// matched (every long has a short), so one side is the contract OI.
const SLOT_OI_LONG_IN_SLOT = 32 + 273;

/// Open interest of asset slot `i` as USD notional (long side × mark), or 0.
function decodeSlotOiUsd(data: Buffer, i: number, priceUsd: number): number {
  const off = slotOffset(i) + SLOT_OI_LONG_IN_SLOT;
  if (data.length < off + 16 || priceUsd <= 0) return 0;
  const u = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const oiBaseAtoms = readU128LE(u, off);
  if (oiBaseAtoms === 0n) return 0;
  return (Number(oiBaseAtoms) / Number(PRICE_SCALE)) * priceUsd;
}

function registryToMarket(entry: RegistryEntry, data: Buffer | null): Market {
  // Pairs live as slots in the shared group; metadata (asset, oracle kind,
  // pool, leverage, fee) is per-slot registry data, and the live mark is the
  // engine's per-slot EWMA effective_price.
  const oracleKind = entry.oracleKind;
  const liveMark = data ? decodeSlotPriceUsd(data, entry.assetIndex) : null;
  const price = liveMark ?? entry.seedPriceUsd ?? 0;
  const openInterest = data ? decodeSlotOiUsd(data, entry.assetIndex, price) : 0;
  // Reference CEX symbol (for the mirrored order book) — derived from the
  // asset preset by ticker; majors have one, custom SPL don't.
  const cexSymbol = ASSET_PRESETS.find((p) => p.ticker === entry.base)?.cexSymbol;
  // Launchpad (curve) markets are their own group but older registry entries omit
  // the House PDA. Derive the canonical House from the market key so trades wire the
  // correct House account (a missing house otherwise falls back to the shared majors
  // House on-chain and reverts with 0x6 InvalidAccountData). Fixes existing + new.
  let house = entry.house;
  let houseBump = entry.houseBump;
  if (entry.ownGroup && !house) {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [HOUSE_SEED, new PublicKey(entry.pubkey).toBuffer()],
      PROGRAM_ID,
    );
    house = pda.toBase58();
    houseBump = bump;
  }
  return {
    pubkey: entry.pubkey,
    symbol: entry.symbol,
    base: entry.base,
    quoteMint: entry.quoteMint,
    vault: entry.vault,
    assetSlotCapacity: entry.assetSlotCapacity,
    assetIndex: entry.assetIndex,
    baseMint: entry.baseMint,
    oracleKind,
    oracleFeedId: entry.oracleFeedId,
    oraclePool: entry.oraclePool,
    maxLeverage: entry.maxLeverage,
    feeBps: entry.feeBps,
    cexSymbol,
    ownGroup: entry.ownGroup,
    house,
    houseBump,
    seedLp: entry.seedLp,
    partner: entry.partner,
    partnerUrl: entry.partnerUrl,
    coinMargin: entry.coinMargin,
    quoteDecimals: entry.quoteDecimals,
    spotKind: entry.spotKind,
    curve: entry.curve,
    spotPool: entry.spotPool,
    price,
    change24h: 0,
    volume24h: 0,
    openInterest,
    funding: 0,
    oracle: oracleKind === "pyth" ? "Pyth" : oracleKind === "dex" ? "DEX" : "Authority",
    oracleStatus: data ? "live" : "stale",
    createdAt: entry.addedAt,
  };
}
