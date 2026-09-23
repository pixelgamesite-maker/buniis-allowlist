# bunii-allowlist

Private allowlist API for Bunii's mint. Adapted from CrocPad's allowlist
service — flat repo, one Railway service, Express + Supabase, matching
the pattern in the CrocPad build notes.

## Routes

- `GET /api/allowlist-proof?address=0x...` — public, rate-limited (60/min
  per IP). Returns `{ eligible, proof }` for one address. Never reveals
  the list or its size.
- `POST /admin/allowlist` — admin only (`Authorization: Bearer
  <ADMIN_API_KEY>`), 5/min. Body `{ csv }`. Builds the Merkle tree, stores
  every proof, removes any older list, returns `{ root, count,
  duplicateCount, skippedCount, skipped }`.
- `GET /admin/allowlist/stats` — admin only. Returns `{ count }`.
- `GET /health` — plain 200, for Railway's health check.

## Setup

1. **Supabase**: create a project (or reuse Bunii's), then run
   `migration-001-bunii-proofs.sql` in the SQL Editor. RLS is enabled with
   no policies — only the `service_role` key can read or write this
   table, which is what keeps the list private.
2. **Railway**: new service from this repo (flat — `package.json` and
   `index.mjs` at the root, so Railway's auto-detect just works). Set
   these env vars in the Railway dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** key from Supabase
     (Project Settings → API), not the anon/public key. This key bypasses
     RLS, so treat it like a password: Railway env var only, never in
     client code, never committed.
   - `ADMIN_API_KEY` — any long random string you generate. Paste this
     same value into the site's `/admin` page when uploading a list; it's
     kept in that browser tab's session storage only.
   - `ALLOWED_ORIGIN` — comma-separated list of origins allowed to call
     the public lookup route, e.g. `https://buniipad.xyz`. Defaults to
     `*` if unset, which is fine for testing but should be locked down
     before launch.
3. Once deployed, copy the Railway URL (e.g.
   `https://bunii-allowlist-production.up.railway.app`) into
   `ALLOWLIST_API_URL` in the site's `src/lib/buniiPadContract.ts`.

## Uploading the list

Two ways to get wallets in — both build the exact same tree and are safe
to re-run if something fails partway (nothing is deleted until every new
row is written successfully):

- **Admin page** (recommended): Connect the owner wallet at `/admin`,
  paste the `ADMIN_API_KEY`, upload the CSV, then click "Set root
  on-chain" — one wallet transaction, no terminal needed.
- **CLI**, for scripting or before the site exists yet:
  ```
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
    node generate-allowlist-private.mjs allowlist.csv
  ```
  Writes `merkle-root.txt`. Set it on-chain from the admin page, or with
  `set-merkle-root.mjs` (needs a private key — see that file's header
  comment; the admin page is the safer route since the key never touches
  a terminal).

CSV just needs one address per line, in any column position, with or
without a header row — see `allowlist.example.csv`. Mixed case and
duplicate addresses are handled automatically.

## Differences from CrocPad's allowlist repo

- `list_generation` migration is included from the start (`migration-001`
  creates the column directly), instead of being added later in a
  `migration-006` file that was referenced but never actually committed
  to that repo — which would have made the upload route fail on a fresh
  setup.
- The CLI script (`generate-allowlist-private.mjs`) now upserts new rows
  and only deletes stale ones afterward, matching the API route. CrocPad's
  version deleted the whole table first — if the script died partway
  through a large CSV, the list was left empty until it was re-run
  successfully. This version is safe to re-run at any point.
- `ALLOWED_ORIGIN` accepts a comma-separated list instead of one exact
  origin, so both the production domain and a local dev server can be
  allowed at once.
- Both the API route and the CLI script now share one `merkle.mjs` module,
  so there's no risk of the two ever building the tree differently.

## Verified

The Merkle construction was checked against 6,001 generated wallets
(including a messy CSV — header row, mixed case, duplicates, a junk line)
and confirmed every proof verifies against `OpenZeppelin`'s
`MerkleProof.verify` — the exact check `BuniiPad.sol`'s `mintAllowlist`
performs — and that an outsider's wallet fails with someone else's proof.
