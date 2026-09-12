-- Phase A, step 4 of docs/element-profile-merge-plan.md: roles, target
-- profiles, teams, invites, and the role-comparison cache, ported
-- unchanged from Element Profile's own schema files. Two of these
-- tables are ported in their current, later-amended shape, not their
-- original one:
--   - element_target_profiles includes `reasoning`, added in that
--     project's schema/011_add_reasoning_to_target_profiles.sql.
--   - element_teams includes `narrative`, `narrative_membership_signature`,
--     and `narrative_generated_at`, added in that project's
--     schema/010_add_narrative_cache_to_teams.sql.
-- Creating them with these columns from the start here is equivalent
-- to the original create-then-alter history there, just collapsed into
-- one step since there is no existing data to migrate around.
--
-- RLS is deliberately not enabled yet, same as every table so far in
-- this phase. That is Phase A, step 5.

create table if not exists element_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  job_description_source text,
  created_at timestamptz not null default now()
);

-- A role can have multiple target profile versions over time, but only
-- one "live" at a time. The draft/review distinction implements the
-- hybrid model: AI drafts from a job description, a human reviews
-- before it goes live.
create table if not exists element_target_profiles (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references element_roles(id) on delete cascade,
  drive smallint not null check (drive between 0 and 100),
  pace smallint not null check (pace between 0 and 100),
  people_orientation smallint not null check (people_orientation between 0 and 100),
  structure smallint not null check (structure between 0 and 100),
  composure smallint not null check (composure between 0 and 100),
  ambiguity_tolerance smallint not null check (ambiguity_tolerance between 0 and 100),
  source text not null check (source in ('ai_draft', 'human_built', 'empirical')),
  status text not null check (status in ('draft', 'live', 'archived')) default 'draft',
  reviewed_by uuid references people(id),
  created_at timestamptz not null default now(),
  reasoning text
);

create table if not exists element_teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  narrative jsonb,
  narrative_membership_signature text,
  narrative_generated_at timestamptz
);

-- Join table designed explicitly to support partial rosters and
-- incremental additions: adding one new hire later never requires
-- touching existing rows.
create table if not exists element_team_members (
  team_id uuid not null references element_teams(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (team_id, person_id)
);

-- Mirrors CARE 360's own raters table: a random token tied to one
-- specific invited person is the entire security boundary for taking
-- the assessment. No password, no session.
create table if not exists element_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  session_id uuid references element_sessions(id)
);

-- Caches the AI-generated person-vs-role comparison report, keyed by
-- person + role. A real Anthropic call is expensive enough that it
-- should only run again when the person's own scores or the role's
-- live target profile weights actually changed, not on every view.
create table if not exists element_role_comparisons (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  role_id uuid not null references element_roles(id) on delete cascade,
  report jsonb not null,
  signature text not null,
  generated_at timestamptz not null default now(),
  unique (person_id, role_id)
);
