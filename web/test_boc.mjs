// Node test for boc.js against real Shellnet LotCreated events (run 7, lots #40 and #41).
//   node web/test_boc.mjs
import { createHash } from "node:crypto";
import { parseBoc, Slice, decodeEvent } from "./boc.js";
import { ABI } from "./config.js";

// These two bodies come from the run-7 factory, before LotCreated gained wantStart, dropEnd and takerId,
// so they are decoded with the first nine fields (their event id is that shorter signature's).
const ev = { name: "LotCreated", inputs: ABI.LotCreated.inputs.slice(0, 9) };
const sig = `${ev.name}(${ev.inputs.map((i) => i.type).join(",")})v2`;
const id = createHash("sha256").update(sig).digest().readUInt32BE(0) & 0x7fffffff;

const bodies = [
  "te6ccgEBAwEAqAABWygsbM8AAAAAAAAAKIACa8/VzV5KbgIqJ9eQRpzi4izbzfBGGSL8mbhxIkJE8/ABAauAGTWj1uggTL3YVdqGmN+1vP6KA/kVQa6SSC9DGC5sXG85NaPW6CBMvdhV2oaY37W8/ooD+RVBrpJIL0MYLmxcbyAAAAAgAAAAAAAAAAAAAB0alKIAEAIAOAAAAAIAAAAAAAAAAAAAAAEqBfIAAAAAAGq89s0=",
  "te6ccgEBAwEAqAABWygsbM8AAAAAAAAAKYAeHX51Hb6qKHw1fjFYg/wOV6221SgcGovJphKAg8dh5RABAauAGTWj1uggTL3YVdqGmN+1vP6KA/kVQa6SSC9DGC5sXG85NaPW6CBMvdhV2oaY37W8/ooD+RVBrpJIL0MYLmxcbyAAAAAgAAAAAAAAAAAAAB0alKIAEAIAOAAAAAIAAAAAAAAAAAAAAAEqBfIAAAAAAGq9BUU=",
];

let fail = 0;
const eq = (name, want, got) => {
  const ok = String(want) === String(got);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${ok ? got : `want=${want} got=${got}`}`);
};

const first = new Slice(parseBoc(bodies[0]));
const raw = Number(first.uint(32));
console.log(`signature ${sig}\n  computed id 0x${id.toString(16)}  body id 0x${raw.toString(16)}`);
eq("event id matches", id, raw);

const MAKER = "0:c9ad1eb7410265eec2aed434c6fdade7f4501fc8aa0d7492417a18c17362e379";
const N = 1000000000n;
bodies.forEach((b, k) => {
  const e = decodeEvent(b, ev, id);
  if (!e) { fail++; console.log("FAIL  decode returned null"); return; }
  console.log(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  eq(`#${40 + k} nonce`, 40 + k, e.nonce);
  eq(`#${40 + k} maker`, MAKER, e.maker);
  eq(`#${40 + k} makerDapp`, MAKER.slice(2), e.makerDapp.toString(16).padStart(64, "0"));
  eq(`#${40 + k} give NACKL`, "1:" + 1000n * N, `${e.giveId}:${e.giveAmount}`);
  eq(`#${40 + k} want SHELL`, "2:" + 5n * N, `${e.wantId}:${e.wantAmount}`);
  eq(`#${40 + k} lot address is 0:hex64`, true, /^0:[0-9a-f]{64}$/.test(e.lot));
  eq(`#${40 + k} deadline is plausible`, true, e.deadline > 1790000000n && e.deadline < 1800000000n);
});
// Current LotCreated (with wantStart, dropEnd, takerId): real events from the run-12 factory.
const evNow = ABI.LotCreated;
const idNow = createHash("sha256").update(`${evNow.name}(${evNow.inputs.map((i) => i.type).join(",")})v2`).digest().readUInt32BE(0) & 0x7fffffff;
const drop = decodeEvent("te6ccgEBAwEA4AABWyLkknYAAAAAAAAAJoARFReT+MZoYawOGwmclZTZATBKm42Ji1TEC9sgHYwlU5ABAauAGTWj1uggTL3YVdqGmN+1vP6KA/kVQa6SSC9DGC5sXG85NaPW6CBMvdhV2oaY37W8/ooD+RVBrpJIL0MYLmxcbyAAAAAgAAAAAAAAAAAAAB0alKIAEAIAqAAAAAIAAAAAAAAAAAAAAAukO3QAAAAAAGrfTMoAAAAAAAAAAAAAABdIdugAAAAAAGrfMV4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", evNow, idNow);
eq("run-12 #38 drop: floor 50 SHELL", 50n * N, drop && drop.wantAmount);
eq("run-12 #38 drop: start 100 SHELL", 100n * N, drop && drop.wantStart);
eq("run-12 #38 drop: public", 0n, drop && drop.takerId);
const priv = decodeEvent("te6ccgEBAwEA4AABWyLkknYAAAAAAAAAJ4AMUbYHFIl29eDkEPOB/FuJqxNevPmtytKbcls2VYmtFPABAauAGTWj1uggTL3YVdqGmN+1vP6KA/kVQa6SSC9DGC5sXG8+E+aoKtJGKRTHgxpm1SkHT35uD9K2xsnqH578OoatA+AAAAAgAAAAAAAAAAAAAB0alKIAEAIAqAAAAAIAAAAAAAAAAAAAAAukO3QAAAAAAGrfTOgAAAAAAAAAAAAAAAukO3QAAAAAAAAAAAAPAxqdd28jLKtMZUygEcjw/FxtNebZxd1HJAzEVwjNSg==", evNow, idNow);
eq("run-12 #39 private: fixed (start = floor)", "true", String(!!priv && priv.wantStart === priv.wantAmount && priv.dropEnd === 0n));
eq("run-12 #39 private: named buyer", "0f031a9d776f232cab4c654ca011c8f0fc5c6d35e6d9c5dd47240cc45708cd4a", priv && priv.takerId.toString(16).padStart(64, "0"));

// Encoder vs `tvm-cli body` / `tvm-cli message --raw` (tvm-cli 3.0.6, offline: nothing sent), 2026-10-26.
import { encodeCallBody, functionSignature } from "./boc.js";
const fid = (fn) => createHash("sha256").update(functionSignature(fn)).digest().readUInt32BE(0) & 0x7fffffff;
eq("createLot body, fixed + public == tvm-cli",
  "te6ccgEBAQEAfgAA+Ec/Bk0AAAABAAAAAgAAAAAAAAAAAAAAASoF8gAAAAAAar0FRcmtHrdBAmXuwq7UNMb9ref0UB/Iqg10kkF6GMFzYuN5AAAAAAAAAAAAAAABKgXyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  encodeCallBody(fid(ABI.createLot), ABI.createLot.inputs, { giveId: 1, wantId: 2, wantAmount: 5000000000n,
    deadline: 1790772549n, makerDapp: BigInt("0x" + MAKER.slice(2)), wantStart: 5000000000n, dropEnd: 0n, takerId: 0n }));
eq("createLot body, drop + private == tvm-cli",
  "te6ccgEBAQEAfgAA+Ec/Bk0AAAABAAAAAgAAAAAAAAAAAAAAC6Q7dAAAAAAAat8CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAXSHboAAAAAABq3tswDwManXdvIyyrTGVMoBHI8PxcbTXm2cXdRyQMxFcIzUo=",
  encodeCallBody(fid(ABI.createLot), ABI.createLot.inputs, { giveId: 1, wantId: 2, wantAmount: 50000000000n,
    deadline: 1793000000n, makerDapp: 1n, wantStart: 100000000000n, dropEnd: 1792990000n,
    takerId: BigInt("0x0f031a9d776f232cab4c654ca011c8f0fc5c6d35e6d9c5dd47240cc45708cd4a") }));
eq("reclaim body == tvm-cli", "te6ccgEBAQEABgAACH8a7W8=", encodeCallBody(fid(ABI.reclaim), [], {}));

import { encodeExternalCall } from "./boc.js";
const ext = await encodeExternalCall("f09f354156923148a63c18d336a9483a7bf3707e95b6364f50fcf7e1d435681f",
  fid(ABI.openListing), ABI.openListing.inputs,
  { key: 123456789n, giveId: 1, giveAmount: 1000000000000n, wantId: 2, wantAmount: 50000000000n, deadline: 1793000000n,
    wantStart: 100000000000n, dropEnd: 1792990000n, takerId: BigInt("0x0f031a9d776f232cab4c654ca011c8f0fc5c6d35e6d9c5dd47240cc45708cd4a") },
  1792800000000n, 1792800120);
eq("openListing message, drop + private == tvm-cli",
  "te6ccgEBAgEAqAABZYgB4T5qgq0kYpFMeDGmbVKQdPfm4P0rbGyeofnvw6hq0D4AAAADQtZqEADVt+rwAR7cNQEA4AAAAAAHW80VAAAAAQAAAAAAAAAAAAAA6NSlEAAAAAACAAAAAAAAAAAAAAALpDt0AAAAAABq3wJAAAAAAAAAAAAAAAAXSHboAAAAAABq3tswDwManXdvIyyrTGVMoBHI8PxcbTXm2cXdRyQMxFcIzUo=",
  ext.boc);
eq("openListing message id == tvm-cli", "de0d73d0c836cba464379fd70e152433cf9808180e3321e7d25ca3fd5cd3bc87", ext.id);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
