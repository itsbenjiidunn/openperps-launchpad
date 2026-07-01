/// Launchpad create flow: an image drop-zone with a live
/// preview, name + symbol + description + socials, and an optional initial dev-buy.
/// Supply is fixed at 1B and the bonding curve + launch price use fixed
/// defaults (no knobs). The mint is a vanity keypair ground in the background; the
/// whole launch (mint + bonding curve [+ your buy] + coin-margin perp) is one approval.

import { useState, useEffect, useMemo } from "react";
import { Keypair } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Loader2,
  Rocket,
  Sparkles,
  Upload,
  Globe,
  Send,
  Twitter,
  Zap,
  Droplets,
  Coins,
  FileText,
  Image as ImageIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { bondingLaunch } from "@/lib/launch/bondingLaunch";
import { defaultUploader } from "@/lib/launch/ipfs";
import type { CurveParams } from "@/lib/curve";
import type { TokenLaunchRequest } from "@/lib/launch/types";
import { WalletButton } from "@/components/openperps/WalletButton";
import { avatarGradient } from "./lib";

const DECIMALS = 6;

// Fixed launch shape (not user-configurable).
const TOTAL_SUPPLY_UI = 1_000_000_000; // 1B
const PERP_LAUNCH_PRICE_USD = 0.0001; // perp manual-oracle seed (curve is the live spot)
const VIRTUAL_SOL = 30_000_000_000n; // 30 SOL price anchor
const DEFAULT_PERP_PCT = 20; // % of supply seeding the perp House (creator-set)
// Share of the curve's for-sale tokens left UNSOLD at graduation, to seed the spot
// pool (the graduate threshold is derived so the curve stops here instead of draining).
const SPOT_RESERVE_PCT = 20;

/// Tokenomics for a given perp-House %: how the 1B splits across the bonding curve,
/// the perp House, and the spot-pool reserve, plus the derived graduate threshold.
function allocationFor(perpPct: number) {
  const p = Math.max(5, Math.min(40, Math.round(perpPct) || DEFAULT_PERP_PCT));
  const supply = TOTAL_SUPPLY_UI;
  const perpTokens = (supply * p) / 100;
  const forSale = supply - perpTokens; // on the curve
  const spotReserve = (forSale * SPOT_RESERVE_PCT) / 100; // unsold at graduation -> spot pool
  // graduateSol so the curve has sold (forSale - spotReserve) by then.
  const vtok = supply * 1.07;
  const k = 30 * vtok;
  const remaining = vtok - (forSale - spotReserve);
  const graduateSol = remaining > 0 ? Math.round(k / remaining - 30) : 0;
  return { p, perpTokens, forSale, spotReserve, graduateSol: Math.max(1, graduateSol) };
}

/// Compact whole-token count for display: 200M, 1.07B, etc.
function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

export function Create({ onLaunched }: { onLaunched: (mint: string) => void }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const connected = !!wallet.publicKey;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");

  const [initialBuy, setInitialBuy] = useState("");
  const [perpPct, setPerpPct] = useState(String(DEFAULT_PERP_PCT));
  const [creatorFeePct, setCreatorFeePct] = useState("1");

  // Vanity mint ground off-thread (one worker per core) for a branded address.
  const [mintKp, setMintKp] = useState<Keypair | null>(null);
  const [grindTries, setGrindTries] = useState(0);
  const vanityReady = !!mintKp;
  const vanityAddr = mintKp?.publicKey.toBase58() ?? "";
  const alloc = useMemo(() => allocationFor(Number(perpPct)), [perpPct]);

  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const imageUrl = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);
  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  // Grind the vanity mint across several workers in parallel; first to find wins.
  useEffect(() => {
    const count = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));
    const workers: Worker[] = [];
    const tries = new Array<number>(count).fill(0);
    let done = false;
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL("../lib/launch/vanityWorker.ts", import.meta.url), {
        type: "module",
      });
      const idx = i;
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as { type: string; tries?: number; secretKey?: number[] };
        if (d.type === "progress") {
          tries[idx] = d.tries ?? 0;
          setGrindTries(tries.reduce((a, b) => a + b, 0));
        }
        if (d.type === "found" && d.secretKey && !done) {
          done = true;
          setMintKp(Keypair.fromSecretKey(Uint8Array.from(d.secretKey)));
          workers.forEach((x) => x.terminate());
        }
      };
      w.onerror = (ev) => {
        if (!done) setError(`Could not generate your token address: ${ev.message || "worker error"}.`);
      };
      w.postMessage({ suffix: "opp" });
      workers.push(w);
    }
    return () => workers.forEach((w) => w.terminate());
  }, []);

  function pickImage(f: File | null | undefined) {
    if (f && f.type.startsWith("image/")) setImage(f);
  }

  async function onLaunch() {
    setError(null);
    setStatusText(null);
    if (!connected || !wallet.publicKey) return setError("Connect a wallet first.");
    if (!mintKp) return setError("Still preparing your token address. Give it a few seconds.");
    if (!name.trim() || !symbol.trim()) return setError("Name and symbol are required.");

    let request: TokenLaunchRequest;
    let curve: CurveParams;
    let initialBuyLamports: bigint | undefined;
    try {
      const scale = 10 ** DECIMALS;
      const supply = BigInt(Math.round(TOTAL_SUPPLY_UI * scale));
      const perpAlloc = (supply * BigInt(alloc.p)) / 100n; // -> perp House (perp's liquidity)
      const tokenForSale = supply - perpAlloc; // -> bonding curve
      const virtualTokens = (supply * 107n) / 100n;
      const k = VIRTUAL_SOL * virtualTokens;
      // Graduate once the curve has sold (100 - SPOT_RESERVE_PCT)% of the for-sale tokens,
      // so the remainder + raised SOL seed the spot pool instead of the curve draining to 0.
      const sold = (tokenForSale * BigInt(100 - SPOT_RESERVE_PCT)) / 100n;
      const remainingVtok = virtualTokens - sold;
      const newVsol = (k + remainingVtok - 1n) / remainingVtok; // ceil
      const graduateSol = newVsol - VIRTUAL_SOL;
      const buySol = Math.max(0, Number(initialBuy) || 0);
      if (buySol > 0) initialBuyLamports = BigInt(Math.round(buySol * 1e9));

      request = {
        name: name.trim(),
        symbol: symbol.trim(),
        decimals: DECIMALS,
        totalSupply: supply,
        revokeMintAuthority: true,
        mintKeypair: mintKp,
      };
      const feeBps = Math.max(0, Math.min(200, Math.round((Number(creatorFeePct) || 0) * 100)));
      curve = { virtualSol: VIRTUAL_SOL, virtualTokens, tokenForSale, graduateSol, feeBps };
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e));
    }

    setBusy(true);
    try {
      const uploader = defaultUploader();
      if (uploader && (image || description.trim() || website || twitter || telegram)) {
        setStatusText("Uploading metadata");
        request.metadataUri = await uploader.uploadMetadata({
          name: request.name,
          symbol: request.symbol,
          description: description.trim() || undefined,
          ...(image ? { image } : {}),
          ...(website ? { website } : {}),
          ...(twitter ? { twitter } : {}),
          ...(telegram ? { telegram } : {}),
        });
      }

      const res = await bondingLaunch({
        wallet,
        connection,
        request,
        curve,
        launchPriceUsd: PERP_LAUNCH_PRICE_USD,
        ...(initialBuyLamports ? { initialBuyLamports } : {}),
        onProgress: setStatusText,
      });
      onLaunched(res.mint.toBase58());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatusText(null);
    }
  }

  const busyLabel = statusText ? `${statusText}…` : "Launching…";

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Create a coin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mint a token, list it on a bonding curve, and stand up a coin-margin perp on it,
          all in one approval. Supply is fixed at 1B.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* form */}
        <div className="space-y-4">
          {/* image drop zone */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pickImage(e.dataTransfer.files?.[0]);
            }}
            className={`relative flex aspect-[2/1] cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed bg-muted/20 transition-colors ${
              dragging ? "border-neon bg-neon/5" : "border-border hover:border-neon/50"
            } ${busy ? "pointer-events-none opacity-60" : ""}`}
          >
            {imageUrl ? (
              <>
                <img src={imageUrl} alt="preview" className="h-full w-full object-contain" />
                <span className="absolute bottom-2 right-2 rounded-md bg-background/80 px-2 py-1 text-[11px] backdrop-blur">
                  Change image
                </span>
              </>
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
                <Upload className="h-6 w-6" />
                <span className="text-sm">Drag &amp; drop or click to upload</span>
                <span className="text-[11px]">PNG, JPG or GIF</span>
              </div>
            )}
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              className="hidden"
              onChange={(e) => pickImage(e.target.files?.[0])}
            />
          </label>

          {/* upload guidelines */}
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
            <div className="flex gap-2">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-xs font-medium">File size and type</div>
                <ul className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
                  <li>Image: max 15 MB</li>
                  <li>.png, .jpg or .gif recommended</li>
                </ul>
              </div>
            </div>
            <div className="flex gap-2">
              <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-xs font-medium">Resolution and aspect</div>
                <ul className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
                  <li>Min 1000 x 1000px</li>
                  <li>1:1 square recommended</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" value={name} onChange={setName} placeholder="My Coin" disabled={busy} />
            <Field label="Symbol" value={symbol} onChange={setSymbol} placeholder="MYC" disabled={busy} />
          </div>

          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is your coin about?"
              rows={3}
              disabled={busy}
            />
          </div>

          {/* socials (always shown) */}
          <div className="space-y-3">
            <Label>Socials (optional)</Label>
            <IconField icon={<Globe className="h-4 w-4" />} value={website} onChange={setWebsite} placeholder="https://yoursite.com" disabled={busy} />
            <IconField icon={<Twitter className="h-4 w-4" />} value={twitter} onChange={setTwitter} placeholder="https://x.com/yourhandle" disabled={busy} />
            <IconField icon={<Send className="h-4 w-4" />} value={telegram} onChange={setTelegram} placeholder="https://t.me/yourgroup" disabled={busy} />
          </div>

          {/* initial buy */}
          <div className="space-y-1 rounded-lg border border-border p-3">
            <Label className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-neon" /> Buy your coin first{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={initialBuy}
                onChange={(e) => setInitialBuy(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                disabled={busy}
                className="max-w-[140px]"
              />
              <span className="text-sm text-muted-foreground">SOL</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Snag the first bag off your own curve, in the same transaction.
            </p>
          </div>

          {/* perp liquidity (the perp House) */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label className="flex items-center gap-1.5">
              <Droplets className="h-3.5 w-3.5 text-neon" /> Perp liquidity
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={perpPct}
                onChange={(e) => setPerpPct(e.target.value)}
                placeholder="20"
                inputMode="numeric"
                disabled={busy}
                className="max-w-[100px]"
              />
              <span className="text-sm text-muted-foreground">% of supply → perp House</span>
            </div>
            {/* allocation breakdown */}
            <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full">
              <div className="bg-neon" style={{ width: `${alloc.p}%` }} title="Perp House" />
              <div className="bg-neon/40" style={{ width: `${(100 - alloc.p) * (SPOT_RESERVE_PCT / 100)}%` }} title="Spot pool reserve" />
              <div className="bg-muted" style={{ width: `${(100 - alloc.p) * (1 - SPOT_RESERVE_PCT / 100)}%` }} title="Bonding curve" />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="text-neon">{compactTokens(alloc.perpTokens)}</span> seed the perp
              House (its own liquidity, held separately and untouched at graduation).{" "}
              {100 - alloc.p}% lists on the curve; ~
              <span className="text-foreground">{compactTokens(alloc.spotReserve)}</span> of it +
              the raised SOL graduate into a spot pool at ~{alloc.graduateSol} SOL.
            </p>
          </div>

          {/* creator fee */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label className="flex items-center gap-1.5">
              <Coins className="h-3.5 w-3.5 text-neon" /> Creator fee
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={creatorFeePct}
                onChange={(e) => setCreatorFeePct(e.target.value)}
                placeholder="1"
                inputMode="decimal"
                disabled={busy}
                className="max-w-[100px]"
              />
              <span className="text-sm text-muted-foreground">% of every buy and sell, up to 2%</span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              You earn this share of every trade on your curve. It accrues on-chain, and you claim it
              anytime from your coin page.
            </p>
          </div>

          {connected ? (
            <Button onClick={onLaunch} disabled={busy || !vanityReady} className="w-full" size="lg">
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {busyLabel}
                </>
              ) : !vanityReady ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Preparing your address…
                </>
              ) : (
                <>
                  <Rocket className="mr-2 h-4 w-4" /> Launch coin
                </>
              )}
            </Button>
          ) : (
            <div className="flex flex-col items-stretch gap-2">
              <p className="text-center text-xs text-muted-foreground">Connect a wallet to launch.</p>
              <WalletButton />
            </div>
          )}

          {connected ? (
            <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
              Launching takes two quick approvals: first your coin is created, then its curve and
              perp are listed.
            </p>
          ) : null}

          {error ? <p className="text-sm text-red-500">{error}</p> : null}
        </div>

        {/* live preview */}
        <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-center gap-2 rounded-lg border border-border p-3 text-xs">
            <Sparkles className={`h-4 w-4 shrink-0 ${vanityReady ? "text-neon" : "text-muted-foreground"}`} />
            {vanityReady ? (
              <span className="break-all font-mono">
                {vanityAddr.slice(0, 8)}…{vanityAddr.slice(-6)}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Preparing your address… ({grindTries.toLocaleString("en-US")})
              </span>
            )}
          </div>

          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Preview</div>
          <div className="rounded-xl border border-border p-3">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg" style={{ background: avatarGradient(vanityAddr || symbol || "coin") }}>
                {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" /> : null}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-semibold">{symbol || "SYMBOL"}</span>
                  <span className="rounded border border-border px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                    Perp 5x
                  </span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{name || "Coin name"}</div>
              </div>
            </div>
            <div className="mt-3 space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-0 rounded-full bg-neon" />
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0% bonded</span>
                <span>0 / {alloc.graduateSol} SOL</span>
              </div>
            </div>
          </div>

          <ul className="space-y-1.5 rounded-xl border border-border p-3 text-[11px] text-muted-foreground">
            <li className="flex gap-2"><span className="text-neon">•</span> Bonding curve anyone can buy/sell</li>
            <li className="flex gap-2"><span className="text-neon">•</span> Coin-margin perp, up to 5x</li>
            <li className="flex gap-2"><span className="text-neon">•</span> Graduates to a spot pool at ~{alloc.graduateSol} SOL</li>
            <li className="flex gap-2"><span className="text-neon">•</span> One approval signs the whole launch</li>
          </ul>
        </aside>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
    </div>
  );
}

function IconField({
  icon,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        {icon}
      </span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} className="pl-9" />
    </div>
  );
}

