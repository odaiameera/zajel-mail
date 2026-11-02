-- Jev conditions in rules.

-- The per-account opt-in now covers more than sorting: it is consent for
-- Jev to read the account's new mail at all, which sorting into tabs and
-- rules with Jev conditions both need. Same values, clearer name.
ALTER TABLE jev_settings RENAME COLUMN auto_sort TO jev_enabled;

-- What Jev said about each rule condition it was asked about for an email:
-- the rule, the statement, the probability, the strictness it needed and
-- whether the rule fired. Like answers_json, never any email text.
ALTER TABLE jev_decisions ADD COLUMN rules_json TEXT;
