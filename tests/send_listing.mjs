// Opens ONE test listing on Shellnet with the page's own code (web/send.js), no wallet and no keys.
//   node tests/send_listing.mjs <factoryHex>
// Then check that the factory's lot count went up (tvm-cli run <f>::<f> getInfo) and the new lot is AWAITING.
import { createHash } from "node:crypto";
import { openListing } from "../web/send.js";
import { ABI } from "../web/config.js";
import { functionSignature } from "../web/boc.js";

const factoryHex = process.argv[2];
if (!/^[0-9a-f]{64}$/.test(factoryHex || "")) { console.error("usage: node tests/send_listing.mjs <factoryHex>"); process.exit(2); }
const funcId = createHash("sha256").update(functionSignature(ABI.openListing)).digest().readUInt32BE(0) & 0x7fffffff;
const N = 10n ** 9n;
try {
  const r = await openListing({
    restBase: "https://shellnet.ackinacki.org/", factoryHex, funcId, abi: ABI.openListing,
    giveId: 1, giveAmount: 1000n * N, wantId: 2, wantAmount: 50n * N,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 2 * 3600),
  });
  console.log(`sent: key ${r.key}  message ${r.id}`);
} catch (e) {
  console.log(`refused: ${e.code} ${e.message}`);
  console.log(JSON.stringify(e.data));
  process.exit(1);
}
