-- Migration: rejections table for test gallery v1
-- Run this in the Supabase SQL editor BEFORE using the reject button.
--
-- Stores structured bug reports from the test gallery. User clicks ✗ on a
-- broken stamp, picks a reason chip, and a row lands here. Claude queries
-- this table at session start to read patterns and fix engine bugs.

create table if not exists public.rejections (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  combo       jsonb not null,            -- { SHAPE, ROWS, FRAME, FILL, COLOR, FONT, STYLE, CORNERS, TEXTURE, TILT }
  reason      text not null,             -- chip key: 'text_clipping' | 'border_break' | 'low_contrast' | 'decoration_intrudes' | 'corner_artifact' | 'nan' | 'other'
  notes       text,                      -- optional free-text
  session_id  text,                      -- groups rejects from one batch run
  rejected_at timestamptz not null default now(),
  rejected_by text                       -- email of admin who rejected
);

-- Index for the common query: "show me the latest rejections"
create index if not exists rejections_rejected_at_idx on public.rejections (rejected_at desc);

-- Index for clustering by reason
create index if not exists rejections_reason_idx on public.rejections (reason);

-- Allow inserts from authenticated admin users only.
-- (Adjust to your auth model — for now allow anon since /admin already gates access.)
alter table public.rejections enable row level security;

-- Permissive insert/select policy for now — admin route gates access at app layer.
-- Tighten later if needed.
drop policy if exists "rejections_insert_anon" on public.rejections;
create policy "rejections_insert_anon" on public.rejections
  for insert with check (true);

drop policy if exists "rejections_select_anon" on public.rejections;
create policy "rejections_select_anon" on public.rejections
  for select using (true);
