-- Records which tier each subscription is on, and makes hand-granted
-- ("comped") product access explicit.
--
-- tier: account_subscriptions already says which product(s) each
-- subscription covers. Once an account can hold separate CARE 360 and
-- Element Profile subscriptions, a single accounts.plan can't say which
-- tier each one is on. The webhook now writes tier from the
-- subscription's current Stripe price, and derives accounts.plan as the
-- highest tier among live subscriptions (left unchanged when nothing is
-- live, and never changed on enterprise or community accounts).
--
-- comp_care360 / comp_element_profile: the webhook recomputes
-- has_care360/has_element_profile from live subscriptions. Without an
-- explicit record of hand-granted access, any billing event would
-- switch a comped product off. A product is now on while a live
-- subscription covers it or while it's comped. To comp a product, set
-- both comp_<product> and has_<product> to true.
--
-- Run in the Supabase SQL editor before deploying the code that writes
-- tier, or every webhook upsert fails until it runs.

alter table account_subscriptions
  add column if not exists tier text check (tier in ('starter', 'growth'));

alter table accounts add column if not exists comp_care360         boolean not null default false;
alter table accounts add column if not exists comp_element_profile boolean not null default false;

-- Backfill: the one real subscription row at the time (Elevate
-- Actually, CARE 360) takes its account's plan. The next webhook for it
-- rewrites tier from the actual Stripe price either way.
update account_subscriptions s
set tier = a.plan
from accounts a
where s.account_id = a.id and s.tier is null and a.plan in ('starter', 'growth');

-- Hand-granted access on manual plans becomes an explicit comp
-- (at the time: In Good Company Collective, both products).
update accounts
set comp_care360 = has_care360, comp_element_profile = has_element_profile
where plan in ('enterprise', 'community');
