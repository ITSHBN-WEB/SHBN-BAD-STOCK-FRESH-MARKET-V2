-- =====================================================================
-- DRS - Recent Masterlist Update Activity
-- Run ONCE in Supabase > SQL Editor, BEFORE publishing the new index.html.
-- Safe to re-run.
-- Existing items keep a blank created_at (so the 42k imported Goods rows
-- do not flood the activity list); only items added from now on are stamped.
-- =====================================================================
alter table masterlist       add column if not exists created_at  timestamptz;
alter table masterlist       add column if not exists added_plant text;
alter table masterlist       alter column created_at set default now();

alter table goods_masterlist add column if not exists created_at  timestamptz;
alter table goods_masterlist add column if not exists added_plant text;
alter table goods_masterlist alter column created_at set default now();

create index if not exists masterlist_created_at_idx       on masterlist       (created_at desc);
create index if not exists goods_masterlist_created_at_idx on goods_masterlist (created_at desc);
