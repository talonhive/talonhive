# Private offers and drop offers (designed 2026-10-25)

Both are terms of an ordinary lot, set when it is created (`createLot`) or opened (`openListing`), and fixed
for its whole life like every other term. A lot can be fixed or drop, and public or private, in any mix.

## Private: one buyer only

- New term `takerId` (uint256): the account id of the only wallet that may take the lot. `0` = anyone.
- The check runs with the other take checks, before `tvm.accept()`: a payment from any other account is
  refused exactly like an underpayment — bounced if bounceable, refunded if not (`_refused`).
- The seller can still cancel at any time (cancel by transfer); the named buyer gains no other power.
- Shared as a link. Privacy is about **who can buy**, not who can see: like every Acki Nacki transfer, the
  lot and its terms are public on chain.
- A wrong `takerId` means nobody can buy; the seller cancels and gets everything back.

## Drop: the price falls to a floor

- New terms `wantStart` (start price) and `dropEnd` (time). `wantAmount` stays the **floor**.
- Fixed price: `wantStart == wantAmount` (`dropEnd` ignored).
- Price at time *t*: `wantStart` when the lot opens, falling in a straight line to `wantAmount` at
  `dropEnd`, then flat. It never goes below the floor or above the start price.
- The drop starts when the lot **opens**: at creation for `createLot`, at the seller's deposit for listings.
- A buyer pays at least the price at the moment the payment is processed. The lot fills at that price and
  returns the rest as change in the same payout (the existing overpay path). The 1% fee is on the fill price.
- Paying less than the current price is refused and refunded.
- Checks (factory, before accepting gas; the lot's constructor repeats them): `wantStart >= wantAmount`; a
  drop must end no later than the offer's deadline and after creation (listings: after the 15-minute deposit
  window, so the price is still falling when the lot can open).
- `getOffer()` returns `wantStart, dropEnd, takerId, startAt, priceNow, fillPrice`.

## What changed in the code

- `AtomicSwap`: new terms and `_startAt`, `_fillPrice`; `_price()`; the private check in `_takeError`;
  `_fill` uses the current price; bounced payouts are attributed with `_fillPrice` (was the fixed price).
- `SwapFactory`: `createLot` and `openListing` take `wantStart, dropEnd, takerId`; `_dropError`;
  `LotCreated`, `ListingOpened` and `onListingFunded` carry the new terms.
- ABI change: tools and the website must send the three new fields (fixed and public: `wantStart =
  wantAmount, dropEnd = 0, takerId = 0`).

## Tests

`tests/run_listing.sh` (all parts, so everything earlier is re-run on the new code), and `run_listing.sh offers`
alone: P1–P4 private (named buyer recorded; a stranger's payment refused bounceable and refunded
non-bounceable; the named buyer fills; the same via `createLot`), D0–D5 drop (price near the start right after
the deposit; paying the floor too early refused; a later 100 SHELL payment fills at the fallen price with the
change returned and the fee on the fill price; after the drop ends the floor fills it; refused drop terms).
