/**
 * CLI alternative to the admin page's upload. Same tree, same storage,
 * same safe upsert-then-cleanup behaviour (it shares merkle.mjs with the
 * API).
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=xxx \
 *   node generate-allowlist-private.mjs allowlist.csv
 *
 * Writes the root to merkle-root.txt. Set it on-chain from the admin page
 * or with set-merkle-root.mjs. Old proofs stop working the moment the
 * on-chain root changes, so do that promptly if replacing a live list.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { parseAddressCsv, buildTree, storeProofs } from "./merkle.mjs";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const csvPath = process.argv[2] || "allowlist.csv";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});

const { addresses, skipped, duplicates } = parseAddressCsv(readFileSync(csvPath, "utf8"));
for (const line of skipped) console.warn(`Skipped: "${line}"`);

if (addresses.length === 0) {
  console.error("No valid addresses found. Nothing to build.");
  process.exit(1);
}
console.log(`${addresses.length} unique addresses (${duplicates} duplicates removed, ${skipped.length} lines skipped).`);

const runId = new Date().toISOString();
const { root, rows } = buildTree(addresses, runId);
writeFileSync("merkle-root.txt", root);
console.log(`Merkle root: ${root}`);

const result = await storeProofs(supabase, rows, runId, {
  onProgress: (done, total) => console.log(`  wrote ${done} / ${total}`),
});

if (!result.ok) {
  console.error(`Failed at row ${result.failedAtRow}: ${result.error.message}`);
  console.error("Nothing was deleted. The previous list is intact; it's safe to re-run.");
  process.exit(1);
}
if (result.cleanupError) console.warn("New list written, but removing old rows failed:", result.cleanupError.message);

console.log(`\nDone. ${addresses.length} proofs stored in bunii_proofs.`);
console.log("Next: set the root on-chain (admin page, or set-merkle-root.mjs).");
