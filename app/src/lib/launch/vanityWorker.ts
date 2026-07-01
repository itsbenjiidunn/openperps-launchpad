/// Web Worker: grind a Solana mint keypair whose address ends in a given suffix (the
/// launchpad CA ends in "opp"). Runs off the main thread so the UI stays responsive;
/// the Create panel spawns several of these in parallel (one per core) so the ~1/195k
/// search for "opp" finishes in seconds.

// MUST be first: the worker has no `window`, so the main-thread Buffer polyfill never
// reached it; @solana/web3.js Keypair.generate()/toBase58() touch the global Buffer.
import "../../polyfills";
import { Keypair } from "@solana/web3.js";

self.onmessage = (e: MessageEvent<{ suffix: string }>) => {
  const suffix = e.data.suffix || "opp";
  let tries = 0;
  let kp = Keypair.generate();
  while (!kp.publicKey.toBase58().endsWith(suffix)) {
    kp = Keypair.generate();
    tries++;
    if (tries % 20000 === 0) {
      (self as unknown as Worker).postMessage({ type: "progress", tries });
    }
  }
  (self as unknown as Worker).postMessage({
    type: "found",
    secretKey: Array.from(kp.secretKey),
    address: kp.publicKey.toBase58(),
    tries,
  });
};
