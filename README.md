<div align="center">

# OpenPerps Launchpad

**Launch a coin on a fair bonding curve, with a coin-margin perpetual on the same token from the first block.**

[![Solana](https://img.shields.io/badge/Solana-Program-14F195?logo=solana&logoColor=white)](https://solana.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-React%2019-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## Overview

OpenPerps Launchpad is a token launch platform where every coin ships with leverage on day one. A creator mints a fixed supply, a share is parked on a constant-product bonding curve that anyone can buy and sell, and the remaining supply seeds a coin-margin perpetual futures market on the same token. Spot price discovery and leveraged trading run side by side from the moment the coin exists, without waiting for a listing.

The repository contains two pieces that work together:

- **`program/`** the on-chain bonding-curve program, written in Rust on Pinocchio.
- **`app/`** the web client, a React application for launching coins, trading the curve, opening leveraged positions, and managing creator rewards.

---

## Features

| Area | What it does |
| --- | --- |
| **Fair bonding curve** | A constant-product (`x * y = k`) curve with virtual and real reserves. Price rises as tokens are bought and falls as they are sold, with rounding that always favors the curve. |
| **Coin-margin perpetual** | Each launch stands up a perpetual futures market collateralized in its own token, so holders can go long or short from the first block. |
| **Creator fees** | Creators set a fee of up to two percent on every curve trade. Fees accrue on-chain and are claimable at any time. |
| **Graduation** | Once a curve raises its threshold, it freezes and hands the raised liquidity and the reserved supply to a spot pool. |
| **Branded mint address** | The launch flow grinds a vanity mint keypair in parallel Web Workers so each coin gets a recognizable contract address. |
| **Holder rewards** | Creators can airdrop tokens to current holders, split pro rata by holdings, in batched transfers. |
| **Coin pages** | Live candlestick charts with selectable timeframes, market caps in USD, a trades feed, a holder list, an all-time-high meter, and a per-coin comment thread. |
| **Creator profiles** | A profile for any wallet listing its created coins, its token balances, and a one-click claim for accrued creator rewards. |
| **Discovery** | A live trades ticker, a trending row, a king-of-the-hill highlight, a searchable explore grid, and multiple sort orders. |

---

## How it works

### The bonding curve

Each launch creates a curve account and a vault token account. The curve holds four reserve values: virtual SOL, virtual tokens, real SOL raised, and real tokens still for sale. The product of the virtual reserves is the curve invariant.

- **Buy** takes SOL in and sends tokens out, moving price up along the invariant. When a buy would clear the last of the for-sale tokens, it is trimmed to exactly drain the curve and charges only the SOL required for those tokens.
- **Sell** takes tokens in and pays SOL out, moving price down. Payouts are bounded by the real SOL raised, and rounding favors the curve so a buy-then-sell round trip can never extract value.

### Graduation

When the real SOL raised crosses the graduation threshold, or the for-sale tokens are fully drained, the curve marks itself complete and freezes. A creator-only withdrawal then sweeps the raised SOL and any unsold tokens to a destination that seeds a spot pool and pins the paired perpetual market oracle.

### Creator fees

A creator can attach a fee, expressed in basis points and capped at two percent, when they create the curve. On each trade the fee is computed from the trade size and accrues inside the curve account as lamports beyond the rent reserve and the withdrawable raised SOL. The creator claims accrued fees through a dedicated instruction at any time, from the coin page or from their profile.

### Coin-margin perpetual

The share of supply not placed on the curve seeds a perpetual futures market whose collateral is the launched token itself. The market carries its own liquidity, so leveraged trading is available immediately alongside the curve.

---

## On-chain program

The program is a native Pinocchio program with a compact, alignment-one account layout. It exposes the following instructions.

| Tag | Instruction | Summary |
| --- | --- | --- |
| `0` | `Create` | Stand up the curve account and a vault token account, pull the for-sale supply into the vault, and record the optional creator fee. |
| `1` | `Buy` | SOL in, tokens out. Charges the creator fee on top of the curve cost. |
| `2` | `Sell` | Tokens in, SOL out. Takes the creator fee from the payout. |
| `3` | `WithdrawGraduated` | Creator-only, after graduation. Sweeps the raised SOL and remaining tokens for spot-pool seeding. |
| `4` | `ClaimFees` | Creator-only. Sweeps accrued creator fees to the creator. |

### Curve account layout

The curve state is a fixed-size, padding-free struct:

```
discriminator            8 bytes   "OPPCURVE"
mint                    32 bytes
creator                 32 bytes
vault                   32 bytes
virtual_sol_reserves     8 bytes
virtual_token_reserves   8 bytes
real_sol_reserves        8 bytes
real_token_reserves      8 bytes
token_total_for_sale     8 bytes
graduate_sol_threshold   8 bytes
complete                 1 byte
bump                     1 byte
vault_bump               1 byte
fee_bps                  2 bytes
reserved                 3 bytes
```

### Building the program

The program builds to a Solana BPF object with the standard toolchain:

```bash
cd program
cargo build-sbf
```

The compiled object is written to `target/deploy/openperps_curve.so`, alongside a program keypair. Deploy it with the Solana CLI once you have funded a deployer account.

---

## Repository layout

```
openperps-launchpad/
  program/                 On-chain bonding-curve program (Rust, Pinocchio)
    src/lib.rs             Program logic: state, curve math, instruction handlers
    Cargo.toml
  app/                     Web client (React, Vite, TypeScript)
    src/
      launchpad/           Launchpad pages: home, create, coin, profile
      components/          Trade panels, wallet button, network selector, UI kit
      lib/                 Curve SDK, launch flows, on-chain reads, indexer client
      wallet/              Wallet adapter providers
      styles.css           Design system tokens and animations
      main.tsx             App entry
    index.html
    package.json
    vite.config.ts
    tsconfig.json
```

---

## Getting started

### Web client

```bash
cd app
npm install
npm run dev
```

The dev server prints a local URL. To produce an optimized build:

```bash
npm run build
npm run preview
```

Configuration is optional. Copy `app/.env.example` to `app/.env.local` to set your own RPC endpoint and program or indexer overrides. Without a `.env.local`, the client uses public defaults.

### Program

```bash
cd program
cargo build-sbf
```

---

## Tech stack

- **Program**: Rust, Pinocchio, bytemuck.
- **Client**: React 19, Vite, TypeScript, Tailwind CSS.
- **Solana**: `@solana/web3.js`, SPL Token, the wallet adapter suite.
- **Charts**: Lightweight Charts.

---

## License

Released under the [MIT License](LICENSE).
