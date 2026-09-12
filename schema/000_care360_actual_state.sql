-- CARE 360: the actual, live state of the database, extracted directly
-- from the real production Supabase project (a read-only session pooler
-- connection, information_schema/pg_catalog only, nothing written or
-- changed) on 2026-09-12, and re-verified against a fresh extraction
-- after 001_drop_account_usage_view.sql was applied, so what follows is
-- current, not a stale snapshot of an earlier moment.
--
-- This exists because the checked-in database_schema.sql only reflects
-- the original 7 tables (cycles, leaders, raters, responses, open_text,
-- start_stop_continue, reports). Everything else here, accounts,
-- account_users, custom_questions, custom_responses, custom_comments,
-- the account_id column on every one of the original 7 tables, the
-- current_account_id() function, and every RLS policy, was added
-- directly against the live database at some point and never captured
-- in any migration file until now. This database finally has a
-- reviewable source of truth instead of only living in the Supabase
-- dashboard.
--
-- This file is not itself a migration to run: it's a description of
-- current state, kept up to date as later numbered files change that
-- state (see 001, which is a real, re-runnable migration). A future
-- schema change for this project should be its own new numbered file,
-- additive from what's captured here, through this same schema/ folder.

-- ============================================================
-- ACCOUNTS (added post-launch, no prior migration file existed)
-- The tenant record: one per paying/trialing customer. Referenced by
-- account_id from every other table below.
-- ============================================================

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'trial',
  status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text,
  community_status text,
  community_note text,
  created_at timestamptz default now(),
  terms_accepted_at timestamptz
);
-- No CHECK constraint on plan or status live: 'trial'/'starter'/'growth'
-- (plan) and 'active'/'canceled'/'past_due' (status) are enforced only
-- at the application layer (src/routes/billing.js, src/routes/account.js),
-- not the database.

create table if not exists account_users (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'admin',
  created_at timestamptz default now()
);
-- No CHECK constraint on role live (default 'admin'; src/auth.js's
-- signUp explicitly inserts 'owner' instead, so both values exist in
-- practice with nothing in the database enforcing either).

-- ============================================================
-- ORIGINAL SURVEY TABLES, account_id added later
-- Column order and every other column below matches
-- database_schema.sql exactly except where noted; account_id is the
-- only addition to each of these 7 tables.
-- ============================================================

create table if not exists cycles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  client_name text,
  status text not null default 'draft',
  opens_at timestamptz,
  closes_at timestamptz,
  created_at timestamptz default now(),
  closed_notified_at timestamptz,
  account_id uuid not null references accounts(id) on delete cascade,
  custom_questions_label text
);

create table if not exists leaders (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid references cycles(id) on delete cascade,
  name text not null,
  title text,
  email text not null,
  department text,
  created_at timestamptz default now(),
  completion_notified_at timestamptz,
  account_id uuid not null references accounts(id) on delete cascade
);

create table if not exists raters (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid references leaders(id) on delete cascade,
  name text not null,
  email text not null,
  rater_group text not null,
  token text unique not null,
  completed_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz default now(),
  reminder_sent_at timestamptz,
  account_id uuid not null references accounts(id) on delete cascade
);

create table if not exists responses (
  id uuid primary key default gen_random_uuid(),
  rater_id uuid references raters(id) on delete cascade,
  leader_id uuid references leaders(id) on delete cascade,
  question_number integer not null,
  section text not null,
  score integer check (score >= 1 and score <= 5),
  created_at timestamptz default now(),
  account_id uuid not null references accounts(id) on delete cascade
);

create table if not exists open_text (
  id uuid primary key default gen_random_uuid(),
  rater_id uuid references raters(id) on delete cascade,
  leader_id uuid references leaders(id) on delete cascade,
  section text not null,
  response text,
  created_at timestamptz default now(),
  account_id uuid not null references accounts(id) on delete cascade
);

create table if not exists start_stop_continue (
  id uuid primary key default gen_random_uuid(),
  rater_id uuid references raters(id) on delete cascade,
  leader_id uuid references leaders(id) on delete cascade,
  start_text text,
  stop_text text,
  continue_text text,
  created_at timestamptz default now(),
  account_id uuid not null references accounts(id) on delete cascade
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid references leaders(id) on delete cascade,
  report_html text,
  report_data jsonb,
  generated_at timestamptz default now(),
  generated_by text,
  account_id uuid not null references accounts(id) on delete cascade
);

-- ============================================================
-- CUSTOM QUESTIONS (added post-launch, no prior migration file existed)
-- Per-Group optional questions, a separate scored section from the
-- five fixed CARE sections above.
-- ============================================================

create table if not exists custom_questions (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references cycles(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  position integer not null default 0,
  rater_text text not null,
  self_text text not null,
  created_at timestamptz default now()
);

create table if not exists custom_responses (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references custom_questions(id) on delete cascade,
  rater_id uuid not null references raters(id) on delete cascade,
  leader_id uuid not null references leaders(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  score integer not null check (score >= 1 and score <= 5),
  created_at timestamptz default now()
);

create table if not exists custom_comments (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references cycles(id) on delete cascade,
  rater_id uuid not null references raters(id) on delete cascade,
  leader_id uuid not null references leaders(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  response text not null,
  created_at timestamptz default now()
);
-- Note: custom_questions.account_id and custom_responses/custom_comments.
-- account_id are nullable live, unlike account_id on the 7 original
-- tables above (all NOT NULL). src/routes/custom-questions.js only sets
-- it "if (req.accountId) row.account_id = req.accountId", i.e. the
-- application does not guarantee it is always populated.

-- ============================================================
-- INDEXES (beyond the ones a PRIMARY KEY/UNIQUE constraint already
-- creates automatically)
-- ============================================================

create index if not exists idx_account_users_acct on account_users (account_id);
create index if not exists idx_account_users_auth on account_users (auth_user_id);
create index if not exists idx_custom_comments_leader on custom_comments (leader_id);
create index if not exists idx_custom_questions_cycle on custom_questions (cycle_id);
create index if not exists idx_custom_responses_leader on custom_responses (leader_id);
create index if not exists idx_custom_responses_rater on custom_responses (rater_id);
create index if not exists idx_cycles_acct on cycles (account_id);
create index if not exists idx_leaders_acct on leaders (account_id);
create index if not exists idx_leaders_cycle on leaders (cycle_id);
create index if not exists idx_raters_acct on raters (account_id);
create index if not exists idx_raters_leader on raters (leader_id);
create index if not exists idx_raters_token on raters (token);
create index if not exists idx_reports_acct on reports (account_id);
create index if not exists idx_responses_leader on responses (leader_id);
create index if not exists idx_responses_rater on responses (rater_id);
-- raters.token also carries a separate UNIQUE constraint (raters_token_key)
-- in addition to this plain index: both exist live, captured as-is.

-- ============================================================
-- account_usage VIEW: existed here, does not anymore.
-- It aggregated every account's name, plan, status, and usage counts
-- into one cross-tenant rollup, with no security_invoker setting (so it
-- ran with its owner's privileges, bypassing the RLS policies below
-- entirely) and a direct SELECT grant held by anon and authenticated,
-- meaning any signed-in customer, or an unauthenticated caller with
-- only the public anon key, could read every account's usage data
-- through it. A full search of src/ and public/ found no reference to
-- it anywhere, including in src/routes/hq.js, the one feature that
-- legitimately needs cross-account visibility, which computes the same
-- rollup independently via the service-role client and never queried
-- this view. Dropped on 2026-09-12 via 001_drop_account_usage_view.sql,
-- confirmed gone (a query against it now fails outright) and confirmed
-- hq.js's own queries still work unchanged. See that file for the full
-- account of what it was and why it was removed.
-- ============================================================

-- ============================================================
-- current_account_id(): the single function every RLS policy below
-- calls, rather than each policy repeating its own subquery against
-- account_users. Cleaner than Element Profile's equivalent (which
-- inlines "organization_id in (select ... from account_users where
-- auth_user_id = auth.uid())" directly in each policy), same idea.
-- ============================================================

create or replace function current_account_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select account_id
  from account_users
  where auth_user_id = auth.uid()
  limit 1;
$function$;

-- ============================================================
-- ROW LEVEL SECURITY
-- Every table below has RLS enabled live. Every policy is PERMISSIVE,
-- applies to all commands (ALL) and to the "public" pseudo-role (i.e.
-- every Postgres role, though the service role used by most of the
-- app's own queries bypasses RLS regardless of policy), with no
-- separate WITH CHECK clause (Postgres reuses the USING clause for
-- writes on an ALL policy when WITH CHECK is omitted).
-- ============================================================

alter table accounts enable row level security;
alter table account_users enable row level security;
alter table cycles enable row level security;
alter table leaders enable row level security;
alter table raters enable row level security;
alter table responses enable row level security;
alter table open_text enable row level security;
alter table start_stop_continue enable row level security;
alter table reports enable row level security;
alter table custom_questions enable row level security;
alter table custom_responses enable row level security;
alter table custom_comments enable row level security;

create policy "own_account" on accounts for all
  using (id = current_account_id());

create policy "own_users" on account_users for all
  using (account_id = current_account_id());

create policy "own_cycles" on cycles for all
  using (account_id = current_account_id());

create policy "own_leaders" on leaders for all
  using (account_id = current_account_id());

create policy "own_raters" on raters for all
  using (account_id = current_account_id());

create policy "own_responses" on responses for all
  using (account_id = current_account_id());

create policy "own_open_text" on open_text for all
  using (account_id = current_account_id());

create policy "own_ssc" on start_stop_continue for all
  using (account_id = current_account_id());

create policy "own_reports" on reports for all
  using (account_id = current_account_id());

create policy "own_custom_questions" on custom_questions for all
  using (account_id = current_account_id());

create policy "own_custom_responses" on custom_responses for all
  using (account_id = current_account_id());

create policy "own_custom_comments" on custom_comments for all
  using (account_id = current_account_id());
