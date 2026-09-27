-- 100: the subject of each message the case sent, so a message can be sent again exactly as it went.
alter table client_message add column if not exists subject text;
