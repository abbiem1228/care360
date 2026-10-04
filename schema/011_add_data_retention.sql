-- Data retention: products are deleted 60 days after their subscription
-- ends (Terms 5.4 and both Privacy Policies), only after the owner is
-- warned 7 days ahead and IGC approves it in HQ.
--
-- unpaid_at: when a subscription became unpaid. Retention counts an
-- unpaid product's 60 days from here.
--
-- retention_log: a record of every warning, deletion and daily run.
-- Ids, products, dates and row counts only, never personal content.
-- account_id deliberately has no foreign key, so the record of a
-- deleted account outlives the account.
--
-- Run in the Supabase SQL editor before deploying the code that uses it.

alter table account_subscriptions add column if not exists unpaid_at timestamptz;

create table if not exists retention_log (
  id uuid primary key default gen_random_uuid(),
  account_id uuid,
  product text check (product in ('care360', 'element_profile', 'account')),
  action text not null check (action in ('scan', 'warning_sent', 'deleted')),
  deletion_date date,
  row_counts jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_retention_log_account on retention_log (account_id);

-- Read and written only by the server's service connection.
alter table retention_log enable row level security;
