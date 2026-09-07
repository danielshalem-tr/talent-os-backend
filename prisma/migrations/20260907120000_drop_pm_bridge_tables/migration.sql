-- PM Bridge moved to the standalone Box (pmbridge.triolla.io); the embedded module and its
-- tables are removed. All three held 0 rows in prod on 2026-09-07 (re-checked before deploy).
-- Dropping a table drops its own FK constraints and indexes; IF EXISTS keeps re-runs safe.
DROP TABLE IF EXISTS "pm_ticket_reviews";
DROP TABLE IF EXISTS "pm_held_requests";
DROP TABLE IF EXISTS "pm_product_decisions";
