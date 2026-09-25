-- InTouch credentials belong to the firm, not the deployment: each firm's admin enters the
-- API address, client id and secret (and the API key / webhook secret if InTouch issued
-- them) on the InTouch page. Stored encrypted, like the tokens. The INTOUCH_* env vars
-- remain as a fallback for a single-firm deployment.
alter table intouch_connection add column if not exists credentials_enc text;
