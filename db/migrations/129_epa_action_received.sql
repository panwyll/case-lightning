-- EPA, live: received email is reading time on the Time page, as the scan counts it (epa/live.ts recordEmail).
-- And a sent email's origin rides in `kind`: 'conveyi' (CONVEYi sent it; no one's time) or 'checking_drafts' (a person sent a CONVEYi draft).
alter table epa_action drop constraint if exists epa_action_source_check;
alter table epa_action add constraint epa_action_source_check check (source in ('sent', 'received', 'intouch_file', 'intouch_task'));
