// Network and contract configuration. The page talks only to the chain's public GraphQL endpoint.
export const NETWORKS = {
  shellnet: {
    label: "Shellnet (test network)",
    graphql: "https://shellnet.ackinacki.org/graphql",
    rest: "https://shellnet.ackinacki.org/",   // POST v2/messages: unsigned external messages (web/send.js)
    // Test factory from tests/run_listing.sh (run 12: private and drop offers). Self-rooted: DApp id == account id.
    factory: "f09f354156923148a63c18d336a9483a7bf3707e95b6364f50fcf7e1d435681f",
    // Code fingerprints the proof page checks on chain. They are the code hashes of contracts/*.sol at commit
    // f75a35b compiled with `sold 0.81.0 --tvm-version gosh`; anyone can reproduce them with
    // `tvm-cli decode stateinit --tvc AtomicSwap.tvc` (code_hash). Change them only with the contracts.
    lotCodeHash: "5854186a7c298f870f7934f05d25e1f3ad219d6f4e48e8345810fc893a9a45af",
    factoryCodeHash: "311e647b0e31c0e6face57ef3604632e7178c13f9f7c141dd61f3acf77e4d9f7",
    sourceCommit: "f75a35b",
    // Test network: coins have no value and do NOT exist on mainnet. The Acki Nacki Wallet app is a
    // mainnet wallet, so the UI must never invite paying test offers from it (real coins would go to an
    // address that doesn't exist on mainnet). Drives the banner, "test" coin labels and pay instructions.
    test: true,
  },
  // mainnet: added only after an independent audit (PROJECT_BRIEF.md).
};
export const DEFAULT_NETWORK = "shellnet";

export const CURRENCIES = {
  1: { sym: "NACKL", dec: 9, minGive: 1000n * 10n ** 9n },
  2: { sym: "SHELL", dec: 9, minGive: 100n * 10n ** 9n },
  3: { sym: "USDC", dec: 6, minGive: 1n * 10n ** 6n },
};
export const PAIRS = [
  { base: 1, quote: 2 },   // NACKL priced in SHELL
  { base: 1, quote: 3 },   // NACKL priced in USDC
];
export const FEE_BPS = 100n;           // matches the factory (getInfo.feeBps)
export const MAX_TTL_SECONDS = 7 * 24 * 3600;
export const EVENTS_TO_SCAN = 150;     // newest LotCreated events read from the factory
export const POLL_MS = 6000;

// ABI fragments the page needs (from contracts/*.abi.json, ABI 2.4).
export const ABI = {
  LotCreated: {
    name: "LotCreated",
    inputs: [
      { name: "nonce", type: "uint64" }, { name: "lot", type: "address" },
      { name: "maker", type: "address" }, { name: "makerDapp", type: "uint256" },
      { name: "giveId", type: "uint32" }, { name: "giveAmount", type: "uint128" },
      { name: "wantId", type: "uint32" }, { name: "wantAmount", type: "uint128" },
      { name: "deadline", type: "uint64" },
      { name: "wantStart", type: "uint128" }, { name: "dropEnd", type: "uint64" }, { name: "takerId", type: "uint256" },
    ],
  },
  createLot: {
    name: "createLot",
    inputs: [
      { name: "giveId", type: "uint32" }, { name: "wantId", type: "uint32" },
      { name: "wantAmount", type: "uint128" }, { name: "deadline", type: "uint64" },
      { name: "makerDapp", type: "uint256" },
      { name: "wantStart", type: "uint128" }, { name: "dropEnd", type: "uint64" }, { name: "takerId", type: "uint256" },
    ],
    outputs: [],
  },
  reclaim: { name: "reclaim", inputs: [], outputs: [] },
  // Lot events, used to tell a filled offer from a cancelled one (only their ids are read).
  Filled: { name: "Filled", inputs: [{ name: "taker", type: "address" }, { name: "paid", type: "uint128" }, { name: "fee", type: "uint128" }] },
  Reclaimed: { name: "Reclaimed", inputs: [{ name: "maker", type: "address" }, { name: "by", type: "address" }] },
  // Listing by transfer (docs/LISTING_BY_TRANSFER.md): sent by the page as an unsigned external message.
  openListing: {
    name: "openListing",
    inputs: [
      { name: "key", type: "uint64" }, { name: "giveId", type: "uint32" },
      { name: "giveAmount", type: "uint128" }, { name: "wantId", type: "uint32" },
      { name: "wantAmount", type: "uint128" }, { name: "deadline", type: "uint64" },
      { name: "wantStart", type: "uint128" }, { name: "dropEnd", type: "uint64" }, { name: "takerId", type: "uint256" },
    ],
    outputs: [],
  },
  ListingOpened: {
    name: "ListingOpened",
    inputs: [
      { name: "key", type: "uint64" }, { name: "nonce", type: "uint64" }, { name: "lot", type: "address" },
      { name: "giveId", type: "uint32" }, { name: "giveAmount", type: "uint128" },
      { name: "wantId", type: "uint32" }, { name: "wantAmount", type: "uint128" },
      { name: "deadline", type: "uint64" }, { name: "fundBy", type: "uint64" },
      { name: "wantStart", type: "uint128" }, { name: "dropEnd", type: "uint64" }, { name: "takerId", type: "uint256" },
    ],
  },
};
