-- =====================================================================
-- DRS - Enable Row Level Security (Option A: RLS on, anon allowed)
-- Run in Supabase > SQL Editor. Safe to re-run.
-- The app keeps working exactly as before. This does NOT stop someone
-- who has the publishable key from reading/changing data; it only
-- switches RLS on and makes the access rules explicit.
--
-- TIP: run STEP 1 for ONE table first (e.g. categories), test the app,
-- then run the rest. Rollback is at the bottom.
-- =====================================================================

-- ---------- STEP 1: tables that staff read, add to and edit ----------
-- Fresh Market + Goods records: app reads, inserts, updates AND deletes
-- (Admin delete, problem-PLU fixes, print gate).
do $$
declare t text;
begin
  foreach t in array array['bad_stock_fresh_market','bad_stock_goods'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "drs anon select" on %I', t);
    execute format('drop policy if exists "drs anon insert" on %I', t);
    execute format('drop policy if exists "drs anon update" on %I', t);
    execute format('drop policy if exists "drs anon delete" on %I', t);
    execute format('create policy "drs anon select" on %I for select to anon using (true)', t);
    execute format('create policy "drs anon insert" on %I for insert to anon with check (true)', t);
    execute format('create policy "drs anon update" on %I for update to anon using (true) with check (true)', t);
    execute format('create policy "drs anon delete" on %I for delete to anon using (true)', t);
  end loop;
end $$;

-- Masterlists: app reads, adds and edits items. It never deletes rows,
-- so no delete policy (deleting from the app/API is blocked).
do $$
declare t text;
begin
  foreach t in array array['masterlist','goods_masterlist'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "drs anon select" on %I', t);
    execute format('drop policy if exists "drs anon insert" on %I', t);
    execute format('drop policy if exists "drs anon update" on %I', t);
    execute format('create policy "drs anon select" on %I for select to anon using (true)', t);
    execute format('create policy "drs anon insert" on %I for insert to anon with check (true)', t);
    execute format('create policy "drs anon update" on %I for update to anon using (true) with check (true)', t);
  end loop;
end $$;

-- Categories: app reads and adds new ones; no edit/delete.
do $$
declare t text;
begin
  foreach t in array array['categories','goods_categories'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "drs anon select" on %I', t);
    execute format('drop policy if exists "drs anon insert" on %I', t);
    execute format('create policy "drs anon select" on %I for select to anon using (true)', t);
    execute format('create policy "drs anon insert" on %I for insert to anon with check (true)', t);
  end loop;
end $$;

-- ---------- STEP 2: the old Print Station queue (no longer used) ----------
-- RLS on with NO policy = nobody using the API key can touch it.
-- Skip this if the table does not exist in your project.
alter table if exists print_queue enable row level security;

-- ---------- STEP 3: check ----------
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

-- The daily retention jobs (pg_cron) run as the database owner and
-- are not affected by RLS.

-- =====================================================================
-- ROLLBACK (if the app misbehaves): turn RLS back off for a table
--   alter table bad_stock_fresh_market disable row level security;
-- =====================================================================
