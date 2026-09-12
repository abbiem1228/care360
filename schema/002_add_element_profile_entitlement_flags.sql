-- Phase A, step 1 of docs/element-profile-merge-plan.md: accounts
-- becomes the single tenant record shared by both products, so it
-- needs to know which of them a given client actually has. Both flags
-- were already anticipated as columns on Element Profile's own
-- organizations table (schema/001_initial_schema.sql in that repo,
-- has_care360/has_element_profile), sitting unused there. This is
-- where they actually belong once accounts is the shared root: one
-- source of truth per entitlement, not two tables each claiming to
-- know the answer.
--
-- has_care360 is backfilled true for every existing row: every account
-- that exists today is a CARE 360 customer by definition, since this
-- table predates Element Profile entirely. has_element_profile stays
-- false for all of them until a real organizations row is actually
-- linked to an account (Phase D of the merge plan), not before.
--
-- Applied directly against the live database on 2026-09-12, ahead of
-- this file, same as 001: this documents the change already made.
--
-- Unlike 001, the final statement here is a one-time historical
-- backfill, not something safe to blindly rerun indefinitely: it sets
-- has_care360 true for every row that exists at the moment it runs.
-- The two alter table statements are safely idempotent (if not
-- exists), but running the update again after new accounts exist that
-- are genuinely Element-Profile-only would incorrectly mark them as
-- CARE 360 customers too. It is included here to document what was
-- actually done to the 3 real accounts that existed on 2026-09-12
-- (In Good Company Collective, Elevate Actually, Soul2Sole), not as a
-- rule to keep applying.

alter table accounts add column if not exists has_care360 boolean not null default false;
alter table accounts add column if not exists has_element_profile boolean not null default false;

update accounts set has_care360 = true;
