-- Stage-aware automations.
--
-- Until now an auto_rule matched only on classifier signals (intent, confidence,
-- sender domain) and was completely blind to where the matter sits on the process
-- DAG. That decoupling is why "automations" and "the case flow" felt like separate
-- products. This lets a rule gate on the matched matter's current stage — e.g.
-- "auto-draft a status ack ONLY while the matter is in Searches & enquiries".
--
-- Empty array = any stage (unchanged behaviour), so existing rules are untouched.
alter table auto_rule add column if not exists match_stages text[] not null default '{}';
