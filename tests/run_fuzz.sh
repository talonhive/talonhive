#!/usr/bin/env bash
# Invariant fuzzing on Shellnet: random actions by three test wallets against the factory and its lots, with the
# Swap's rules checked on chain after every step. Reproducible: the seed is printed; rerun a failing case with
#   SEED=<seed> STEPS=<n> bash run_fuzz.sh
#
# Actors: maker (M), taker (T), stranger (S) - TestWallets as in run_listing.sh. Actions (random, weighted):
#   open a listing (fixed/drop, public/private, NACKL/SHELL/USDC), createLot with a short deadline, fund a listing
#   (exact or wrong amount, right or wrong wallet), take (exact, under, over, wrong currency, flag-16 SHELL),
#   cancel by transfer, unsigned reclaim / close / release, and make T or S refuse payments for a while
#   (forces bounced payouts into the lots' owed ledger).
# Invariants, after every step:
#   C   conservation: per currency, M + T + S + factory + every lot created here never changes
#   L   every coin accounted for, per lot touched (all lots every 10 steps):
#         OPEN: give held = giveAmount + owed give, want held = owed want
#         AWAITING / FILLED / RECLAIMED: give held = owed give, want held = owed want; no third currency
#   F   factory ledger: getHeld() == the factory's real balance, per currency
# End: every open lot is cancelled by its maker, owed coins are released, then every lot must hold nothing.
#
# Run from WSL (default 40 steps, ~30-40 minutes, unattended):  cd <repo>/tests && bash run_fuzz.sh
# Log: tests/out/fuzz.log
set -u
cd "$(dirname "$0")"
mkdir -p out build
LOG=out/fuzz.log
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

STEPS=${STEPS:-40}
SEED=${SEED:-$(( (RANDOM << 15) | RANDOM ))}
RANDOM=$SEED

OWNER=../spike.keys.json; MKEYS=../maker.keys.json; TKEYS=../taker.keys.json; SKEYS=../stranger.keys.json
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
N=1000000000; U=1000000
PASS=0; FAIL=0; WARN=0

say()  { echo; echo "=== $(date -u +%H:%M:%S) $* ==="; }
die()  { echo "STOPPING: $*"; exit 1; }
is_hex64() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
jget() { python3 -c "import json,sys
try: print(json.load(sys.stdin).get('$1','?'))
except Exception: print('?')"; }
pass() { PASS=$((PASS+1)); }
fail() { FAIL=$((FAIL+1)); echo "  FAIL [seed $SEED, step $STEP] $*"; }
rnd()  { echo $(( RANDOM % $1 )); }                       # 0..n-1
pick() { local a=("$@"); echo "${a[$(( RANDOM % ${#a[@]} ))]}"; }
unit() { [ "$1" = 3 ] && echo $U || echo $N; }

# ---- chain reads ----
# Balances of many accounts in one GraphQL request: args "account:dapp" -> lines "account native nackl shell usdc"
balances() {
  python3 - "$GQL" "$@" <<'PY'
import json, sys, urllib.request
gql, accts = sys.argv[1], sys.argv[2:]
q = " ".join(f'a{i}: account(account_id:"{a.split(":")[0]}", dapp_id:"{a.split(":")[1]}") {{ info {{ acc_type balance(format:DEC) balance_other {{ currency value(format:DEC) }} }} }}'
             for i, a in enumerate(accts))
for attempt in range(4):
    try:
        # Cloudflare in front of the API refuses Python's default client name (403), so send a plain one.
        req = urllib.request.Request(gql, json.dumps({"query": "{ blockchain { " + q + " } }"}).encode(),
                                     {"Content-Type": "application/json", "User-Agent": "talonhive-swap-tests/1.0"})
        d = json.load(urllib.request.urlopen(req, timeout=30))["data"]["blockchain"]
        break
    except Exception:
        if attempt == 3: raise
for i, a in enumerate(accts):
    info = (d.get(f"a{i}") or {}).get("info") or {}
    o = {int(float(x["currency"])): int(x["value"]) for x in info.get("balance_other") or []}
    print(a.split(":")[0], int(info.get("balance") or 0), o.get(1, 0), o.get(2, 0), o.get(3, 0))
PY
}
lot_json() { tvm-cli -j run "$FHEX::$1" "$2" '{}' --abi "$SWAP_ABI" 2>/dev/null; }
lot_id() {
  tvm-cli -j run "$FA" lotAccountId "{\"nonce\":\"$1\"}" --abi "$FACT_ABI" | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value0",""); v=v[2:] if v.startswith("0x") else v; print(v.lower().rjust(64,"0"))'
}
lot_count() { tvm-cli -j run "$FA" getInfo '{}' --abi "$FACT_ABI" | jget lots; }

# ---- writes ----
give() { tvm-cli -j callx --abi "$GABI" --addr "$G" -m sendCurrencyWithFlag "{\"dest\":\"$1\",\"value\":1000000000,\"ecc\":$2,\"flag\":$3}" >/dev/null; }
body() { tvm-cli body "$1" "$2" --abi "$3" | grep -oE 'te6[A-Za-z0-9+/=]+' | head -1; }
wsend() {  # keys walletHex destHex bounce eccJson flag payload
  tvm-cli -j call "$2::$2" sendTx \
    "{\"dest\":\"0:$3\",\"destDapp\":\"0x$FHEX\",\"value\":\"10000000\",\"bounce\":$4,\"cc\":$5,\"flags\":$6,\"payload\":\"$7\"}" \
    --abi "$WAL_ABI" --sign "$1" | grep -E '"(exit_code|aborted)"' | tr -d '\n '; echo
}
ext_lot() { tvm-cli -j call "$FHEX::$1" "$2" "$3" --abi "$SWAP_ABI" 2>&1 | grep -oE '"exit_code":[^,]*' | head -1; }
genaddr_save() { tvm-cli -j genaddr --abi "$1" --setkey "$3" --save "$2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("raw_address","")[2:])'; }
deploy_until_ready() {
  for try in 1 2 3; do
    tvm-cli -j run "$5::$5" "$6" '{}' --abi "$1" 2>&1 | grep -q '"Error"' || return 0
    tvm-cli -j deploy --abi "$1" --sign "$3" "$2" "$4" >/dev/null; sleep 10
  done
  tvm-cli -j run "$5::$5" "$6" '{}' --abi "$1" 2>&1 | grep -q '"Error"' && die "$2 not ready"
}
keys_of() { case "$1" in "$MHEX") echo "$MKEYS";; "$THEX") echo "$TKEYS";; "$SHEX") echo "$SKEYS";; *) echo "";; esac; }
name_of() { case "$1" in "$MHEX") echo M;; "$THEX") echo T;; "$SHEX") echo S;; *) echo "?";; esac; }

# =====================================================================
say "compile and set up (seed $SEED, $STEPS steps)"
( cd ../contracts && rm -f AtomicSwap.tvc SwapFactory.tvc && sold --tvm-version gosh AtomicSwap.sol && sold --tvm-version gosh SwapFactory.sol ) >/dev/null || die "compile failed"
rm -f TestWallet.tvc; sold --tvm-version gosh TestWallet.sol >/dev/null || die "wallet compile failed"
LOT_CODE=$(tvm-cli -j decode stateinit --tvc ../contracts/AtomicSwap.tvc | jget code)
for K in "$OWNER" "$MKEYS" "$TKEYS" "$SKEYS"; do [ -f "$K" ] || tvm-cli genphrase --dump "$K" >/dev/null; done
for w in maker taker stranger; do cp TestWallet.tvc build/$w.tvc; done
cp ../contracts/SwapFactory.tvc build/factory_listing.tvc
MHEX=$(genaddr_save "$WAL_ABI" build/maker.tvc "$MKEYS"); THEX=$(genaddr_save "$WAL_ABI" build/taker.tvc "$TKEYS")
SHEX=$(genaddr_save "$WAL_ABI" build/stranger.tvc "$SKEYS"); FHEX=$(genaddr_save "$FACT_ABI" build/factory_listing.tvc "$OWNER")
for h in "$MHEX" "$THEX" "$SHEX" "$FHEX"; do is_hex64 "$h" || die "address"; done
FA="$FHEX::$FHEX"
echo "maker $MHEX | taker $THEX | stranger $SHEX | factory $FHEX"
for W in "$MHEX" "$THEX" "$SHEX"; do
  give "0:$W" '{"2":"4000000000"}' 16
  give "0:$W" "{\"1\":\"$(( 20000 * N ))\"}" 1; give "0:$W" "{\"2\":\"$(( 1500 * N ))\"}" 1; give "0:$W" "{\"3\":\"$(( 60 * U ))\"}" 1
done
give "0:$FHEX" '{"2":"5000000000"}' 16
sleep 20
deploy_until_ready "$WAL_ABI" build/maker.tvc "$MKEYS" '{}' "$MHEX" rejecting
deploy_until_ready "$WAL_ABI" build/taker.tvc "$TKEYS" '{}' "$THEX" rejecting
deploy_until_ready "$WAL_ABI" build/stranger.tvc "$SKEYS" '{}' "$SHEX" rejecting
deploy_until_ready "$FACT_ABI" build/factory_listing.tvc "$OWNER" "{\"lotCode\":\"$LOT_CODE\",\"feeBps\":\"100\",\"closeDelay\":\"60\"}" "$FHEX" getInfo
CFG=$(tvm-cli -j run "$DAPPROOT" getConfigAddr "{\"dapp_id\":\"0x$FHEX\"}" --abi "$ROOT_ABI" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("config","")[2:])')
if ! { is_hex64 "$CFG" && balances "$CFG:$FHEX" | awk '{exit !($2>0)}'; }; then
  give "0:$FHEX" "{\"2\":\"$(( 130 * N ))\"}" 1; sleep 15
  P=$(tvm-cli body deployNewConfigCustom '{"authorityAddress":null}' --abi "$ROOT_ABI" | grep -oE 'te6[A-Za-z0-9+/=]+' | head -1)
  tvm-cli -j call "$FA" sendTransaction "{\"dest\":\"0:$DAPPROOT_HEX\",\"destDapp\":\"0x$ZERO_HEX\",\"value\":\"10000000\",\"bounce\":false,\"cc\":{\"2\":\"$(( 120 * N ))\"},\"flags\":1,\"payload\":\"$P\"}" --abi "$FACT_ABI" --sign "$OWNER" >/dev/null
  sleep 20
fi
for W in "$MHEX" "$THEX" "$SHEX"; do
  K=$(keys_of "$W")
  tvm-cli -j call "$W::$W" setRejecting '{"value":false}' --abi "$WAL_ABI" --sign "$K" >/dev/null
done
sleep 10

LOTS=()           # lots created in this run (hex), synced from the factory's counter (nobody else uses this factory)
START_LOTS=$(lot_count); [[ "$START_LOTS" =~ ^[0-9]+$ ]] || die "factory getInfo"
sync_lots() {
  local cnt i l; cnt=$(lot_count); [[ "$cnt" =~ ^[0-9]+$ ]] || return
  for ((i = START_LOTS + ${#LOTS[@]}; i < cnt; i++)); do l=$(lot_id "$i"); is_hex64 "$l" && LOTS+=("$l") && TOUCHED+=("$l") && echo "    lot #$i $l"; done
}
REJ_T=0; REJ_S=0  # rejecting flags (to restore at the end)
TOUCHED=()        # lots touched in the current step (checked in detail after it)
tracked() { local a=("$MHEX:$MHEX" "$THEX:$THEX" "$SHEX:$SHEX" "$FHEX:$FHEX"); for l in "${LOTS[@]}"; do a+=("$l:$FHEX"); done; echo "${a[@]}"; }
totals() { sync_lots; balances $(tracked) | python3 -c "import sys
n=s=u=0
for l in sys.stdin:
    f=l.split(); n+=int(f[2]); s+=int(f[3]); u+=int(f[4])
print(n, s, u)"; }
read T0N T0S T0U <<< "$(totals)"
echo "start totals: NACKL $T0N | SHELL $T0S | USDC $T0U"

# ---- invariants ----
check_lot() {  # lotHex -> L invariant
  local l=$1 st og ow tm gi ga wi
  st=$(lot_json "$l" getStatus); og=$(lot_json "$l" getOwedTotal); tm=$(lot_json "$l" getTerms)
  if [ -z "$st" ] || echo "$st" | grep -q '"Error"'; then
    # closed lots are deleted: then they must hold nothing at all
    read _ _ bn bs bu <<< "$(balances "$l:$FHEX")"
    [ "$bn$bs$bu" = "000" ] && { pass; return; }
    fail "L lot $l unreadable but holds NACKL $bn SHELL $bs USDC $bu"; return
  fi
  # Coins in flight or a read that failed (a just-created lot, a network hiccup): read everything again once.
  check_lot_once "$l" "$st" "$og" "$tm" >/dev/null 2>&1 || {
    sleep 15; st=$(lot_json "$l" getStatus); og=$(lot_json "$l" getOwedTotal); tm=$(lot_json "$l" getTerms); }
  check_lot_once "$l" "$st" "$og" "$tm"
  case $? in
    0) pass;;
    2) WARN=$((WARN+1)); echo "  WARN lot $l could not be read (checked again in the next full sweep)";;
    *) fail "L lot $l (see above)";;
  esac
}
check_lot_once() {  # lotHex statusJson owedJson termsJson
  python3 - "$2" "$3" "$4" "$(balances "$1:$FHEX")" "$1" <<'PY'
import json, sys
try:
    st, og, tm = (json.loads(x) for x in sys.argv[1:4])
    st["state"], og["give"], og["want"], tm["giveId"], tm["wantId"], tm["giveAmount"]
except Exception:
    sys.exit(2)          # unreadable (read error / not ready): not a rule violation
bal = sys.argv[4].split(); lot = sys.argv[5]
held = {1: int(bal[2]), 2: int(bal[3]), 3: int(bal[4])}
state = int(st["state"]); gi, wi = int(tm["giveId"]), int(tm["wantId"]); ga = int(tm["giveAmount"])
owg, oww = int(og["give"]), int(og["want"])
want_give = ga + owg if state == 0 else owg
other = [c for c in (1, 2, 3) if c not in (gi, wi)][0]
ok = state in (0, 1, 2, 3) and held[gi] == want_give and held[wi] == oww and held[other] == 0
if not ok:
    print(f"    lot {lot}: state {state}, give {gi} held {held[gi]} expected {want_give} (giveAmount {ga} + owed {owg} if open), "
          f"want {wi} held {held[wi]} expected owed {oww}, third currency {other} held {held[other]}")
sys.exit(0 if ok else 1)
PY
}
check_all() {  # $1 = lots to check in detail ("all" or a list)
  read TN TS TU <<< "$(totals)"
  # A payout or refund can be between accounts for a few seconds: look again once before calling it a failure.
  [ "$TN $TS $TU" = "$T0N $T0S $T0U" ] || { sleep 15; read TN TS TU <<< "$(totals)"; }
  if [ "$TN $TS $TU" = "$T0N $T0S $T0U" ]; then pass; else
    fail "C conservation: NACKL $TN (start $T0N, diff $((TN-T0N))) SHELL $TS (diff $((TS-T0S))) USDC $TU (diff $((TU-T0U)))"; fi
  local h fb
  h=$(tvm-cli -j run "$FA" getHeld '{}' --abi "$FACT_ABI" 2>/dev/null)
  read _ _ fn fs fu <<< "$(balances "$FHEX:$FHEX")"
  if [ "$(echo "$h" | jget nackl) $(echo "$h" | jget shell) $(echo "$h" | jget usdc)" = "$fn $fs $fu" ]; then pass; else
    fail "F factory ledger $(echo "$h" | tr -d '\n ') != balance NACKL $fn SHELL $fs USDC $fu"; fi
  local list=("$@"); [ "${1:-}" = all ] && list=("${LOTS[@]}")
  for l in "${list[@]}"; do [ -n "$l" ] && check_lot "$l"; done
}

# ---- actions ----
rand_terms() {  # sets GI GA WI WA (smallest units)
  GI=$(pick 1 1 2 3); WI=$(pick 1 2 3); while [ "$WI" = "$GI" ]; do WI=$(pick 1 2 3); done
  case $GI in 1) GA=$(( (1000 + $(rnd 500)) * N ));; 2) GA=$(( (100 + $(rnd 50)) * N ));; 3) GA=$(( (1 + $(rnd 3)) * U ));; esac
  case $WI in 1) WA=$(( (100 + $(rnd 2000)) * N ));; 2) WA=$(( (1 + $(rnd 60)) * N ));; 3) WA=$(( (1 + $(rnd 5)) * U ));; esac
}
rand_extra() {  # $1 = earliest drop end (s from now) ; sets WS DE TK
  WS=$WA; DE=0; TK=0
  if [ $(rnd 3) = 0 ]; then WS=$(( WA * (2 + $(rnd 2)) )); DE=$(( $(date +%s) + $1 + $(rnd 300) )); fi
  case $(rnd 4) in 0) TK="0x$THEX";; 1) TK="0x$SHEX";; esac
}
new_lot_after() { sync_lots; }   # new lots are picked up from the factory's counter
lot_state() { lot_json "$1" getStatus | jget state; }
random_lot() {  # $1 = wanted state (0 open, 3 awaiting, any) -> hex or ""
  local cand=() l s
  for l in "${LOTS[@]}"; do s=$(lot_state "$l"); { [ "$1" = any ] || [ "$s" = "$1" ]; } && cand+=("$l"); done
  [ ${#cand[@]} -gt 0 ] && pick "${cand[@]}" || echo ""
}

act_open_listing() {
  rand_terms; rand_extra 1000
  local b dl; b=$(lot_count); dl=$(( $(date +%s) + 1500 + $(rnd 600) ))
  echo "  open listing: give $GA of #$GI for $WA of #$WI (start $WS, dropEnd $DE, taker ${TK:0:10})"
  tvm-cli -j call "$FA" openListing "{\"key\":\"$RANDOM$RANDOM\",\"giveId\":$GI,\"giveAmount\":\"$GA\",\"wantId\":$WI,\"wantAmount\":\"$WA\",\"deadline\":\"$dl\",\"wantStart\":\"$WS\",\"dropEnd\":\"$DE\",\"takerId\":\"$TK\"}" --abi "$FACT_ABI" 2>&1 | grep -oE '"exit_code":[^,]*' | head -1
  sleep 18; new_lot_after "$b"
}
act_create_lot() {
  rand_terms; rand_extra 30
  local b dl p; b=$(lot_count); dl=$(( $(date +%s) + 150 + $(rnd 450) ))
  [ "$DE" != 0 ] && [ "$DE" -gt "$dl" ] && DE=$(( dl - 10 ))
  echo "  createLot by M: give $GA of #$GI for $WA of #$WI (start $WS, dropEnd $DE, taker ${TK:0:10}, deadline +$(( dl - $(date +%s) ))s)"
  p=$(body createLot "{\"giveId\":$GI,\"wantId\":$WI,\"wantAmount\":\"$WA\",\"deadline\":\"$dl\",\"makerDapp\":\"0x$MHEX\",\"wantStart\":\"$WS\",\"dropEnd\":\"$DE\",\"takerId\":\"$TK\"}" "$FACT_ABI")
  wsend "$MKEYS" "$MHEX" "$FHEX" "$(pick true false)" "{\"$GI\":\"$GA\"}" 1 "$p"
  sleep 20; new_lot_after "$b"
}
act_fund() {
  local l; l=$(random_lot 3); [ -z "$l" ] && { act_open_listing; return; }
  local tm gi ga who amt b; tm=$(lot_json "$l" getTerms); gi=$(echo "$tm" | jget giveId); ga=$(echo "$tm" | jget giveAmount)
  who=$(pick "$MHEX" "$MHEX" "$MHEX" "$SHEX"); amt=$ga
  case $(rnd 4) in 0) amt=$(( ga - $(unit "$gi") ));; 1) amt=$(( ga + $(unit "$gi") ));; esac
  b=$(pick true false)
  echo "  fund $l by $(name_of "$who"): $amt of #$gi (needs $ga), bounce $b"
  wsend "$(keys_of "$who")" "$who" "$l" "$b" "{\"$gi\":\"$amt\"}" 1 "$EMPTY_CELL"; TOUCHED+=("$l"); sleep 20
}
act_take() {
  local l; l=$(random_lot 0); [ -z "$l" ] && { act_create_lot; return; }
  local tm of gi wi price who cur amt flag b
  tm=$(lot_json "$l" getTerms); of=$(lot_json "$l" getOffer)
  gi=$(echo "$tm" | jget giveId); wi=$(echo "$tm" | jget wantId); price=$(echo "$of" | jget priceNow)
  [[ "$price" =~ ^[0-9]+$ ]] || price=$(echo "$tm" | jget wantAmount)
  who=$(pick "$THEX" "$THEX" "$SHEX"); cur=$wi; amt=$price; flag=1; b=$(pick true false)
  case $(rnd 6) in
    0) amt=$(( price - 1 ));;                                  # underpay by one smallest unit
    1) amt=$(( price + price / 10 + 1 ));;                     # overpay: change comes back
    2) cur=$gi; amt=$(( $(unit "$gi") ));;                     # wrong currency
    3) [ "$wi" = 2 ] && { flag=16; b=true; };;                 # flag-16 SHELL (bounceable: comes back as SHELL)
  esac
  [ "$amt" -lt 1 ] && amt=1
  echo "  take $l by $(name_of "$who"): $amt of #$cur (price $price of #$wi), flag $flag, bounce $b"
  wsend "$(keys_of "$who")" "$who" "$l" "$b" "{\"$cur\":\"$amt\"}" "$flag" "$EMPTY_CELL"; TOUCHED+=("$l"); sleep 22
}
act_cancel() {
  local l; l=$(random_lot 0); [ -z "$l" ] && return
  local tm mk gi wi cur keys; tm=$(lot_json "$l" getTerms); mk=$(echo "$tm" | jget maker); mk=${mk#0:}
  gi=$(echo "$tm" | jget giveId); wi=$(echo "$tm" | jget wantId); keys=$(keys_of "$mk"); [ -z "$keys" ] && return
  cur=$(pick "$gi" "$wi")
  echo "  cancel $l by its maker $(name_of "$mk") with 1 unit of #$cur"
  wsend "$keys" "$mk" "$l" "$(pick true false)" "{\"$cur\":\"$(unit "$cur")\"}" 1 "$EMPTY_CELL"; TOUCHED+=("$l"); sleep 20
}
act_keeper() {
  local l; l=$(random_lot any); [ -z "$l" ] && return
  local fn; fn=$(pick reclaim close release release)
  if [ "$fn" = release ]; then
    local who; who=$(pick "$MHEX" "$THEX" "$SHEX")
    echo "  unsigned release($(name_of "$who")) on $l: $(ext_lot "$l" release "{\"owner\":\"0:$who\"}")"
  else
    echo "  unsigned $fn on $l: $(ext_lot "$l" "$fn" '{}')"
  fi
  TOUCHED+=("$l"); sleep 18
}
act_reject_toggle() {
  local who; who=$(pick "$THEX" "$SHEX"); local v=true
  if [ "$who" = "$THEX" ]; then [ $REJ_T = 1 ] && v=false; REJ_T=$([ $v = true ] && echo 1 || echo 0)
  else [ $REJ_S = 1 ] && v=false; REJ_S=$([ $v = true ] && echo 1 || echo 0); fi
  echo "  $(name_of "$who") now refuses payments: $v"
  tvm-cli -j call "$who::$who" setRejecting "{\"value\":$v}" --abi "$WAL_ABI" --sign "$(keys_of "$who")" >/dev/null; sleep 12
}

# =====================================================================
for ((STEP = 1; STEP <= STEPS; STEP++)); do
  TOUCHED=()
  case $(rnd 20) in
    0|1|2) a=act_open_listing;; 3|4|5) a=act_create_lot;; 6|7|8) a=act_fund;; 9|10|11|12|13) a=act_take;;
    14|15) a=act_cancel;; 16|17) a=act_keeper;; *) a=act_reject_toggle;;
  esac
  say "step $STEP/$STEPS: ${a#act_}"
  $a
  if (( STEP % 10 == 0 )); then check_all all; else check_all "${TOUCHED[@]}"; fi
  echo "  invariants so far: PASS=$PASS FAIL=$FAIL"
done

say "wind-down: everyone accepts payments, makers cancel open lots, owed coins are released"
for W in "$THEX" "$SHEX"; do tvm-cli -j call "$W::$W" setRejecting '{"value":false}' --abi "$WAL_ABI" --sign "$(keys_of "$W")" >/dev/null; done
sleep 12
for l in "${LOTS[@]}"; do
  [ "$(lot_state "$l")" = 0 ] || continue
  tm=$(lot_json "$l" getTerms); mk=$(echo "$tm" | jget maker); mk=${mk#0:}; gi=$(echo "$tm" | jget giveId); k=$(keys_of "$mk")
  [ -n "$k" ] && wsend "$k" "$mk" "$l" true "{\"$gi\":\"$(unit "$gi")\"}" 1 "$EMPTY_CELL"
done
sleep 30
for l in "${LOTS[@]}"; do for W in "$MHEX" "$THEX" "$SHEX"; do
  og=$(tvm-cli -j run "$FHEX::$l" getOwed "{\"owner\":\"0:$W\"}" --abi "$SWAP_ABI" 2>/dev/null)
  [ "$(echo "$og" | jget give)$(echo "$og" | jget want)" = "00" ] || { echo "  release owed of $(name_of "$W") on $l: $(ext_lot "$l" release "{\"owner\":\"0:$W\"}")"; }
done; done
sleep 30
STEP=end
check_all all
say "end: no lot created here may still hold coins (awaiting, filled, cancelled or closed)"
for l in "${LOTS[@]}"; do
  s=$(lot_state "$l"); read _ _ bn bs bu <<< "$(balances "$l:$FHEX")"
  if [ "$s" = 0 ]; then fail "lot $l still OPEN after its maker cancelled"; elif [ "$bn$bs$bu" = "000" ]; then pass; else fail "lot $l (state $s) still holds NACKL $bn SHELL $bs USDC $bu"; fi
done

say "DONE  seed $SEED, $STEPS steps, ${#LOTS[@]} lots  PASS=$PASS FAIL=$FAIL WARN=$WARN (unreadable at the time, re-checked in later sweeps)"
[ "$FAIL" = 0 ]
