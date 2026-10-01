-- InTouch write-back (docs/intouch-integration.md "Writing back"): what CONVEYi files on a case and what
-- happens on it go into the firm's InTouch case, so InTouch stays their system of record. Each is off
-- until the firm turns it on, like milestones.
alter table intouch_connection add column if not exists documents_writeback boolean not null default false;
alter table intouch_connection add column if not exists notes_writeback boolean not null default false;
comment on column intouch_connection.documents_writeback is 'Push documents CONVEYi files on a mirrored case into the InTouch case.';
comment on column intouch_connection.notes_writeback is 'Push a one-line case note to InTouch for each significant thing the engine records.';
