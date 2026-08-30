-- ============================================================
-- CARE 360 Database Schema — In Good Company Collective
-- Run this entire file in your Supabase SQL Editor
-- ============================================================

CREATE TABLE cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  client_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE leaders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id UUID REFERENCES cycles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT NOT NULL,
  department TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE raters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id UUID REFERENCES leaders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  rater_group TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  completed_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id UUID REFERENCES raters(id) ON DELETE CASCADE,
  leader_id UUID REFERENCES leaders(id) ON DELETE CASCADE,
  question_number INTEGER NOT NULL,
  section TEXT NOT NULL,
  score INTEGER CHECK (score >= 1 AND score <= 5),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE open_text (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id UUID REFERENCES raters(id) ON DELETE CASCADE,
  leader_id UUID REFERENCES leaders(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE start_stop_continue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_id UUID REFERENCES raters(id) ON DELETE CASCADE,
  leader_id UUID REFERENCES leaders(id) ON DELETE CASCADE,
  start_text TEXT,
  stop_text TEXT,
  continue_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id UUID REFERENCES leaders(id) ON DELETE CASCADE,
  report_html TEXT,
  report_data JSONB,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  generated_by TEXT
);

CREATE INDEX idx_raters_token ON raters(token);
CREATE INDEX idx_raters_leader ON raters(leader_id);
CREATE INDEX idx_responses_rater ON responses(rater_id);
CREATE INDEX idx_responses_leader ON responses(leader_id);
CREATE INDEX idx_leaders_cycle ON leaders(cycle_id);

ALTER TABLE cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaders ENABLE ROW LEVEL SECURITY;
ALTER TABLE raters ENABLE ROW LEVEL SECURITY;
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE start_stop_continue ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
