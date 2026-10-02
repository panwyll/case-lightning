-- A lender's Part 2 rules on where the deposit may come from (money.md 5.12): borrowed money, and a gift from a donor abroad.
-- null: not stated (the rules then flag nothing extra).
alter table lender_profile add column if not exists accepts_loan_deposit boolean;
alter table lender_profile add column if not exists accepts_donor_abroad boolean;
