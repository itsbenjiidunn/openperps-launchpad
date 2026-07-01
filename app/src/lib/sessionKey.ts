/// Session keys for popup-free trading. The owner authorizes a browser-held
/// keypair once (SetDelegate, one wallet tx, also funds it with a little SOL
/// for fees); afterwards PlaceOrder/Close sign with the session key locally —
/// no wallet popup per trade. The delegate can ONLY trade (never withdraw),
/// so a leaked session key can't drain funds. Session secrets live in
/// localStorage; clearing them or revoking on-chain disables 1-click trading.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { DELEGATE_SEED, setDelegateIx } from "@opp-oss/sdk";

import { PROGRAM_ID } from "./program";

/// SOL transferred to the session key on enable, to cover trade fees.
const SESSION_FUND_LAMPORTS = 20_000_000; // 0.02 SOL
/// Below this the session can't pay fees → fall back to the wallet.
const SESSION_MIN_LAMPORTS = 1_000_000; // 0.001 SOL

const keyFor = (owner: string) => `openperps:session:${owner}`;

export function loadSession(owner: string): Keypair | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(owner));
    if (!raw) return null;
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    return null;
  }
}

function saveSession(owner: string, kp: Keypair): void {
  window.localStorage.setItem(keyFor(owner), JSON.stringify(Array.from(kp.secretKey)));
}

export function clearSession(owner: string): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(keyFor(owner));
}

export function delegatePda(portfolio: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DELEGATE_SEED, portfolio.toBuffer()],
    PROGRAM_ID,
  );
}

/// True if a session key exists locally AND can pay fees. NOTE: this does not
/// check whether the key is actually authorized on-chain for a given portfolio
/// — use [`sessionUsableFor`] before signing a trade.
export async function sessionUsable(
  connection: Connection,
  owner: string,
): Promise<Keypair | null> {
  const kp = loadSession(owner);
  if (!kp) return null;
  const bal = await connection.getBalance(kp.publicKey);
  return bal >= SESSION_MIN_LAMPORTS ? kp : null;
}

/// Whether `session` is the registered on-chain delegate for `portfolio`. The
/// DelegateAccount PDA layout is discriminator(8) + portfolio(32) + delegate(32);
/// it must be program-owned and name this session key. A funded local session
/// from a *different* portfolio (e.g. after re-bootstrapping the market) is NOT
/// valid here — signing with it would fail PlaceOrder with MissingRequiredSignature.
export async function delegateRegistered(
  connection: Connection,
  portfolio: PublicKey,
  session: PublicKey,
): Promise<boolean> {
  const [pda] = delegatePda(portfolio);
  const info = await connection.getAccountInfo(pda);
  if (!info || !info.owner.equals(PROGRAM_ID) || info.data.length < 72) return false;
  const delegateBytes = info.data.subarray(40, 72);
  return Buffer.from(delegateBytes).equals(Buffer.from(session.toBytes()));
}

/// Session key usable for *this* portfolio: exists, funded, AND registered
/// on-chain as the portfolio's delegate. Returns null (→ caller uses the
/// wallet path) otherwise.
export async function sessionUsableFor(
  connection: Connection,
  owner: string,
  portfolio: PublicKey,
): Promise<Keypair | null> {
  const kp = await sessionUsable(connection, owner);
  if (!kp) return null;
  return (await delegateRegistered(connection, portfolio, kp.publicKey)) ? kp : null;
}

/// How long a session key stays valid on-chain before the user must re-enable
/// it (one wallet tx). Bounded so a leaked delegate cannot trade forever.
/// ~7 days at ~2.5 slots/s.
const SESSION_TTL_SLOTS = 1_500_000n;

/// One wallet tx: authorize the session key as the portfolio's delegate and
/// fund it for fees. After this, trades are popup-free.
export async function enableSession(args: {
  wallet: WalletContextState;
  connection: Connection;
  portfolio: PublicKey;
}): Promise<{ signature: string; session: PublicKey }> {
  const { wallet, connection, portfolio } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet not connected.");
  }
  const owner = wallet.publicKey.toBase58();
  const session = loadSession(owner) ?? Keypair.generate();
  const [pda, bump] = delegatePda(portfolio);

  // Time-bound the session key so a leaked delegate cannot trade forever; the
  // user re-enables (one wallet tx) when it lapses.
  const currentSlot = BigInt(await connection.getSlot("confirmed"));
  const expirySlot = currentSlot + SESSION_TTL_SLOTS;

  const tx = new Transaction()
    .add(
      setDelegateIx({
        programId: PROGRAM_ID,
        delegatePda: pda,
        portfolio,
        owner: wallet.publicKey,
        delegate: session.publicKey,
        bump,
        expirySlot,
      }),
    )
    .add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: session.publicKey,
        lamports: SESSION_FUND_LAMPORTS,
      }),
    );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  saveSession(owner, session);
  return { signature: sig, session: session.publicKey };
}

/// Revoke on-chain (delegate → all-zero) and forget the local session key.
export async function disableSession(args: {
  wallet: WalletContextState;
  connection: Connection;
  portfolio: PublicKey;
}): Promise<{ signature: string }> {
  const { wallet, connection, portfolio } = args;
  if (!wallet.publicKey || !wallet.sendTransaction) {
    throw new Error("Wallet not connected.");
  }
  const [pda, bump] = delegatePda(portfolio);
  const tx = new Transaction().add(
    setDelegateIx({
      programId: PROGRAM_ID,
      delegatePda: pda,
      portfolio,
      owner: wallet.publicKey,
      delegate: PublicKey.default,
      bump,
      expirySlot: 0n,
    }),
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  clearSession(wallet.publicKey.toBase58());
  return { signature: sig };
}
