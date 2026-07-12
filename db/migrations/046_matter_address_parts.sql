-- Structured property address. `property_address` stays the canonical display string
-- (everything reads it), but the House tab now edits the parts here — building/street/
-- town/postcode/country — and recomposes property_address on save. Legacy matters keep
-- working with address_parts null until the first structured edit.
alter table matter add column if not exists address_parts jsonb;
