#!/usr/bin/env bash
# Live chart demo (Shellnet only, test wallets from the test suite): real trades at rising prices, so the
# website's price chart climbs as they land. Each round the test maker lists 1,000 NACKL for SHELL (createLot)
# and the test taker buys it with a plain transfer, then the script waits before the next round so every
# step shows on the chart. The price climbs about 6% a round on average (12 rounds: about +60%), with small
# dips. Watch it on the chart's 1H view (the other views also include older test trades).
#
#   bash demo_rally.sh                 12 rounds from 0.012 SHELL per NACKL, 30 s apart
#   bash demo_rally.sh ROUNDS START GAP   e.g.  bash demo_rally.sh 15 0.02 20
#
# Needs: maker ~1,000 test NACKL per round (+ a little gas), taker enough test SHELL for the fills
# (12 rounds from 0.012 is about 185 SHELL). At the end it leaves one open offer a bit above the last price,
# so the chart's live point sits above the line.
# Run from WSL:  cd <repo>/tests && bash demo_rally.sh
set -u
cd "$(dirname "$0")"
MKEYS=../maker.keys.json
TKEYS=../taker.keys.json
FACT_ABI=../contracts/SwapFactory.abi.json
SWAP_ABI=../contracts/AtomicSwap.abi.json
WAL_ABI=TestWallet.abi.json
EMPTY_CELL=te6ccgEBAQEAAgAAAA==
N=1000000000
ROUNDS=${1:-12}; START=${2:-0.012}; GAP=${3:-30}
LOT_NACKL=1000

die() { echo "STOPPING: $*"; exit 1; }
[[ "$ROUNDS" =~ ^[0-9]+$ && "$ROUNDS" -ge 1 && "$ROUNDS" -le 40 ]] || die "ROUNDS must be 1-40"
[[ "$START" =~ ^0?\.[0-9]+$|^[0-9]+(\.[0-9]+)?$ ]] || die "START must be a price like 0.012"
[[ "$GAP" =~ ^[0-9]+$ ]] || die "GAP must be seconds"

SRC=""; for f in out/listing.log out/listing-usdc.log out/phase2a.log; do [ -f "$f" ] && { SRC=$f; break; }; done
[ -n "$SRC" ] || die "no suite log in tests/out; run run_listing.sh first"
hex_of() { grep -m1 "^$1 " "$SRC" | awk '{print $2}' | cut -d: -f1; }
MHEX=$(hex_of maker); THEX=$(hex_of taker); FHEX=$(hex_of factory)
for h in "$MHEX" "$THEX" "$FHEX"; do [[ "$h" =~ ^[0-9a-f]{64}$ ]] || die "could not read addresses from $SRC"; done
FA="$FHEX::$FHEX"
# The trades only show on the website if they go through the factory the website reads.
WEBF=$(grep -oE 'factory: "[0-9a-f]{64}"' ../web/config.js | head -1 | grep -oE '[0-9a-f]{64}')
[ "$WEBF" = "$FHEX" ] || die "the suite's factory ($FHEX) is not the one the website uses ($WEBF)"

body() { tvm-cli body "$1" "$2" --abi "$3" | grep -oE 'te6[A-Za-z0-9+/=]+' | head -1; }
send() {  # keys walletHex destHex bounce eccJson payload
  tvm-cli -j call "$2::$2" sendTx \
    "{\"dest\":\"0:$3\",\"destDapp\":\"0x$FHEX\",\"value\":\"10000000\",\"bounce\":$4,\"cc\":$5,\"flags\":1,\"payload\":\"$6\"}" \
    --abi "$WAL_ABI" --sign "$1" | grep -E '"(exit_code|aborted)"' | tr -d '\n '; echo
}
lots_count() { tvm-cli -j run "$FA" getInfo '{}' --abi "$FACT_ABI" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["lots"])
except Exception: print("")'; }
lot_hex() { tvm-cli -j run "$FA" lotAccountId "{\"nonce\":\"$1\"}" --abi "$FACT_ABI" | python3 -c 'import json,sys
v=json.load(sys.stdin)["value0"]; v=v[2:] if v.startswith("0x") else v; print(v.lower().rjust(64,"0"))'; }
state_of() { tvm-cli -j run "$FHEX::$1" getStatus '{}' --abi "$SWAP_ABI" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["state"])
except Exception: print("x")'; }
want_of() { tvm-cli -j run "$FHEX::$1" getTerms '{}' --abi "$SWAP_ABI" 2>/dev/null | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d["maker"].split(":")[-1], d["wantAmount"])
except Exception: print("x x")'; }

# Lists LOT_NACKL NACKL for WANT nano-SHELL and prints the new lot's account id (found by maker + price,
# so another script creating lots at the same time can't confuse it). Empty on failure.
list_lot() {
  local want=$1 before dl p after i L
  before=$(lots_count); [[ "$before" =~ ^[0-9]+$ ]] || { echo ""; return; }
  dl=$(( $(date +%s) + 86400 ))
  p=$(body createLot "{\"giveId\":1,\"wantId\":2,\"wantAmount\":\"$want\",\"deadline\":\"$dl\",\"makerDapp\":\"0x$MHEX\",\"wantStart\":\"$want\",\"dropEnd\":\"0\",\"takerId\":\"0\"}" "$FACT_ABI")
  send "$MKEYS" "$MHEX" "$FHEX" true "{\"1\":\"$(( LOT_NACKL * N ))\"}" "$p" >&2
  for _ in $(seq 1 20); do
    sleep 3
    after=$(lots_count); [[ "$after" =~ ^[0-9]+$ ]] || continue
    for ((i=after-1; i>=before; i--)); do
      L=$(lot_hex "$i")
      read MK WA <<< "$(want_of "$L")"
      if [ "$MK" = "$MHEX" ] && [ "$WA" = "$want" ] && [ "$(state_of "$L")" = 0 ]; then echo "$L"; return; fi
    done
  done
  echo ""
}

# Price path: about +6% a round on average (12 rounds: about +60%), with small dips (seeded, so a rerun gives the same shape).
PRICES=$(python3 - "$ROUNDS" "$START" <<'PY'
import random, sys
n, p = int(sys.argv[1]), float(sys.argv[2])
r = random.Random(42)
out = []
for _ in range(n + 1):
    out.append(p)
    p *= 1 + r.uniform(-0.03, 0.15)
print(" ".join(f"{x:.6f}" for x in out))
PY
)
read -r -a P <<< "$PRICES"

echo "=== $(date +%T) live chart demo: $ROUNDS trades from $START SHELL per NACKL, ${GAP}s apart, factory $FHEX ==="
echo "    open the website on your phone (NACKL / SHELL) and watch the chart"
OK=0
for ((r=0; r<ROUNDS; r++)); do
  PRICE=${P[$r]}
  WANT=$(python3 -c "import sys; print(int(round(float(sys.argv[1]) * $LOT_NACKL * 1e9)))" "$PRICE")
  printf '\n[%s] round %d/%d: %s NACKL at %s SHELL each (%s nano-SHELL)\n' "$(date +%T)" $((r+1)) "$ROUNDS" "$LOT_NACKL" "$PRICE" "$WANT"
  L=$(list_lot "$WANT")
  [ -n "$L" ] || { echo "  listing didn't appear within a minute (out of test NACKL or gas?); stopping"; break; }
  echo "  listed: $L"
  printf '  taker pays: '
  send "$TKEYS" "$THEX" "$L" true "{\"2\":\"$WANT\"}" "$EMPTY_CELL"
  S=""
  for _ in $(seq 1 15); do sleep 3; S=$(state_of "$L"); [ "$S" = 0 ] || break; done
  if [ "$S" = 1 ] || [ "$S" = x ]; then OK=$((OK+1)); echo "  filled$([ "$S" = x ] && echo " (offer already closed)")"
  else echo "  not filled (state $S): the taker may be out of test SHELL; stopping"; break; fi
  [ $((r+1)) -lt "$ROUNDS" ] && sleep "$GAP"
done

# One open offer a little above the last trade: the chart's live point.
LAST=${P[$ROUNDS]}
WANT=$(python3 -c "import sys; print(int(round(float(sys.argv[1]) * $LOT_NACKL * 1e9)))" "$LAST")
printf '\n[%s] leaving an open offer at %s SHELL per NACKL (24 h)\n' "$(date +%T)" "$LAST"
L=$(list_lot "$WANT"); [ -n "$L" ] && echo "  open: $L" || echo "  (couldn't confirm it; not important)"
echo
echo "=== $(date +%T) DONE  $OK of $ROUNDS trades filled ==="
