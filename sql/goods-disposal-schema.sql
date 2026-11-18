-- =====================================================================
-- DRMS - Goods Disposal schema (run once in Supabase > SQL Editor)
-- Safe to re-run: every statement uses IF NOT EXISTS / ON CONFLICT.
-- Fresh Market tables (masterlist, bad_stock_fresh_market, categories)
-- are NOT touched.
-- =====================================================================

-- 1) Goods masterlist: one row per barcode (a Material repeats across
--    sales units: EA / CAR / BDL / PAC). Not unique on ean so a messy
--    42k-row import never fails; the app handles several matches.
create table if not exists goods_masterlist (
  id           bigint generated always as identity primary key,
  material     text not null,
  description  text,
  sales_unit   text,
  numerator    numeric,
  ean          text,
  department   text
);
create index if not exists goods_masterlist_ean_idx      on goods_masterlist (ean);
create index if not exists goods_masterlist_material_idx on goods_masterlist (material);

-- 2) Goods categories (separate from Fresh Market's `categories`)
create table if not exists goods_categories (
  id          bigint generated always as identity primary key,
  name        text unique not null,
  created_at  timestamptz default now()
);
insert into goods_categories (name) values
  ('Bad Stock Harrisons'),
  ('Bad Stock Supplier'),
  ('Bad Stock EG')
on conflict (name) do nothing;

-- 3) Goods transactions: one row per item, grouped by batch_id
--    (same model as bad_stock_fresh_market). status: pending | keyed_in
create table if not exists bad_stock_goods (
  id                bigint generated always as identity primary key,
  batch_id          text not null,
  entry_date        timestamptz not null default now(),
  category          text not null,
  staff             text,
  supervisor        text,
  ean               text,
  material          text,
  description       text,
  sales_unit        text,
  numerator         numeric,
  department        text,
  quantity          numeric not null,
  reason            text not null,          -- Damaged / Expired / Buy 1 Free 1 / Others
  plant             text not null,
  sloc              text default '1000',
  material_document text,
  key_in_by         text,
  key_in_date       timestamptz,
  status            text not null default 'pending',
  created_at        timestamptz default now()
);
create index if not exists bad_stock_goods_plant_status_idx on bad_stock_goods (plant, status);
create index if not exists bad_stock_goods_batch_idx        on bad_stock_goods (batch_id);
create index if not exists bad_stock_goods_matdoc_idx       on bad_stock_goods (material_document);

-- 4) Same access model as the Fresh Market tables (internal tool)
alter table goods_masterlist disable row level security;
alter table goods_categories disable row level security;
alter table bad_stock_goods  disable row level security;

-- 5) 2-year retention, same as Fresh Market (runs daily at 03:00)
select cron.schedule(
  'delete-old-goods-entries',
  '0 3 * * *',
  $$ delete from bad_stock_goods where created_at < now() - interval '2 years' $$
);
