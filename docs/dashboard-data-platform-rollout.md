# Dashboard data platform rollout

This release changes the investigation identity primary key and makes the
webhook command outbox, product projection, private artifacts, and delivery
recovery available to the bot, API, and worker. Treat it as a coordinated,
forward-only rollout.

## Required order

1. Stop or pause new `issue_comment` ingestion.
2. Drain existing investigation and delivery jobs with the old worker. Do not
   deploy a new worker against jobs created by the old bot.
3. Verify a current database backup and record the row count and size of
   `public.investigation_states`.
4. Apply, in order, the dashboard schema migration and recovery-hardening
   migration. Use a maintenance window; the UUID backfill, bigint-to-text
   conversion, and primary-key replacement require strong table locks.
5. Run `npm run reconcile:dashboard-data` with GitHub App credentials plus
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. This snapshots every current
   installation and its authoritative repository selection, fails on remaining
   legacy orphans, and validates the two investigation-state foreign keys plus
   the permanent-command installation foreign key. If the audit reports a
   historical installation that GitHub no longer returns, stop: reconcile it
   explicitly as a deleted installation (and any historical repository as
   removed) from verified operational records. Do not invent an active
   membership or bypass the validator.
6. Run `npm run recover:durable-work`. It must report zero failures.
7. Deploy the API/bot image and the worker from the same commit before
   reopening webhooks. `npm start` packages API and bot together; neither a new
   bot/old worker nor an old bot/new worker overlap is supported.
8. Reopen webhook ingestion and run one authorized investigation smoke test
   through queued comment, dashboard polling, evidence, PR, and terminal
   comment.
9. Schedule `npm run recover:durable-work` at least once per minute and
   `npm run cleanup:retention` daily.

## Required configuration

The API/bot and worker must both receive `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, select `SHERLOCK_STATE_STORE=supabase`, and run
with `SHERLOCK_RUN_STARTUP_CHECKS=true`. The API additionally retains its existing
`SUPABASE_PUBLISHABLE_KEY`, `GITHUB_APP_SLUG`, and
`SHERLOCK_FRONTEND_URL` requirements. The recovery and reconciliation commands
must run with the same Redis and Supabase targets as the deployed services.

No service-role key, GitHub private key, installation token, or signed artifact
URL belongs in a browser environment or database row.

## Failure and rollback

The migration is forward-only after new UUID child rows or permanent command
claims are written. Do not attempt to restore the old primary key in place.
If migration or reconciliation fails, keep webhook ingestion paused, leave the
old application version stopped, restore from the verified backup only if no
new-schema writes were accepted, or ship a forward-fix migration.

The migration should be applied with a bounded lock timeout selected for the
production maintenance window. A lock-timeout failure is safe to retry after
the blocking transaction is resolved; do not terminate unrelated database
sessions automatically.
