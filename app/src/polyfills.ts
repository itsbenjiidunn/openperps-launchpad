/// Browser polyfills that MUST run before any Solana / web3 dependency is
/// evaluated. ES modules evaluate every `import` before the importing module's
/// own body, so an inline `window.Buffer = …` in main.tsx runs AFTER its other
/// imports have already been evaluated. Eagerly-imported deps (the Raydium SDK,
/// @solana/web3.js) touch the global `Buffer` at their top level, so the
/// assignment has to live in its own module that main.tsx imports FIRST.
import { Buffer } from "buffer";

// Use `globalThis`, not `window`, so this also installs Buffer inside Web Workers
// (whose global is `self`, with no `window`). The vanity-mint grinder worker imports
// @solana/web3.js and would otherwise crash on the first `Keypair.generate()`.
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
