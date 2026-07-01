//! OPP bonding-curve program: a pump.fun-style constant-product curve.
//!
//! A launch mints a fixed SPL supply, parks `token_for_sale` of it in a vault
//! token account owned by the curve PDA, and lets anyone `Buy` (SOL in, tokens
//! out, price rises along `x*y=k`) or `Sell` (tokens in, SOL out). Once the real
//! SOL raised crosses `graduate_sol_threshold` (or the for-sale tokens are
//! drained), the curve marks `complete` and freezes; `WithdrawGraduated` then
//! hands the raised SOL and any unsold tokens to a destination so the launch
//! flow can seed a Raydium pool and pin the perp's DEX oracle.
//!
//! Pinocchio 0.8 + bytemuck only (no Anchor), so the crate shares the workspace
//! lockfile and builds on the same platform-tools as `openperps-program`. The
//! CPI helpers mirror that program's hand-rolled System/SPL-Token layouts.
#![cfg_attr(target_os = "solana", no_std)]

use bytemuck::{Pod, Zeroable};
use pinocchio::{
    account_info::AccountInfo,
    cpi::{invoke, invoke_signed},
    instruction::{AccountMeta, Instruction, Seed, Signer},
    program_error::ProgramError,
    pubkey::{create_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/// SPL Token program (v1, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const TOKEN_PROGRAM_ID: Pubkey = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133,
    237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];

/// Solana System program (all-zero pubkey).
pub const SYSTEM_PROGRAM_ID: Pubkey = [0u8; 32];

/// PDA seed for the per-mint curve state account: `[CURVE_SEED, mint]`.
pub const CURVE_SEED: &[u8] = b"curve";

/// PDA seed for the per-mint token vault: `[VAULT_SEED, mint]`. An SPL token
/// account whose authority is the curve PDA, holding the for-sale tokens.
pub const VAULT_SEED: &[u8] = b"vault";

/// Magic bytes at the start of a [`BondingCurve`] account.
pub const CURVE_DISCRIMINATOR: [u8; 8] = *b"OPPCURVE";

/// Byte length of an SPL token account (`spl_token::state::Account::LEN`).
pub const SPL_TOKEN_ACCOUNT_LEN: u64 = 165;

/// Max creator fee, in basis points (200 = 2%). Buys/sells route up to this share
/// of the trade to the coin's creator, claimable via `ClaimFees`.
pub const FEE_BPS_MAX: u16 = 200;

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

/// Program error codes, surfaced as `ProgramError::Custom(6000 + code)` so they
/// never collide with the builtin `ProgramError` discriminants.
#[derive(Clone, Copy, Debug)]
#[repr(u32)]
pub enum CurveError {
    BadParams = 0,
    ZeroAmount = 1,
    AlreadyComplete = 2,
    NotComplete = 3,
    Slippage = 4,
    InsufficientReserves = 5,
    Math = 6,
    Unauthorized = 7,
    BadPda = 8,
    NotSigner = 9,
    NotWritable = 10,
    BadAccount = 11,
    BadDiscriminator = 12,
    BadInstruction = 13,
}

impl From<CurveError> for ProgramError {
    fn from(e: CurveError) -> Self {
        ProgramError::Custom(6000 + e as u32)
    }
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

/// Per-mint bonding-curve state. All multi-byte integers are little-endian byte
/// arrays so the struct is alignment-1, padding-free, and `Pod`-safe over raw
/// account data (mirrors `openperps-program`'s account layouts).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct BondingCurve {
    pub discriminator: [u8; 8],
    pub mint: [u8; 32],
    pub creator: [u8; 32],
    pub vault: [u8; 32],
    /// Virtual SOL reserves (lamports). Sets the starting price; never withdrawn.
    pub virtual_sol_reserves: [u8; 8],
    /// Virtual token reserves (base units). The product `vsol*vtok` is the curve invariant.
    pub virtual_token_reserves: [u8; 8],
    /// Real SOL raised from buyers (lamports), withdrawable at graduation.
    pub real_sol_reserves: [u8; 8],
    /// Real tokens still in the vault and sellable to buyers (base units).
    pub real_token_reserves: [u8; 8],
    /// The `real_token_reserves` value at creation, for a bonding-progress denominator.
    pub token_total_for_sale: [u8; 8],
    /// Real SOL raised at which the curve graduates and freezes (lamports).
    pub graduate_sol_threshold: [u8; 8],
    /// 1 once graduated (SOL threshold reached or tokens drained); buys/sells then revert.
    pub complete: u8,
    pub bump: u8,
    pub vault_bump: u8,
    /// Creator fee in basis points (u16 LE), capped at [`FEE_BPS_MAX`]. Zero for
    /// legacy curves created before fees existed (their pad bytes were zero), so
    /// the field is fully backward compatible with the unchanged 160-byte layout.
    pub fee_bps: [u8; 2],
    pub _pad: [u8; 3],
}

impl BondingCurve {
    pub const LEN: usize = core::mem::size_of::<Self>();

    #[inline]
    pub fn is_initialized(&self) -> bool {
        self.discriminator == CURVE_DISCRIMINATOR
    }

    // Little-endian accessors.
    #[inline]
    pub fn vsol(&self) -> u64 {
        u64::from_le_bytes(self.virtual_sol_reserves)
    }
    #[inline]
    pub fn vtok(&self) -> u64 {
        u64::from_le_bytes(self.virtual_token_reserves)
    }
    #[inline]
    pub fn real_sol(&self) -> u64 {
        u64::from_le_bytes(self.real_sol_reserves)
    }
    #[inline]
    pub fn real_tok(&self) -> u64 {
        u64::from_le_bytes(self.real_token_reserves)
    }
    #[inline]
    pub fn threshold(&self) -> u64 {
        u64::from_le_bytes(self.graduate_sol_threshold)
    }
    #[inline]
    pub fn fee_bps_u16(&self) -> u16 {
        u16::from_le_bytes(self.fee_bps)
    }
}

// ----------------------------------------------------------------------------
// Pure curve math (host-testable, no Solana dependency)
// ----------------------------------------------------------------------------

/// Result of a buy quote against the curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    /// Lamports actually charged (<= requested when the buy graduates the curve).
    pub sol_in: u64,
    /// Tokens delivered to the buyer (base units).
    pub tokens_out: u64,
    /// New virtual SOL reserves.
    pub new_vsol: u64,
    /// New virtual token reserves.
    pub new_vtok: u64,
    /// True if this buy drains the for-sale tokens (forces graduation).
    pub drains: bool,
}

/// Quote a buy: `sol_in` lamports along `x*y=k` with `real_tok` as the hard cap on
/// deliverable tokens. If the requested SOL would buy more than the remaining
/// for-sale tokens, the trade is trimmed to exactly drain the curve and charges
/// only the SOL needed for those tokens (no overpay), returning `drains_curve`.
pub fn quote_buy(vsol: u64, vtok: u64, real_tok: u64, sol_in: u64) -> Result<BuyQuote, CurveError> {
    if sol_in == 0 {
        return Err(CurveError::ZeroAmount);
    }
    let vsol = vsol as u128;
    let vtok = vtok as u128;
    let real_tok = real_tok as u128;
    let k = vsol.checked_mul(vtok).ok_or(CurveError::Math)?;

    let mut new_vsol = vsol.checked_add(sol_in as u128).ok_or(CurveError::Math)?;
    // ceil so the curve keeps more tokens: the buyer is never over-credited.
    let mut new_vtok = k.div_ceil(new_vsol);
    let mut tokens_out = vtok.checked_sub(new_vtok).ok_or(CurveError::Math)?;
    let mut charged = sol_in as u128;
    let mut drains = false;

    if tokens_out >= real_tok {
        // Trim to exactly drain the for-sale side and recompute the SOL needed.
        tokens_out = real_tok;
        new_vtok = vtok.checked_sub(tokens_out).ok_or(CurveError::Math)?;
        // ceil so the curve is never under-charged for the last slice.
        new_vsol = k.div_ceil(new_vtok.max(1));
        charged = new_vsol.checked_sub(vsol).ok_or(CurveError::Math)?;
        drains = true;
    }
    // A buy too small to clear one token unit (after curve-favoring rounding)
    // would pay SOL for nothing; reject it rather than silently burn the SOL.
    if tokens_out == 0 {
        return Err(CurveError::ZeroAmount);
    }

    Ok(BuyQuote {
        sol_in: u64::try_from(charged).map_err(|_| CurveError::Math)?,
        tokens_out: u64::try_from(tokens_out).map_err(|_| CurveError::Math)?,
        new_vsol: u64::try_from(new_vsol).map_err(|_| CurveError::Math)?,
        new_vtok: u64::try_from(new_vtok).map_err(|_| CurveError::Math)?,
        drains,
    })
}

/// Result of a sell quote against the curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    pub sol_out: u64,
    pub new_vsol: u64,
    pub new_vtok: u64,
}

/// Quote a sell: `tokens_in` base units back along `x*y=k`, paying out SOL. The
/// caller must additionally bound `sol_out` by the real SOL reserves.
pub fn quote_sell(vsol: u64, vtok: u64, tokens_in: u64) -> Result<SellQuote, CurveError> {
    if tokens_in == 0 {
        return Err(CurveError::ZeroAmount);
    }
    let vsol = vsol as u128;
    let vtok = vtok as u128;
    let k = vsol.checked_mul(vtok).ok_or(CurveError::Math)?;

    let new_vtok = vtok.checked_add(tokens_in as u128).ok_or(CurveError::Math)?;
    // ceil so the curve pays out less SOL than the exact quote: rounding favors
    // the curve, so a buy-then-sell round-trip can never extract value.
    let new_vsol = k.div_ceil(new_vtok);
    let sol_out = vsol.checked_sub(new_vsol).ok_or(CurveError::Math)?;

    Ok(SellQuote {
        sol_out: u64::try_from(sol_out).map_err(|_| CurveError::Math)?,
        new_vsol: u64::try_from(new_vsol).map_err(|_| CurveError::Math)?,
        new_vtok: u64::try_from(new_vtok).map_err(|_| CurveError::Math)?,
    })
}

/// Creator fee in lamports for a trade of `amount` lamports at `bps` basis points.
/// Floor division through a u128 intermediate so it never overflows.
#[inline]
pub fn fee_lamports(amount: u64, bps: u16) -> u64 {
    if bps == 0 {
        return 0;
    }
    ((amount as u128 * bps as u128) / 10_000) as u64
}

// ----------------------------------------------------------------------------
// Entrypoint (SBF target only; host builds / tests exclude it)
// ----------------------------------------------------------------------------

#[cfg(all(target_os = "solana", not(feature = "no-entrypoint")))]
mod entrypoint {
    use super::process_instruction;
    use pinocchio::{default_allocator, program_entrypoint};

    program_entrypoint!(process_instruction);
    default_allocator!();

    // `no_std` panic handler, mirroring `openperps-program`'s: report the panic
    // location via the Solana syscall and abort. We hand-write it (instead of
    // pinocchio's `nostd_panic_handler!`) to avoid the `#[no_mangle]` that Rust
    // 1.89 forbids on lang items.
    #[cfg(target_os = "solana")]
    #[panic_handler]
    fn handle_panic(info: &core::panic::PanicInfo<'_>) -> ! {
        if let Some(location) = info.location() {
            unsafe {
                pinocchio::syscalls::sol_panic_(
                    location.file().as_ptr(),
                    location.file().len() as u64,
                    location.line() as u64,
                    location.column() as u64,
                )
            }
        } else {
            pinocchio::log::sol_log("** PANICKED **");
            unsafe { pinocchio::syscalls::abort() }
        }
    }
}

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

/// Instruction tags (first byte of `instruction_data`).
pub mod tag {
    pub const CREATE: u8 = 0;
    pub const BUY: u8 = 1;
    pub const SELL: u8 = 2;
    pub const WITHDRAW_GRADUATED: u8 = 3;
    pub const CLAIM_FEES: u8 = 4;
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (&t, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::from(CurveError::BadInstruction))?;
    match t {
        tag::CREATE => process_create(program_id, accounts, rest),
        tag::BUY => process_buy(program_id, accounts, rest),
        tag::SELL => process_sell(program_id, accounts, rest),
        tag::WITHDRAW_GRADUATED => process_withdraw(program_id, accounts, rest),
        tag::CLAIM_FEES => process_claim_fees(program_id, accounts, rest),
        _ => Err(CurveError::BadInstruction.into()),
    }
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

/// `Create`: args `vsol(8) | vtok(8) | token_for_sale(8) | graduate_threshold(8)
/// | curve_bump(1) | vault_bump(1) | fee_bps(2, optional)`. The trailing fee is
/// optional so legacy 34-byte callers still work (they get a zero fee).
///
/// Accounts: `[creator(signer,payer,w), mint, curve(w), vault(w),
/// creator_token(w), system_program, token_program]`.
fn process_create(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [creator, mint, curve, vault, creator_token, _system_program, _token_program, ..] = accounts
    else {
        return Err(CurveError::BadAccount.into());
    };
    if !creator.is_signer() {
        return Err(CurveError::NotSigner.into());
    }
    if !curve.is_writable() || !vault.is_writable() || !creator_token.is_writable() {
        return Err(CurveError::NotWritable.into());
    }
    if data.len() < 34 {
        return Err(CurveError::BadInstruction.into());
    }
    let vsol = read_u64(data, 0)?;
    let vtok = read_u64(data, 8)?;
    let token_for_sale = read_u64(data, 16)?;
    let threshold = read_u64(data, 24)?;
    let curve_bump = data[32];
    let vault_bump = data[33];
    // Optional trailing u16 creator fee (bps). Absent (legacy callers) => 0.
    let fee_bps = if data.len() >= 36 {
        read_u16(data, 34)?.min(FEE_BPS_MAX)
    } else {
        0
    };

    if vsol == 0 || vtok == 0 || token_for_sale == 0 || threshold == 0 {
        return Err(CurveError::BadParams.into());
    }
    // The for-sale side must fit inside the virtual reserves, else the curve
    // could be drained past its invariant.
    if token_for_sale > vtok {
        return Err(CurveError::BadParams.into());
    }

    let mint_key: [u8; 32] = *mint.key();

    // Verify both PDAs against the supplied bumps.
    let curve_expected = create_program_address(&[CURVE_SEED, mint_key.as_ref(), &[curve_bump]], program_id)
        .map_err(|_| CurveError::BadPda)?;
    if *curve.key() != curve_expected {
        return Err(CurveError::BadPda.into());
    }
    let vault_expected = create_program_address(&[VAULT_SEED, mint_key.as_ref(), &[vault_bump]], program_id)
        .map_err(|_| CurveError::BadPda)?;
    if *vault.key() != vault_expected {
        return Err(CurveError::BadPda.into());
    }

    // Reject double-create: the curve account must be system-owned (fresh) here.
    if curve.data_len() != 0 {
        return Err(CurveError::AlreadyComplete.into());
    }

    let rent = Rent::get()?;

    // 1. Allocate the curve state account, owned by this program, signed by its PDA seeds.
    {
        let bump_arr = [curve_bump];
        let seeds = [
            Seed::from(CURVE_SEED),
            Seed::from(mint_key.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            creator,
            curve,
            rent.minimum_balance(BondingCurve::LEN),
            BondingCurve::LEN as u64,
            program_id,
            &[signer],
        )?;
    }

    // 2. Allocate + initialize the vault as an SPL token account whose authority
    //    is the curve PDA (so only this program can move tokens out).
    {
        let bump_arr = [vault_bump];
        let seeds = [
            Seed::from(VAULT_SEED),
            Seed::from(mint_key.as_ref()),
            Seed::from(bump_arr.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        system_create_account(
            creator,
            vault,
            rent.minimum_balance(SPL_TOKEN_ACCOUNT_LEN as usize),
            SPL_TOKEN_ACCOUNT_LEN,
            &TOKEN_PROGRAM_ID,
            &[signer],
        )?;
    }
    token_initialize_account3(vault, mint, curve.key())?;

    // 3. Pull the for-sale tokens from the creator into the vault.
    token_transfer(creator_token, vault, creator, token_for_sale)?;

    // 4. Write curve state.
    {
        let mut buf = curve.try_borrow_mut_data().map_err(|_| CurveError::BadAccount)?;
        let c: &mut BondingCurve = pod_mut(&mut buf)?;
        c.discriminator = CURVE_DISCRIMINATOR;
        c.mint = mint_key;
        c.creator = *creator.key();
        c.vault = *vault.key();
        c.virtual_sol_reserves = vsol.to_le_bytes();
        c.virtual_token_reserves = vtok.to_le_bytes();
        c.real_sol_reserves = 0u64.to_le_bytes();
        c.real_token_reserves = token_for_sale.to_le_bytes();
        c.token_total_for_sale = token_for_sale.to_le_bytes();
        c.graduate_sol_threshold = threshold.to_le_bytes();
        c.complete = 0;
        c.bump = curve_bump;
        c.vault_bump = vault_bump;
        c.fee_bps = fee_bps.to_le_bytes();
        c._pad = [0u8; 3];
    }

    pinocchio::log::sol_log("opp-curve: created");
    Ok(())
}

/// `Buy`: args `sol_in(8) | min_tokens_out(8)`.
///
/// Accounts: `[buyer(signer,w), curve(w), vault(w), buyer_token(w),
/// token_program, system_program]`.
fn process_buy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [buyer, curve, vault, buyer_token, _token_program, _system_program, ..] = accounts else {
        return Err(CurveError::BadAccount.into());
    };
    if !buyer.is_signer() {
        return Err(CurveError::NotSigner.into());
    }
    if !curve.is_writable() || !vault.is_writable() || !buyer_token.is_writable() {
        return Err(CurveError::NotWritable.into());
    }
    let sol_in = read_u64(data, 0)?;
    let min_tokens_out = read_u64(data, 8)?;

    // Load + validate the curve, compute the quote.
    let (quote, complete_after, mint_key, curve_bump, fee_bps) = {
        let buf = curve.try_borrow_data().map_err(|_| CurveError::BadAccount)?;
        let c: &BondingCurve = pod_ref(&buf)?;
        verify_curve(program_id, curve, c)?;
        if *vault.key() != c.vault {
            return Err(CurveError::BadAccount.into());
        }
        if c.complete != 0 {
            return Err(CurveError::AlreadyComplete.into());
        }
        let q = quote_buy(c.vsol(), c.vtok(), c.real_tok(), sol_in)?;
        if q.tokens_out < min_tokens_out {
            return Err(CurveError::Slippage.into());
        }
        let new_real_sol = c.real_sol().checked_add(q.sol_in).ok_or(CurveError::Math)?;
        let complete = q.drains || new_real_sol >= c.threshold();
        (q, complete, c.mint, c.bump, c.fee_bps_u16())
    };

    // Creator fee is charged on top of the curve cost and left in the curve
    // account as excess lamports (the creator claims it via ClaimFees).
    let fee = fee_lamports(quote.sol_in, fee_bps);
    let total_in = quote.sol_in.checked_add(fee).ok_or(CurveError::Math)?;
    // Move SOL in (buyer -> curve PDA): curve cost plus the creator fee.
    system_transfer(buyer, curve, total_in)?;

    // Move tokens out (vault -> buyer), signed by the curve PDA (the vault's authority).
    {
        let cb = [curve_bump];
        let seeds = [
            Seed::from(CURVE_SEED),
            Seed::from(mint_key.as_ref()),
            Seed::from(cb.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        token_transfer_signed(vault, buyer_token, curve, quote.tokens_out, &[signer])?;
    }

    // Commit reserve updates.
    {
        let mut buf = curve.try_borrow_mut_data().map_err(|_| CurveError::BadAccount)?;
        let c: &mut BondingCurve = pod_mut(&mut buf)?;
        c.virtual_sol_reserves = quote.new_vsol.to_le_bytes();
        c.virtual_token_reserves = quote.new_vtok.to_le_bytes();
        c.real_sol_reserves = c.real_sol().checked_add(quote.sol_in).ok_or(CurveError::Math)?.to_le_bytes();
        c.real_token_reserves = c.real_tok().checked_sub(quote.tokens_out).ok_or(CurveError::Math)?.to_le_bytes();
        if complete_after {
            c.complete = 1;
        }
    }

    pinocchio::log::sol_log("opp-curve: buy");
    Ok(())
}

/// `Sell`: args `tokens_in(8) | min_sol_out(8)`.
///
/// Accounts: `[seller(signer,w), curve(w), vault(w), seller_token(w), token_program]`.
fn process_sell(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [seller, curve, vault, seller_token, _token_program, ..] = accounts else {
        return Err(CurveError::BadAccount.into());
    };
    if !seller.is_signer() {
        return Err(CurveError::NotSigner.into());
    }
    if !curve.is_writable() || !vault.is_writable() || !seller_token.is_writable() {
        return Err(CurveError::NotWritable.into());
    }
    let tokens_in = read_u64(data, 0)?;
    let min_sol_out = read_u64(data, 8)?;

    let (quote, fee_bps) = {
        let buf = curve.try_borrow_data().map_err(|_| CurveError::BadAccount)?;
        let c: &BondingCurve = pod_ref(&buf)?;
        verify_curve(program_id, curve, c)?;
        if *vault.key() != c.vault {
            return Err(CurveError::BadAccount.into());
        }
        if c.complete != 0 {
            return Err(CurveError::AlreadyComplete.into());
        }
        let q = quote_sell(c.vsol(), c.vtok(), tokens_in)?;
        if q.sol_out < min_sol_out {
            return Err(CurveError::Slippage.into());
        }
        // Never pay out more real SOL than buyers have put in.
        if q.sol_out > c.real_sol() {
            return Err(CurveError::InsufficientReserves.into());
        }
        (q, c.fee_bps_u16())
    };

    // Creator fee comes out of the seller's payout and stays in the curve as
    // excess lamports (the creator claims it via ClaimFees).
    let fee = fee_lamports(quote.sol_out, fee_bps);
    let payout = quote.sol_out.checked_sub(fee).ok_or(CurveError::Math)?;

    // Tokens in (seller -> vault), seller signs.
    token_transfer(seller_token, vault, seller, tokens_in)?;

    // SOL out (curve PDA -> seller) via direct lamport mutation (curve is program-owned).
    move_lamports(curve, seller, payout)?;

    // Commit reserve updates.
    {
        let mut buf = curve.try_borrow_mut_data().map_err(|_| CurveError::BadAccount)?;
        let c: &mut BondingCurve = pod_mut(&mut buf)?;
        c.virtual_sol_reserves = quote.new_vsol.to_le_bytes();
        c.virtual_token_reserves = quote.new_vtok.to_le_bytes();
        c.real_sol_reserves = c.real_sol().checked_sub(quote.sol_out).ok_or(CurveError::Math)?.to_le_bytes();
        c.real_token_reserves = c.real_tok().checked_add(tokens_in).ok_or(CurveError::Math)?.to_le_bytes();
    }

    pinocchio::log::sol_log("opp-curve: sell");
    Ok(())
}

/// `WithdrawGraduated`: no args. Only the creator, only after graduation. Sends
/// the raised SOL to `sol_dest` and every remaining vault token to `token_dest`
/// so the launch flow can seed a Raydium pool and pin the perp oracle.
///
/// Accounts: `[creator(signer), curve(w), vault(w), sol_dest(w), token_dest(w),
/// token_program]`.
fn process_withdraw(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let [creator, curve, vault, sol_dest, token_dest, _token_program, ..] = accounts else {
        return Err(CurveError::BadAccount.into());
    };
    if !creator.is_signer() {
        return Err(CurveError::NotSigner.into());
    }
    if !curve.is_writable() || !vault.is_writable() || !sol_dest.is_writable() || !token_dest.is_writable() {
        return Err(CurveError::NotWritable.into());
    }

    let (sol_out, mint_key, curve_bump, real_tok) = {
        let buf = curve.try_borrow_data().map_err(|_| CurveError::BadAccount)?;
        let c: &BondingCurve = pod_ref(&buf)?;
        verify_curve(program_id, curve, c)?;
        if *vault.key() != c.vault {
            return Err(CurveError::BadAccount.into());
        }
        if *creator.key() != c.creator {
            return Err(CurveError::Unauthorized.into());
        }
        if c.complete == 0 {
            return Err(CurveError::NotComplete.into());
        }
        (c.real_sol(), c.mint, c.bump, c.real_tok())
    };

    // Sweep the remaining vault tokens to the destination (curve PDA authorizes).
    if real_tok > 0 {
        let cb = [curve_bump];
        let seeds = [
            Seed::from(CURVE_SEED),
            Seed::from(mint_key.as_ref()),
            Seed::from(cb.as_ref()),
        ];
        let signer = Signer::from(seeds.as_ref());
        token_transfer_signed(vault, token_dest, curve, real_tok, &[signer])?;
    }

    // Sweep the raised SOL.
    if sol_out > 0 {
        move_lamports(curve, sol_dest, sol_out)?;
    }

    // Zero the reserves so a re-call is a no-op.
    {
        let mut buf = curve.try_borrow_mut_data().map_err(|_| CurveError::BadAccount)?;
        let c: &mut BondingCurve = pod_mut(&mut buf)?;
        c.real_sol_reserves = 0u64.to_le_bytes();
        c.real_token_reserves = 0u64.to_le_bytes();
    }

    pinocchio::log::sol_log("opp-curve: withdraw");
    Ok(())
}

/// `ClaimFees`: no args. Creator-only, callable anytime. Sweeps the creator fees
/// accrued in the curve account (its lamports beyond the rent reserve and the
/// withdrawable raised SOL) to the creator. A no-op when nothing has accrued.
///
/// Accounts: `[creator(signer,w), curve(w)]`.
fn process_claim_fees(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let [creator, curve, ..] = accounts else {
        return Err(CurveError::BadAccount.into());
    };
    if !creator.is_signer() {
        return Err(CurveError::NotSigner.into());
    }
    if !curve.is_writable() {
        return Err(CurveError::NotWritable.into());
    }

    let real_sol = {
        let buf = curve.try_borrow_data().map_err(|_| CurveError::BadAccount)?;
        let c: &BondingCurve = pod_ref(&buf)?;
        verify_curve(program_id, curve, c)?;
        if *creator.key() != c.creator {
            return Err(CurveError::Unauthorized.into());
        }
        c.real_sol()
    };

    // Everything above rent + the withdrawable raised SOL is accrued creator fees.
    let rent_min = Rent::get()?.minimum_balance(BondingCurve::LEN);
    let reserved = rent_min.checked_add(real_sol).ok_or(CurveError::Math)?;
    let claimable = curve.lamports().saturating_sub(reserved);
    if claimable > 0 {
        move_lamports(curve, creator, claimable)?;
    }

    pinocchio::log::sol_log("opp-curve: claim-fees");
    Ok(())
}

// ----------------------------------------------------------------------------
// Account / PDA helpers
// ----------------------------------------------------------------------------

/// Validate that `curve` is this program's canonical curve PDA for its recorded
/// mint, is program-owned, and carries the curve discriminator.
fn verify_curve(program_id: &Pubkey, curve: &AccountInfo, c: &BondingCurve) -> Result<(), CurveError> {
    if unsafe { curve.owner() } != program_id {
        return Err(CurveError::BadAccount);
    }
    if !c.is_initialized() {
        return Err(CurveError::BadDiscriminator);
    }
    let expected = create_program_address(&[CURVE_SEED, c.mint.as_ref(), &[c.bump]], program_id)
        .map_err(|_| CurveError::BadPda)?;
    if *curve.key() != expected {
        return Err(CurveError::BadPda);
    }
    Ok(())
}

/// Move `amount` lamports from a program-owned `from` account to `to` by direct
/// balance mutation (no System CPI; valid because this program owns `from`).
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let mut from_l = from.try_borrow_mut_lamports().map_err(|_| CurveError::BadAccount)?;
    let mut to_l = to.try_borrow_mut_lamports().map_err(|_| CurveError::BadAccount)?;
    *from_l = from_l.checked_sub(amount).ok_or(CurveError::InsufficientReserves)?;
    *to_l = to_l.checked_add(amount).ok_or(CurveError::Math)?;
    Ok(())
}

/// `&mut BondingCurve` view over the first [`BondingCurve::LEN`] bytes of a buffer.
fn pod_mut(buf: &mut [u8]) -> Result<&mut BondingCurve, CurveError> {
    if buf.len() < BondingCurve::LEN {
        return Err(CurveError::BadAccount);
    }
    bytemuck::try_from_bytes_mut(&mut buf[..BondingCurve::LEN]).map_err(|_| CurveError::BadAccount)
}

/// `&BondingCurve` view over the first [`BondingCurve::LEN`] bytes of a buffer.
fn pod_ref(buf: &[u8]) -> Result<&BondingCurve, CurveError> {
    if buf.len() < BondingCurve::LEN {
        return Err(CurveError::BadAccount);
    }
    bytemuck::try_from_bytes(&buf[..BondingCurve::LEN]).map_err(|_| CurveError::BadAccount)
}

/// Read a little-endian `u64` at byte offset `off`, bounds-checked.
fn read_u64(d: &[u8], off: usize) -> Result<u64, ProgramError> {
    let end = off.checked_add(8).ok_or(ProgramError::from(CurveError::BadInstruction))?;
    let slice = d.get(off..end).ok_or(ProgramError::from(CurveError::BadInstruction))?;
    let mut arr = [0u8; 8];
    arr.copy_from_slice(slice);
    Ok(u64::from_le_bytes(arr))
}

/// Read a little-endian `u16` at byte offset `off`, bounds-checked.
fn read_u16(d: &[u8], off: usize) -> Result<u16, ProgramError> {
    let end = off.checked_add(2).ok_or(ProgramError::from(CurveError::BadInstruction))?;
    let slice = d.get(off..end).ok_or(ProgramError::from(CurveError::BadInstruction))?;
    let mut arr = [0u8; 2];
    arr.copy_from_slice(slice);
    Ok(u16::from_le_bytes(arr))
}

// ----------------------------------------------------------------------------
// CPI helpers (System + SPL Token v1), mirroring openperps-program/src/cpi.rs
// ----------------------------------------------------------------------------

/// `System::CreateAccount`, signed for `new_account` via its PDA seeds.
/// Layout: tag(u32 LE = 0) | lamports(u64 LE) | space(u64 LE) | owner([u8;32]).
fn system_create_account<'a>(
    payer: &'a AccountInfo,
    new_account: &'a AccountInfo,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
    signer_seeds: &[Signer<'_, '_>],
) -> ProgramResult {
    let mut data = [0u8; 4 + 8 + 8 + 32];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner);
    let accounts = [
        AccountMeta::new(payer.key(), true, true),
        AccountMeta::new(new_account.key(), true, true),
    ];
    let ix = Instruction {
        program_id: &SYSTEM_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke_signed::<2>(&ix, &[payer, new_account], signer_seeds)
}

/// `System::Transfer(lamports)` with `from` as a regular signer.
/// Layout: tag(u32 LE = 2) | lamports(u64 LE).
fn system_transfer<'a>(from: &'a AccountInfo, to: &'a AccountInfo, lamports: u64) -> ProgramResult {
    let mut data = [0u8; 4 + 8];
    data[0..4].copy_from_slice(&2u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    let accounts = [
        AccountMeta::new(from.key(), true, true),
        AccountMeta::new(to.key(), true, false),
    ];
    let ix = Instruction {
        program_id: &SYSTEM_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke::<2>(&ix, &[from, to])
}

/// `Token::InitializeAccount3(owner)`: initialize an allocated account as an SPL
/// token account for `mint`, with `owner` as the transfer authority.
/// Layout: tag(u8 = 18) | owner([u8;32]).
fn token_initialize_account3<'a>(
    account: &'a AccountInfo,
    mint: &'a AccountInfo,
    owner: &Pubkey,
) -> ProgramResult {
    let mut data = [0u8; 1 + 32];
    data[0] = 18;
    data[1..33].copy_from_slice(owner);
    let accounts = [
        AccountMeta::new(account.key(), true, false),
        AccountMeta::readonly(mint.key()),
    ];
    let ix = Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke::<2>(&ix, &[account, mint])
}

/// `Token::Transfer(amount)` with `authority` as a regular signer.
/// Layout: tag(u8 = 3) | amount(u64 LE).
fn token_transfer<'a>(
    source: &'a AccountInfo,
    destination: &'a AccountInfo,
    authority: &'a AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 1 + 8];
    data[0] = 3;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let accounts = [
        AccountMeta::new(source.key(), true, false),
        AccountMeta::new(destination.key(), true, false),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke::<3>(&ix, &[source, destination, authority])
}

/// Same as [`token_transfer`] but the `authority` is a PDA signing via `signer_seeds`.
fn token_transfer_signed<'a>(
    source: &'a AccountInfo,
    destination: &'a AccountInfo,
    authority: &'a AccountInfo,
    amount: u64,
    signer_seeds: &[Signer<'_, '_>],
) -> ProgramResult {
    let mut data = [0u8; 1 + 8];
    data[0] = 3;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let accounts = [
        AccountMeta::new(source.key(), true, false),
        AccountMeta::new(destination.key(), true, false),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: &TOKEN_PROGRAM_ID,
        data: &data,
        accounts: &accounts,
    };
    invoke_signed::<3>(&ix, &[source, destination, authority], signer_seeds)
}

// ----------------------------------------------------------------------------
// Host tests for the pure curve math.
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_160_and_pod_safe() {
        assert_eq!(BondingCurve::LEN, 160);
        // A zeroed buffer round-trips through the Pod view.
        let mut buf = [0u8; BondingCurve::LEN];
        let c = pod_mut(&mut buf).unwrap();
        c.discriminator = CURVE_DISCRIMINATOR;
        assert!(c.is_initialized());
    }

    #[test]
    fn buy_then_sell_round_trips_below_fees() {
        // Virtual reserves 30 SOL / 1.073e9 tokens (pump.fun-ish shape), all for sale.
        let vsol = 30_000_000_000u64;
        let vtok = 1_073_000_000_000_000u64;
        let q = quote_buy(vsol, vtok, vtok, 1_000_000_000).unwrap();
        assert!(q.tokens_out > 0);
        assert!(!q.drains);
        assert_eq!(q.sol_in, 1_000_000_000);
        // Price rose: selling the bought tokens back returns <= the SOL paid.
        let s = quote_sell(q.new_vsol, q.new_vtok, q.tokens_out).unwrap();
        assert!(s.sol_out <= 1_000_000_000);
    }

    #[test]
    fn buy_caps_at_real_tokens_and_drains() {
        let vsol = 30_000_000_000u64;
        let vtok = 1_073_000_000_000_000u64;
        // Only 1000 tokens actually for sale: a large buy drains and trims SOL.
        let real_tok = 1_000u64;
        let q = quote_buy(vsol, vtok, real_tok, 1_000_000_000_000).unwrap();
        assert!(q.drains);
        assert_eq!(q.tokens_out, real_tok);
        assert!(q.sol_in < 1_000_000_000_000);
    }

    #[test]
    fn price_monotonic() {
        let vsol = 30_000_000_000u64;
        let vtok = 1_073_000_000_000_000u64;
        let q1 = quote_buy(vsol, vtok, vtok, 1_000_000_000).unwrap();
        let q2 = quote_buy(q1.new_vsol, q1.new_vtok, vtok, 1_000_000_000).unwrap();
        // Same SOL buys fewer tokens after the price has risen.
        assert!(q2.tokens_out < q1.tokens_out);
    }

    #[test]
    fn zero_rejected() {
        assert!(quote_buy(1, 1, 1, 0).is_err());
        assert!(quote_sell(1, 1, 0).is_err());
    }
}
