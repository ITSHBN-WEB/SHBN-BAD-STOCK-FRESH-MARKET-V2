-- =====================================================================
-- DRS - Reference Numbers + Deleted Disposal Record
-- Run ONCE in Supabase > SQL Editor BEFORE publishing the new files.
-- Safe to re-run.
--
-- Reference Number = plant + MMYY + disposal id + 3-digit sequence
--   e.g. 1008112601001  (1008 / 1126 = Nov 2026 / 01 = Fresh Market / 001)
-- Disposal id: 01 = Fresh Market, 02 = Goods. The sequence restarts at 001
-- on the 1st of every month (Malaysia time), per outlet and disposal type.
-- =====================================================================

alter table bad_stock_fresh_market add column if not exists ref_no text;
alter table bad_stock_fresh_market add column if not exists deleted_at timestamptz;
alter table bad_stock_goods        add column if not exists ref_no text;
alter table bad_stock_goods        add column if not exists deleted_at timestamptz;

create index if not exists bad_stock_fresh_market_ref_no_idx on bad_stock_fresh_market (ref_no);
create index if not exists bad_stock_goods_ref_no_idx        on bad_stock_goods (ref_no);

-- Make sure no CHECK constraint blocks the new 'deleted' status.
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

-- One counter row per outlet + month + disposal type.
create table if not exists drs_ref_counter (
  plant    text not null,
  ym       text not null,
  disposal text not null,
  last_seq int  not null default 0,
  primary key (plant, ym, disposal)
);
-- RLS on with no policies: the app can only reach it through the function below.
alter table drs_ref_counter enable row level security;

-- Hands out the next number. The upsert is atomic, so two devices submitting
-- at the same moment can never receive the same sequence.
create or replace function drs_next_ref(p_plant text, p_disposal text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ym  text := to_char(now() at time zone 'Asia/Kuala_Lumpur', 'MMYY');
  v_seq int;
begin
  if p_plant not in ('1008', '1015', '1007') then
    raise exception 'Unknown outlet %', p_plant;
  end if;
  if p_disposal not in ('01', '02') then
    raise exception 'Unknown disposal id %', p_disposal;
  end if;

  insert into drs_ref_counter (plant, ym, disposal, last_seq)
  values (p_plant, v_ym, p_disposal, 1)
  on conflict (plant, ym, disposal)
  do update set last_seq = drs_ref_counter.last_seq + 1
  returning last_seq into v_seq;

  if v_seq > 999 then
    raise exception 'Reference Number sequence is full (999) for % % %', p_plant, v_ym, p_disposal;
  end if;

  return p_plant || v_ym || p_disposal || lpad(v_seq::text, 3, '0');
end $$;

revoke all on function drs_next_ref(text, text) from public;
grant execute on function drs_next_ref(text, text) to anon, authenticated;
