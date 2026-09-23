-- Run once in the Supabase SQL Editor.
--
-- Stores each allowlisted wallet's Merkle proof privately. This replaces
-- publishing a proofs.json file, which would expose the full list and its
-- size to anyone.
--
-- Includes list_generation from the start (CrocPad added it later in a
-- separate migration that never made it into the repo, which broke the
-- admin upload route).

create table if not exists public.bunii_proofs (
  wallet_address  text primary key,
  proof           jsonb not null,
  list_generation text not null,
  created_at      timestamptz not null default now()
);

create index if not exists bunii_proofs_list_generation_idx
  on public.bunii_proofs (list_generation);

-- RLS on with NO policies: the anon key can't read or write this table at
-- all. Only the service_role key (server-side only) can, since it bypasses
-- RLS. Do not add a public select policy — that would expose the list.
alter table public.bunii_proofs enable row level security;
