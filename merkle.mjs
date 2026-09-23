/**
 * Shared Merkle + CSV helpers, used by both the API and the CLI script so
 * the two can never build the tree differently.
 *
 * Leaf format must match BuniiPad.sol exactly:
 *   keccak256(abi.encodePacked(msg.sender))
 * i.e. keccak256 of the raw 20 address bytes. sortPairs: true matches
 * OpenZeppelin's MerkleProof.verify, which hashes pairs in sorted order.
 */
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { isAddress, getAddress } from "viem";

export function leafFor(address) {
  return keccak256(Buffer.from(address.slice(2).toLowerCase(), "hex"));
}

/**
 * Only the first column of each line matters. A header row containing the
 * word "address" is skipped; everything else that isn't a valid address is
 * returned in `skipped` so the admin can see what was ignored.
 */
export function parseAddressCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const raw = [];
  const skipped = [];
  let sawHeader = false;

  for (const line of lines) {
    const firstCol = line.split(",")[0].trim().replace(/^"|"$/g, "");
    if (isAddress(firstCol, { strict: false })) {
      raw.push(getAddress(firstCol));
    } else if (!sawHeader && /address/i.test(firstCol)) {
      sawHeader = true;
    } else {
      skipped.push(line);
    }
  }

  // Dedupe, case-insensitive.
  const seen = new Set();
  const addresses = [];
  for (const a of raw) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(a);
  }

  return { addresses, skipped, duplicates: raw.length - addresses.length };
}

/** Builds the tree and the rows to store, one per address. */
export function buildTree(addresses, runId) {
  const leaves = addresses.map(leafFor);
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const rows = addresses.map((address, i) => ({
    wallet_address: address.toLowerCase(),
    proof: tree.getHexProof(leaves[i]),
    list_generation: runId,
  }));
  return { root: tree.getHexRoot(), rows, tree, leaves };
}

/**
 * Writes rows, then removes anything from an older list. Upsert first,
 * delete after: if a batch fails partway, nothing has been deleted and the
 * previous list is still intact, so retrying the same upload is always safe.
 */
export async function storeProofs(supabase, rows, runId, { batchSize = 500, onProgress } = {}) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from("bunii_proofs").upsert(batch, { onConflict: "wallet_address" });
    if (error) return { ok: false, error, failedAtRow: i };
    onProgress?.(Math.min(i + batchSize, rows.length), rows.length);
  }

  const { error: cleanupError } = await supabase
    .from("bunii_proofs")
    .delete()
    .neq("list_generation", runId);

  return { ok: true, cleanupError };
}
