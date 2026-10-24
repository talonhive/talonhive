# Listing by transfer — sell from the Acki Nacki Wallet app (designed 2026-10-24)

## Why

The Acki Nacki Wallet app can only make plain transfers (`docs/WALLET_INTEGRATION.md`). Taking a lot already
works that way (pay-to-take), but **creating** one needed `createLot` with a payload, which only agent
wallets and the CLI can send. So most holders could not sell, and the market stayed empty.

## Flow

1. **Open (the web page, no wallet).** The page sends `SwapFactory.openListing(key, giveId, giveAmount,
   wantId, wantAmount, deadline)` as an unsigned external message. The factory deploys an `AtomicSwap` in
   state **AWAITING (3)**: terms fixed, no coins, no maker, deposit deadline `fundBy = now + 15 min`.
   It emits `ListingOpened(key, nonce, lot, …)`; the page finds its listing by `key`.
2. **Fund (the wallet app, plain transfer).** The maker sends **exactly** `giveAmount` of the give
   currency to the lot. The lot records the sender as maker, becomes **OPEN**, and tells the factory,
   which emits the usual `LotCreated`, so order books need no change.
3. **Take** works as before (pay-to-take).
4. **Cancel (the wallet app, plain transfer).** Any plain transfer from the maker to their open lot (for
   example 1 NACKL, or 1 SHELL) returns the lot's coins plus that transfer to the maker. This applies to
   every lot, so a maker can no longer fill their own lot by mistake.
5. **Expiry.** A listing not funded by `fundBy` refuses deposits (refunded) and, `closeDelay` later,
   anyone may `close()` it; its gas returns to the factory.

## What can go wrong, and what happens

| Case | Result |
|---|---|
| Wrong amount, extra currency, or late deposit | Refused: bounced if bounceable, refunded if not (same `_refused` path as takes) |
| Someone else funds your listing first | They become its maker and sell their own coins on your terms; your deposit is refunded (the lot is open, and the give currency is not the want currency). You lose nothing |
| Flag-16 SHELL as a deposit | Listed but converted to gas, so it does not count (`ERR_NOT_ARRIVED`) |
| Spam `openListing` | Each listing costs the DApp a deploy plus a close (gas returns on close). Rate limit: **12 listings per 10 minutes**, so the cost is bounded (measure it in `tests/run_listing.sh` L11). Under attack, honest users may be told "busy, try again in a few minutes"; no coins are at risk |
| Refused `openListing` (bad terms, busy) | Checked before `tvm.accept()`: costs the DApp nothing |
| Fake `onListingFunded` | Only lot `nonce` itself passes the address check |

**Invariant I1 changes:** a lot is funded from birth, **or** an AWAITING listing with nothing at stake for
at most 15 minutes. I2–I6 are unchanged.

## Still open

1. **Sending the external message from a browser.** tvm-cli sends unsigned external messages fine
   (`tests/RESULTS.md`, keepers), but the browser endpoint and format are not documented (asked in the
   outreach notes). Options: ask GOSH, or copy what the official SDK does. Until then the Shellnet demo can
   open listings with tvm-cli.
2. **What the wallet app's plain transfer looks like on mainnet** (bounce flag, destination DApp id). Pay-to-take
   already relies on this; the planned 1-NACKL mainnet probe answers it for both.
3. **Independent audit** before mainnet, as for all contract changes.

## Tests

`tests/run_listing.sh` (Shellnet, unattended): L1 open by external message, L2 refused terms, L3 wrong
deposits refunded (bounceable and not), L4 exact deposit opens with the sender as maker, L5 a second deposit
refunded, L6 pay-to-take on a funded listing, L7–L8 cancel by transfer (NACKL and SHELL signal), L9 cancel
on a `createLot` lot, L10 rate limit, L11 expiry and close.
