-- Phase A, step 2 of docs/element-profile-merge-plan.md: organizations
-- and people, ported from Element Profile's own
-- schema/001_initial_schema.sql, with one deliberate change.
--
-- organizations gains account_id, linking it to this project's real
-- accounts table (the entitlement flags added in 002). It drops the
-- has_care360/has_element_profile columns Element Profile's own copy
-- carried: those now live on accounts as the single source of truth,
-- per the decision noted in the merge plan, so organizations does not
-- keep a second, independently-driftable copy of the same answer.
-- account_id is `on delete restrict`, not cascade: deleting a CARE 360
-- account should never silently delete an Element Profile organization
-- without a human noticing.
--
-- people is unchanged from Element Profile's own definition: the
-- individuals being assessed, scoped to one organization, distinct
-- from account_users (who can log in and administer).
--
-- RLS is deliberately not enabled yet. That is its own step (Phase A,
-- step 5 in the merge plan), so these tables are created here without
-- policies on purpose, not by oversight.

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  stripe_customer_id text,
  account_id uuid not null references accounts(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  unique (organization_id, email)
);
