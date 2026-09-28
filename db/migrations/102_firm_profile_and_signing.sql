-- The firm's own details (letters, email footers, where signed originals are posted) and
-- how deeds are signed (wet ink or electronically, per lender and per case).
alter table tenant add column if not exists address_line1 text;
alter table tenant add column if not exists address_line2 text;
alter table tenant add column if not exists town text;
alter table tenant add column if not exists postcode text;
alter table tenant add column if not exists phone text;
alter table tenant add column if not exists sra_number text;
alter table tenant add column if not exists website text;
-- A lender that accepts an electronically signed mortgage deed (null: unknown, treated as wet ink).
alter table lender_profile add column if not exists accepts_digital_deed boolean;
