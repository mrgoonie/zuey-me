-- Dewee now hosts account linking (Dewee Connect, access_gate.link.mode = hosted): Dewee links chat accounts to
-- members itself and sends the member id as external_subject, so zuey.me no longer maps senders or redeems link
-- tokens. Drops the sender mapping and the used-token nonces created by 0021_channel_identities.sql.
--
-- DEPLOY ORDER (production):
--   1. Switch the Dewee channel instance to hosted mode first and deploy the code that no longer reads these tables.
--      Applied earlier, the partner-mode verifier would fail on the missing tables and Dewee would fail closed
--      (deny) for every sender until the switch.
--   2. Back up before applying. `wrangler d1 export` fails on this database (FTS5 tables), so record a restore
--      point with `wrangler d1 time-travel info zuey_me_db` and also keep a copy of the two tables, e.g.
--      `wrangler d1 execute zuey_me_db --remote --json --command "SELECT * FROM channel_identities"` (and the same
--      for channel_link_nonces), saved outside the repository.
--   3. Apply: `wrangler d1 execute zuey_me_db --remote --file=./migrations/0029_drop_channel_link_tables.sql -y`.
-- Existing links are not imported into Dewee: they carry no Dewee-verifiable proof, so each linked member relinks
-- once through the bot's Dewee prompt.
--
-- ROLLBACK: re-run 0021_channel_identities.sql to recreate the tables (its community backfill runs again), then
-- re-insert the saved rows, or restore the time-travel bookmark if nothing else changed since; switch the Dewee
-- instance back to link.mode = partner together with reverting the code.
--
-- Safe to run more than once.

DROP INDEX IF EXISTS idx_channel_link_nonces_expiry;
DROP TABLE IF EXISTS channel_link_nonces;
DROP INDEX IF EXISTS idx_channel_identities_user;
DROP TABLE IF EXISTS channel_identities;
