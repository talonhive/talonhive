#!/usr/bin/env bash
# Listing by transfer (docs/LISTING_BY_TRANSFER.md): a page opens a listing with an UNSIGNED external message,
# the maker funds it with a PLAIN transfer (all the Acki Nacki Wallet app can do), and cancels it with
# another plain transfer. Every check is a real transaction on Shellnet (PASS / FAIL).
# Same test keys and wallets as run_phase2a.sh; deploys a NEW factory (the lot code changed).
#
# Run from WSL (~25 minutes, unattended: one listing is left to expire):
#   cd <repo>/tests && bash run_listing.sh
# Log: tests/out/listing.log
set -u
cd "$(dirname "$0")"
mkdir -p out build
LOG=out/listing.log
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

OWNER=../spike.keys.json
MKEYS=../maker.keys.json
TKEYS=../taker.keys.json
G=0000000000000000000000000000000000000000000000000000000000000000::1111111111111111111111111111111111111111111111111111111111111111
GABI=~/tools/GiverV3.abi.json
DAPPROOT=0000000000000000000000000000000000000000000000000000000000000000::9999999999999999999999999999999999999999999999999999999999999999
DAPPROOT_HEX=9999999999999999999999999999999999999999999999999999999999999999
ZERO_HEX=0000000000000000000000000000000000000000000000000000000000000000
ROOT_ABI=~/tools/DappRoot.abi.json
SWAP_ABI=../contracts/AtomicSwap.abi.json
FACT_ABI=../contracts/SwapFactory.abi.json
WAL_ABI=TestWallet.abi.json
GQL=https://shellnet.ackinacki.org/graphql
EMPTY_CELL=te6ccgEBAQEAAgAAAA==
N=1000000000
TTL=900                            # SwapFactory.LISTING_TTL
PASS=0; FAIL=0

say()      { echo; echo "=== $(date -u +%H:%M:%S) $* ==="; }
die()      { echo "STOPPING: $*"; exit 1; }
is_hex64() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1  ($3)";
  else FAIL=$((FAIL+1)); echo "  FAIL  $1  expected=$2 actual=$3"; fi
}

acct() {
  curl -s -X POST "$GQL" -H 'Content-Type: application/json' \
    -d "{\"query\":\"{ blockchain { account(account_id:\\\"$1\\\", dapp_id:\\\"$2\\\") { info { acc_type balance(format:DEC) balance_other { currency value(format:DEC) } } } } }\"}"
}
bal() {
  acct "$1" "$2" | python3 -c 'import json,sys
i=(json.load(sys.stdin).get("data") or {}).get("blockchain",{}).get("account",{}).get("info")
if not i: print("0 0 0"); sys.exit()
o={int(float(x["currency"])):int(x["value"]) for x in i.get("balance_other") or []}
print(int(i["balance"]), o.get(1,0), o.get(2,0))'
}
nackl()  { bal "$1" "$2" | cut -d' ' -f2; }
shell()  { bal "$1" "$2" | cut -d' ' -f3; }
native() { bal "$1" "$2" | cut -d' ' -f1; }
active() { acct "$1" "$2" | grep -c '"acc_type":1'; }
jget()   { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1','?'))"; }

lot_state() { tvm-cli -j run "$FHEX::$1" getStatus '{}' --abi "$SWAP_ABI" | jget state; }
lot_maker() { tvm-cli -j run "$FHEX::$1" getTerms '{}' --abi "$SWAP_ABI" | jget maker; }
lot_fundby() { tvm-cli -j run "$FHEX::$1" getFundBy '{}' --abi "$SWAP_ABI" | jget fundBy; }
lot_count() { tvm-cli -j run "$FA" getInfo '{}' --abi "$FACT_ABI" | jget lots; }

give() {
  tvm-cli -j callx --abi "$GABI" --addr "$G" -m sendCurrencyWithFlag \
    "{\"dest\":\"$1\",\"value\":1000000000,\"ecc\":$2,\"flag\":$3}" | grep -E '"(exit_code|aborted)"' | tr -d '\n '; echo
}
body() { tvm-cli body "$1" "$2" --abi "$3" | grep -oE 'te6[A-Za-z0-9+/=]+' | head -1; }
wsend() {  # keys walletHex destHex destDappHex bounce eccJson flag payload
  tvm-cli -j call "$2::$2" sendTx \
    "{\"dest\":\"0:$3\",\"destDapp\":\"0x$4\",\"value\":\"10000000\",\"bounce\":$5,\"cc\":$6,\"flags\":$7,\"payload\":\"$8\"}" \
    --abi "$WAL_ABI" --sign "$1" | grep -E '"(exit_code|aborted|message)"' | tr -d '\n '; echo
}
psend() { wsend "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$EMPTY_CELL"; }   # PLAIN transfer, like the wallet app
ext_lot() { tvm-cli -j call "$FHEX::$1" "$2" "$3" --abi "$SWAP_ABI" 2>&1 | grep -E '"(exit_code|aborted|message)"' | tr -d '\n '; echo; }
genaddr_save() {
  tvm-cli -j genaddr --abi "$1" --setkey "$3" --save "$2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("raw_address","")[2:])'
}
deploy_until_ready() {  # abi tvc keys params hex getter
  for try in 1 2 3; do
    tvm-cli -j run "$5::$5" "$6" '{}' --abi "$1" 2>&1 | grep -q '"Error"' || { echo "  ready: $2"; return 0; }
    echo "  deploy $2, attempt $try"
    tvm-cli -j deploy --abi "$1" --sign "$3" "$2" "$4" | grep -E '"(exit_code|message)"' | tr -d '\n '; echo
    sleep 10
  done
  tvm-cli -j run "$5::$5" "$6" '{}' --abi "$1" 2>&1 | grep -q '"Error"' && die "$2 not ready after 3 attempts"
  echo "  ready: $2"
}
lot_id() {  # nonce -> lot hex
  tvm-cli -j run "$FA" lotAccountId "{\"nonce\":\"$1\"}" --abi "$FACT_ABI" | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value0","")
v=v[2:] if v.startswith("0x") else v
print(v.lower().rjust(64,"0"))'
}

open_listing() {  # giveNackl wantShell deadlineSecs -> UNSIGNED external openListing; prints the exit line
  local dl=$(( $(date +%s) + $3 ))
  tvm-cli -j call "$FA" openListing \
    "{\"key\":\"$RANDOM$RANDOM\",\"giveId\":1,\"giveAmount\":\"$(( $1 * N ))\",\"wantId\":2,\"wantAmount\":\"$(( $2 * N ))\",\"deadline\":\"$dl\"}" \
    --abi "$FACT_ABI" 2>&1 | grep -E '"(exit_code|aborted|message)"' | tr -d '\n '; echo
}
new_listing() {  # giveNackl wantShell deadlineSecs -> sets LOT (AWAITING)
  local before; before=$(lot_count); [[ "$before" =~ ^[0-9]+$ ]] || die "factory getInfo did not return a lot count"
  open_listing "$1" "$2" "$3"
  sleep 20
  LOT=$(lot_id "$before"); is_hex64 "$LOT" && [ "$LOT" != "$ZERO_HEX" ] || die "no lot id for nonce $before"
  for w in 1 2 3; do [ "$(active "$LOT" "$FHEX")" = 1 ] && break; sleep 8; done
  [ "$(active "$LOT" "$FHEX")" = 1 ] || die "listing #$before is not live on chain"
  echo "  listing #$before: $FHEX::$LOT  (give $1 NACKL, want $2 SHELL)"
}
fund() { psend "$MKEYS" "$MHEX" "$1" "$FHEX" "${2:-true}" "{\"1\":\"$(( $3 * N ))\"}" 1; }   # lotHex bounce nackl

# =====================================================================
say "compile"
( cd ../contracts && rm -f AtomicSwap.tvc SwapFactory.tvc \
  && sold --tvm-version gosh AtomicSwap.sol && sold --tvm-version gosh SwapFactory.sol ) || die "contract compile failed"
rm -f TestWallet.tvc; sold --tvm-version gosh TestWallet.sol || die "wallet compile failed"
LOT_CODE=$(tvm-cli -j decode stateinit --tvc ../contracts/AtomicSwap.tvc | jget code)
[ -n "$LOT_CODE" ] && [ "$LOT_CODE" != "?" ] || die "no lot code"

say "test keys and addresses (Shellnet only)"
for K in "$OWNER" "$MKEYS" "$TKEYS"; do [ -f "$K" ] || tvm-cli genphrase --dump "$K" >/dev/null; done
cp TestWallet.tvc build/maker.tvc; cp TestWallet.tvc build/taker.tvc
cp ../contracts/SwapFactory.tvc build/factory_listing.tvc
MHEX=$(genaddr_save "$WAL_ABI" build/maker.tvc "$MKEYS");   is_hex64 "$MHEX" || die "maker addr"
THEX=$(genaddr_save "$WAL_ABI" build/taker.tvc "$TKEYS");   is_hex64 "$THEX" || die "taker addr"
FHEX=$(genaddr_save "$FACT_ABI" build/factory_listing.tvc "$OWNER"); is_hex64 "$FHEX" || die "factory addr"
FA="$FHEX::$FHEX"
echo "maker   $MHEX::$MHEX"; echo "taker   $THEX::$THEX"; echo "factory $FA"

say "fund from the giver"
give "0:$MHEX" '{"2":"3000000000"}' 16
give "0:$MHEX" "{\"1\":\"$(( 6000 * N ))\"}" 1
give "0:$MHEX" "{\"2\":\"$(( 10 * N ))\"}" 1
give "0:$THEX" '{"2":"3000000000"}' 16
give "0:$THEX" "{\"1\":\"$(( 1000 * N ))\"}" 1
give "0:$THEX" "{\"2\":\"$(( 200 * N ))\"}" 1
give "0:$FHEX" '{"2":"5000000000"}' 16
give "0:$FHEX" "{\"2\":\"$(( 130 * N ))\"}" 1
sleep 20

say "deploy wallets (if needed) and the new factory"
deploy_until_ready "$WAL_ABI" build/maker.tvc "$MKEYS" '{}' "$MHEX" rejecting
deploy_until_ready "$WAL_ABI" build/taker.tvc "$TKEYS" '{}' "$THEX" rejecting
deploy_until_ready "$FACT_ABI" build/factory_listing.tvc "$OWNER" "{\"lotCode\":\"$LOT_CODE\",\"feeBps\":\"100\",\"closeDelay\":\"60\"}" "$FHEX" getInfo
for W in maker taker; do
  if [ "$W" = maker ]; then K=$MKEYS; H=$MHEX; else K=$TKEYS; H=$THEX; fi
  R=$(tvm-cli -j run "$H::$H" rejecting '{}' --abi "$WAL_ABI" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("rejecting","")).lower())')
  if [ "$R" != "false" ]; then
    tvm-cli -j call "$H::$H" setRejecting '{"value":false}' --abi "$WAL_ABI" --sign "$K" | grep -E '"exit_code"' | tr -d '\n '; echo
    sleep 15
  fi
done

say "create the factory's DappConfig (120 SHELL credit)"
P=$(tvm-cli body deployNewConfigCustom '{"authorityAddress":null}' --abi "$ROOT_ABI" | grep -oE 'te6[A-Za-z0-9+/=]+' | head -1)
tvm-cli -j call "$FA" sendTransaction \
  "{\"dest\":\"0:$DAPPROOT_HEX\",\"destDapp\":\"0x$ZERO_HEX\",\"value\":\"10000000\",\"bounce\":false,\"cc\":{\"2\":\"$(( 120 * N ))\"},\"flags\":1,\"payload\":\"$P\"}" \
  --abi "$FACT_ABI" --sign "$OWNER" | grep -E '"(exit_code|aborted|message)"' | tr -d '\n '; echo
sleep 20
lot_count | grep -qE '^[0-9]+$' || die "factory getInfo failed"

# =====================================================================
say "L1 a page opens a listing with an unsigned external message (no wallet)"
new_listing 1000 50 7200; LX=$LOT      # LX is left unfunded to test expiry at the end
LX_FUNDBY=$(lot_fundby "$LX")
check "L1 listing is AWAITING (3)" 3 "$(lot_state "$LX")"
check "L1 listing holds no NACKL" 0 "$(nackl "$LX" "$FHEX")"
check "L1 deposit deadline set" yes "$([[ "$LX_FUNDBY" =~ ^[0-9]+$ ]] && [ "$LX_FUNDBY" -gt "$(date +%s)" ] && echo yes || echo no)"
FN=$(native "$FHEX" "$FHEX")

say "L2 refused listings create nothing (too small, deadline inside the deposit window)"
B=$(lot_count)
open_listing 10 1 7200; sleep 15
check "L2a below the minimum lot: no listing" "$B" "$(lot_count)"
open_listing 1000 50 600; sleep 15
check "L2b deadline before the deposit window ends: no listing" "$B" "$(lot_count)"

say "L3 wrong deposits are returned and leave the listing AWAITING"
new_listing 1000 50 7200; L3=$LOT
MK=$(nackl "$MHEX" "$MHEX")
fund "$L3" true 999; sleep 20
check "L3a bounceable 999 NACKL: listing still AWAITING" 3 "$(lot_state "$L3")"
check "L3a maker's 999 NACKL came back" "$MK" "$(nackl "$MHEX" "$MHEX")"
fund "$L3" false 1001; sleep 25
check "L3b non-bounceable 1001 NACKL: listing still AWAITING" 3 "$(lot_state "$L3")"
check "L3b maker's 1001 NACKL refunded" "$MK" "$(nackl "$MHEX" "$MHEX")"
check "L3 listing holds no NACKL" 0 "$(nackl "$L3" "$FHEX")"

say "L4 the exact deposit (plain transfer) opens the listing, with the sender as maker"
fund "$L3" true 1000; sleep 25
check "L4 listing OPEN (0)" 0 "$(lot_state "$L3")"
check "L4 lot holds 1000 NACKL" "$(( 1000 * N ))" "$(nackl "$L3" "$FHEX")"
check "L4 maker recorded = depositor" "0:$MHEX" "$(lot_maker "$L3")"

say "L5 someone else's deposit to the now-open lot is returned"
TK=$(nackl "$THEX" "$THEX")
psend "$TKEYS" "$THEX" "$L3" "$FHEX" false "{\"1\":\"$(( 1000 * N ))\"}" 1; sleep 25
check "L5 taker's 1000 NACKL refunded" "$TK" "$(nackl "$THEX" "$THEX")"
check "L5 lot still OPEN with 1000 NACKL" "0 $(( 1000 * N ))" "$(lot_state "$L3") $(nackl "$L3" "$FHEX")"

say "L6 pay-to-take still works on a funded listing"
MS=$(shell "$MHEX" "$MHEX"); TK=$(nackl "$THEX" "$THEX")
psend "$TKEYS" "$THEX" "$L3" "$FHEX" true "{\"2\":\"$(( 50 * N ))\"}" 1; sleep 25
check "L6 FILLED" 1 "$(lot_state "$L3")"
check "L6 maker got 49.5 SHELL" "$(( 495 * N / 10 ))" "$(( $(shell "$MHEX" "$MHEX") - MS ))"
check "L6 taker got 1000 NACKL" "$(( 1000 * N ))" "$(( $(nackl "$THEX" "$THEX") - TK ))"

say "L7 cancel by transfer: the maker sends 1 NACKL to their open lot"
new_listing 1000 50 7200; L7=$LOT
fund "$L7" true 1000; sleep 25
check "L7 listing OPEN" 0 "$(lot_state "$L7")"
MK=$(nackl "$MHEX" "$MHEX")
fund "$L7" true 1; sleep 25
check "L7 RECLAIMED (2)" 2 "$(lot_state "$L7")"
check "L7 maker net +1000 NACKL (the 1 sent came back too)" "$(( 1000 * N ))" "$(( $(nackl "$MHEX" "$MHEX") - MK ))"
check "L7 lot holds nothing" "0 0" "$(nackl "$L7" "$FHEX") $(shell "$L7" "$FHEX")"

say "L8 cancel with SHELL as the signal (non-bounceable)"
new_listing 1000 50 7200; L8=$LOT
fund "$L8" true 1000; sleep 25
MK=$(nackl "$MHEX" "$MHEX"); MS=$(shell "$MHEX" "$MHEX")
psend "$MKEYS" "$MHEX" "$L8" "$FHEX" false "{\"2\":\"$N\"}" 1; sleep 25
check "L8 RECLAIMED" 2 "$(lot_state "$L8")"
check "L8 maker got 1000 NACKL back" "$(( 1000 * N ))" "$(( $(nackl "$MHEX" "$MHEX") - MK ))"
check "L8 maker's 1 SHELL came back too" "$MS" "$(shell "$MHEX" "$MHEX")"

say "L9 a lot made with createLot: the maker's plain transfer cancels it (no self-fill)"
B=$(lot_count)
P=$(body createLot "{\"giveId\":1,\"wantId\":2,\"wantAmount\":\"$(( 50 * N ))\",\"deadline\":\"$(( $(date +%s) + 7200 ))\",\"makerDapp\":\"0x$MHEX\"}" "$FACT_ABI")
wsend "$MKEYS" "$MHEX" "$FHEX" "$FHEX" true "{\"1\":\"$(( 1000 * N ))\"}" 1 "$P"; sleep 25
L9=$(lot_id "$B")
check "L9 lot born funded and OPEN" "0 $(( 1000 * N ))" "$(lot_state "$L9") $(nackl "$L9" "$FHEX")"
MK=$(nackl "$MHEX" "$MHEX"); MS=$(shell "$MHEX" "$MHEX")
psend "$MKEYS" "$MHEX" "$L9" "$FHEX" true "{\"2\":\"$(( 50 * N ))\"}" 1; sleep 25
check "L9 maker paying their own lot cancels it" 2 "$(lot_state "$L9")"
check "L9 maker's 50 SHELL returned, no fee taken" "$MS" "$(shell "$MHEX" "$MHEX")"
check "L9 maker's 1000 NACKL returned" "$(( 1000 * N ))" "$(( $(nackl "$MHEX" "$MHEX") - MK ))"

say "L10 rate limit: at most 12 listings per 10 minutes"
# The window may have restarted since L1 (the steps above take several minutes), so open listings back to
# back until one is refused: that must happen within 12, and the count left in the window is logged.
OPENED=0; REFUSED=no
for i in $(seq 1 13); do
  B=$(lot_count); open_listing 1000 50 7200; sleep 12
  if [ "$(lot_count)" = "$B" ]; then REFUSED=yes; break; fi
  OPENED=$((OPENED+1))
done
echo "  info: opened $OPENED listings before the refusal"
check "L10 a listing is refused within 12 back-to-back listings" yes "$([ "$REFUSED" = yes ] && [ "$OPENED" -le 12 ] && echo yes || echo no)"

say "L11 expiry: the unfunded listing L1 refuses late deposits and can then be closed by anyone"
WAIT=$(( LX_FUNDBY - $(date +%s) + 5 )); [ "$WAIT" -gt 0 ] && { echo "  waiting ${WAIT}s for the deposit deadline"; sleep "$WAIT"; }
MK=$(nackl "$MHEX" "$MHEX")
fund "$LX" false 1000; sleep 25
check "L11a late deposit refunded" "$MK" "$(nackl "$MHEX" "$MHEX")"
check "L11a listing still AWAITING" 3 "$(lot_state "$LX")"
sleep 50   # closeDelay (60 s) after the deposit deadline
FN=$(native "$FHEX" "$FHEX")
ext_lot "$LX" close '{}'; sleep 25
check "L11b expired listing closed (account gone)" 0 "$(active "$LX" "$FHEX")"
echo "  info: factory native change from the close: $(( $(native "$FHEX" "$FHEX") - FN ))"

say "DONE  PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
