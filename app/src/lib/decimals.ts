/// Human ↔ SPL atomic units conversion. All mock-USDC markets in this
/// app are 6 decimals. If we later support markets with other quote
/// mints, look up `decimals` from the mint account info.

export const QUOTE_DECIMALS = 6;

/// "10" → 10_000_000n. Accepts decimal strings with up to QUOTE_DECIMALS
/// fractional digits.
export function humanToAtoms(human: string, decimals = QUOTE_DECIMALS): bigint {
  if (!/^\d*\.?\d*$/.test(human) || human === "" || human === ".") {
    throw new Error(`Invalid amount: "${human}"`);
  }
  const [intPart, fracPartRaw = ""] = human.split(".");
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${intPart || "0"}${fracPart}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined === "" ? "0" : combined);
}

/// 10_000_000n → "10.000000" (or "10" if trimmed). Always returns a
/// finite-precision string suitable for monospace display.
export function atomsToHuman(
  atoms: bigint,
  decimals = QUOTE_DECIMALS,
  trim = false,
): string {
  const neg = atoms < 0n;
  const abs = neg ? -atoms : atoms;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  let fracPart = s.slice(s.length - decimals);
  if (trim) {
    fracPart = fracPart.replace(/0+$/, "");
  }
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}
