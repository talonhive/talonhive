// Network and contract configuration. The page talks only to the chain's public GraphQL endpoint.
export const NETWORKS = {
  shellnet: {
    label: "Shellnet (test network)",
    graphql: "https://shellnet.ackinacki.org/graphql",
    rest: "https://shellnet.ackinacki.org/",   // POST v2/messages: unsigned external messages (web/send.js)
    // Test factory from tests/run_listing.sh (run 9: listing by transfer). Self-rooted: DApp id == account id.
    factory: "ae5ef6cba9a1ae056412b5fe78f2993a8023224c64f5cfc9f52efb13e1f1f77c",
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
    ],
  },
  createLot: {
    name: "createLot",
    inputs: [
      { name: "giveId", type: "uint32" }, { name: "wantId", type: "uint32" },
      { name: "wantAmount", type: "uint128" }, { name: "deadline", type: "uint64" },
      { name: "makerDapp", type: "uint256" },
    ],
    outputs: [],
  },
  reclaim: { name: "reclaim", inputs: [], outputs: [] },
  // Listing by transfer (docs/LISTING_BY_TRANSFER.md): sent by the page as an unsigned external message.
  openListing: {
    name: "openListing",
    inputs: [
      { name: "key", type: "uint64" }, { name: "giveId", type: "uint32" },
      { name: "giveAmount", type: "uint128" }, { name: "wantId", type: "uint32" },
      { name: "wantAmount", type: "uint128" }, { name: "deadline", type: "uint64" },
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
    ],
  },
};
