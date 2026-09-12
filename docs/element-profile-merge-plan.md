# Migration Plan: Element Profile Schema → CARE 360's Real Project

This is a plan only. Nothing below has been executed. It reflects your five decisions exactly, plus a few places where those decisions leave a gap I had to resolve or flag rather than silently guess past.

## Target end state, restated

- CARE 360's Supabase project is the one physical database both products live in.
- `accounts` (CARE 360) is the single tenant record. It gains `has_care360` and `has_element_profile` (both already anticipated as comments in Element Profile's own `schema/001_initial_schema.sql`, currently sitting unused on `organizations` instead).
- `account_users` (CARE 360's real one) is the single login-identity table. Element Profile's own `account_users` (`schema/005_add_account_users_and_rls.sql`) is retired outright, not merged, not kept as a shadow copy.
- `organizations` (Element Profile) stays a genuinely separate table from `accounts`, gains `account_id uuid references accounts(id)`, and becomes Element Profile's own tenant-scoped record, linked to but distinct from the CARE 360 tenant record.
- Every `element_*` table (`element_sessions`, `element_responses`, `element_scores`, `element_archetypes`, `element_roles`, `element_target_profiles`, `element_teams`, `element_team_members`, `element_invites`, `element_item_bank`, `element_role_comparisons`) moves into CARE 360's project unchanged in name and shape. `people` moves unchanged too (no collision with anything in CARE 360).

## A decision I made that you didn't explicitly specify — flagging before anything else

You said `accounts` "gains" the two entitlement flags "already anticipated in the documentation." Those flags currently already exist, live, on Element Profile's `organizations` table. Your instructions don't say what happens to `organizations.has_care360`/`has_element_profile` once `accounts` has its own copies.

**I'm planning to drop them from `organizations`** once the `account_id` link exists, rather than keep both. Two independent booleans claiming to answer the same question ("does this client have Element Profile?") is exactly the kind of drift this whole investigation was started to close, not reopen. If you'd rather keep `organizations.has_element_profile` as a local cache for some reason, say so and I'll adjust the sequence below — it's a one-step change either way.

## Two more decisions

**The product/purchase page offers three genuine first-choice options at initial purchase: CARE 360 alone, Element Profile alone, or the bundle**, not individual products with bundling only available as a later upgrade. Someone who picks the bundle up front gets an `accounts` row with both `has_care360` and `has_element_profile` true from the moment their account is created, both products provisioned together at signup, not one now and the other added afterward.

**The in-dashboard "Add [Product]" action is specifically for the other path: someone who purchased one product individually and later decides to add the other.** It happens from inside an authenticated session, never through the public purchase page. An account already signed in to either product gets a real, in-app action, "Add Element Profile" on CARE 360's side, "Add CARE 360" on Element Profile's side, that links a new `organizations` row (or the CARE 360 equivalent) to their existing `account_id` directly. This replaces the "does this signup email already match an existing account" branching Phase C step 12 originally described, and it's a better answer, not just a simpler one: there's nothing to match, because the person is already authenticated as that account.

These are two distinct paths to the same end state, never confused for each other: the purchase page always creates a fresh account, provisioned with whatever combination was actually bought; "Add [Product]" always acts on an account that already exists, in-session, never at purchase time.

**Both products show a small, persistent, entitlement-aware reminder, visible only to an account missing one of the two products, and it disappears entirely once an account has both.** A quiet banner pointing toward the "Add [Product]" action above, shown to a CARE 360 account where `has_element_profile = false`, and to an Element Profile account whose linked account has `has_care360 = false`. The moment both flags are true, it simply stops rendering. No dismissal state to track, no separate table.

The data this needs already exists, live, as of this morning's Phase A work: `has_care360` and `has_element_profile` on `accounts` (`schema/002`) are exactly the two booleans this reminder reads. That has a real, asymmetric consequence for build order: **CARE 360's half of this ("Add Element Profile") is buildable right now, today, independent of every later phase** — it already knows, for every real account, whether `has_element_profile` is true or false. Element Profile's half ("Add CARE 360") can't exist until an organization is actually linked to an account, which depends on Phase C's "Add [Product]" action existing first (or Phase D's migration, for accounts migrated with the link already in place).

## The auth-identity problem, the single biggest risk in this plan

**Confirmed with the project owner: no real customer currently has accounts in both products, only the owner's own testing.** This means Phase D's reconciliation step (16-17 below) will only ever need to handle a small, known set of accounts, not ambiguous real-customer matching, when the actual migration happens. The mechanical risk described below (Supabase Auth being project-scoped) is unchanged and the spike is still needed, but the scale of what it has to reconcile is far smaller than "real customer data" implies.

Supabase Auth users are **project-scoped**. `auth.users` in Element Profile's project and `auth.users` in CARE 360's project are two entirely separate tables with no relationship. Moving to "one shared home" doesn't just mean moving rows between Postgres tables — it means every Element Profile admin's actual login has to be re-created inside CARE 360's project, and reconciled against whether that same person already has a CARE 360 login (same email, different `auth.users` row, different `account_users` row, today).

This needs its own spike before Phase D below can be scheduled for real: confirming exactly how Supabase's Admin API handles re-creating a user with a known password hash versus forcing a reset, and building the actual email-matching logic that decides "this Element Profile admin already has a CARE 360 account" vs. "this is a brand new tenant." I'm calling this out prominently because it's easy to plan the schema side of this migration cleanly and then discover the auth side blocks the whole cutover.

## The full sequence

**Phase A — Additive changes to CARE 360, zero risk, can run anytime**

1. `care360/schema/002_add_element_profile_entitlement_flags.sql` — add `has_care360 boolean not null default false`, `has_element_profile boolean not null default false` to `accounts`. Backfill `has_care360 = true` for every existing row (they're all CARE 360 customers today by definition). `has_element_profile` stays `false` for all of them until Phase D links a real org to them.
2. `care360/schema/003_add_element_profile_organizations_and_people.sql` — create `organizations` (with `account_id uuid references accounts(id) on delete restrict` — deliberately not `cascade`: deleting a CARE 360 account should never silently cascade-delete an Element Profile org without a human noticing) and `people`, ported unchanged from Element Profile's own `001`.
3. `care360/schema/004_add_element_profile_core_tables.sql` — `element_sessions`, `element_responses`, `element_scores`, `element_archetypes` (+ seed data from Element Profile's `002`), `element_item_bank` (+ seed from `003`).
4. `care360/schema/005_add_element_profile_roles_and_teams.sql` — `element_roles`, `element_target_profiles`, `element_teams`, `element_team_members`, `element_invites`, `element_role_comparisons`.
5. `care360/schema/006_add_element_profile_rls.sql` — RLS for every table above. This is where the real structural change lives: every policy that used to read `organization_id in (select organization_id from account_users where auth_user_id = auth.uid())` now reads `organization_id in (select id from organizations where account_id = current_account_id())`, reusing CARE 360's existing function instead of duplicating Element Profile's old inline pattern. Since none of this has any data in it yet, there's no legacy-pattern transition to manage — write it correctly once.

Nothing in Phase A touches an existing CARE 360 row except the two new nullable-with-default columns in step 1. CARE 360's own tables, policies, and application are unaffected.

**Phase B — Disposable-data testing, before anything real is at stake**

This runs entirely inside CARE 360's real project, using the same throwaway-account discipline as every test this session (a real confirmed Supabase Auth user, a real `accounts` row, deleted and re-confirmed at zero afterward), because Phase A already put the real target schema in the real target project — there's no separate sandbox to test against.

6. Create 2-3 throwaway `accounts` + `account_users` + linked `organizations` rows.
7. Rewrite `test-rls-boundary.js`'s actual test logic (not just re-run it) for the new policy shape, and run it against these throwaway accounts: two different throwaway tenants, confirm one still can't read, update, or insert into the other's `organizations`/`people`/`element_*` data through the new `current_account_id()`-based policies. This is the one test that must genuinely re-prove something, since the mechanism underneath changed even though the guarantee didn't.
8. Re-verify every feature built this session end-to-end against a throwaway account under the new schema: role creation + AI draft, review/approval + one-live-profile enforcement, the person-vs-role comparison report + its caching. Not because the feature logic changed, but because the RLS wiring underneath every one of them did.
9. Specifically test the scenario your decisions create that didn't exist before: a throwaway account that already has `has_care360 = true` (simulate an existing CARE 360 customer) getting a linked `organizations` row added and `has_element_profile` flipped to `true` on the same account, confirming nothing about their existing CARE 360 access changes.
10. Delete all throwaway data, re-confirm zero residue.

**Phase C — Application code changes (Element Profile's server)**

Not schema, but load-bearing and must land in the same deploy as the cutover, not before or after:

11. Rewrite Element Profile's session-attachment logic (its `auth.js`-equivalent) to resolve `organizationId` via `account_users → accounts → organizations`, not the old direct `account_users(organization_id)` shape. A draft of exactly this change already exists (`docs/phase-c-auth-draft-patch.diff`), applied and verified once during Phase B testing, then reverted since Phase C hadn't been reached yet.
12. Build the "Add [Product]" action described above: reachable only from inside an authenticated session, never the public purchase page. On Element Profile's side, it links a new `organizations` row to the current session's existing `account_id`. This is strictly the add-later path, for an account that purchased one product individually; it resolves what was previously an open UX question about email-matching at signup time, since there's no matching left to do. The purchase page's three-option flow (CARE 360 alone, Element Profile alone, or the bundle) is separate work, not detailed here: whichever combination is bought there provisions both entitlement flags at account creation, so a bundle purchase never touches this action at all.
13. Build the entitlement-aware reminder described above. CARE 360's half can be built and shipped independently, right now, ahead of the rest of this plan, since the data it needs (`has_element_profile` on `accounts`) already exists live. Element Profile's half depends on step 12 existing first.
14. Point Element Profile's Railway environment (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) at CARE 360's project. This is the actual cutover moment and must happen atomically with deploying steps 11-13's code, and only after real data (Phase D) is already in place, not before.

**Phase D — Real data migration, the only phase that touches real accounts**

Only begins after Phase B has passed cleanly and the auth-identity spike from earlier has a confirmed mechanism.

15. Maintenance window: Element Profile's current app goes read-only.
16. Export every row from every Element Profile table in its own (old) project.
17. For each real `organizations` row: resolve its `account_id` — match against an existing CARE 360 `accounts` row by a human-reviewed signal (likely organization name or admin email domain, since no existing key links these today), or create a fresh `accounts` row if there's no match. **This step is a reconciliation exercise, not a script** — flag every ambiguous match for a human to confirm rather than guessing. This is a one-time historical migration step, distinct from step 12's ongoing "Add [Product]" action: it exists only because these specific rows predate that action existing at all.
18. Migrate every affected admin's Supabase Auth identity into CARE 360's project per whatever mechanism the auth spike settled on, reusing an existing CARE 360 login where the email already matches one.
19. Insert `organizations`, then `people`, then everything else, in FK-dependency order, preserving every UUID exactly as-is (all PKs are `gen_random_uuid()`, so this is safe).
20. Verify row counts match old vs. new, table by table.
21. Execute Phase C (cutover + code deploy) as one atomic step.
22. Smoke-test with one real admin login immediately after.
23. Keep the old Element Profile Supabase project fully intact and untouched for a real retention window (30 days, minimum) as a cold rollback, not deleted the moment the new one looks fine.

**Phase E — Cleanup, only after the retention window passes with no issues**

24. Drop `organizations.has_care360`/`has_element_profile` (per the decision flagged above).
25. Mark Element Profile's own `schema/` folder as historical in its own README; CARE 360's `schema/` folder is canonical from here forward for both products.
26. Decommission the old Element Profile Supabase project.

## Where I'd want your explicit go-ahead again before touching anything

Phase A is genuinely additive and safe to schedule whenever you want — I'd treat that as the first thing to actually execute, separately from everything after it. Phase B needs nothing from you beyond "proceed." Phase C steps 12-13 no longer need a product decision before they're built, that's resolved above, they just need building. Phase D needs the auth-migration spike resolved first, and needs its own explicit go-ahead the same way dropping `account_usage` did, since it's the only phase touching real customer data and real logins.
