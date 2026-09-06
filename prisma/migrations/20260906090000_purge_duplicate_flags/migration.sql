-- Round 1 dedup automation: the intake pipeline no longer writes duplicate_flags and nothing
-- reads them. Both FKs on this table are ON DELETE RESTRICT, so every row must be gone before
-- any candidate referenced by one can be deleted (production cleanup script). The table itself
-- stays until a later maintenance round.
DELETE FROM "duplicate_flags";
