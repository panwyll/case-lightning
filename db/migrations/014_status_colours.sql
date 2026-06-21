-- Firm-configurable status → colour map for the master board.
--
-- The "Colour" column in the board's Statuses list is the source of truth; on
-- sync we read it into this jsonb ({ "On track": "Green", ... }) so the choice
-- persists across rebuilds, and the board's status conditional formatting is
-- generated from it. Null → the built-in defaults.

alter table policy_config add column if not exists status_colours jsonb;
