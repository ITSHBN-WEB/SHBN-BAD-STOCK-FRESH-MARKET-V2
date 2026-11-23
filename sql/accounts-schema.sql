-- =====================================================================
-- DRS accounts, login and 30-minute inactivity timeout.
-- Run once in Supabase SQL Editor BEFORE publishing the new version.
--
-- Account passwords are stored readable on purpose, because Management
-- must be able to see them (Admin > Accounts). The tables have RLS on and
-- NO policies, so the browser can only use the functions below; it can
-- never read the tables directly.
-- Default password of an account: outlet short name + 1234,
-- e.g. SHBN1234 (Head Office: HO1234, Management: MG1234).
-- Users change their own password in the app; Management can reset any
-- account back to its default.
-- =====================================================================

create table if not exists drs_accounts (
  id          bigserial primary key,
  login_id    text not null,
  password    text not null,
  category    text not null check (category in ('Outlet','Head Office','Management')),
  plant       text,          -- outlet code of an Outlet account (separates its records)
  outlet_name text,          -- outlet name of an Outlet account (default password prefix)
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table drs_accounts add column if not exists outlet_name text;
create unique index if not exists drs_accounts_login_uq on drs_accounts (lower(login_id));

create table if not exists drs_sessions (
  token      uuid primary key default gen_random_uuid(),
  account_id bigint not null references drs_accounts(id) on delete cascade,
  last_seen  timestamptz not null default now()
);

alter table drs_accounts enable row level security;
alter table drs_sessions enable row level security;
revoke all on drs_accounts, drs_sessions from anon, authenticated;

-- ---------- helpers ----------
create or replace function drs_gen_password(p_category text, p_name text) returns text
language sql immutable as $$
  select case p_category when 'Head Office' then 'HO' when 'Management' then 'MG' else upper(coalesce(p_name, '')) end || '1234'
$$;

-- older installs: fill in the outlet name of the first three outlets
update drs_accounts set outlet_name = case plant when '1008' then 'SHBN' when '1015' then 'SHPL' when '1007' then 'SHPP' end
 where category = 'Outlet' and outlet_name is null;

-- returns the account row behind a live session (30 min inactivity), and refreshes the session
create or replace function drs_touch(p_token uuid) returns drs_accounts
language plpgsql security definer set search_path = public as $$
declare a drs_accounts;
begin
  delete from drs_sessions where last_seen < now() - interval '30 minutes';
  select acc.* into a from drs_sessions s join drs_accounts acc on acc.id = s.account_id
   where s.token = p_token and acc.active;
  if not found then return null; end if;
  update drs_sessions set last_seen = now() where token = p_token;
  return a;
end $$;

-- ---------- login / session ----------
create or replace function drs_login(p_login text, p_password text) returns json
language plpgsql security definer set search_path = public as $$
declare a drs_accounts; t uuid;
begin
  select * into a from drs_accounts
   where lower(login_id) = lower(trim(p_login)) and password = trim(p_password) and active;
  if not found then return null; end if;
  delete from drs_sessions where last_seen < now() - interval '30 minutes';
  insert into drs_sessions (account_id) values (a.id) returning token into t;
  return json_build_object('token', t, 'id', a.id, 'login_id', a.login_id, 'category', a.category, 'plant', a.plant, 'outlet_name', a.outlet_name);
end $$;

create or replace function drs_session(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare a drs_accounts;
begin
  a := drs_touch(p_token);
  if a.id is null then return null; end if;
  return json_build_object('token', p_token, 'id', a.id, 'login_id', a.login_id, 'category', a.category, 'plant', a.plant, 'outlet_name', a.outlet_name);
end $$;

-- any logged-in account changes its own password
create or replace function drs_change_password(p_token uuid, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public as $$
declare a drs_accounts; n text := trim(p_new);
begin
  a := drs_touch(p_token);
  if a.id is null then raise exception 'Your session has ended. Please log in again.'; end if;
  if a.password <> trim(p_old) then raise exception 'The current password is not correct.'; end if;
  if length(n) < 6 then raise exception 'The new password must be at least 6 characters.'; end if;
  if n ~ '\s' then raise exception 'The new password cannot contain spaces.'; end if;
  if n = a.password then raise exception 'The new password must be different from the current one.'; end if;
  update drs_accounts set password = n where id = a.id;
end $$;

create or replace function drs_logout(p_token uuid) returns void
language sql security definer set search_path = public as $$
  delete from drs_sessions where token = p_token
$$;

-- ---------- Management only ----------
-- every outlet that has an active Outlet account (any logged-in account may read this list)
create or replace function drs_outlets(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare a drs_accounts;
begin
  a := drs_touch(p_token);
  if a.id is null then raise exception 'Your session has ended. Please log in again.'; end if;
  return coalesce((select json_agg(json_build_object('plant', plant, 'name', nm) order by plant)
    from (select plant, min(outlet_name) as nm from drs_accounts where active and category = 'Outlet' and plant is not null group by plant) o), '[]'::json);
end $$;

create or replace function drs_account_list(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare a drs_accounts;
begin
  a := drs_touch(p_token);
  if a.id is null or a.category <> 'Management' then raise exception 'Not allowed'; end if;
  return coalesce((select json_agg(json_build_object('id', id, 'login_id', login_id, 'password', password,
            'category', category, 'plant', plant, 'outlet_name', outlet_name) order by id) from drs_accounts where active), '[]'::json);
end $$;

create or replace function drs_account_create(p_token uuid, p_login text, p_category text, p_plant text) returns json
language plpgsql security definer set search_path = public as $$
declare a drs_accounts; n drs_accounts; pw text; lg text := trim(p_login); v_plant text; v_name text; m text[];
begin
  a := drs_touch(p_token);
  if a.id is null or a.category <> 'Management' then raise exception 'Not allowed'; end if;
  if lg = '' then raise exception 'Enter a Login ID.'; end if;
  if p_category not in ('Outlet','Head Office','Management') then raise exception 'Choose a category.'; end if;
  -- Outlet access: the Login ID is "<4-digit outlet code>-<outlet name>", e.g. 1001-SHP.
  -- The code separates that outlet's records; the name is the default password prefix (SHP1234).
  if p_category = 'Outlet' then
    m := regexp_match(lg, '^([0-9]{4})-([A-Za-z0-9]+)');
    if m is null then
      raise exception 'An Outlet Login ID must look like 1001-SHP: a 4-digit outlet code, a dash, then the outlet name.';
    end if;
    v_plant := m[1]; v_name := upper(m[2]);
  end if;
  if exists (select 1 from drs_accounts where lower(login_id) = lower(lg)) then
    raise exception 'Login ID "%" already exists.', lg;
  end if;
  pw := drs_gen_password(p_category, v_name);
  insert into drs_accounts (login_id, password, category, plant, outlet_name)
    values (lg, pw, p_category, v_plant, v_name) returning * into n;
  return json_build_object('id', n.id, 'login_id', n.login_id, 'password', n.password, 'category', n.category, 'plant', n.plant, 'outlet_name', n.outlet_name);
end $$;

-- Management resets another account to its default password (outlet name + 1234)
create or replace function drs_account_reset(p_token uuid, p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare a drs_accounts; t drs_accounts; pw text;
begin
  a := drs_touch(p_token);
  if a.id is null or a.category <> 'Management' then raise exception 'Not allowed'; end if;
  if a.id = p_id then raise exception 'Use Change Password for your own account.'; end if;
  select * into t from drs_accounts where id = p_id and active;
  if not found then raise exception 'Account not found.'; end if;
  pw := drs_gen_password(t.category, t.outlet_name);
  update drs_accounts set password = pw where id = p_id;
  delete from drs_sessions where account_id = p_id;
  return json_build_object('login_id', t.login_id, 'password', pw);
end $$;

create or replace function drs_account_deactivate(p_token uuid, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a drs_accounts;
begin
  a := drs_touch(p_token);
  if a.id is null or a.category <> 'Management' then raise exception 'Not allowed'; end if;
  if a.id = p_id then raise exception 'You cannot deactivate the account you are logged in with.'; end if;
  update drs_accounts set active = false where id = p_id;
  delete from drs_sessions where account_id = p_id;
end $$;

grant execute on function drs_login(text, text), drs_session(uuid), drs_logout(uuid),
  drs_change_password(uuid, text, text), drs_account_reset(uuid, bigint),
  drs_outlets(uuid), drs_account_list(uuid), drs_account_create(uuid, text, text, text), drs_account_deactivate(uuid, bigint)
  to anon, authenticated;
revoke execute on function drs_touch(uuid) from public, anon, authenticated;

-- ---------- starting accounts (safe to re-run) ----------
insert into drs_accounts (login_id, password, category, plant, outlet_name) values
  ('1008-SHBN',  'SHBN1234', 'Outlet', '1008', 'SHBN'),
  ('1015-SHPL',  'SHPL1234', 'Outlet', '1015', 'SHPL'),
  ('1007-SHPP',  'SHPP1234', 'Outlet', '1007', 'SHPP'),
  ('Head_Office', 'HO1234', 'Head Office', null, null),
  ('Management', 'MG1133', 'Management', null, null)
on conflict do nothing;
-- Starting passwords: SHBN1234, SHPL1234, SHPP1234, HO1234, and MG1133 for Management.
-- Log in as Management and open Admin > Accounts to see or reset any account.
