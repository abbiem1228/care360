-- Phase A, step 3 of docs/element-profile-merge-plan.md: the core
-- assessment tables, ported unchanged from Element Profile's own
-- schema/001_initial_schema.sql (element_sessions, element_responses,
-- element_scores, element_archetypes) and schema/003_seed_item_bank.sql
-- (element_item_bank), plus their seed data from schema/002_seed_archetypes.sql
-- and schema/003_seed_item_bank.sql, copied verbatim so there is no
-- drift between what is documented there and what exists here.
--
-- element_sessions carries organization_id directly, matching Element
-- Profile's current live shape after schema/005_add_account_users_and_rls.sql
-- backfilled and constrained it there (not the original 001 shape,
-- which only had it reachable indirectly via person_id -> people). No
-- backfill needed here: this table is created fresh and empty, so the
-- column is simply not null from the start.
--
-- RLS is deliberately not enabled yet, same as organizations/people in
-- 003. That is Phase A, step 5.

-- The six elements are fixed and never change per client. Stored as an
-- enum rather than a free-text column so scoring code can't typo a
-- dimension name.
create type element_key as enum (
  'drive', 'pace', 'people_orientation', 'structure', 'composure', 'ambiguity_tolerance'
);

-- One row per assessment "session" a person completes. Kept separate
-- from results so a person can have multiple sessions over time
-- (retakes are append-only, never overwritten).
create table if not exists element_sessions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  administered_by uuid references people(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  organization_id uuid not null references organizations(id) on delete cascade
);

-- Raw tetrad answers, one row per block per session. Keeping raw
-- answers, not just final scores, means the scoring logic can be
-- re-run later if the item bank or scoring method changes without
-- needing to re-administer.
create table if not exists element_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references element_sessions(id) on delete cascade,
  tetrad_index smallint not null,
  most_element element_key not null,
  least_element element_key not null,
  check (most_element <> least_element)
);

-- Computed scores per session. One row per session, six columns, not
-- six rows, since a person's six scores are always read together.
create table if not exists element_scores (
  session_id uuid primary key references element_sessions(id) on delete cascade,
  drive smallint not null check (drive between 0 and 100),
  pace smallint not null check (pace between 0 and 100),
  people_orientation smallint not null check (people_orientation between 0 and 100),
  structure smallint not null check (structure between 0 and 100),
  composure smallint not null check (composure between 0 and 100),
  ambiguity_tolerance smallint not null check (ambiguity_tolerance between 0 and 100),
  archetype_key text not null,
  computed_at timestamptz not null default now()
);

-- The 16 archetypes (15 pairs + Wild Card fallback). Stored in the
-- database, not hardcoded in application code, so content edits don't
-- require a deploy.
create table if not exists element_archetypes (
  key text primary key,
  name text not null,
  element_pair text[] not null,
  tagline text not null,
  description text not null,
  in_your_element text not null,
  outside_your_element text not null
);

insert into element_archetypes (key, name, element_pair, tagline, description, in_your_element, outside_your_element)
values
('wild_card', 'The Wild Card', ARRAY[]::element_key[], 'Adapts to what the moment calls for.', 'No single dimension dominates. Rather than defaulting to one strong pattern, this profile flexes to match what a given situation actually needs.', 'Can slot into whatever role a moment requires without a strong personal agenda getting in the way.', 'May be harder for a team to predict, since there''s no single dominant lean to read.'),
('clear_path', 'The Clear Path', ARRAY['drive','structure']::element_key[], 'Sees the plan, then pushes it into motion.', 'Combines a need for a clear, well-defined plan with the drive to actually carry it out rather than just outlining it. High standards paired with real follow-through.', 'Turns a vague goal into a concrete plan and doesn''t let it die in a slide deck.', 'Can get frustrated when others want to deviate from the plan once it''s set, even for good reason.'),
('steady_hand', 'The Steady Hand', ARRAY['composure','drive']::element_key[], 'Takes the risk, stays composed through what follows.', 'A self-starter with real goal orientation who doesn''t rattle when the pressure is real. Takes the risk that needs taking and stays composed through whatever follows.', 'Absorbs chaos from a dozen directions and keeps moving toward the goal anyway.', 'May underestimate how stressful a situation feels to people around them, since it barely registers to them.'),
('rallying_point', 'The Rallying Point', ARRAY['drive','people_orientation']::element_key[], 'People organize around their energy.', 'Leads by pulling people together around a goal rather than pushing from behind. Cooperative and efficient, people naturally organize around their energy.', 'Rallies a team fast, especially when morale is low and someone needs to just show up and lead.', 'Can crowd out other people''s ownership by being too present, too hands-on.'),
('head_start', 'The Head Start', ARRAY['drive','pace']::element_key[], 'Acts while others are still planning to act.', 'Fast-paced and self-disciplined, acting while others are still planning to act. Straightforward, and most comfortable once there''s a clear direction to run in.', 'Turns "we should probably..." into a working first version by end of day.', 'What gets built fast can be thin in places; needs someone else to check the details.'),
('free_agent', 'The Free Agent', ARRAY['ambiguity_tolerance','drive']::element_key[], 'Doesn''t need certainty to start.', 'A natural problem solver who handles change better than almost anyone in the room. Doesn''t need certainty to start, and doesn''t need to be told to start either.', 'Gets things moving during a reorg, a pivot, or a brand-new initiative with no playbook.', 'May move so far ahead that the rest of the team hasn''t caught up to the direction already committed to.'),
('welcome_wagon', 'The Welcome Wagon', ARRAY['pace','people_orientation']::element_key[], 'Makes a new situation feel warmer, fast.', 'Friendly and fast, making a new situation feel warmer just by showing up in it. Upholds real standards for the team while doing it with genuine warmth.', 'Rallies a group through a tight deadline without losing anyone along the way.', 'May keep pushing pace even when the team genuinely needs a pause.'),
('quick_study', 'The Quick Study', ARRAY['pace','structure']::element_key[], 'Learns fast, moves fast, no mess behind it.', 'Independent and deadline-driven, focused squarely on results. Learns fast and moves fast, without leaving a mess behind because the process is built to move fast on purpose.', 'Hits an aggressive deadline without anyone scrambling at the end.', 'Can get rigid about the sequence even when reality calls for skipping a step.'),
('front_runner', 'The Front Runner', ARRAY['composure','pace']::element_key[], 'Ahead, and unbothered by being ahead.', 'Skilled, detail-oriented, and unbothered by being ahead of the pack. Doesn''t rattle as a deadline closes in, and doesn''t slow down either.', 'Delivers the final stretch fast and clean when everyone else has run out of steam.', 'May move on before properly debriefing a finish, since the next thing is already calling.'),
('trailblazer', 'The Trailblazer', ARRAY['ambiguity_tolerance','pace']::element_key[], 'Moves fast with no map, and isn''t bothered by that.', 'Innovative and unfazed by failure, heading in the most promising direction immediately and adjusting as new information shows up.', 'Makes real progress in genuinely undefined situations where waiting for a plan would waste months.', 'Can leave a trail that''s hard for slower-moving or clarity-needing teammates to follow.'),
('common_thread', 'The Common Thread', ARRAY['people_orientation','structure']::element_key[], 'Holds the team and the process together.', 'Socially grounded and genuinely motivating, the person a team organizes around without being asked to. Holds both the people and the process together at once.', 'Keeps a team functioning smoothly through a stretch where morale and process could easily slip.', 'Can be slow to embrace a needed change if it threatens the stability already built.'),
('safe_harbor', 'The Safe Harbor', ARRAY['composure','people_orientation']::element_key[], 'Where people go when things get hard.', 'Big-picture focused, with the rare ability to deliver a hard message without damaging the relationship. The person a team trusts with its hardest conversations.', 'Delivers hard news or handles a tense conversation without anyone walking away feeling mishandled.', 'May absorb more emotional weight from the team than they let on.'),
('true_north', 'The True North', ARRAY['ambiguity_tolerance','people_orientation']::element_key[], 'The fixed point others orient to.', 'Unselfish and approachable, steady enough to become the fixed point a team orients to when things get unclear.', 'Becomes the person a team turns to during a reorg or a pivot, because they make uncertainty feel survivable.', 'May under-communicate the plan because its absence doesn''t bother them personally.'),
('careful_eye', 'The Careful Eye', ARRAY['composure','structure']::element_key[], 'Catches what everyone else missed, calmly.', 'Highly precise and appropriately skeptical, while still respecting the process being worked within. Catches what everyone else missed, without any drama once it''s found.', 'Catches the error that would have been expensive three steps later.', 'Can slow down a team that needs to move before every detail is verified.'),
('open_mind', 'The Open Mind', ARRAY['ambiguity_tolerance','structure']::element_key[], 'Builds understanding without a finished map.', 'Analytical and accurate, but genuinely comfortable operating without a finished map. Builds understanding methodically, even when the ground keeps shifting.', 'Brings order to a genuinely undefined situation without waiting for someone else to define it first.', 'May over-invest in building a system before just moving.'),
('even_keel', 'The Even Keel', ARRAY['ambiguity_tolerance','composure']::element_key[], 'Steady regardless of what the water''s doing.', 'Patient, relaxed, and a naturally cooperative presence on a team. Stays steady through both good conditions and bad, without needing certainty to feel okay.', 'Becomes the stable point everyone else can operate around during real organizational turbulence.', 'May seem detached or under-reactive to people who process change more visibly.');

-- The 48-statement item bank (12 balanced tetrads of 4 statements
-- each). Every element appears 8 times, every pair traded off 4-5
-- times.
create table if not exists element_item_bank (
  tetrad_index smallint not null,
  item_index smallint not null,
  element element_key not null,
  statement_text text not null,
  primary key (tetrad_index, item_index)
);

insert into element_item_bank (tetrad_index, item_index, element, statement_text)
values
(0, 0, 'ambiguity_tolerance', 'Can start moving on something even without a finished plan'),
(0, 1, 'composure', 'Stays steady when everyone around me is stressed'),
(0, 2, 'pace', 'Would rather start today with 80% of the information than wait for all of it'),
(0, 3, 'structure', 'Wants to see the plan in writing before committing to it'),
(1, 0, 'ambiguity_tolerance', 'Doesn''t need to know the whole roadmap to feel comfortable working'),
(1, 1, 'composure', 'Doesn''t let a bad morning affect the rest of my day'),
(1, 2, 'pace', 'Gets more energized, not more anxious, when things speed up'),
(1, 3, 'people_orientation', 'Can usually tell when someone in the room disagrees, even if they don''t say so'),
(2, 0, 'ambiguity_tolerance', 'Treats a change in direction as normal rather than a sign something''s wrong'),
(2, 1, 'pace', 'Keeps several fast-moving things going at once without losing track'),
(2, 2, 'people_orientation', 'Builds trust with a new team quickly'),
(2, 3, 'structure', 'Double-checks the numbers even when I''m confident they''re right'),
(3, 0, 'composure', 'Can deliver a difficult message without it throwing off my focus'),
(3, 1, 'pace', 'Finds long planning phases more draining than the work itself'),
(3, 2, 'people_orientation', 'Thinks about how a decision will land on the people affected by it before making it'),
(3, 3, 'structure', 'Prefers a repeatable process over solving the same problem a new way each time'),
(4, 0, 'ambiguity_tolerance', 'Stays engaged even when leadership hasn''t settled on an answer yet'),
(4, 1, 'composure', 'Recovers fast after a mistake instead of dwelling on it'),
(4, 2, 'drive', 'Jumps in and takes the lead when a project doesn''t have a clear owner'),
(4, 3, 'structure', 'Feels the pull to gather more information before making a call'),
(5, 0, 'ambiguity_tolerance', 'Comfortable defining my own next step when no one else has'),
(5, 1, 'composure', 'Performs better, not worse, when the pressure is real'),
(5, 2, 'drive', 'Willing to push back on a decision I think is wrong, even under pushback myself'),
(5, 3, 'people_orientation', 'Prefers getting real buy-in over just getting a yes'),
(6, 0, 'ambiguity_tolerance', 'Doesn''t need certainty to commit to a decision'),
(6, 1, 'drive', 'Prefers to make the call myself rather than wait for a group to agree'),
(6, 2, 'people_orientation', 'Remembers small personal details about people I work with'),
(6, 3, 'structure', 'Keeps detailed notes so nothing falls through the cracks'),
(7, 0, 'composure', 'Keeps a clear head when a conversation turns tense'),
(7, 1, 'drive', 'Takes it personally when something under my watch doesn''t get done'),
(7, 2, 'people_orientation', 'Adjusts how I deliver a message based on who''s receiving it'),
(7, 3, 'structure', 'Would rather follow a proven method than improvise one'),
(8, 0, 'ambiguity_tolerance', 'Keeps working productively through a reorg or leadership change'),
(8, 1, 'drive', 'Comfortable being the person who delivers unwelcome news'),
(8, 2, 'pace', 'Treats a tight deadline as a reason to move, not a reason to worry'),
(8, 3, 'structure', 'Wants clear criteria defined before evaluating an outcome'),
(9, 0, 'composure', 'Doesn''t take a sharp comment personally in the moment'),
(9, 1, 'drive', 'Would rather ask forgiveness than wait for permission to act'),
(9, 2, 'pace', 'Prefers momentum and course-correction over getting it perfect out of the gate'),
(9, 3, 'structure', 'Reads the fine print that other people skip'),
(10, 0, 'ambiguity_tolerance', 'Adjusts easily when the goalposts move partway through a project'),
(10, 1, 'drive', 'Sets the pace for a group rather than falling in line with it'),
(10, 2, 'pace', 'Notices when a project has stalled before anyone else flags it'),
(10, 3, 'people_orientation', 'Notices when someone''s engagement has quietly dropped off'),
(11, 0, 'composure', 'Stays composed when a plan falls apart at the last minute'),
(11, 1, 'drive', 'Negotiates hard for what a project actually needs, even if it''s an unpopular ask'),
(11, 2, 'pace', 'Would rather send an imperfect draft than sit on a perfect one'),
(11, 3, 'people_orientation', 'Would rather slow down a decision than leave someone feeling unheard');
