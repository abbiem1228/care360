-- Weekly free Element Profile summary: one row per week, so the email goes
-- out exactly once however many times the job runs or the server restarts.
--
-- week_start: the Monday (Arizona time) the summarized week began.
-- status: 'sending' while a run holds the week, 'sent' once Resend accepted
-- the email. A failed send deletes its row, so the next run tries again.
-- Counts and the Resend id only, never anyone's email or results.
--
-- Run in the Supabase SQL editor before deploying the code that uses it.

create table if not exists free_summary_weeks (
  week_start date primary key,
  status text not null check (status in ('sending', 'sent')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  taken integer,
  opted_in integer,
  resend_id text
);

-- Read and written only by the server's service connection.
alter table free_summary_weeks enable row level security;
revoke all on free_summary_weeks from anon, authenticated;
