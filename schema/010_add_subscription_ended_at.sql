-- When each subscription ended, as reported by Stripe (sub.ended_at).
-- The ended page in both apps shows the data-retention date from it:
-- the Terms (Section 5.4) and Privacy Policy keep data for 60 days
-- after cancellation. Also the date the upcoming deletion phase will
-- count from.
--
-- Run in the Supabase SQL editor before deploying either app's Phase 3
-- code: the webhook writes this column, and both apps' access checks
-- read it.
--
-- No backfill: no real subscription has ended yet. Rows written before
-- this column existed fall back to updated_at.

alter table account_subscriptions add column if not exists ended_at timestamptz;
