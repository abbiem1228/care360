-- Fixes a real structural gap surfaced while planning Element Profile's
-- checkout integration (see docs/element-profile-merge-plan.md's Stripe
-- section): accounts.stripe_subscription_id is a single column,
-- assuming one Stripe subscription per account. That was true when
-- CARE 360 was the only product. It stops being true the moment an
-- account can hold a CARE 360 subscription and a separate Element
-- Profile subscription at once (bought separately, via the "Add
-- [Product]" path), since there is nowhere to put the second ID.
--
-- account_subscriptions is one row per real Stripe subscription, not
-- per account, so an account can have as many as it actually has.
-- products is the same three-value signal used everywhere else in this
-- integration ('care360', 'element_profile', 'bundle'): which
-- product(s) that specific subscription represents.
--
-- accounts.stripe_subscription_id and accounts.plan are left in place,
-- not dropped: real, existing subscriptions are backfilled into this
-- table below, but the old column stays as a historical value the
-- webhook will simply stop updating going forward. Removing it outright
-- is a separate decision for later, not part of fixing the immediate gap.
--
-- accounts.status has the same single-value-for-multiple-subscriptions
-- shape of problem (an account could have one product active and
-- another past due at the same time). This migration does not fix
-- that: it was not part of what was asked, and status is tracked here
-- per-subscription in addition to, not instead of, the existing
-- account-level field, so nothing regresses. Flagging it as the next
-- version of this same gap, not resolved here.

create table if not exists account_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  stripe_subscription_id text not null unique,
  products text not null check (products in ('care360', 'element_profile', 'bundle')),
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_account_subscriptions_account on account_subscriptions (account_id);

alter table account_subscriptions enable row level security;

create policy "org members access their own subscriptions" on account_subscriptions for all
  using (account_id = current_account_id())
  with check (account_id = current_account_id());

-- Backfill: every real account that already has a stripe_subscription_id
-- today is, by definition, a CARE 360 subscription, since CARE 360 has
-- been the only product that's ever existed. Preserves continuity for
-- real, paying customers rather than starting this table empty under
-- them.
insert into account_subscriptions (account_id, stripe_subscription_id, products, status)
select id, stripe_subscription_id, 'care360', status
from accounts
where stripe_subscription_id is not null
on conflict (stripe_subscription_id) do nothing;
