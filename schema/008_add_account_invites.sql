-- Real teammate invites: a way to add a second real login to an
-- existing account, rather than the only path that exists today
-- (signUp() in src/auth.js, which always creates a brand new account).
-- The data model already supported more than one account_users row per
-- account_id, nothing ever wrote a second one.
--
-- Deliberately modeled on raters (schema/000): a plain nanoid token
-- stored directly on the row, looked up by exact match, with the row's
-- own state (accepted_at) as the validity check, same as raters use
-- completed_at. No signing, no JWT, no separate expiry column, matching
-- how simple that existing pattern already is.
--
-- account_users.auth_user_id is unique (one login, one account, ever),
-- so an invite sent to an email that already has a CARE 360 login
-- elsewhere cannot be accepted: that is enforced at the application
-- layer (src/routes/account.js), not here, but is the reason no
-- attempt is made in this schema to pre-validate the email.

create table if not exists account_invites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  email text not null,
  name text,
  token text unique not null,
  invited_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_account_invites_account on account_invites (account_id);
create index if not exists idx_account_invites_token on account_invites (token);

alter table account_invites enable row level security;

create policy "org members manage their own invites" on account_invites for all
  using (account_id = current_account_id())
  with check (account_id = current_account_id());
