-- =====================================================================
-- DRS - Unpost Material Document / Reverted Disposal
-- Run ONCE in Supabase > SQL Editor BEFORE publishing the new index.html.
-- Safe to re-run.
-- =====================================================================
alter table bad_stock_fresh_market add column if not exists reverted_at timestamptz;
alter table bad_stock_fresh_market add column if not exists reverted_doc text;
alter table bad_stock_goods        add column if not exists reverted_at timestamptz;
alter table bad_stock_goods        add column if not exists reverted_doc text;

-- If a CHECK constraint limits "status" to pending/unresolved/keyed_in,
-- remove it so the new status 'reverted' is allowed.
do $$
declare r record;
begin
  for r in
    select c.conname, c.conrelid::regclass as tbl
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in ('bad_stock_fresh_market'::regclass, 'bad_stock_goods'::regclass)
      and pg_get_constraintdef(c.oid) ilike '%status%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;
