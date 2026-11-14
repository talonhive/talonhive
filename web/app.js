// TalonHive Swap web app: reads lots straight from the chain (no backend) and guides pay-to-take.
// The page never asks for keys or seed phrases and never holds coins.
import {
  NETWORKS, DEFAULT_NETWORK, CURRENCIES, PAIRS, FEE_BPS, MAX_TTL_SECONDS, EVENTS_TO_SCAN, POLL_MS, ABI,
} from "./config.js";
import { decodeEvent, encodeCallBody, functionSignature, eventSignature, parseBoc, Slice } from "./boc.js";
import { openListing } from "./send.js";

const net = NETWORKS[DEFAULT_NETWORK];
const HEX64 = /^[0-9a-f]{64}$/;
// ?factory=<hex64> previews another test factory (e.g. right after a test-suite run); otherwise config.js.
const override = (new URLSearchParams(location.search).get("factory") || "").toLowerCase();
const F = HEX64.test(override) ? override : net.factory;
const TEST = !!net.test;              // test network: banner, "test" labels, no real-wallet instructions

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let IDS = {};
let lots = [];
let loaded = false;
let pairIdx = 0;
let tab = "asks";

// ---------- storage (per-viewer convenience only) ----------
const store = {
  get(k) { try { return localStorage.getItem("ns:" + k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem("ns:" + k, v); } catch { /* private mode */ } },
};

// ---------- chain ----------
async function abiId(sig) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sig));
  return new DataView(h).getUint32(0) & 0x7fffffff;
}
async function gql(query) {
  const r = await fetch(net.graphql, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error("network error " + r.status);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
async function fetchLots() {
  const d = await gql(`{ blockchain { account(account_id:"${F}", dapp_id:"${F}") {
    messages(msg_type:[ExtOut], last:${EVENTS_TO_SCAN}) { edges { node { body created_at } } } } } }`);
  const out = [];
  for (const { node } of d?.blockchain?.account?.messages?.edges || []) {
    if (!node.body) continue;
    let e;
    try { e = decodeEvent(node.body, ABI.LotCreated, IDS.LotCreated); } catch { continue; }
    if (!e) continue;                                   // other factory events (Refunded)
    const lot = e.lot.split(":")[1];
    if (!HEX64.test(lot)) continue;
    out.push({
      lot, nonce: e.nonce.toString(), maker: e.maker, giveId: Number(e.giveId), giveAmount: e.giveAmount, wantId: Number(e.wantId),
      wantAmount: e.wantAmount, deadline: Number(e.deadline), createdAt: node.created_at, status: "…", held: 0n,
      // Drop and private terms (docs/PRIVATE_AND_DROP.md). Fixed price: wantStart == wantAmount.
      wantStart: e.wantStart, dropEnd: Number(e.dropEnd), takerId: e.takerId ? e.takerId.toString(16).padStart(64, "0") : "",
    });
  }
  return out;
}
/** The ListingOpened event with this key (the page chose it when sending openListing), or null. */
async function findListing(key) {
  const d = await gql(`{ blockchain { account(account_id:"${F}", dapp_id:"${F}") {
    messages(msg_type:[ExtOut], last:50) { edges { node { body } } } } } }`);
  for (const { node } of d?.blockchain?.account?.messages?.edges || []) {
    if (!node.body) continue;
    let e;
    try { e = decodeEvent(node.body, ABI.ListingOpened, IDS.ListingOpened); } catch { continue; }
    if (e && e.key === key) return { ...e, lot: e.lot.split(":")[1] };
  }
  return null;
}
async function fetchStatuses(list) {
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const q = chunk.map((l, k) => `a${k}: account(account_id:"${l.lot}", dapp_id:"${F}") {
      info { acc_type balance_other { currency value(format:DEC) } } }`).join("\n");
    const d = await gql(`{ blockchain { ${q} } }`);
    const now = Date.now() / 1000;
    chunk.forEach((l, k) => {
      const info = d.blockchain[`a${k}`]?.info;
      if (!info || info.acc_type !== 1) { l.status = "closed"; return; }
      const bal = (info.balance_other || []).find((x) => Number(x.currency) === l.giveId);
      l.held = bal ? BigInt(bal.value) : 0n;
      l.status = l.held >= l.giveAmount ? (now < l.deadline ? "open" : "expired") : "settled";
    });
  }
  await fetchOutcomes(list);
}

// A finished lot was either filled or cancelled; its own Filled / Reclaimed event says which, and when. Filled
// also carries the buyer and the fee, which give the real trade price (a drop offer fills below its start).
// Final, so cached.
const outcomes = new Map();   // lot hex -> { kind: "filled" | "cancelled", at, taker?, fee?, price? }
async function fetchOutcomes(list) {
  const todo = list.filter((l) => (l.status === "settled" || l.status === "closed") && !outcomes.has(l.lot)).slice(0, 60);
  for (let i = 0; i < todo.length; i += 20) {
    const chunk = todo.slice(i, i + 20);
    const q = chunk.map((l, k) => `b${k}: account(account_id:"${l.lot}", dapp_id:"${F}") {
      messages(msg_type:[ExtOut], last:6) { edges { node { body created_at } } } }`).join("\n");
    let d;
    try { d = await gql(`{ blockchain { ${q} } }`); } catch { break; }   // labels can wait for the next refresh
    chunk.forEach((l, k) => {
      for (const { node } of d.blockchain[`b${k}`]?.messages?.edges || []) {
        let id;
        try { id = Number(new Slice(parseBoc(node.body)).uint(32)); } catch { continue; }
        if (id === IDS.Filled) {
          let e = null; try { e = decodeEvent(node.body, ABI.Filled, IDS.Filled); } catch { /* keep the label */ }
          // The lot charged fee = price × 1%, so price ≈ fee / 1% (within 99 base units), kept between the floor and paid.
          let price = l.wantAmount;
          if (e && isDrop(l) && FEE_BPS > 0n) {
            price = (e.fee * 10000n) / FEE_BPS;
            if (price > e.paid) price = e.paid;
            if (price < l.wantAmount) price = l.wantAmount;
          }
          outcomes.set(l.lot, { kind: "filled", at: node.created_at, taker: e?.taker || "", fee: e ? e.fee : (l.wantAmount * FEE_BPS) / 10000n, price });
          break;
        }
        if (id === IDS.Reclaimed) { outcomes.set(l.lot, { kind: "cancelled", at: node.created_at }); break; }
      }
    });
  }
  for (const l of list) {
    const o = outcomes.get(l.lot);
    l.outcome = o?.kind || ""; l.closedAt = o?.at || 0; l.taker = o?.taker || ""; l.fee = o?.fee ?? 0n; l.fillPrice = o?.price ?? 0n;
  }
}

// ---------- numbers ----------
function fmt(v, dec, maxFrac = 4) {
  const base = 10n ** BigInt(dec);
  const int = (v / base).toLocaleString("en-US");
  const frac = (v % base).toString().padStart(dec, "0").slice(0, maxFrac).replace(/0+$/, "");
  return int + (frac ? "." + frac : "");
}
function parseUnits(str, dec) {
  // Phone keyboards add spaces ("0. 005") and some use a comma as the decimal point ("0,005"). A single comma
  // is a decimal point unless it reads as a thousands group ("1,000" or "12,500"); never guess "0,005" = 5.
  let s = String(str).replace(/\s+/g, "");
  if (!s.includes(".") && /^\d+,\d+$/.test(s) && !/^[1-9]\d{0,2},\d{3}$/.test(s)) s = s.replace(",", ".");
  s = s.replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter a number");
  const [i, f = ""] = s.split(".");
  if (f.length > dec) throw new Error(`At most ${dec} decimals`);
  return BigInt(i) * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec));
}
const sym = (id) => CURRENCIES[id]?.sym || `#${id}`;
const dec = (id) => CURRENCIES[id]?.dec ?? 9;
const amt = (v, id) => `${fmt(v, dec(id))} ${sym(id)}`;
const pair = () => PAIRS[pairIdx];
const onPair = (p = pair()) => lots.filter((l) => (l.giveId === p.base && l.wantId === p.quote) || (l.giveId === p.quote && l.wantId === p.base));
// Drop offers: the same straight line as AtomicSwap._price(). The drop starts when the lot opened; the page
// knows that only to within seconds (LotCreated's time), so what it asks a buyer to pay is the price a minute
// earlier (wantToPay): never below the lot's own price, and the lot returns any extra as change.
const isDrop = (l) => l.wantStart > l.wantAmount;
function wantNow(l, now = Date.now() / 1000) {
  if (!isDrop(l) || l.dropEnd <= l.createdAt || now >= l.dropEnd) return l.wantAmount;
  if (now <= l.createdAt) return l.wantStart;
  return l.wantStart - ((l.wantStart - l.wantAmount) * BigInt(Math.floor(now - l.createdAt))) / BigInt(l.dropEnd - l.createdAt);
}
const wantToPay = (l) => wantNow(l, Date.now() / 1000 - 60);
function priceOf(l, p = pair()) {
  const b = 10n ** BigInt(dec(p.base));
  const want = l.status === "open" ? wantNow(l) : l.wantAmount;
  return l.giveId === p.base ? (want * b) / l.giveAmount : (l.giveAmount * b) / want;
}
// Private offers (takerId) stay out of the public market: shown to their seller, their named buyer (when the
// optional wallet address in My offers matches) and anyone who opened the offer's share link (?offer=<lot>).
const linkedLot = (new URLSearchParams(location.search).get("offer") || "").toLowerCase().replace(/^0:/, "");
const visible = (l) => !l.takerId || mineLot(l) || l.takerId === myAccount() || l.lot === linkedLot;
const asksOf = (p = pair()) => onPair(p).filter((l) => l.status === "open" && l.giveId === p.base && visible(l)).sort((a, b) => (priceOf(a, p) < priceOf(b, p) ? -1 : 1));
const bidsOf = (p = pair()) => onPair(p).filter((l) => l.status === "open" && l.giveId === p.quote && visible(l)).sort((a, b) => (priceOf(a, p) > priceOf(b, p) ? -1 : 1));
/** Account id (hex64) from "dapp::account", "0:hex" or bare hex; "" if it isn't one. */
function accountOf(str) {
  const m = String(str || "").trim().toLowerCase().match(/^(?:[0-9a-f]{64}::|0:)?([0-9a-f]{64})$/);
  return m ? m[1] : "";
}
function timeLeft(deadline) {
  const s = Math.floor(deadline - Date.now() / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86400) return `${Math.floor(s / 3600)} h left`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h left`;
}
function ago(ts) {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`;
}
const short = (hex) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;
/** "2 h 14 min", "45 min", "under a minute": time until ts. */
function until(ts) {
  const s = Math.floor(ts - Date.now() / 1000);
  if (s < 60) return "under a minute";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
// The outcome card's drop line: where the price is now, where it ends, how long until then, and progress (0–100).
function dropState(l) {
  const now = Date.now() / 1000;
  if (now >= l.dropEnd) return { text: `At its lowest price: ${amt(l.wantAmount, l.wantId)}.`, pct: 100 };
  const pct = Math.max(0, Math.min(100, ((now - l.createdAt) / Math.max(1, l.dropEnd - l.createdAt)) * 100));
  const when = new Date(l.dropEnd * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return { text: `Price falling: started at ${amt(l.wantStart, l.wantId)}, reaches ${amt(l.wantAmount, l.wantId)} at ${when} (in ${until(l.dropEnd)}).`, pct };
}

// ---------- friendly names (no raw addresses in front of people) ----------
// A stable nickname derived from the wallet address: same wallet, same name; reveals nothing about the owner.
const ADJ = ["Amber", "Azure", "Bold", "Brave", "Bright", "Calm", "Clever", "Coral", "Crimson", "Swift", "Gentle", "Golden",
  "Jade", "Keen", "Lucky", "Lunar", "Mellow", "Misty", "Noble", "Ocean", "Quiet", "Royal", "Ruby", "Sage", "Silver", "Solar",
  "Steady", "Sunny", "Velvet", "Vivid", "Wise", "Zesty"];
const ANIMAL = ["Heron", "Falcon", "Otter", "Lynx", "Panda", "Fox", "Owl", "Dolphin", "Tiger", "Koala", "Raven", "Bison",
  "Gecko", "Ibis", "Jaguar", "Lemur", "Marten", "Narwhal", "Orca", "Puffin", "Quokka", "Robin", "Seal", "Toucan", "Kestrel",
  "Walrus", "Yak", "Zebra", "Badger", "Crane", "Egret", "Hare"];
const acct = (addr) => String(addr).replace(/^.*[:]/, "").toLowerCase();
function myAccount() { const m = store.get("wallet").toLowerCase().match(/([0-9a-f]{64})$/); return m ? m[1] : ""; }
const isMine = (addr) => { const me = myAccount(); return !!me && acct(addr) === me; };
// Offers prepared in this browser, remembered by their exact terms (the deadline is to the second), so
// "My offers" works without ever asking for a wallet address. Local to this browser only.
function prepared() { try { return JSON.parse(store.get("prepared") || "[]"); } catch { return []; } }
function rememberPrepared(t) { const list = [t, ...prepared()].slice(0, 50); store.set("prepared", JSON.stringify(list)); }
const termsKey = (giveId, giveAmount, wantId, wantAmount, deadline) => `${giveId}:${giveAmount}:${wantId}:${wantAmount}:${deadline}`;
const mineLot = (l) => isMine(l.maker)
  || prepared().includes(termsKey(l.giveId, l.giveAmount, l.wantId, l.wantAmount, l.deadline));
function nickname(addr) {
  const h = acct(addr);
  return `${ADJ[parseInt(h.slice(0, 8), 16) % ADJ.length]} ${ANIMAL[parseInt(h.slice(8, 16), 16) % ANIMAL.length]}`;
}
function person(addr, mine = isMine(addr)) {
  const name = mine ? "You" : nickname(addr);
  const hue = parseInt(acct(addr).slice(16, 20), 16) % 360;
  return `<span class="person"><span class="avatar" style="background:hsl(${hue} 65% 62%)">${esc(name[0])}</span>${esc(name)}</span>`;
}
const coin = (id, cls = "") => `<span class="coin c${id} ${cls}">${esc(sym(id)[0])}</span>`;

// ---------- icons ----------
const ICON = {
  chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>`,
  right: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>`,
  share: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex:none;margin-top:1px"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/><path d="M12 8v4M12 16h.01"/></svg>`,
};

// ---------- home ----------
function renderHome() {
  const p = pair();
  const asks = asksOf(p), bids = bidsOf(p);
  $("#pair-chip").innerHTML = `<span class="chip-coins">${coin(p.base)}${coin(p.quote)}</span>${sym(p.base)} / ${sym(p.quote)} ${ICON.chev}`;
  $("#buy-sub").textContent = sym(p.base);
  $("#sell-sub").textContent = sym(p.base);
  $("#hero-unit").textContent = `${sym(p.quote)} / ${sym(p.base)}`;
  if (!loaded) return;
  if (asks.length) {
    $("#hero-label").textContent = `Best price to buy ${sym(p.base)}`;
    $("#hero-price").textContent = fmt(priceOf(asks[0], p), dec(p.quote), 6);
  } else if (bids.length) {
    $("#hero-label").textContent = `Best price to sell ${sym(p.base)}`;
    $("#hero-price").textContent = fmt(priceOf(bids[0], p), dec(p.quote), 6);
  } else {
    $("#hero-label").textContent = "No open offers yet";
    $("#hero-price").textContent = "—";
  }
  const forSale = asks.reduce((a, l) => a + l.giveAmount, 0n);
  $("#hero-sub").innerHTML = asks.length || bids.length
    ? `<b>${fmt(forSale, dec(p.base), 0)} ${sym(p.base)}</b> for sale in ${asks.length} offer${asks.length === 1 ? "" : "s"} · ${bids.length} buyer${bids.length === 1 ? "" : "s"}`
    : `Be the first: tap <b>List</b> to set your price.`;

  // other markets peek out behind the card
  const others = PAIRS.map((q, i) => ({ q, i })).filter(({ i }) => i !== pairIdx).slice(0, 2);
  $("#stack").innerHTML = others.map(({ q, i }) => {
    const a = asksOf(q)[0];
    return `<button data-i="${i}" aria-label="Switch to ${sym(q.base)} / ${sym(q.quote)}"><span>${sym(q.base)} / ${sym(q.quote)}</span><b>${a ? fmt(priceOf(a, q), dec(q.quote), 6) : "no offers"}</b></button>`;
  }).join("");
  if (others.length === 1) $("#stack").insertAdjacentHTML("afterbegin", `<button tabindex="-1" aria-hidden="true" style="pointer-events:none"></button>`);
  $$("#stack button[data-i]").forEach((b) => b.addEventListener("click", () => setPair(Number(b.dataset.i))));
  renderStats();
  renderChart();
  renderRows();
}

function setPair(i) { pairIdx = i; renderHome(); }
const SORTS = [["best", "Best price"], ["new", "Newest"], ["ending", "Ending soon"], ["big", "Biggest"]];
let sortBy = SORTS.some(([v]) => v === store.get("sort")) ? store.get("sort") : "best";

function renderRows() {
  const p = pair();
  const el = $("#rows");
  let list;
  if (tab === "asks") list = asksOf(p);
  else if (tab === "bids") list = bidsOf(p);
  else list = onPair(p).filter(visible).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  const bestLot = tab === "recent" ? null : list[0];
  // Sort chips (open offers only): best price first is the default.
  const so = $("#sorts");
  so.hidden = tab === "recent" || list.length < 2;
  so.innerHTML = SORTS.map(([v, t]) => `<button type="button" data-sort="${v}" aria-pressed="${sortBy === v}">${t}</button>`).join("");
  $$("[data-sort]", so).forEach((b) => b.addEventListener("click", () => { sortBy = b.dataset.sort; store.set("sort", sortBy); renderRows(); }));
  if (tab !== "recent" && sortBy !== "best") {
    const size = (l) => (l.giveId === p.base ? l.giveAmount : l.wantAmount);
    list = [...list].sort({
      new: (a, b) => b.createdAt - a.createdAt,
      ending: (a, b) => a.deadline - b.deadline,
      big: (a, b) => (size(b) > size(a) ? 1 : size(b) < size(a) ? -1 : 0),
    }[sortBy] || (() => 0));
  }
  if (!list.length) {
    const msg = {
      asks: [`No ${sym(p.base)} for sale right now`, `List yours and set the price.`, "List an offer"],
      bids: [`No one is buying ${sym(p.base)} right now`, `Create a buy offer with ${sym(p.quote)}.`, "Create a buy offer"],
      recent: ["Nothing here yet", "Offers appear here as soon as they are on chain.", "List an offer"],
    }[tab];
    el.innerHTML = `<li class="empty-state"><b>${esc(msg[0])}</b>${esc(msg[1])}<br><button class="btn ghost" id="empty-cta">${esc(msg[2])}</button></li>`;
    $("#empty-cta").addEventListener("click", () => openSheet(viewList({ side: tab === "bids" ? "buy" : "sell" })));
    return;
  }
  el.innerHTML = list.map((l) => rowHtml(l, p, l === bestLot)).join("");
  $$(".row", el).forEach((r) => r.addEventListener("click", () => openSheet(viewTake(r.dataset.lot))));
}

function rowHtml(l, p, best) {
  const sellsBase = l.giveId === p.base;
  const want = l.status === "open" ? wantNow(l) : l.wantAmount;
  const baseAmt = sellsBase ? l.giveAmount : want;
  const quoteAmt = sellsBase ? want : l.giveAmount;
  const statusTag = {
    open: sellsBase ? `<span class="tag buy">Buy</span>` : `<span class="tag sell">Sell</span>`,
    expired: `<span class="tag exp">Expired</span>`,
    settled: `<span class="tag done">${{ filled: "Filled", cancelled: "Cancelled" }[l.outcome] || "Done"}</span>`,
    closed: `<span class="tag done">${{ filled: "Filled", cancelled: "Cancelled" }[l.outcome] || "Done"}</span>`,
  }[l.status] || "";
  const sub = (mineLot(l) ? "Your offer · " : "") + (l.takerId ? "Private · " : "")
    + (isDrop(l) && l.status === "open" ? (Date.now() / 1000 < l.dropEnd ? "Dropping · " : "At its lowest · ") : "")
    + (l.status === "open"
    ? `${sellsBase ? "for" : "wants"} ${amt(quoteAmt, p.quote)} · ${timeLeft(l.deadline)}`
    : `${amt(quoteAmt, p.quote)} · ${ago(l.createdAt)}`);
  return `<li class="row" data-lot="${l.lot}" tabindex="0" role="button" aria-label="${sellsBase ? "Buy" : "Sell"} ${fmt(baseAmt, dec(p.base))} ${sym(p.base)}">
    <span class="coins">${coin(sellsBase ? p.base : p.quote)}${coin(sellsBase ? p.quote : p.base)}</span>
    <span class="row-main"><b>${fmt(baseAmt, dec(p.base))} ${sym(p.base)}${best ? `<span class="best">Best</span>` : ""}</b><span>${esc(sub)}</span></span>
    <span class="row-end"><b>${fmt(priceOf(l, p), dec(p.quote), 6)}</b><small>${sym(p.quote)} each</small><br>${statusTag}</span></li>`;
}

// ---------- trades, stats, chart ----------
// Everything here comes from the newest EVENTS_TO_SCAN offers this page reads from the chain (no backend).
const pairOf = (l) => PAIRS.find((x) => [x.base, x.quote].includes(l.giveId) && [x.base, x.quote].includes(l.wantId));
/** Price in quote per base for this lot when it costs `want`. */
const px = (l, p, want) => { const b = 10n ** BigInt(dec(p.base)); return l.giveId === p.base ? (want * b) / l.giveAmount : (l.giveAmount * b) / want; };
const tradePrice = (l, p) => px(l, p, l.fillPrice || l.wantAmount);
const tradeBase = (l, p) => (l.giveId === p.base ? l.giveAmount : (l.fillPrice || l.wantAmount));
const tradeQuote = (l, p) => (l.giveId === p.base ? (l.fillPrice || l.wantAmount) : l.giveAmount);
const tradesOf = (p = pair()) => onPair(p).filter((l) => l.outcome === "filled" && l.closedAt).sort((a, b) => a.closedAt - b.closedAt);
const who = (addr, mine = isMine(addr)) => (mine ? "You" : addr ? nickname(addr) : "Someone");

function statsOf(p) {
  const t = tradesOf(p), now = Date.now() / 1000;
  const last = t.at(-1);
  const before = [...t].reverse().find((l) => l.closedAt <= now - 86400);
  const day = t.filter((l) => l.closedAt > now - 86400);
  let change = null;
  if (last && before) { const a = Number(tradePrice(before, p)), b = Number(tradePrice(last, p)); if (a) change = ((b - a) / a) * 100; }
  return { last, change, vol: day.reduce((a, l) => a + tradeBase(l, p), 0n), trades: day.length };
}
function feesTotal() {
  const m = new Map();
  for (const l of lots) if (l.outcome === "filled") m.set(l.wantId, (m.get(l.wantId) || 0n) + l.fee);
  return m;
}
function renderStats() {
  const p = pair(), s = statsOf(p), fees = feesTotal();
  const cell = (k, v, cls = "", title = "") => `<div${title ? ` title="${esc(title)}"` : ""}><span>${k}</span><b class="${cls}">${v}</b></div>`;
  $("#stats").innerHTML =
    cell("Last trade", s.last ? `${fmt(tradePrice(s.last, p), dec(p.quote), 6)} <small>${sym(p.quote)}</small>` : "—") +
    cell("24h change", s.change === null ? "—" : `${s.change >= 0 ? "+" : "−"}${Math.abs(s.change).toFixed(1)}%`, s.change === null ? "" : s.change >= 0 ? "up" : "down") +
    cell("24h volume", `${fmt(s.vol, dec(p.base), 0)} <small>${sym(p.base)}</small>`, "", `${s.trades} trade${s.trades === 1 ? "" : "s"} in the last 24 hours`) +
    cell("Fees to treasury", fees.size ? [...fees].map(([id, v]) => `${fmt(v, dec(id), 2)} <small>${sym(id)}</small>`).join(" · ") : "—", "",
      "The 1% fee from filled offers, all markets. It goes to the TalonHive treasury to keep the project running.");
}

function renderChart() {
  const p = pair(), el = $("#chart");
  const t = tradesOf(p).slice(-40), asks = asksOf(p), bids = bidsOf(p);
  const head = `<div class="chart-head"><b>Price</b><span>${sym(p.quote)} per ${sym(p.base)}</span></div>`;
  if (!t.length && !asks.length && !bids.length) { el.innerHTML = head + `<p class="chart-empty">The chart starts with the first trade.</p>`; return; }
  // Drawn at its real width (one unit = one pixel) so labels stay readable on phones.
  const W = Math.max(280, Math.round(el.clientWidth - 32) || 600), H = 170, L = 6, R = 78, T = 14, B = 24;
  const pts = t.map((l) => ({ x: l.closedAt, y: Number(tradePrice(l, p)), l }));
  const askY = asks.slice(0, 6).map((l) => Number(priceOf(l, p))), bidY = bids.slice(0, 6).map((l) => Number(priceOf(l, p)));
  const ys = [...pts.map((q) => q.y), ...askY, ...bidY];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi = hi * 1.1 || 1; lo = lo * 0.9; }
  const padY = (hi - lo) * 0.14; lo = Math.max(0, lo - padY); hi += padY;
  const now = Date.now() / 1000, x0 = pts.length ? Math.min(pts[0].x, now - 3600) : now - 86400;
  const X = (x) => L + ((x - x0) / (now - x0)) * (W - L - R), Y = (y) => T + ((hi - y) / (hi - lo)) * (H - T - B);
  const lbl = (v) => fmt(BigInt(Math.round(v)), dec(p.quote), 6);
  const when = (s) => new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const line = pts.length > 1 ? `<path class="c-line" d="${pts.map((q, i) => `${i ? "L" : "M"}${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`).join(" ")}"/>` : "";
  const level = (y, cls, text) => `<line class="${cls}" x1="${L}" x2="${W - R + 4}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/>
    <text class="c-tag ${cls}" x="${W - R + 8}" y="${(Y(y) + 4).toFixed(1)}">${text}</text>`;
  const ticks = (list, cls) => list.slice(1).map((y) => `<line class="${cls} tick" x1="${W - R - 10}" x2="${W - R + 2}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/>`).join("");
  el.innerHTML = head + `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recent trade prices with the cheapest offer for sale and the best buyer">
      <line class="c-axis" x1="${L}" x2="${W - R + 4}" y1="${H - B}" y2="${H - B}"/>
      ${bidY.length ? level(bidY[0], "c-bid", lbl(bidY[0])) + ticks(bidY, "c-bid") : ""}
      ${askY.length ? level(askY[0], "c-ask", lbl(askY[0])) + ticks(askY, "c-ask") : ""}
      ${line}
      ${pts.map((q) => `<g class="c-pt" data-lot="${q.l.lot}" tabindex="0" role="button" aria-label="Trade at ${lbl(q.y)}, ${when(q.x)}"><circle class="c-hit" cx="${X(q.x).toFixed(1)}" cy="${Y(q.y).toFixed(1)}" r="12"/><circle class="c-dot" cx="${X(q.x).toFixed(1)}" cy="${Y(q.y).toFixed(1)}" r="4"/><title>${lbl(q.y)} ${sym(p.quote)} · ${when(q.x)}</title></g>`).join("")}
      <text class="c-time" x="${L}" y="${H - 6}">${pts.length ? when(x0) : "24 h ago"}</text>
      <text class="c-time" x="${W - R}" y="${H - 6}" text-anchor="end">now</text>
    </svg>
    <div class="chart-legend"><span><i class="lg-trade"></i>Trades</span>${askY.length ? `<span><i class="lg-ask"></i>Cheapest for sale</span>` : ""}${bidY.length ? `<span><i class="lg-bid"></i>Best buyer</span>` : ""}${!pts.length ? `<span>No trades yet</span>` : ""}</div>`;
  $$(".c-pt", el).forEach((g) => {
    const open = () => openSheet(viewProof(g.dataset.lot));
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// ---------- activity (every offer and trade, like a block explorer for the Swap) ----------
function activityEvents() {
  const ev = [];
  for (const l of lots) {
    if (!visible(l) || !pairOf(l)) continue;
    ev.push({ kind: "listed", at: l.createdAt, l });
    if (l.closedAt && (l.outcome === "filled" || l.outcome === "cancelled")) ev.push({ kind: l.outcome, at: l.closedAt, l });
  }
  return ev.sort((a, b) => b.at - a.at);
}
function eventRow(e) {
  const l = e.l, p = pairOf(l), sellsBase = l.giveId === p.base, maker = who(l.maker, mineLot(l));
  const filled = e.kind === "filled";
  const base = filled ? tradeBase(l, p) : sellsBase ? l.giveAmount : l.wantAmount;
  const price = filled ? tradePrice(l, p) : px(l, p, l.wantAmount);
  const taker = who(l.taker);
  const [tag, main, sub] = {
    filled: [`<span class="tag buy">Trade</span>`, `${fmt(base, dec(p.base))} ${sym(p.base)} for ${amt(tradeQuote(l, p), p.quote)}`,
      sellsBase ? `${maker} sold to ${taker}` : `${taker} sold to ${maker}`],
    listed: [`<span class="tag open">New offer</span>`, `${sellsBase ? "Selling" : "Buying"} ${fmt(base, dec(p.base))} ${sym(p.base)}`,
      `${maker}${isDrop(l) ? " · drop offer, lowest price" : ""}${l.takerId ? " · private" : ""}`],
    cancelled: [`<span class="tag done">Cancelled</span>`, `${sellsBase ? "Selling" : "Buying"} ${fmt(base, dec(p.base))} ${sym(p.base)}`, `${maker} took it back`],
  }[e.kind];
  return `<li class="row" data-lot="${l.lot}" tabindex="0" role="button" aria-label="${esc(main)}, ${esc(sub)}. Check it on chain">
    <span class="coins">${coin(sellsBase ? p.base : p.quote)}${coin(sellsBase ? p.quote : p.base)}</span>
    <span class="row-main"><b>${esc(main)}</b><span>${esc(sub)} · ${ago(e.at)}</span></span>
    <span class="row-end"><b>${fmt(price, dec(p.quote), 6)}</b><small>${sym(p.quote)} each</small><br>${tag}</span></li>`;
}
function viewActivity() {
  let kind = "all", market = -1;
  const SHOW = 60;
  const view = {
    title: "Activity",
    html: () => `<p class="note" style="margin:0 0 12px;color:var(--ink-2)">Every offer and trade on TalonHive Swap, read straight from the blockchain. Tap one to check it yourself.</p>
      <div class="chips mini" id="act-kind"></div><div class="chips mini" id="act-market" style="margin:8px 0 6px"></div>
      <ul class="rows" id="act-rows"></ul><p class="note" id="act-note"></p>`,
    bind: (r) => view.live(r),
    live: (r) => {
      if (!$("#act-rows", r)) return;
      const all = activityEvents().filter((e) => market < 0 || pairOf(e.l) === PAIRS[market]);
      const n = (k) => all.filter((e) => e.kind === k).length;
      $("#act-kind", r).innerHTML = [["all", `All (${all.length})`], ["filled", `Trades (${n("filled")})`], ["listed", `New offers (${n("listed")})`], ["cancelled", `Cancelled (${n("cancelled")})`]]
        .map(([v, t]) => `<button type="button" data-k="${v}" aria-pressed="${kind === v}">${t}</button>`).join("");
      $("#act-market", r).innerHTML = [[-1, "All markets"], ...PAIRS.map((q, i) => [i, `${sym(q.base)} / ${sym(q.quote)}`])]
        .map(([v, t]) => `<button type="button" data-m="${v}" aria-pressed="${market === v}">${t}</button>`).join("");
      const list = all.filter((e) => kind === "all" || e.kind === kind);
      $("#act-rows", r).innerHTML = list.length ? list.slice(0, SHOW).map(eventRow).join("")
        : `<li class="empty-state"><b>Nothing here yet</b>${loaded ? "Offers and trades show up here as soon as they're on chain." : "Reading the chain…"}</li>`;
      $("#act-note", r).textContent = `${list.length > SHOW ? `Showing the newest ${SHOW}. ` : ""}From the newest ${EVENTS_TO_SCAN} offers on the TalonHive Swap factory.`;
      $$("[data-k]", r).forEach((b) => b.addEventListener("click", () => { kind = b.dataset.k; view.live(r); }));
      $$("[data-m]", r).forEach((b) => b.addEventListener("click", () => { market = Number(b.dataset.m); view.live(r); }));
      $$(".row", r).forEach((row) => row.addEventListener("click", () => push(viewProof(row.dataset.lot))));
    },
  };
  return view;
}

// ---------- how it works ----------
function viewHow() {
  return {
    title: "How it works",
    html: () => `
      <p class="note" style="margin:0 0 4px;color:var(--ink-2)">TalonHive Swap is a market for ${PAIRS.map((q) => `${sym(q.base)}/${sym(q.quote)}`).join(" and ")} with no middleman. Each offer is its own small contract on Acki Nacki.</p>
      <h4 class="proof-h">Buying</h4>
      <ol class="steps" style="margin-top:0">
        <li><span>Pick an offer. The card shows exactly what you pay and what you get.</span></li>
        <li><span>Send that amount from your Acki Nacki Wallet to the offer's address, as a normal transfer.</span></li>
        <li><span>The offer sends you the coins in the same transaction. If someone was faster, or the offer ended, your payment comes back on its own.</span></li>
      </ol>
      <h4 class="proof-h">Selling (or buying at your own price)</h4>
      <ol class="steps" style="margin-top:0">
        <li><span>Set the amount, the price and how long it stays open. A drop offer starts high and falls to your lowest price.</span></li>
        <li><span>Send your coins to the new offer, as a normal transfer. They wait in the offer's own contract, not with us.</span></li>
        <li><span>When someone takes it you're paid automatically, minus the ${Number(FEE_BPS) / 100}% fee. Until then you can cancel and get everything back.</span></li>
      </ol>
      <h4 class="proof-h">Why it's safe</h4>
      <ul class="proof">
        <li class="proof-ok">${ICON.check}<span><b>Nobody holds your coins.</b> An offer can only pay its seller, its buyer, or the ${Number(FEE_BPS) / 100}% fee. There's no admin key and no upgrade, so not even TalonHive can move them.</span></li>
        <li class="proof-ok">${ICON.check}<span><b>All or nothing.</b> You get the whole amount, or your payment comes back.</span></li>
        <li class="proof-ok">${ICON.check}<span><b>Check it yourself.</b> Every offer has a "Check this offer" page that reads the chain directly: its code, its balance, every transfer.</span></li>
        <li class="proof-ok">${ICON.check}<span><b>No keys, ever.</b> This page never asks for your seed phrase or keys, and never touches your wallet. You send every transfer yourself.</span></li>
      </ul>
      <h4 class="proof-h">Fees</h4>
      <p class="note" style="margin:0;color:var(--ink-2)">${Number(FEE_BPS) / 100}% of the price, paid by the offer's creator out of what they receive. Buyers pay exactly the price shown. Fees go to the TalonHive treasury to keep the project running.</p>
      <h4 class="proof-h">Good to know</h4>
      <p class="note" style="margin:0;color:var(--ink-2)">The contracts passed every on-chain test but haven't had an independent audit yet. Trades are public on the blockchain, like every Acki Nacki transfer; this site shows nicknames, not wallet addresses.</p>
      <button class="btn ghost block" style="margin-top:16px" id="how-activity">See every trade</button>`,
    bind: (r) => $("#how-activity", r).addEventListener("click", () => push(viewActivity())),
  };
}

// ---------- share ----------
async function shareOffer(l) {
  const url = shareLink(l.lot);
  const text = `${amt(l.giveAmount, l.giveId)} for ${amt(l.status === "open" ? wantToPay(l) : l.wantAmount, l.wantId)} on TalonHive Swap`;
  if (navigator.share) {
    try { await navigator.share({ title: "TalonHive Swap offer", text, url }); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast("Copy this link: " + url); }
}

// ---------- sheet navigation ----------
const views = [];
let current = null;
function openSheet(view) {
  views.length = 0;
  show(view);
  if (!$("#sheet").open) $("#sheet").showModal();
}
function push(view) { if (current) views.push(current); show(view); }
function back() { const v = views.pop(); if (v) show(v); }
function show(view) {
  current = view;
  $("#sheet-title").textContent = view.title;
  $("#sheet-back").hidden = views.length === 0;
  $("#sheet-body").innerHTML = view.html();
  view.bind?.($("#sheet-body"));
  $$("[data-how]", $("#sheet-body")).forEach((b) => b.addEventListener("click", () => push(viewHow())));
}
function closeSheet() { $("#sheet").close(); current = null; views.length = 0; }
function refreshSheet() { if (current?.live && $("#sheet").open) current.live($("#sheet-body")); }

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 1600);
}
function bindCopy(root) {
  $$("[data-copy]", root).forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); }
    catch { toast("Couldn't copy: select it and copy by hand"); }
  }));
  // Shortened ids expand on tap (Copy always copies the full value).
  $$("code.tap", root).forEach((c) => c.addEventListener("click", (e) => {
    e.stopPropagation();
    const full = c.dataset.open !== "1";
    c.textContent = full ? c.dataset.full : c.dataset.short;
    c.dataset.open = full ? "1" : "0";
  }));
}

/** Long id/payload shown as "start…end"; tap to see it all. */
const mid = (s, a = 10, b = 8) => (s.length > a + b + 3 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const tapCode = (full, a, b) =>
  `<code class="tap" data-full="${esc(full)}" data-short="${esc(mid(full, a, b))}" title="Tap to show all">${esc(mid(full, a, b))}</code>`;

// ---------- views ----------
function viewPairs() {
  return {
    title: "Choose market",
    html: () => `<div class="choice">${PAIRS.map((p, i) => {
      const a = asksOf(p)[0];
      return `<button data-i="${i}"><b>${sym(p.base)} / ${sym(p.quote)}</b><span>${a ? `from ${fmt(priceOf(a, p), dec(p.quote), 6)} ${sym(p.quote)} per ${sym(p.base)}` : "no offers yet"} · ${asksOf(p).length + bidsOf(p).length} open</span>${ICON.right}</button>`;
    }).join("")}</div>`,
    bind: (r) => $$("button[data-i]", r).forEach((b) => b.addEventListener("click", () => { setPair(Number(b.dataset.i)); closeSheet(); })),
  };
}

function viewOffers(kind) {           // kind: "asks" (buy from sellers) | "bids" (sell to buyers)
  const p = pair();
  return {
    title: kind === "asks" ? `Buy ${sym(p.base)}` : `Sell ${sym(p.base)} now`,
    html: () => {
      const list = kind === "asks" ? asksOf(p) : bidsOf(p);
      if (!list.length) {
        return `<div class="empty-state"><b>${kind === "asks" ? `No ${sym(p.base)} for sale right now` : `No buyers right now`}</b>
          ${kind === "asks" ? "Create a buy offer and let sellers come to you." : "List your NACKL at your own price."}<br>
          <button class="btn light" id="to-list">${kind === "asks" ? "Create a buy offer" : "List at my price"}</button></div>`;
      }
      return `<p class="note" style="margin:0 0 10px">${kind === "asks" ? "Cheapest first. Each offer is a fixed amount at a fixed price." : "Best price first. You sell the whole amount shown."}</p>
        <ul class="rows">${list.map((l, k) => rowHtml(l, p, k === 0)).join("")}</ul>`;
    },
    bind: (r) => {
      $$(".row", r).forEach((row) => row.addEventListener("click", () => push(viewTake(row.dataset.lot))));
      $("#to-list", r)?.addEventListener("click", () => push(viewList({ side: kind === "asks" ? "buy" : "sell" })));
    },
  };
}

function viewSellChoice() {
  const p = pair();
  const best = bidsOf(p)[0];
  return {
    title: `Sell ${sym(p.base)}`,
    html: () => `<div class="choice">
      <button id="c-now"><b>Sell now to a buyer</b><span>${best ? `Best offer: ${fmt(priceOf(best, p), dec(p.quote), 6)} ${sym(p.quote)} per ${sym(p.base)}` : "No buyers at the moment"}</span>${ICON.right}</button>
      <button id="c-list"><b>List at my own price</b><span>Your ${sym(p.base)} waits in its own contract until someone buys. Cancel any time.</span>${ICON.right}</button></div>`,
    bind: (r) => {
      $("#c-now", r).addEventListener("click", () => push(viewOffers("bids")));
      $("#c-list", r).addEventListener("click", () => push(viewList({ side: "sell" })));
    },
  };
}

// ---------- proof page ----------
// Everything here is read from the chain by this page, not claimed by us: what the offer holds, that it runs the
// published offer code (code hash), that our factory created it, and every message it sent or received.
async function fetchProof(lotHex) {
  const d = await gql(`{ blockchain {
    lot: account(account_id:"${lotHex}", dapp_id:"${F}") {
      info { acc_type code_hash balance_other { currency value(format:DEC) } }
      messages(last:50) { edges { node { msg_type created_at src dst bounce bounced value_other { currency value(format:DEC) } } } } }
    factory: account(account_id:"${F}", dapp_id:"${F}") { info { code_hash } } } }`);
  const lot = d?.blockchain?.lot, info = lot?.info;
  const coins = (list) => (list || []).map((x) => ({ id: Number(x.currency), v: BigInt(x.value) })).filter((c) => c.v > 0n);
  return {
    exists: info?.acc_type === 1,
    codeHash: info?.code_hash || "",
    factoryCodeHash: d?.blockchain?.factory?.info?.code_hash || "",
    holds: coins(info?.balance_other),
    messages: (lot?.messages?.edges || []).map(({ node: n }) => ({
      type: n.msg_type, at: n.created_at, src: n.src || "", dst: n.dst || "", bounced: !!n.bounced, coins: coins(n.value_other),
    })).sort((a, b) => a.at - b.at),
  };
}

/** Plain-words timeline of a lot's messages (internal ones; events and gas-only notices are left out). */
function proofTimeline(l, msgs) {
  const me = `0:${l.lot}`, factory = `0:${F}`;
  const who = (a) => a === factory ? "TalonHive" : (a === l.maker ? "the seller" : nickname(a));
  const list = (cs) => cs.map((c) => amt(c.v, c.id)).join(" + ");
  const out = [];
  for (const m of msgs) {
    if (m.dst === me && !m.src) { out.push({ at: m.at, text: "No-wallet message (keeper or this page)" }); continue; }
    if (m.dst === me && m.src === factory && !m.coins.length) { out.push({ at: m.at, text: "Created by the TalonHive Swap factory" }); continue; }
    if (m.dst === me && m.coins.length) { out.push({ at: m.at, text: `Received ${list(m.coins)} from ${who(m.src)}`, kind: "in" }); continue; }
    if (m.src === me && m.coins.length) {
      // Returned exactly what that sender just sent: a refused payment (bounced) or a refund.
      const back = msgs.some((x) => x.at === m.at && x.dst === me && x.src === m.dst && list(x.coins) === list(m.coins));
      const text = m.bounced ? `Refused: bounced ${list(m.coins)} back to ${who(m.dst)}`
        : back ? `Refunded ${list(m.coins)} to ${who(m.dst)}`
        : m.dst === factory ? `Paid the ${Number(FEE_BPS) / 100}% fee, ${list(m.coins)}, to TalonHive`
        : `Paid ${list(m.coins)} to ${who(m.dst)}`;
      out.push({ at: m.at, text, kind: m.bounced || back ? "back" : "out" });
    }
  }
  return out;
}

function viewProof(lotHex) {
  let data = null, error = "";
  const find = () => lots.find((x) => x.lot === lotHex);
  const check = (ok, yes, no) => `<li class="proof-${ok ? "ok" : "bad"}">${ok ? ICON.check : ICON.shield}<span>${ok ? yes : no}</span></li>`;
  const view = {
    title: "Check this offer",
    html: () => `<p class="note" style="margin:0 0 12px;color:var(--ink-2)">Everything below is read straight from the blockchain by this page. You don't have to trust us.</p><div id="proof-out"><div class="skeleton"></div></div>`,
    bind: (r) => {
      fetchProof(lotHex).then((d) => { data = d; view.live(r); }).catch((e) => { error = e.message; view.live(r); });
    },
    live: (r) => {
      const box = $("#proof-out", r);
      const l = find();
      if (!box || (!data && !error)) return;
      if (error) { box.innerHTML = `<p class="err">Couldn't read the chain: ${esc(error)}. Try again in a moment.</p>`; return; }
      if (!l) { box.innerHTML = `<p class="err">This offer wasn't created by the TalonHive Swap factory this page uses.</p>`; return; }
      const codeOk = !data.exists || data.codeHash === net.lotCodeHash;
      const facOk = data.factoryCodeHash === net.factoryCodeHash;
      const src = `https://github.com/talonhive/talonhive/blob/${net.sourceCommit}/contracts/AtomicSwap.sol`;
      const steps = proofTimeline(l, data.messages);
      box.innerHTML = `
        <div class="sum">
          <div class="sum-row"><span>Holds right now</span><b>${data.exists ? (data.holds.length ? data.holds.map((c) => amt(c.v, c.id)).join(" + ") : "nothing") : "closed"}</b></div>
          <div class="sum-row"><span>Terms</span><b style="font-size:13.5px;text-align:right">${amt(l.giveAmount, l.giveId)} for ${isDrop(l)
            ? `${amt(l.wantStart, l.wantId)} falling to ${amt(l.wantAmount, l.wantId)}` : amt(l.wantAmount, l.wantId)}${l.takerId ? ", one buyer only" : ""}</b></div>
          <div class="sum-row"><span>Open until</span><b style="font-size:14px">${new Date(l.deadline * 1000).toLocaleString()}</b></div>
        </div>
        <ul class="proof">
          ${check(facOk, "Created by the TalonHive Swap factory, which runs the published factory code.", "The factory's code doesn't match the published code. Don't use this offer.")}
          ${data.exists ? check(codeOk, `Runs the published offer code (the same fingerprint as <a href="${src}" target="_blank" rel="noopener">the source on GitHub</a>, commit ${esc(net.sourceCommit)}).`,
            "This offer's code doesn't match the published code. Don't pay it.") : `<li class="proof-ok">${ICON.check}<span>Finished and closed: it holds nothing any more.</span></li>`}
          <li class="proof-ok">${ICON.check}<span>That code has no admin key and no upgrade: it can only pay the seller, the buyer, or a ${Number(FEE_BPS) / 100}% fee to TalonHive.</span></li>
        </ul>
        <h4 class="proof-h">Every transfer, oldest first</h4>
        ${steps.length ? `<ol class="proof-steps">${steps.map((s) => `<li class="${s.kind || ""}"><time>${new Date(s.at * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}</time><span>${esc(s.text)}</span></li>`).join("")}</ol>`
          : `<p class="note">No transfers yet.</p>`}
        <details class="more"><summary>Check it with your own tools</summary>
          <p style="margin:0 0 6px">The offer's code fingerprint (code hash) on chain:</p>
          <div class="codebox"><code>${esc(data.codeHash || "closed")}</code></div>
          <p style="margin:0 0 6px">Compile <code>contracts/AtomicSwap.sol</code> at commit ${esc(net.sourceCommit)} with <code>sold 0.81.0 --tvm-version gosh</code>, then <code>tvm-cli decode stateinit --tvc AtomicSwap.tvc</code>: its code_hash is</p>
          <div class="codebox"><code>${esc(net.lotCodeHash)}</code></div>
          <p style="margin:0 0 12px">Offer ${tapCode(`${F}::${l.lot}`, 10, 8)}</p>
        </details>
        <details class="more"><summary>What this doesn't prove</summary>
          <p style="margin:0 0 12px">That the code has no bugs. It passed ${TEST ? "every Shellnet test" : "its tests"}, but it hasn't had an independent audit yet. Trades are also public: anyone can read these transfers, as on every blockchain.</p>
        </details>`;
      bindCopy(box);
    },
  };
  return view;
}

function viewTake(lotHex) {
  let watchedOpen = false;
  const find = () => lots.find((x) => x.lot === lotHex);
  const view = {
    title: "",
    html: () => {
      const l = find();
      if (!l) return `<p class="err">This offer is no longer listed.</p>`;
      const p = pair();
      const addr = `0:${l.lot}`;
      view.title = l.giveId === p.base ? `Buy ${amt(l.giveAmount, l.giveId)}` : `Sell ${amt(l.wantAmount, l.wantId)}`;
      const open = l.status === "open";
      const drop = open && isDrop(l) ? dropState(l) : null;
      const paid = open ? wantToPay(l) : l.wantAmount;     // the price per coin matches the amount shown
      const b = 10n ** BigInt(dec(p.base));
      const paidPrice = l.giveId === p.base ? (paid * b) / l.giveAmount : (l.giveAmount * b) / paid;
      return `
        <div class="match">
          <div class="k">${open ? "Your deal" : "This offer"}</div>
          <div class="line">${open ? "Pay" : "Paid"} <b id="take-pay">${amt(paid, l.wantId)}</b><span class="arrow">→</span>${open ? "get" : "got"} <b>${amt(l.giveAmount, l.giveId)}</b></div>
          <div class="sub">That's ${fmt(paidPrice, dec(p.quote), 6)} ${sym(p.quote)} per ${sym(p.base)}.${open ? " You get all of it, or your payment comes back: nothing can be half done." : ""}</div>
          ${drop ? `<div class="sub" id="take-drop">${esc(drop.text)}</div><div class="dropbar" aria-hidden="true"><i id="take-dropbar" style="width:${drop.pct.toFixed(1)}%"></i></div>` : ""}
        </div>
        ${open ? `<div class="share-row"><button type="button" class="btn ghost" id="take-share">${ICON.share}Share this offer</button><button type="button" class="linkbtn" data-how>How does this work?</button></div>` : ""}
        <div class="sum">
          <div class="sum-row"><span>Offered by</span><b style="font-size:14px">${person(l.maker, mineLot(l))}</b></div>
          <div class="sum-row"><span>${open ? "Time left" : "Status"}</span><b style="font-size:14px">${open ? timeLeft(l.deadline).replace(" left", "") : ({ filled: "Filled", cancelled: "Cancelled" }[l.outcome] || (l.status === "expired" ? "Expired" : "Closed"))}</b></div>
        </div>
        <div id="take-live"></div>
        <details class="more"><summary>Offer details</summary><dl>
          <dt>Offer</dt><dd>#${esc(l.nonce)}</dd>
          <dt>Expires</dt><dd>${new Date(l.deadline * 1000).toLocaleString()}</dd>
          <dt>Fee</dt><dd>${Number(FEE_BPS) / 100}%, taken from what the offer's creator receives. You pay exactly the price.</dd>
          <dt>Verified</dt><dd>Created by the TalonHive Swap factory and read straight from the blockchain. <button type="button" class="btn ghost" id="take-proof" style="margin-top:6px">Check this offer yourself</button></dd>
          <dt>Privacy</dt><dd>Like every Acki Nacki transfer, trades are public on the blockchain. This site shows nicknames, not wallet addresses.</dd>
        </dl>
        <details class="more" style="margin:0 0 12px"><summary>Technical details</summary><dl>
          <dt>Offer</dt><dd>${tapCode(`${F}::${l.lot}`, 10, 8)}</dd>
          <dt>Seller</dt><dd>${tapCode(l.maker, 10, 8)}</dd>
          <dt>Factory</dt><dd>${tapCode(F, 10, 8)}</dd>
        </dl></details></details>`;
    },
    bind: (r) => {
      $("#take-proof", r)?.addEventListener("click", () => push(viewProof(lotHex)));
      $("#take-share", r)?.addEventListener("click", () => { const l = find(); if (l) shareOffer(l); });
      view.live(r);
    },
    live: (r) => {
      const l = find(); const box = $("#take-live", r);
      if (!l || !box) return;
      const addr = `0:${l.lot}`;
      if (l.status === "open") {
        watchedOpen = true;
        if (box.dataset.state === "open") {
          $(".live span", box).textContent = `Waiting for your payment · ${timeLeft(l.deadline)}`;
          if (isDrop(l)) {   // the price falls: keep the amount (and what Copy copies) current
            const pay = fmt(wantToPay(l), dec(l.wantId), 9);
            $("#pay-amt", box).textContent = pay; $("#pay-copy", box).dataset.copy = pay.replace(/,/g, "");
            const top = $("#take-pay", r); if (top) top.textContent = amt(wantToPay(l), l.wantId);
            const d = dropState(l), dt = $("#take-drop", r), db = $("#take-dropbar", r);
            if (dt) dt.textContent = d.text; if (db) db.style.width = `${d.pct.toFixed(1)}%`;
          }
          return;
        }
        box.dataset.state = "open";
        box.innerHTML = `
          ${l.takerId ? `<div class="safe" style="margin-top:0;margin-bottom:12px">${ICON.shield}<span><b>Private offer.</b> Only the wallet ending <b>…${esc(l.takerId.slice(-8))}</b> can buy it. A payment from any other wallet comes back automatically.</span></div>` : ""}
          ${TEST ? `<div class="danger">${ICON.shield}<span><b>Test offer: test coins only.</b> Don't pay it from the Acki Nacki Wallet app or any real wallet. That would send <b>real</b> ${sym(l.wantId)} to an address that doesn't exist on mainnet, and it could be lost.</span></div>` : ""}
          <div class="pay"${TEST ? ' style="margin-top:12px"' : ""}>
            <div class="k">${isDrop(l) ? "Send at least" : "Send exactly"}</div>
            <div class="amount"><span id="pay-amt">${fmt(wantToPay(l), dec(l.wantId), 9)}</span> <small>${TEST ? "test " : ""}${sym(l.wantId)}</small></div>
            <div class="k" style="margin-bottom:6px">to this offer</div>
            <div class="addr">${tapCode(addr, 12, 8)}<button class="btn dark" data-copy="${addr}">Copy</button></div>
            <div class="pay-tools"><button class="btn light" style="border:1px solid #dfe5ef" id="pay-copy" data-copy="${fmt(wantToPay(l), dec(l.wantId), 9).replace(/,/g, "")}">Copy amount</button>${TEST ? "" : `<button class="btn light" style="border:1px solid #dfe5ef" id="qr-toggle">Show QR</button>`}</div>
            ${isDrop(l) ? `<p style="margin:10px 0 0;font-size:12.5px;color:#5c5c5c">The price keeps falling. You pay the price at the moment your payment lands; anything extra comes back with your ${sym(l.giveId)}.</p>` : ""}
            <div id="qr"></div>
          </div>
          <ol class="steps">
            ${TEST
              ? `<li><span>From a <b>Shellnet test wallet</b> (developers: tvm-cli), send ${isDrop(l) ? "the amount above" : `<b>${fmt(l.wantAmount, dec(l.wantId))} test ${sym(l.wantId)}</b>`} to the address above, as a plain transfer.</span></li>
                 <li><span>The test wallet receives <b>${fmt(l.giveAmount, dec(l.giveId))} test ${sym(l.giveId)}</b> within seconds.</span></li>`
              : `<li><span>Open your <b>Acki Nacki Wallet</b> and send ${isDrop(l) ? "the amount above" : `<b>${amt(l.wantAmount, l.wantId)}</b>`} to the address above, as a normal transfer.</span></li>
                 <li><span>Your <b>${amt(l.giveAmount, l.giveId)}</b> arrives in the same wallet within seconds.</span></li>`}
          </ol>
          ${l.wantId === 2 ? `<div class="safe">${ICON.shield}<span>Send SHELL <b>as SHELL</b>. Don't convert it to gas first: converted SHELL can't be refunded.</span></div>` : ""}
          <div class="live"><i></i><span>Waiting for your payment · ${timeLeft(l.deadline)}</span></div>`;
        bindCopy(box);
        $("#qr-toggle", box)?.addEventListener("click", (e) => {
          const q = $("#qr", box);
          if (!q.dataset.made && window.QRCode) { try { new window.QRCode(q, { text: addr, width: 168, height: 168, colorDark: "#0b1224", colorLight: "#ffffff" }); q.dataset.made = 1; } catch { /* optional */ } }
          q.classList.toggle("on"); e.target.textContent = q.classList.contains("on") ? "Hide QR" : "Show QR";
        });
        return;
      }
      if (box.dataset.state === l.status) return;
      box.dataset.state = l.status;
      if ((l.status === "settled" || l.status === "closed") && watchedOpen) {
        box.innerHTML = `<div class="done-card"><div class="check">${ICON.check}</div><h4>Offer filled</h4>
          <p>If that was your payment, <b>${amt(l.giveAmount, l.giveId)}</b> is already in your wallet.<br>If someone was faster, your payment was returned.</p></div>
          <button class="btn light block" style="margin-top:16px" id="done-ok">Done</button>`;
        $("#done-ok", box).addEventListener("click", closeSheet);
        return;
      }
      const msg = {
        expired: "This offer has expired. Don't pay: its coins go back to the seller.",
        settled: "This offer has already been filled. Don't pay.",
        closed: "This offer is finished. Don't pay.",
      }[l.status] || "Checking the offer…";
      box.innerHTML = `<div class="live warn"><i></i><span>${esc(msg)}</span></div>`;
    },
  };
  view.html();                                            // sets the title
  return view;
}

// Quick amounts of NACKL for a new offer (the smallest offer is 1,000 NACKL).
const AMOUNT_CHIPS = [[1000, "1k"], [5000, "5k"], [10000, "10k"], [50000, "50k"], [100000, "100k"]];
function viewList(pre = {}) {
  const s = {
    side: pre.side || "sell", quote: pair().quote, amount: "", price: "", hours: 24,
    kind: "fixed", start: "", dropHours: 6,     // drop offers (selling only): start price, how long it falls
    who: "anyone", buyer: "",                   // private offers: the buyer's wallet address
  };
  const chips = (attr, cur, list) => list.map(([v, t]) => `<button data-${attr}="${v}" aria-pressed="${cur === v}">${t}</button>`).join("");
  const view = {
    title: "Create an offer",
    html: () => {
      const drop = s.side === "sell" && s.kind === "drop";
      return `
      <div class="toggle" role="group" aria-label="Side">
        <button data-side="sell" aria-pressed="${s.side === "sell"}">Sell NACKL</button>
        <button data-side="buy" aria-pressed="${s.side === "buy"}">Buy NACKL</button>
      </div>
      <div class="field"><span>Paid in</span><div class="chips" id="q-chips">${PAIRS.map((p) => `<button data-q="${p.quote}" aria-pressed="${s.quote === p.quote}">${sym(p.quote)}</button>`).join("")}</div></div>
      <label class="field"><span>Amount of NACKL</span><div class="input"><input id="f-amount" inputmode="decimal" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="1,000" value="${esc(s.amount)}" autocomplete="off"><em>NACKL</em></div>
        <div class="chips mini" id="a-chips">${AMOUNT_CHIPS.map(([v, t]) => `<button type="button" data-amt="${v}" aria-pressed="false">${t}</button>`).join("")}</div></label>
      ${s.side === "sell" ? `<div class="field"><span>Price</span><div class="chips">${chips("kind", s.kind, [["fixed", "Fixed"], ["drop", "Drop: starts high, falls"]])}</div></div>` : ""}
      ${drop ? `<label class="field"><span>Start price per NACKL</span><div class="input"><input id="f-start" inputmode="decimal" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="0.01" value="${esc(s.start)}" autocomplete="off"><em>${sym(s.quote)}</em></div></label>` : ""}
      <label class="field"><span>${drop ? "Lowest price per NACKL" : "Price per NACKL"} <button type="button" id="f-best"></button></span><div class="input"><input id="f-price" inputmode="decimal" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="0.005" value="${esc(s.price)}" autocomplete="off"><em>${sym(s.quote)}</em></div>
        <div class="chips mini" id="p-chips"></div></label>
      ${drop ? `<div class="field"><span>Price falls to the lowest over</span><div class="chips">${chips("dh", s.dropHours, [[1, "1 hour"], [6, "6 hours"], [24, "1 day"], [72, "3 days"]])}</div></div>` : ""}
      <div class="field"><span>Offer stays open for</span><div class="chips" id="h-chips">${chips("h", s.hours, [[1, "1 hour"], [24, "1 day"], [72, "3 days"], [167, "7 days"]])}</div></div>
      <div class="field"><span>Who can ${s.side === "sell" ? "buy" : "sell"}</span><div class="chips">${chips("who", s.who, [["anyone", "Anyone"], ["one", "One person"]])}</div></div>
      ${s.who === "one" ? `<label class="field"><span>Their wallet address</span><div class="input"><input class="small" id="f-buyer" placeholder="dapp_id::account_id" value="${esc(s.buyer)}" autocomplete="off" spellcheck="false"></div></label>` : ""}
      <div class="quote" id="f-quote"></div>
      <p class="err" id="f-err"></p>
      <button class="btn light block" id="f-go">Continue</button>
      <p class="note">Next, this page opens your offer and shows where to send your coins, as a normal transfer from your wallet. They go straight into the offer's own contract, never to us. <button type="button" class="linkbtn" data-how>How does this work?</button></p>`;
    },
    bind: (r) => {
      const read = () => {
        s.amount = $("#f-amount", r).value; s.price = $("#f-price", r).value;
        if ($("#f-start", r)) s.start = $("#f-start", r).value;
        if ($("#f-buyer", r)) s.buyer = $("#f-buyer", r).value;
      };
      const redraw = () => { read(); r.innerHTML = view.html(); view.bind(r); };   // the fields depend on the toggles
      const recalc = () => {
        read();
        const p = PAIRS.find((x) => x.quote === s.quote);
        const best = s.side === "sell" ? asksOf(p)[0] : bidsOf(p)[0];
        const bestBtn = $("#f-best", r);
        bestBtn.textContent = best ? `Best now: ${fmt(priceOf(best, p), dec(p.quote), 6)}` : "";
        bestBtn.onclick = () => { $("#f-price", r).value = fmt(priceOf(best, p), dec(p.quote), 9).replace(/,/g, ""); recalc(); };
        // Amount chips: lit when the box holds that amount.
        let typed = null; try { typed = parseUnits(s.amount, dec(p.base)); } catch { /* not a number yet */ }
        $$("[data-amt]", r).forEach((b) => b.setAttribute("aria-pressed", String(typed !== null && typed === BigInt(b.dataset.amt) * 10n ** BigInt(dec(p.base)))));
        // Price chips: steps from the best competing offer. Selling: a bit under it sells first, above it waits for
        // more. Buying: a bit over the best bid gets filled first. None when the market is empty.
        const pc = $("#p-chips", r);
        if (best) {
          const m = priceOf(best, p);
          const steps = s.side === "sell" ? [-1, 0, 5, 10] : [-10, -5, 0, 1];
          const at = (pct) => fmt((m * BigInt(10000 + pct * 100)) / 10000n, dec(p.quote), 9).replace(/,/g, "");
          let cur = null; try { cur = parseUnits(s.price, dec(p.quote)); } catch { /* empty */ }
          pc.innerHTML = steps.map((pct) => {
            const v = at(pct);
            const label = pct === 0 ? "Market" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
            const hint = pct === 0 ? "Same as the best offer now" : (s.side === "sell") === (pct < 0) ? "Fills sooner" : "Waits for a better price";
            return `<button type="button" data-px="${v}" title="${hint}" aria-pressed="${cur !== null && cur === parseUnits(v, dec(p.quote))}">${label}</button>`;
          }).join("");
          $$("[data-px]", pc).forEach((b) => b.addEventListener("click", () => { $("#f-price", r).value = b.dataset.px; recalc(); }));
        } else pc.innerHTML = "";
        const q = computeOffer(s);
        const drop = q.ok && q.wantStart > q.wantAmount;
        const verb = q.giveId === 1 ? "buys it" : "sells to you";
        $("#f-quote", r).innerHTML = q.ok ? `
          <div class="match"><div class="k">Your deal</div>
            <div class="line">Put in <b>${amt(q.giveAmount, q.giveId)}</b><span class="arrow">→</span>get <b>${amt((drop ? q.wantStart - (q.wantStart * FEE_BPS) / 10000n : q.wantAmount - q.fee), q.wantId)}</b></div>
            <div class="sub">${drop
              ? `when someone ${verb}. The price falls to ${amt(q.wantAmount - q.fee, q.wantId)} (after fee) over ${s.dropHours} h, then stays there.`
              : `when someone ${verb}, after the ${Number(FEE_BPS) / 100}% fee.`} Until then you can cancel and get everything back.</div>
          </div>
          <div class="sum-row"><span>Fee (${Number(FEE_BPS) / 100}%)</span><b style="font-size:14px">${drop ? "1% of the price paid" : amt(q.fee, q.wantId)}</b></div>`
          : `<div class="sum-row"><span>Enter an amount and a price to see what you'll receive.</span></div>`;
        $("#f-err", r).textContent = q.ok ? "" : (s.amount && s.price ? q.error : "");
        $("#f-go", r).disabled = !q.ok;
      };
      const pick = (attr, key, num) => $$(`[data-${attr}]`, r).forEach((b) => b.addEventListener("click", () => {
        s[key] = num ? Number(b.dataset[attr]) : b.dataset[attr]; redraw();
      }));
      pick("side", "side"); pick("q", "quote", true); pick("h", "hours", true);
      pick("kind", "kind"); pick("dh", "dropHours", true); pick("who", "who");
      $$("[data-amt]", r).forEach((b) => b.addEventListener("click", () => { $("#f-amount", r).value = Number(b.dataset.amt).toLocaleString("en-US"); recalc(); }));
      ["#f-amount", "#f-price", "#f-start", "#f-buyer"].forEach((id) => $(id, r)?.addEventListener("input", recalc));
      $("#f-go", r).addEventListener("click", () => {
        const q = computeOffer(s);
        if (!q.ok) { $("#f-err", r).textContent = q.error; return; }
        push(viewOpenListing(q));
      });
      recalc();
    },
  };
  return view;
}

function computeOffer(s) {
  try {
    const p = PAIRS.find((x) => x.quote === s.quote);
    // Say which box is wrong.
    const num = (v, d, what) => { try { return parseUnits(v, d); } catch (e) { throw new Error(`${what}: ${e.message.toLowerCase()}`); } };
    const baseAmt = num(s.amount, dec(p.base), "Amount");
    const price = num(s.price, dec(p.quote), s.side === "sell" && s.kind === "drop" ? "Lowest price" : "Price");
    if (baseAmt === 0n) throw new Error("Enter an amount");
    const quoteAmt = (baseAmt * price) / 10n ** BigInt(dec(p.base));
    const [giveId, giveAmount, wantId, wantAmount] = s.side === "sell"
      ? [p.base, baseAmt, p.quote, quoteAmt] : [p.quote, quoteAmt, p.base, baseAmt];
    if (giveAmount < CURRENCIES[giveId].minGive) throw new Error(`The smallest offer is ${amt(CURRENCIES[giveId].minGive, giveId)} (you'd put in ${amt(giveAmount, giveId)}).`);
    if (wantAmount <= 0n) throw new Error("That price is too small");
    if (!(s.hours >= 1 && s.hours * 3600 <= MAX_TTL_SECONDS)) throw new Error("Pick how long the offer stays open");
    // Drop (selling only): the start price must be above the lowest, and the drop must end before the offer does.
    let wantStart = wantAmount, dropHours = 0;
    if (s.side === "sell" && s.kind === "drop") {
      wantStart = (baseAmt * num(s.start, dec(p.quote), "Start price")) / 10n ** BigInt(dec(p.base));
      if (wantStart <= wantAmount) throw new Error("The start price must be higher than the lowest price");
      if (!(s.dropHours < s.hours)) throw new Error("The price must reach its lowest before the offer closes: pick a longer open time or a shorter drop");
      dropHours = s.dropHours;
    }
    // Private: only this account may take the offer.
    let takerId = "";
    if (s.who === "one") {
      takerId = accountOf(s.buyer);
      if (!takerId) throw new Error("Add their wallet address (dapp_id::account_id)");
    }
    return { ok: true, giveId, giveAmount, wantId, wantAmount, fee: (wantAmount * FEE_BPS) / 10000n, hours: s.hours,
      wantStart, dropHours, takerId };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Listing by transfer (docs/LISTING_BY_TRANSFER.md): the page opens the offer itself (unsigned external message,
// no wallet), then the seller funds it with a plain transfer, which is all the Acki Nacki Wallet app can send.
const LISTING_TTL = 15 * 60;   // SwapFactory.LISTING_TTL: time to send the deposit
// Drop and private terms for createLot / openListing (docs/PRIVATE_AND_DROP.md). The drop's end is fixed when
// the offer is sent; the lot's price starts falling when it opens. Fixed and public: wantStart = wantAmount, 0, 0.
const extra = (q) => ({
  wantStart: q.wantStart,
  dropEnd: q.dropHours ? BigInt(Math.floor(Date.now() / 1000) + q.dropHours * 3600) : 0n,
  takerId: q.takerId ? BigInt("0x" + q.takerId) : 0n,
});
const shareLink = (lot) => `${location.origin}${location.pathname}?offer=${lot}`;
function viewOpenListing(q) {
  // The offer must outlive the 15-minute deposit window; keep the chosen window, minus a little slack.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + q.hours * 3600 - 120);
  const terms = termsKey(q.giveId, q.giveAmount, q.wantId, q.wantAmount, Number(deadline));
  let phase = "ready";           // ready | sending | waiting (for ListingOpened) | fund | live | expired | failed
  let listing = null, sentAt = 0, error = "", polling = false;
  const unit = (id) => `${TEST ? "test " : ""}${sym(id)}`;
  const view = {
    title: "Open your offer",
    html: () => `
      <div class="sum">
        <div class="sum-row"><span>${coin(q.giveId)}You put in</span><b>${amt(q.giveAmount, q.giveId)}</b></div>
        <div class="sum-row"><span>${coin(q.wantId)}You receive</span><b>${q.wantStart > q.wantAmount
          ? `${amt(q.wantStart - (q.wantStart * FEE_BPS) / 10000n, q.wantId)} falling to ${amt(q.wantAmount - q.fee, q.wantId)}`
          : amt(q.wantAmount - q.fee, q.wantId)}</b></div>
        ${q.wantStart > q.wantAmount ? `<div class="sum-row"><span>Drop</span><b style="font-size:14px">Falls to its lowest over ${q.dropHours} h, from when your coins arrive</b></div>` : ""}
        ${q.takerId ? `<div class="sum-row"><span>Private</span><b style="font-size:14px">Only the wallet ending …${esc(q.takerId.slice(-8))} can ${q.giveId === 1 ? "buy" : "sell"}</b></div>` : ""}
        <div class="sum-row"><span>Open until</span><b style="font-size:14px">${new Date(Number(deadline) * 1000).toLocaleString()}</b></div>
      </div>
      <div id="ol-box"></div>
      <details class="more"><summary>Using a developer wallet (tvm-cli)?</summary>
        <p style="margin:0 0 12px">Wallets that can attach a message can create the offer in one step instead.</p>
        <button class="btn ghost" id="ol-dev" style="margin-bottom:12px">Show the developer message</button></details>
      <div class="safe">${ICON.shield}<span>TalonHive never asks for your keys or seed phrase. Anyone who does is trying to steal from you.</span></div>`,
    bind: (r) => {
      $("#ol-dev", r).addEventListener("click", () => push(viewListResult(q)));
      view.live(r);
    },
    live: (r) => {
      const box = $("#ol-box", r);
      if (!box) return;
      const now = Date.now() / 1000;
      if (phase === "fund" && listing) {
        const live = lots.find((x) => x.lot === listing.lot);
        if (live) phase = "live";
        else if (now >= Number(listing.fundBy)) phase = "expired";
      }
      if (box.dataset.phase === phase && phase !== "fund") return;
      if (phase === "fund" && box.dataset.phase === "fund") {
        $(".live span", box).textContent = `Waiting for your ${sym(q.giveId)} · ${Math.max(0, Math.ceil((Number(listing.fundBy) - now) / 60))} min left`;
        return;
      }
      box.dataset.phase = phase;
      if (phase === "ready" || phase === "failed") {
        box.innerHTML = `
          ${phase === "failed" ? `<p class="err" style="margin-top:14px">${esc(error)}</p>` : ""}
          <ol class="steps">
            <li><span>Tap <b>Open my offer</b>. This page creates it on the blockchain, with your price and nothing in it yet.</span></li>
            <li><span>Send exactly <b>${fmt(q.giveAmount, dec(q.giveId), 9)} ${unit(q.giveId)}</b> to it from your wallet, as a normal transfer, within 15 minutes.</span></li>
            <li><span>It goes live in the market. When someone buys, <b>${amt(q.wantAmount - q.fee, q.wantId)}</b> arrives in your wallet automatically.</span></li>
          </ol>
          <button class="btn light block" style="margin-top:16px" id="ol-go">${phase === "failed" ? "Try again" : "Open my offer"}</button>`;
        $("#ol-go", box).addEventListener("click", send);
        return;
      }
      if (phase === "sending" || phase === "waiting") {
        box.innerHTML = `<div class="live"><i></i><span>${phase === "sending" ? "Opening your offer…" : "Waiting for the blockchain to confirm your offer…"}</span></div>`;
        return;
      }
      if (phase === "fund") {
        const addr = `0:${listing.lot}`;
        const amount = fmt(q.giveAmount, dec(q.giveId), 9);
        box.innerHTML = `
          ${TEST ? `<div class="danger">${ICON.shield}<span><b>Test offer: test coins only.</b> Send from a Shellnet <b>test</b> wallet, never from the Acki Nacki Wallet app or any real wallet: real ${sym(q.giveId)} would go to an address that doesn't exist on mainnet.</span></div>` : ""}
          <div class="pay" style="margin-top:12px">
            <div class="k">Send exactly</div>
            <div class="amount">${amount} <small>${unit(q.giveId)}</small></div>
            <div class="k" style="margin-bottom:6px">to your offer</div>
            <div class="addr">${tapCode(addr, 12, 8)}<button class="btn dark" data-copy="${addr}">Copy</button></div>
            <div class="pay-tools"><button class="btn light" style="border:1px solid #dfe5ef" data-copy="${amount.replace(/,/g, "")}">Copy amount</button>${TEST ? "" : `<button class="btn light" style="border:1px solid #dfe5ef" id="qr-toggle">Show QR</button>`}</div>
            <div id="qr"></div>
          </div>
          <ol class="steps">
            <li><span>Send <b>exactly</b> that amount, as a normal transfer. A different amount comes straight back.</span></li>
            <li><span>Your offer goes live as soon as it arrives, with you as the seller.</span></li>
          </ol>
          ${q.giveId === 2 ? `<div class="safe">${ICON.shield}<span>Send SHELL <b>as SHELL</b>. Don't convert it to gas first: converted SHELL can't be refunded.</span></div>` : ""}
          <div class="live"><i></i><span>Waiting for your ${sym(q.giveId)} · ${Math.max(0, Math.ceil((Number(listing.fundBy) - now) / 60))} min left</span></div>
          ${TEST ? `<details class="more"><summary>Shellnet test helper (repo script)</summary>
            <p style="margin:0 0 6px">Funds this offer from the repo's test seller wallet with a plain transfer:</p>
            <div class="codebox"><code class="cmd">bash tests/demo_lots.sh fund ${addr} ${q.giveId} ${amount.replace(/,/g, "")}</code><button class="btn ghost" data-copy="bash tests/demo_lots.sh fund ${addr} ${q.giveId} ${amount.replace(/,/g, "")}">Copy</button></div></details>` : ""}`;
        bindCopy(box);
        $("#qr-toggle", box)?.addEventListener("click", (e) => {
          const qr = $("#qr", box);
          if (!qr.dataset.made && window.QRCode) { try { new window.QRCode(qr, { text: addr, width: 168, height: 168, colorDark: "#0b1224", colorLight: "#ffffff" }); qr.dataset.made = 1; } catch { /* optional */ } }
          qr.classList.toggle("on"); e.target.textContent = qr.classList.contains("on") ? "Hide QR" : "Show QR";
        });
        return;
      }
      if (phase === "live") {
        const l = lots.find((x) => x.lot === listing.lot);
        box.innerHTML = `<div class="done-card"><div class="check">${ICON.check}</div><h4>Your offer is live</h4>
          <p>Offer #${esc(l.nonce)} is in the market. You'll be paid automatically when someone buys.<br>
          To cancel, send any small amount (for example 1 ${sym(q.giveId)}) to it from the same wallet: everything comes back.</p></div>
          ${q.takerId ? `<div class="field" style="margin-top:14px"><span>Send this link to your buyer (the offer isn't listed publicly)</span>
            <div class="codebox"><code class="cmd">${esc(shareLink(l.lot))}</code><button class="btn ghost" data-copy="${esc(shareLink(l.lot))}">Copy</button></div></div>` : ""}
          <button class="btn light block" style="margin-top:14px" id="see-offer">See my offer</button>`;
        bindCopy(box);
        $("#see-offer", box).addEventListener("click", () => push(viewTake(l.lot)));
        return;
      }
      if (phase === "expired") {
        box.innerHTML = `<div class="live warn"><i></i><span>Time's up: no deposit arrived within 15 minutes, so this offer was not opened. Anything sent after this is returned automatically.</span></div>
          <button class="btn light block" style="margin-top:14px" id="ol-again">Start again</button>`;
        $("#ol-again", box).addEventListener("click", () => { phase = "ready"; listing = null; view.live(r); });
      }
    },
  };

  async function send() {
    phase = "sending"; refreshSheet();
    try {
      const { key } = await openListing({
        restBase: net.rest, factoryHex: F, funcId: IDS.openListing, abi: ABI.openListing,
        giveId: q.giveId, giveAmount: q.giveAmount, wantId: q.wantId, wantAmount: q.wantAmount, deadline, ...extra(q),
      });
      rememberPrepared(terms);
      phase = "waiting"; sentAt = Date.now(); refreshSheet();
      waitForListing(key);
    } catch (e) {
      phase = "failed"; error = `Couldn't open the offer: ${e.message}. Nothing was sent from your wallet.`; refreshSheet();
    }
  }
  // A refused openListing (for example too many new offers in the last few minutes) creates nothing and
  // returns no error, so give the chain a minute to show the ListingOpened event before saying so.
  async function waitForListing(key) {
    if (polling) return;
    polling = true;
    try {
      while (phase === "waiting" && Date.now() - sentAt < 60000) {
        await new Promise((res) => setTimeout(res, 3000));
        try { listing = await findListing(key); } catch { /* network blip: try again */ }
        if (listing) { phase = "fund"; break; }
      }
      if (phase === "waiting") {
        phase = "failed";
        error = "The network didn't open your offer. This usually means many offers were opened in the last few minutes. Please try again shortly. Nothing was sent from your wallet.";
      }
    } finally { polling = false; refreshSheet(); }
  }
  return view;
}

function parseWallet(str) {
  const t = String(str || "").trim().toLowerCase();
  const m = t.match(/^([0-9a-f]{64})::([0-9a-f]{64})$/);
  if (m) return { dapp: m[1], account: m[2] };
  if (!t) throw new Error("Add your wallet address");
  throw new Error("Wallet address should look like dapp_id::account_id (two 64-character codes)");
}

function viewListResult(q) {
  // Deadline slightly inside the chosen window so the message still lands within the 7-day limit.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + q.hours * 3600 - 120);
  // No wallet address needed: the lot records the sender as the seller, and payouts reach an EXISTING wallet
  // by account id whatever DApp id they name (Phase 1 T8, spike 6 C6), exactly as pay-to-take buyers are paid.
  // So the seller's DApp field carries our own DApp id.
  const payload = encodeCallBody(IDS.createLot, ABI.createLot.inputs,
    { giveId: q.giveId, wantId: q.wantId, wantAmount: q.wantAmount, deadline, makerDapp: BigInt("0x" + F), ...extra(q) });
  const args = JSON.stringify({ dest: `0:${F}`, value: "10000000", cc: { [q.giveId]: q.giveAmount.toString() }, bounce: true, flag: 1, payload, dapp_id: `0x${F}` });
  rememberPrepared(termsKey(q.giveId, q.giveAmount, q.wantId, q.wantAmount, Number(deadline)));
  let from = "<your-wallet-address>";
  try { const w = parseWallet(store.get("wallet")); from = `${w.dapp}::${w.account}`; } catch { /* placeholder */ }
  const cmd = `tvm-cli call ${from} submitTransaction '${args}' --abi UpdateCustodianMultisigWallet_v2.abi.json --sign <your-key-file>`;
  const key = termsKey(q.giveId, q.giveAmount, q.wantId, q.wantAmount, Number(deadline));
  return {
    title: "Send to create your offer",
    html: () => `
      <div class="note" style="margin:0 0 12px;color:var(--ink-2)">
        <b style="color:var(--ink)">This last step happens in your wallet, not on this page.</b> It needs a wallet that can send coins
        <i>with an attached message</i>. Today that means developer wallets (tvm-cli); the Acki Nacki Wallet app can't attach
        messages yet, and we've asked the Acki Nacki team to add it. <b style="color:var(--ink)">Buying</b> already works with a plain transfer.</div>
      <div class="sum">
        <div class="sum-row"><span>${coin(q.giveId)}You put in</span><b>${amt(q.giveAmount, q.giveId)}</b></div>
        <div class="sum-row"><span>${coin(q.wantId)}You receive</span><b>${amt(q.wantAmount - q.fee, q.wantId)}</b></div>
        <div class="sum-row"><span>Open until</span><b style="font-size:14px">${new Date(Number(deadline) * 1000).toLocaleString()}</b></div>
      </div>
      ${TEST ? `<div class="danger">${ICON.shield}<span><b>Test network.</b> Send this only from a Shellnet <b>test</b> wallet. From a real wallet, real coins would go to an address that doesn't exist on mainnet.</span></div>` : ""}
      <ol class="steps">
        <li><span>From a ${TEST ? "Shellnet test wallet" : "wallet"} that can attach a message, send <b>${TEST ? `${fmt(q.giveAmount, dec(q.giveId))} test ${sym(q.giveId)}` : amt(q.giveAmount, q.giveId)}</b> to the TalonHive Swap factory, bounce on:</span></li>
      </ol>
      <div class="codebox">${tapCode(`0:${F}`, 12, 8)}<button class="btn ghost" data-copy="0:${F}">Copy</button></div>
      <ol class="steps" start="2" style="counter-reset:s 1">
        <li><span>Attach this message (it holds your price and expiry):</span></li>
      </ol>
      <div class="codebox">${tapCode(payload, 14, 8)}<button class="btn ghost" data-copy="${payload}">Copy</button></div>
      <ol class="steps" style="counter-reset:s 2">
        <li><span>Your offer appears in the market within seconds. When someone buys, <b>${amt(q.wantAmount - q.fee, q.wantId)}</b> arrives in your wallet automatically.</span></li>
      </ol>
      <div id="track"><div class="live"><i></i><span>Watching the blockchain for your offer… this page updates by itself once you've sent it.</span></div></div>
      <details class="more"><summary>Using tvm-cli with a multisig wallet</summary>
        <div class="codebox"><code class="cmd">${esc(cmd)}</code><button class="btn ghost" data-copy="${esc(cmd)}">Copy</button></div>
        <p style="margin:0 0 12px">Destination DApp: <code>${F}</code></p></details>
      ${TEST && q.giveAmount % 10n ** BigInt(dec(q.giveId)) === 0n ? `<details class="more"><summary>Shellnet test helper (repo script)</summary>
        <p style="margin:0 0 6px">Sends this exact offer from the repo's test seller wallet:</p>
        <div class="codebox"><code class="cmd">bash tests/demo_lots.sh send ${q.giveId} ${q.giveAmount / 10n ** BigInt(dec(q.giveId))} ${payload}</code><button class="btn ghost" data-copy="bash tests/demo_lots.sh send ${q.giveId} ${q.giveAmount / 10n ** BigInt(dec(q.giveId))} ${payload}">Copy</button></div></details>` : ""}
      <div class="safe">${ICON.shield}<span>TalonHive never asks for your keys or seed phrase. Anyone who does is trying to steal from you.</span></div>`,
    bind: (r) => { bindCopy(r); },
    // Called on every refresh: flips to "live" as soon as an offer with exactly these terms is on chain.
    live: (r) => {
      const t = $("#track", r);
      if (!t || t.dataset.done) return;
      const l = lots.find((x) => termsKey(x.giveId, x.giveAmount, x.wantId, x.wantAmount, x.deadline) === key);
      if (!l) return;
      t.dataset.done = "1";
      t.innerHTML = `<div class="done-card"><div class="check">${ICON.check}</div><h4>Your offer is live</h4>
        <p>Offer #${esc(l.nonce)} is in the market. You'll be paid automatically when someone buys.</p></div>
        <button class="btn light block" style="margin-top:14px" id="see-offer">See my offer</button>`;
      $("#see-offer", t).addEventListener("click", () => push(viewTake(l.lot)));
    },
  };
}

function viewMine() {
  const view = {
    title: "My offers",
    html: () => `
      <div id="m-out"></div>
      <details class="more"${store.get("wallet") ? " open" : ""}><summary>Offers made from another device?</summary>
        <label class="field" style="margin-top:2px"><span>Find them by wallet address (optional)</span><div class="input"><input class="small" id="m-wallet" placeholder="dapp_id::account_id" value="${esc(store.get("wallet"))}" autocomplete="off" spellcheck="false"></div></label>
      </details>`,
    bind: (r) => {
      const run = () => {
        const out = $("#m-out", r);
        const v = $("#m-wallet", r).value.trim().toLowerCase();
        const m = v.match(/^(?:[0-9a-f]{64}::|0:)?([0-9a-f]{64})$/);
        if (m) store.set("wallet", v); else if (!v) store.set("wallet", "");
        // Offers prepared in this browser (no address needed), plus any found by the optional wallet address.
        const mine = lots.filter((l) => mineLot(l) || (m && l.maker === `0:${m[1]}`)).sort((a, b) => b.createdAt - a.createdAt);
        if (!mine.length) {
          out.innerHTML = v && !m ? `<p class="err">That doesn't look like a wallet address (dapp_id::account_id).</p>`
            : `<div class="empty-state"><b>No offers yet</b>Offers you prepare on this device show up here automatically once they're on chain.</div>`;
          return;
        }
        const cancel = encodeCallBody(IDS.reclaim, [], {});
        out.innerHTML = `<ul class="rows">${mine.map((l) => {
          const p = PAIRS.find((x) => [x.base, x.quote].includes(l.giveId) && [x.base, x.quote].includes(l.wantId)) || pair();
          return rowHtml(l, p, false) + (l.status === "open" || l.status === "expired" ? `
            <li style="list-style:none;padding:0 12px 12px"><details class="more" style="margin:0"><summary>Cancel and get my ${sym(l.giveId)} back</summary>
              <p style="margin:0 0 8px">From the wallet that created the offer, send <b>any small amount</b> (for example 1 ${sym(l.giveId)}) to the offer, as a normal transfer. Everything comes back to you, including that amount.</p>
              <div class="codebox">${tapCode(`0:${l.lot}`, 12, 8)}<button class="btn ghost" data-copy="0:${l.lot}">Copy</button></div>
              <p style="margin:0 0 8px">Developer wallets can instead send it a message with <b>no coins</b>, bounce on, carrying:</p>
              <div class="codebox"><code>${cancel}</code><button class="btn ghost" data-copy="${cancel}">Copy</button></div>
              ${l.status === "expired" ? `<p style="margin:0 0 12px">It has expired, so anyone can also return it to you.</p>` : ""}</details></li>` : "");
        }).join("")}</ul>`;
        bindCopy(out);
        $$(".row", out).forEach((row) => row.addEventListener("click", () => push(viewTake(row.dataset.lot))));
      };
      $("#m-wallet", r).addEventListener("input", run);
      run();
    },
    live: (r) => { /* list refreshes when reopened */ },
  };
  return view;
}

// ---------- refresh loop ----------
async function refresh() {
  $("#btn-refresh").classList.add("spin");
  try {
    const fresh = await fetchLots();
    await fetchStatuses(fresh);
    lots = fresh; loaded = true;
    $("#net").className = "net glass ok"; $("#net span").textContent = "Shellnet · live";
    renderHome();
    refreshSheet();
    // A share link (?offer=<lot>) opens that offer once, as soon as it is known.
    if (linkedLot && !refresh.openedLink && lots.some((l) => l.lot === linkedLot)) {
      refresh.openedLink = true;
      openSheet(viewTake(linkedLot));
    }
    const proofLot = (new URLSearchParams(location.search).get("proof") || "").toLowerCase().replace(/^0:/, "");
    if (proofLot && !refresh.openedProof && lots.some((l) => l.lot === proofLot)) {
      refresh.openedProof = true;
      openSheet(viewProof(proofLot));
    }
  } catch (e) {
    $("#net").className = "net glass bad"; $("#net span").textContent = "Offline";
    $("#net").title = e.message;
    if (!loaded) $("#rows").innerHTML = `<li class="empty-state"><b>Can't reach the chain</b>${esc(e.message)}. Retrying…</li>`;
  } finally {
    $("#btn-refresh").classList.remove("spin");
  }
}

async function main() {
  IDS = {
    LotCreated: await abiId(eventSignature(ABI.LotCreated)),
    createLot: await abiId(functionSignature(ABI.createLot)),
    reclaim: await abiId(functionSignature(ABI.reclaim)),
    openListing: await abiId(functionSignature(ABI.openListing)),
    ListingOpened: await abiId(eventSignature(ABI.ListingOpened)),
    Filled: await abiId(eventSignature(ABI.Filled)),
    Reclaimed: await abiId(eventSignature(ABI.Reclaimed)),
  };
  $("#factory").outerHTML = tapCode(`${F}::${F}`, 8, 6);
  bindCopy(document.querySelector("footer"));
  $("#testbar").hidden = !TEST;
  $("#pair-chip").addEventListener("click", () => openSheet(viewPairs()));
  $("#btn-buy").addEventListener("click", () => openSheet(viewOffers("asks")));
  $("#btn-sell").addEventListener("click", () => openSheet(viewSellChoice()));
  $("#btn-list").addEventListener("click", () => openSheet(viewList({ side: "sell" })));
  $("#btn-mine").addEventListener("click", () => openSheet(viewMine()));
  $("#btn-activity").addEventListener("click", () => openSheet(viewActivity()));
  let resizeT = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (loaded) renderChart(); }, 150); });
  $("#trust-how").addEventListener("click", () => openSheet(viewHow()));
  // Phone tab bar: Market just closes any sheet and scrolls up; the rest open their sheet.
  $$("#tabbar [data-nav]").forEach((b) => b.addEventListener("click", () => {
    const go = { market: () => { if ($("#sheet").open) closeSheet(); window.scrollTo({ top: 0, behavior: "smooth" }); },
      activity: () => openSheet(viewActivity()), mine: () => openSheet(viewMine()), how: () => openSheet(viewHow()) }[b.dataset.nav];
    go?.();
  }));
  $("#btn-refresh").addEventListener("click", refresh);
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-back").addEventListener("click", back);
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
  $("#sheet").addEventListener("close", () => { current = null; views.length = 0; });
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.tab; $$("#tabs button").forEach((x) => x.setAttribute("aria-selected", x === b)); renderRows();
  }));
  $("#rows").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("row")) { e.preventDefault(); e.target.click(); } });
  // Installable app (PWA): service worker for a resilient shell, and an Install button where supported.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => { /* optional */ });
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; $("#btn-install").hidden = false; });
  window.addEventListener("appinstalled", () => { deferredInstall = null; $("#btn-install").hidden = true; toast("TalonHive Swap installed"); });
  $("#btn-install").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => null);
    deferredInstall = null; $("#btn-install").hidden = true;
  });
  renderHome();
  await refresh();
  setInterval(refresh, POLL_MS);
}

main();
