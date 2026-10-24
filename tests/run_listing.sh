#!/usr/bin/env bash
# Listing by transfer (docs/LISTING_BY_TRANSFER.md): a page opens a listing with an UNSIGNED external message,
# the maker funds it with a PLAIN transfer (all the Acki Nacki Wallet app can do), and cancels it with
# another plain transfer. Every check is a real transaction on Shellnet (PASS / FAIL).
# Same test keys and wallets as run_phase2a.sh; deploys a NEW factory (the lot code changed).
#
# Run from WSL (~30 minutes, unattended: one listing is left to expire):
#   cd <repo>/tests && bash run_listing.sh          all checks (L1-L11, then U1-U7 with USDC)
#   cd <repo>/tests && bash run_listing.sh usdc     only the USDC checks (~8 minutes)
# Log: tests/out/listing.log (tests/out/listing-usdc.log for the USDC-only run)
set -u
PART=${1:-all}
cd "$(dirname "$0")"
mkdir -p out build
LOG=out/listing.log; [ "$PART" = usdc ] && LOG=out/listing-usdc.log
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
U=1000000                          # 1 USDC (6 decimals)
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
if not i: print("0 0 0 0"); sys.exit()
o={int(float(x["currency"])):int(x["value"]) for x in i.get("balance_other") or []}
print(int(i["balance"]), o.get(1,0), o.get(2,0), o.get(3,0))'
}
nackl()  { bal "$1" "$2" | cut -d' ' -f2; }
shell()  { bal "$1" "$2" | cut -d' ' -f3; }
usdc()   { bal "$1" "$2" | cut -d' ' -f4; }
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

open_listing_raw() {  # giveId giveAmount wantId wantAmount deadlineSecs (amounts in smallest units)
  local dl=$(( $(date +%s) + $5 ))
  tvm-cli -j call "$FA" openListing \
    "{\"key\":\"$RANDOM$RANDOM\",\"giveId\":$1,\"giveAmount\":\"$2\",\"wantId\":$3,\"wantAmount\":\"$4\",\"deadline\":\"$dl\"}" \
    --abi "$FACT_ABI" 2>&1 | grep -E '"(exit_code|aborted|message)"' | tr -d '\n '; echo
}
open_listing() { open_listing_raw 1 "$(( $1 * N ))" 2 "$(( $2 * N ))" "$3"; }   # giveNackl wantShell deadlineSecs
new_listing_raw() {  # giveId giveAmount wantId wantAmount deadlineSecs -> sets LOT (AWAITING)
  local before; before=$(lot_count); [[ "$before" =~ ^[0-9]+$ ]] || die "factory getInfo did not return a lot count"
  open_listing_raw "$@"
  sleep 20
  LOT=$(lot_id "$before"); is_hex64 "$LOT" && [ "$LOT" != "$ZERO_HEX" ] || die "no lot id for nonce $before"
  for w in 1 2 3; do [ "$(active "$LOT" "$FHEX")" = 1 ] && break; sleep 8; done
  [ "$(active "$LOT" "$FHEX")" = 1 ] || die "listing #$before is not live on chain"
  echo "  listing #$before: $FHEX::$LOT  (give $2 of currency $1, want $4 of currency $3)"
}
new_listing() { new_listing_raw 1 "$(( $1 * N ))" 2 "$(( $2 * N ))" "$3"; }      # giveNackl wantShell deadlineSecs
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
give "0:$MHEX" "{\"3\":\"$(( 50 * U ))\"}" 1      # the giver mints test USDC on demand
give "0:$THEX" "{\"3\":\"$(( 50 * U ))\"}" 1
give "0:$FHEX" '{"2":"5000000000"}' 16
[ "$PART" = usdc ] || give "0:$FHEX" "{\"2\":\"$(( 130 * N ))\"}" 1
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

CFG=$(tvm-cli -j run "$DAPPROOT" getConfigAddr "{\"dapp_id\":\"0x$FHEX\"}" --abi "$ROOT_ABI" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("config","")[2:])')
if is_hex64 "$CFG" && [ "$(active "$CFG" "$FHEX")" = 1 ]; then
  say "the factory's DappConfig already exists (earlier run): $CFG"
else
  say "create the factory's DappConfig (120 SHELL credit)"
  P=$(tvm-cli body deployNewConfigCustom '{"authorityAddress":null}' --abi "$ROOT_ABI" | grep -oE 'te6[A-Za-z0-9+/=]+' | head -1)
  tvm-cli -j call "$FA" sendTransaction \
    "{\"dest\":\"0:$DAPPROOT_HEX\",\"destDapp\":\"0x$ZERO_HEX\",\"value\":\"10000000\",\"bounce\":false,\"cc\":{\"2\":\"$(( 120 * N ))\"},\"flags\":1,\"payload\":\"$P\"}" \
    --abi "$FACT_ABI" --sign "$OWNER" | grep -E '"(exit_code|aborted|message)"' | tr -d '\n '; echo
  sleep 20
fi
lot_count | grep -qE '^[0-9]+$' || die "factory getInfo failed"

if [ "$PART" != usdc ]; then
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
fi   # PART != usdc

# =====================================================================
# USDC (currency 3, 6 decimals) on both sides: selling NACKL for USDC, and buying NACKL with USDC.
say "U1 sell NACKL for USDC: listing 1000 NACKL for 5 USDC, funded by plain transfer"
new_listing_raw 1 "$(( 1000 * N ))" 3 "$(( 5 * U ))" 7200; U1=$LOT
fund "$U1" true 1000; sleep 25
check "U1 listing OPEN with 1000 NACKL" "0 $(( 1000 * N ))" "$(lot_state "$U1") $(nackl "$U1" "$FHEX")"

say "U2 underpaying in USDC is refused (4 of 5 USDC, bounceable)"
TU=$(usdc "$THEX" "$THEX")
psend "$TKEYS" "$THEX" "$U1" "$FHEX" true "{\"3\":\"$(( 4 * U ))\"}" 1; sleep 25
check "U2 lot still OPEN" 0 "$(lot_state "$U1")"
check "U2 taker's 4 USDC came back" "$TU" "$(usdc "$THEX" "$THEX")"

say "U3 paying 5 USDC fills it: USDC to the seller and the fee, NACKL to the buyer"
MU=$(usdc "$MHEX" "$MHEX"); TK=$(nackl "$THEX" "$THEX"); FU=$(usdc "$FHEX" "$FHEX")
psend "$TKEYS" "$THEX" "$U1" "$FHEX" true "{\"3\":\"$(( 5 * U ))\"}" 1; sleep 25
check "U3 FILLED" 1 "$(lot_state "$U1")"
check "U3 seller got 4.95 USDC (5 - 1% fee)" "$(( 495 * U / 100 ))" "$(( $(usdc "$MHEX" "$MHEX") - MU ))"
check "U3 buyer got 1000 NACKL" "$(( 1000 * N ))" "$(( $(nackl "$THEX" "$THEX") - TK ))"
check "U3 treasury got the 0.05 USDC fee" "$(( 5 * U / 100 ))" "$(( $(usdc "$FHEX" "$FHEX") - FU ))"
check "U3 lot holds no USDC" 0 "$(usdc "$U1" "$FHEX")"

say "U4 buy NACKL with USDC: listing gives 5 USDC for 1000 NACKL; a wrong deposit is refunded"
new_listing_raw 3 "$(( 5 * U ))" 1 "$(( 1000 * N ))" 7200; U4=$LOT
MU=$(usdc "$MHEX" "$MHEX")
psend "$MKEYS" "$MHEX" "$U4" "$FHEX" false "{\"3\":\"$(( 5 * U - 1 ))\"}" 1; sleep 25
check "U4a 4.999999 USDC (non-bounceable): listing still AWAITING" 3 "$(lot_state "$U4")"
check "U4a buyer's 4.999999 USDC refunded" "$MU" "$(usdc "$MHEX" "$MHEX")"
psend "$MKEYS" "$MHEX" "$U4" "$FHEX" true "{\"3\":\"$(( 5 * U ))\"}" 1; sleep 25
check "U4b exactly 5 USDC opens it, holding 5 USDC" "0 $(( 5 * U ))" "$(lot_state "$U4") $(usdc "$U4" "$FHEX")"
check "U4b offer's creator recorded = depositor" "0:$MHEX" "$(lot_maker "$U4")"

say "U5 a NACKL holder fills the USDC offer: NACKL to its creator and the fee, USDC to the NACKL holder"
MK=$(nackl "$MHEX" "$MHEX"); TU=$(usdc "$THEX" "$THEX"); FK=$(nackl "$FHEX" "$FHEX")
psend "$TKEYS" "$THEX" "$U4" "$FHEX" true "{\"1\":\"$(( 1000 * N ))\"}" 1; sleep 25
check "U5 FILLED" 1 "$(lot_state "$U4")"
check "U5 offer's creator got 990 NACKL (1000 - 1% fee)" "$(( 990 * N ))" "$(( $(nackl "$MHEX" "$MHEX") - MK ))"
check "U5 NACKL holder got 5 USDC" "$(( 5 * U ))" "$(( $(usdc "$THEX" "$THEX") - TU ))"
check "U5 treasury got the 10 NACKL fee" "$(( 10 * N ))" "$(( $(nackl "$FHEX" "$FHEX") - FK ))"
check "U5 lot holds nothing" "0 0" "$(usdc "$U4" "$FHEX") $(nackl "$U4" "$FHEX")"

say "U6 cancel a USDC offer with 1 USDC (non-bounceable): everything comes back"
new_listing_raw 3 "$(( 5 * U ))" 1 "$(( 1000 * N ))" 7200; U6=$LOT
psend "$MKEYS" "$MHEX" "$U6" "$FHEX" true "{\"3\":\"$(( 5 * U ))\"}" 1; sleep 25
check "U6 listing OPEN" 0 "$(lot_state "$U6")"
MU=$(usdc "$MHEX" "$MHEX")
psend "$MKEYS" "$MHEX" "$U6" "$FHEX" false "{\"3\":\"$U\"}" 1; sleep 25
check "U6 RECLAIMED" 2 "$(lot_state "$U6")"
check "U6 creator net +5 USDC (the 1 sent came back too)" "$(( 5 * U ))" "$(( $(usdc "$MHEX" "$MHEX") - MU ))"
check "U6 lot holds no USDC" 0 "$(usdc "$U6" "$FHEX")"

say "U7 USDC with createLot (developer wallet) and the USDC minimum"
B=$(lot_count)
P=$(body createLot "{\"giveId\":3,\"wantId\":1,\"wantAmount\":\"$(( 1000 * N ))\",\"deadline\":\"$(( $(date +%s) + 7200 ))\",\"makerDapp\":\"0x$MHEX\"}" "$FACT_ABI")
wsend "$MKEYS" "$MHEX" "$FHEX" "$FHEX" true "{\"3\":\"$(( 5 * U ))\"}" 1 "$P"; sleep 25
U7=$(lot_id "$B")
check "U7a createLot lot born funded with 5 USDC" "0 $(( 5 * U ))" "$(lot_state "$U7") $(usdc "$U7" "$FHEX")"
TU=$(usdc "$THEX" "$THEX")
psend "$TKEYS" "$THEX" "$U7" "$FHEX" true "{\"1\":\"$(( 1000 * N ))\"}" 1; sleep 25
check "U7a pay-to-take with NACKL fills it" 1 "$(lot_state "$U7")"
check "U7a NACKL holder got 5 USDC" "$(( 5 * U ))" "$(( $(usdc "$THEX" "$THEX") - TU ))"
B=$(lot_count)
open_listing_raw 3 "$(( U / 2 ))" 1 "$(( 100 * N ))" 7200; sleep 15
check "U7b 0.5 USDC is below the 1 USDC minimum: no listing" "$B" "$(lot_count)"

say "DONE  PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
