-- Remark captured when Admin deletes a pending / reverted record that has a Reference Number.
-- Run once in Supabase SQL Editor BEFORE publishing the new version.
alter table bad_stock_fresh_market add column if not exists delete_remark text;
alter table bad_stock_goods        add column if not exists delete_remark text;
