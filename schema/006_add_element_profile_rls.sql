-- Phase A, step 5 (the final step) of docs/element-profile-merge-plan.md:
-- RLS for every Element Profile table that holds client data.
--
-- This is the one place this port deliberately does NOT match Element
-- Profile's own historical migrations byte for byte. Its original
-- policies (schema/005_add_account_users_and_rls.sql,
-- schema/012_add_element_role_comparisons.sql there) checked
-- organization_id against its own, now-retired account_users table:
--   organization_id in (select organization_id from account_users where auth_user_id = auth.uid())
-- That table doesn't exist here. account_users is CARE 360's real one,
-- keyed by account_id, not organization_id, and current_account_id()
-- already resolves auth.uid() to the caller's account_id in one place
-- rather than every policy repeating that lookup. The new shape is:
--   organization_id in (select id from organizations where account_id = current_account_id())
-- Since none of these tables hold any real data yet, there is no
-- transition to manage: this is simply the correct, final form,
-- written once.
--
-- element_archetypes and element_item_bank are shared reference data,
-- not client data (same reasoning as Element Profile's own schema/005),
-- and deliberately stay outside RLS.

alter table organizations enable row level security;
alter table people enable row level security;
alter table element_sessions enable row level security;
alter table element_responses enable row level security;
alter table element_scores enable row level security;
alter table element_roles enable row level security;
alter table element_target_profiles enable row level security;
alter table element_teams enable row level security;
alter table element_team_members enable row level security;
alter table element_invites enable row level security;
alter table element_role_comparisons enable row level security;

create policy "org members access their own organization" on organizations for all
  using (account_id = current_account_id())
  with check (account_id = current_account_id());

create policy "org members access their own people" on people for all
  using (organization_id in (select id from organizations where account_id = current_account_id()))
  with check (organization_id in (select id from organizations where account_id = current_account_id()));

create policy "org members access their own sessions" on element_sessions for all
  using (organization_id in (select id from organizations where account_id = current_account_id()))
  with check (organization_id in (select id from organizations where account_id = current_account_id()));

create policy "org members access responses for their own sessions" on element_responses for all
  using (exists (
    select 1 from element_sessions s
    where s.id = element_responses.session_id
      and s.organization_id in (select id from organizations where account_id = current_account_id())
  ))
  with check (exists (
    select 1 from element_sessions s
    where s.id = element_responses.session_id
      and s.organization_id in (select id from organizations where account_id = current_account_id())
  ));

create policy "org members access scores for their own sessions" on element_scores for all
  using (exists (
    select 1 from element_sessions s
    where s.id = element_scores.session_id
      and s.organization_id in (select id from organizations where account_id = current_account_id())
  ))
  with check (exists (
    select 1 from element_sessions s
    where s.id = element_scores.session_id
      and s.organization_id in (select id from organizations where account_id = current_account_id())
  ));

create policy "org members access their own roles" on element_roles for all
  using (organization_id in (select id from organizations where account_id = current_account_id()))
  with check (organization_id in (select id from organizations where account_id = current_account_id()));

create policy "org members access target profiles for their own roles" on element_target_profiles for all
  using (exists (
    select 1 from element_roles r
    where r.id = element_target_profiles.role_id
      and r.organization_id in (select id from organizations where account_id = current_account_id())
  ))
  with check (exists (
    select 1 from element_roles r
    where r.id = element_target_profiles.role_id
      and r.organization_id in (select id from organizations where account_id = current_account_id())
  ));

create policy "org members access their own teams" on element_teams for all
  using (organization_id in (select id from organizations where account_id = current_account_id()))
  with check (organization_id in (select id from organizations where account_id = current_account_id()));

create policy "org members access members of their own teams" on element_team_members for all
  using (exists (
    select 1 from element_teams t
    where t.id = element_team_members.team_id
      and t.organization_id in (select id from organizations where account_id = current_account_id())
  ))
  with check (exists (
    select 1 from element_teams t
    where t.id = element_team_members.team_id
      and t.organization_id in (select id from organizations where account_id = current_account_id())
  ));

create policy "org members access their own invites" on element_invites for all
  using (organization_id in (select id from organizations where account_id = current_account_id()))
  with check (organization_id in (select id from organizations where account_id = current_account_id()));

create policy "org members access comparisons for their own roles" on element_role_comparisons for all
  using (exists (
    select 1 from element_roles r
    where r.id = element_role_comparisons.role_id
      and r.organization_id in (select id from organizations where account_id = current_account_id())
  ))
  with check (exists (
    select 1 from element_roles r
    where r.id = element_role_comparisons.role_id
      and r.organization_id in (select id from organizations where account_id = current_account_id())
  ));
