// Permanent regression test for the RLS boundary around Element
// Profile's tables now that they live in CARE 360's real project,
// rewritten from Element Profile's own test-rls-boundary.js rather
// than just re-run: that original test checked policies keyed off
// Element Profile's own, now-retired account_users table
// (organization_id in (select organization_id from account_users
// where auth_user_id = auth.uid())). The real, current policies (see
// schema/006_add_element_profile_rls.sql) are keyed off this project's
// own current_account_id() function and an organizations lookup
// instead, so the actual condition being proven here is different, not
// just the same test re-run against a new database.
//
// Creates three throwaway accounts with real, confirmed Supabase Auth
// users (not hand-crafted tokens), signs each in for a genuine access
// token, and proves:
//   1. Tenant A cannot read, update, or insert into Tenant B's
//      organizations, people, or element_* data (both the tables that
//      carry organization_id directly and the ones whose policy joins
//      through element_roles instead).
//   2. Tenant A still reads its own data normally (a sanity check,
//      without which a bug that blocked everything, not just the
//      boundary, would look identical to a passing test above).
//   3. The scenario this whole migration was built around: an account
//      that already has has_care360 = true (an existing real CARE 360
//      customer) keeps its existing CARE 360 access completely
//      unchanged before and after a new organizations row is linked to
//      it and has_element_profile is flipped true, and its new Element
//      Profile access is genuinely scoped to it, not to anyone else's.
//
// Creates and tears down all of its own data every run, mirroring
// test-rls-boundary.js's own discipline exactly.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnv(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
loadEnv(path.join(__dirname, '..', '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const RUN_ID = Date.now().toString(36);
const PASSWORD = `RlsBoundary-${RUN_ID}-!Aa1`;

async function createTenant(label, opts = {}) {
  const { data: account, error: accountErr } = await admin
    .from('accounts')
    .insert({ name: `RLS Boundary Test ${label} ${RUN_ID}`, has_care360: !!opts.hasCare360 })
    .select()
    .single();
  if (accountErr) throw accountErr;

  const email = `rls-boundary-test-${label.toLowerCase()}-${RUN_ID}@ingoodcocollective.com`;
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (authErr) throw authErr;

  const { error: linkErr } = await admin.from('account_users').insert({
    account_id: account.id, auth_user_id: authUser.user.id, email, name: `RLS Boundary Test ${label}`, role: 'owner',
  });
  if (linkErr) throw linkErr;

  return { account, authUserId: authUser.user.id, email };
}

async function signInClient(email) {
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

async function main() {
  const created = { accountIds: [], authUserIds: [] };
  const results = [];

  try {
    // ── Set up Tenant A and Tenant B, each a real account with a real
    // confirmed admin and a linked organization, plus a role, a target
    // profile, and a person under Tenant B specifically for A to try
    // reaching.
    const tenantA = await createTenant('A');
    const tenantB = await createTenant('B');
    created.accountIds.push(tenantA.account.id, tenantB.account.id);
    created.authUserIds.push(tenantA.authUserId, tenantB.authUserId);

    const { data: orgA, error: orgAErr } = await admin.from('organizations')
      .insert({ name: `Org A ${RUN_ID}`, account_id: tenantA.account.id }).select().single();
    if (orgAErr) throw orgAErr;

    const { data: orgB, error: orgBErr } = await admin.from('organizations')
      .insert({ name: `Org B ${RUN_ID}`, account_id: tenantB.account.id }).select().single();
    if (orgBErr) throw orgBErr;

    const { data: roleB, error: roleBErr } = await admin.from('element_roles')
      .insert({ organization_id: orgB.id, name: `Role B ${RUN_ID}` }).select().single();
    if (roleBErr) throw roleBErr;

    const { data: targetB, error: targetBErr } = await admin.from('element_target_profiles')
      .insert({
        role_id: roleB.id, drive: 50, pace: 50, people_orientation: 50, structure: 50, composure: 50, ambiguity_tolerance: 50,
        source: 'human_built', status: 'draft',
      }).select().single();
    if (targetBErr) throw targetBErr;

    const { data: personB, error: personBErr } = await admin.from('people')
      .insert({ organization_id: orgB.id, email: `person-b-${RUN_ID}@ingoodcocollective.com`, full_name: 'Person B' })
      .select().single();
    if (personBErr) throw personBErr;

    // ── Sign in as Tenant A's real admin, exactly like the app itself
    // does, for a genuine RLS-scoped client.
    const clientA = await signInClient(tenantA.email);

    // Check 1: read organizations (the root of the new policy chain).
    const { data: readOrg, error: readOrgErr } = await clientA.from('organizations').select('*').eq('id', orgB.id);
    results.push({
      label: "Read another tenant's organization",
      pass: !readOrgErr && readOrg.length === 0,
      detail: readOrgErr ? readOrgErr.message : `${readOrg.length} row(s) returned`,
    });

    // Check 2: update organizations.
    const { data: updateOrg, error: updateOrgErr } = await clientA.from('organizations')
      .update({ name: 'Hijacked' }).eq('id', orgB.id).select();
    results.push({
      label: "Update another tenant's organization",
      pass: !updateOrgErr && (!updateOrg || updateOrg.length === 0),
      detail: updateOrgErr ? updateOrgErr.message : `${(updateOrg || []).length} row(s) updated`,
    });

    // Check 3: insert into people under another tenant's organization
    // (a table whose policy carries organization_id directly).
    const { error: insertPersonErr } = await clientA.from('people')
      .insert({ organization_id: orgB.id, email: `injected-${RUN_ID}@ingoodcocollective.com` });
    results.push({
      label: "Insert a person into another tenant's organization",
      pass: !!insertPersonErr,
      detail: insertPersonErr ? insertPersonErr.message : 'insert succeeded (should have been rejected)',
    });

    // Check 4: read people under another tenant's organization.
    const { data: readPerson, error: readPersonErr } = await clientA.from('people').select('*').eq('id', personB.id);
    results.push({
      label: "Read a person from another tenant's organization",
      pass: !readPersonErr && readPerson.length === 0,
      detail: readPersonErr ? readPersonErr.message : `${readPerson.length} row(s) returned`,
    });

    // Check 5: read element_roles (a table whose policy carries
    // organization_id directly).
    const { data: readRole, error: readRoleErr } = await clientA.from('element_roles').select('*').eq('id', roleB.id);
    results.push({
      label: "Read another tenant's element_roles row",
      pass: !readRoleErr && readRole.length === 0,
      detail: readRoleErr ? readRoleErr.message : `${readRole.length} row(s) returned`,
    });

    // Check 6: read element_target_profiles (a table whose policy
    // joins through element_roles instead of carrying organization_id
    // itself, the other policy shape used in schema/006).
    const { data: readTarget, error: readTargetErr } = await clientA.from('element_target_profiles').select('*').eq('id', targetB.id);
    results.push({
      label: "Read another tenant's element_target_profiles row (joined through element_roles)",
      pass: !readTargetErr && readTarget.length === 0,
      detail: readTargetErr ? readTargetErr.message : `${readTarget.length} row(s) returned`,
    });

    // Sanity check: Tenant A can still read its own organization
    // normally. Without this, a bug that blocked everything (not just
    // the boundary) would look identical to every check above passing.
    const { data: ownOrg, error: ownOrgErr } = await clientA.from('organizations').select('*').eq('id', orgA.id);
    results.push({
      label: "Still reads its own organization",
      pass: !ownOrgErr && ownOrg.length === 1,
      detail: ownOrgErr ? ownOrgErr.message : `${ownOrg.length} row(s) returned`,
    });

    // ── The scenario this migration was built around: Tenant C
    // already has has_care360 = true and a real CARE 360 cycle, before
    // any Element Profile organization is linked to it.
    const tenantC = await createTenant('C', { hasCare360: true });
    created.accountIds.push(tenantC.account.id);
    created.authUserIds.push(tenantC.authUserId);

    const { data: cycleC, error: cycleCErr } = await admin.from('cycles')
      .insert({ name: `Cycle C ${RUN_ID}`, account_id: tenantC.account.id, status: 'draft' }).select().single();
    if (cycleCErr) throw cycleCErr;

    const clientC = await signInClient(tenantC.email);

    // Before: C's real CARE 360 access works, and C has no Element
    // Profile organization yet at all.
    const { data: cycleBefore, error: cycleBeforeErr } = await clientC.from('cycles').select('*').eq('id', cycleC.id);
    results.push({
      label: "[Existing CARE 360 customer] Reads its own CARE 360 data, before any Element Profile link",
      pass: !cycleBeforeErr && cycleBefore.length === 1,
      detail: cycleBeforeErr ? cycleBeforeErr.message : `${cycleBefore.length} row(s) returned`,
    });

    const { data: orgBeforeLink, error: orgBeforeErr } = await clientC.from('organizations').select('*');
    results.push({
      label: "[Existing CARE 360 customer] Has no organizations row yet, before linking",
      pass: !orgBeforeErr && orgBeforeLink.length === 0,
      detail: orgBeforeErr ? orgBeforeErr.message : `${orgBeforeLink.length} row(s) returned`,
    });

    // The actual migration step being tested: link a new organizations
    // row to Tenant C's existing account, flip has_element_profile.
    const { data: orgC, error: orgCErr } = await admin.from('organizations')
      .insert({ name: `Org C ${RUN_ID}`, account_id: tenantC.account.id }).select().single();
    if (orgCErr) throw orgCErr;
    const { error: flipErr } = await admin.from('accounts').update({ has_element_profile: true }).eq('id', tenantC.account.id);
    if (flipErr) throw flipErr;

    // After: the same CARE 360 access, unchanged.
    const { data: cycleAfter, error: cycleAfterErr } = await clientC.from('cycles').select('*').eq('id', cycleC.id);
    results.push({
      label: "[Existing CARE 360 customer] Still reads the same CARE 360 data, unchanged, after linking",
      pass: !cycleAfterErr && cycleAfter.length === 1,
      detail: cycleAfterErr ? cycleAfterErr.message : `${cycleAfter.length} row(s) returned`,
    });

    // After: C's new Element Profile access is genuinely there, and
    // genuinely scoped to only its own organization.
    const { data: orgAfterLink, error: orgAfterErr } = await clientC.from('organizations').select('*');
    results.push({
      label: "[Existing CARE 360 customer] Now reads exactly its own new organization, after linking",
      pass: !orgAfterErr && orgAfterLink.length === 1 && orgAfterLink[0].id === orgC.id,
      detail: orgAfterErr ? orgAfterErr.message : `${orgAfterLink.length} row(s) returned`,
    });

    // After: C still cannot see Tenant A's or Tenant B's organizations,
    // isolation holds for the newly-linked tenant too.
    const { data: orgCrossA, error: orgCrossAErr } = await clientC.from('organizations').select('*').eq('id', orgA.id);
    const { data: orgCrossB, error: orgCrossBErr } = await clientC.from('organizations').select('*').eq('id', orgB.id);
    results.push({
      label: "[Existing CARE 360 customer] Still isolated from Tenant A and Tenant B after linking",
      pass: !orgCrossAErr && !orgCrossBErr && orgCrossA.length === 0 && orgCrossB.length === 0,
      detail: `A: ${orgCrossAErr ? orgCrossAErr.message : orgCrossA.length + ' row(s)'}, B: ${orgCrossBErr ? orgCrossBErr.message : orgCrossB.length + ' row(s)'}`,
    });

    const passCount = results.filter((r) => r.pass).length;
    console.log(`Element Profile RLS boundary (CARE 360 project): ${passCount}/${results.length} passed\n`);
    results.forEach((r) => {
      const status = r.pass ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${r.label.padEnd(75)} ${r.detail}`);
    });

    if (passCount !== results.length) {
      process.exitCode = 1;
    }
  } finally {
    // ── Always clean up, even on failure.
    const { data: orgs } = await admin.from('organizations').select('id').in('account_id', created.accountIds);
    const orgIds = (orgs || []).map((o) => o.id);
    if (orgIds.length) {
      const { data: roles } = await admin.from('element_roles').select('id').in('organization_id', orgIds);
      const roleIds = (roles || []).map((r) => r.id);
      if (roleIds.length) await admin.from('element_target_profiles').delete().in('role_id', roleIds);
      await admin.from('element_roles').delete().in('organization_id', orgIds);
      await admin.from('people').delete().in('organization_id', orgIds);
      await admin.from('organizations').delete().in('id', orgIds);
    }
    await admin.from('cycles').delete().in('account_id', created.accountIds);
    for (const authUserId of created.authUserIds) {
      await admin.from('account_users').delete().eq('auth_user_id', authUserId);
      await admin.auth.admin.deleteUser(authUserId);
    }
    await admin.from('accounts').delete().in('id', created.accountIds);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
