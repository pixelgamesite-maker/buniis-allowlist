/**
 * Bunii allowlist API.
 *
 * PUBLIC
 *   GET /api/allowlist-proof?address=0x...
 *     Returns { eligible, proof } for one address only. Never reveals the
 *     list or its size. Rate-limited per visitor.
 *
 * ADMIN (Authorization: Bearer <ADMIN_API_KEY>)
 *   POST /admin/allowlist   body: { csv: string }
 *     Builds the Merkle tree, stores every proof in bunii_proofs, removes
 *     rows from any older list, and returns { root, count, ... } so the
 *     admin page can set the root on-chain in one wallet transaction.
 *     Safe to retry: nothing is deleted until every new row is written.
 *
 *   GET /admin/allowlist/stats
 *     Returns { count } for the list currently stored. Admin only.
 *
 * Env vars (set on Railway):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_API_KEY,
 *   ALLOWED_ORIGIN — comma-separated, e.g.
 *     https://buniipad.xyz,https://www.buniipad.xyz
 */

import express from "express";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { isAddress, getAddress } from "viem";
import WebSocket from "ws";
import { parseAddressCsv, buildTree, storeProofs } from "./merkle.mjs";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_API_KEY } = process.env;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "*")
  .split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}
if (!ADMIN_API_KEY) {
  console.warn("ADMIN_API_KEY is not set — every /admin request will be rejected until it is.");
}
if (ALLOWED_ORIGINS.includes("*")) {
  console.warn("ALLOWED_ORIGIN is '*'. Fine for testing; set it to your site's URL before launch.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  // This service never uses Supabase Realtime (no live subscriptions —
  // everything here is plain request/response REST calls), but the
  // client's constructor initializes a RealtimeClient unconditionally,
  // which crashes on startup if native WebSocket isn't available. Rather
  // than depend on Railway building with a specific Node version,
  // explicitly hand it the `ws` package so it never looks for a native one.
  realtime: { transport: WebSocket },
});
const app = express();

// Railway runs this behind a reverse proxy. Without this, every visitor
// looks like the proxy's IP and the per-visitor rate limit becomes one
// shared bucket for the whole site. This caused a real outage on CrocPad.
app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ───────────── public: eligibility lookup ───────────── */

const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

app.get("/api/allowlist-proof", lookupLimiter, async (req, res) => {
  const address = req.query.address;
  if (typeof address !== "string" || !isAddress(address, { strict: false })) {
    return res.status(400).json({ error: "A valid EVM address is required." });
  }

  const { data, error } = await supabase
    .from("bunii_proofs")
    .select("proof")
    .eq("wallet_address", getAddress(address).toLowerCase())
    .maybeSingle();

  if (error) {
    console.error("Lookup failed:", error.message);
    return res.status(500).json({ error: "Lookup failed. Try again shortly." });
  }
  res.setHeader("Cache-Control", "no-store");
  if (!data) return res.status(200).json({ eligible: false, proof: null });
  return res.status(200).json({ eligible: true, proof: data.proof });
});

/* ───────────── admin ───────────── */

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Wait a moment." },
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!ADMIN_API_KEY || token !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized. Check the admin key." });
  }
  next();
}

app.post("/admin/allowlist", adminLimiter, requireAdmin, async (req, res) => {
  const csv = req.body?.csv;
  if (!csv || typeof csv !== "string") {
    return res.status(400).json({ error: "Missing csv field in request body." });
  }

  const { addresses, skipped, duplicates } = parseAddressCsv(csv);
  if (addresses.length === 0) {
    return res.status(400).json({ error: "No valid addresses found in that file.", skipped: skipped.slice(0, 20) });
  }

  const runId = new Date().toISOString();
  const { root, rows } = buildTree(addresses, runId);
  const result = await storeProofs(supabase, rows, runId);

  if (!result.ok) {
    console.error(`Failed writing batch at row ${result.failedAtRow}:`, result.error);
    return res.status(500).json({
      error: "Failed writing proofs. Nothing was deleted, so the previous list is still intact and it's safe to retry this upload.",
      detail: { message: result.error.message, code: result.error.code, hint: result.error.hint },
      failedAtRow: result.failedAtRow,
      totalRows: rows.length,
    });
  }
  if (result.cleanupError) {
    // New list is fully written and correct; stale rows just won't verify
    // against the new on-chain root.
    console.error("Cleanup of old rows failed (new list is intact):", result.cleanupError);
  }

  return res.status(200).json({
    root,
    count: addresses.length,
    duplicateCount: duplicates,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 20),
  });
});

app.get("/admin/allowlist/stats", adminLimiter, requireAdmin, async (req, res) => {
  const { count, error } = await supabase.from("bunii_proofs").select("*", { count: "exact", head: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ count });
});

app.get("/health", (req, res) => res.status(200).send("ok"));

app.listen(PORT, () => console.log(`Bunii allowlist API listening on port ${PORT}`));
