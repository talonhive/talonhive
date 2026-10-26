// parseUnits from web/app.js against phone-style inputs (spaces, comma decimals, thousands).   node web/test_parse.mjs
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("function parseUnits"), src.indexOf("const sym ="));
const parseUnits = new Function(body + "; return parseUnits;")();
const cases = [["0. 005", 6, 5000n], ["0,005", 6, 5000n], ["0.005", 6, 5000n], ["1,000", 9, 1000000000000n], ["12,500", 9, 12500000000000n],
  ["1,000,000", 9, 1000000000000000n], ["1 000", 9, 1000000000000n], ["1,5", 9, 1500000000n], ["1000,25", 6, 1000250000n], [" 2.5 ", 9, 2500000000n], ["abc", 9, "Enter a number"], ["0.1234567", 6, "At most 6 decimals"]];
let fail = 0;
for (const [inp, d, want] of cases) {
  let got; try { got = parseUnits(inp, d); } catch (e) { got = e.message; }
  const ok = got === want; if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(inp)} -> ${got}${ok ? "" : `  (want ${want})`}`);
}
process.exit(fail ? 1 : 0);
