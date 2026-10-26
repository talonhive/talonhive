// Sends unsigned external messages from the page (no wallet), the way tvm-sdk 3.x does:
// POST <node>/v2/messages with a JSON array of one message (tvm_client/src/net/server_link.rs, ExtMessageV3).
// The node may answer with a redirect to the block producer (WRONG_PRODUCER) or the right thread
// (THREAD_MISMATCH); like the SDK, we retry with what it says. Never resend after a send went through:
// an identical resend is refused as DUPLICATE_MESSAGE.
import { encodeExternalCall } from "./boc.js";

/** Send one message. Returns the node's JSON answer; throws Error with .code and .data on refusal. */
export async function postMessage(restBase, { boc, id }, dappHex, accountHex) {
  let url = new URL("v2/messages", restBase).href;
  let threadId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const msg = { id, body: boc, expire_at: null, ext_message_token: null, dapp_id: dappHex, account_id: accountHex };
    if (threadId) msg.thread_id = threadId;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([msg]) });
    let data = null;
    try { data = await res.json(); } catch { /* empty or not JSON */ }
    const ext = data?.node_error?.extensions || data?.error?.node_error?.extensions;
    const code = ext?.code;
    if (res.ok && !code) return data;
    if (code === "WRONG_PRODUCER" || code === "THREAD_MISMATCH") {
      const producer = data?.result?.producers?.[0] || ext?.details?.producers?.[0];
      if (producer) url = new URL("v2/messages", producer.startsWith("http") ? producer : `https://${producer}`).href;
      threadId = ext?.details?.thread_id || threadId;
      continue;
    }
    const err = new Error(ext?.message || data?.message || `HTTP ${res.status}`);
    err.code = code || `HTTP_${res.status}`;
    err.data = data;
    throw err;
  }
  throw Object.assign(new Error("The network kept redirecting the message"), { code: "REDIRECT_LOOP" });
}

/**
 * Open a listing (SwapFactory.openListing) for a seller whose wallet can only make plain transfers.
 * Returns { key, id } — key finds the listing's ListingOpened event, id is the message hash.
 */
export async function openListing({ restBase, factoryHex, funcId, abi, giveId, giveAmount, wantId, wantAmount, deadline,
  wantStart = wantAmount, dropEnd = 0n, takerId = 0n }) {   // defaults: fixed price, anyone may take
  const key = BigInt.asUintN(64, BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0")).join("")));
  const now = Date.now();
  const msg = await encodeExternalCall(factoryHex, funcId, abi.inputs,
    { key, giveId, giveAmount, wantId, wantAmount, deadline, wantStart, dropEnd, takerId }, BigInt(now), Math.floor(now / 1000) + 120);
  await postMessage(restBase, msg, factoryHex, factoryHex);   // self-rooted factory: DApp id == account id
  return { key, id: msg.id };
}
