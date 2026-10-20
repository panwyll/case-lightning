-- The firm's colour, for the pages its clients see (the client portal and the secure file and code pages):
-- buttons, tabs and highlights take it, with the firm's logo (105) at the top, so the client sees their
-- solicitor, not us. Null keeps the standard colour.

alter table tenant add column if not exists brand_colour text;
alter table tenant drop constraint if exists tenant_brand_colour_hex;
alter table tenant add constraint tenant_brand_colour_hex check (brand_colour is null or brand_colour ~ '^#[0-9a-f]{6}$');
