-- Which side of the transaction we're acting on. Without this the app (and the
-- drafting AI) implicitly assumed PURCHASE/buyer-side; this lets a matter be a
-- sale or remortgage so drafts and stage reasoning address the right party.

alter table matter add column if not exists track text not null default 'PURCHASE';
-- PURCHASE | SALE | REMORTGAGE
