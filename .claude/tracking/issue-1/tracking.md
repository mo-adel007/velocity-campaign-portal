# Issue #1: Build multi-brand client campaign portal

## Status (2026-09-13)

**Progress:** Execute phase. Done: schema, ingestion, seed load, dashboard RPCs, isolation test, auth config (signups off, allowlist hook on), send flow SQL (preview, approval, frozen snapshot, single-flight, worker functions, dispatch pause). Next: UI screens. Waiting on the user for the provider's send API docs (endpoint, body, response, limits) before the dispatch Edge Function + cron.

**Last commit:** see `git log` — send flow SQL

**Auth config (2026-09-13):** set on the project through the Management API and mirrored in `supabase/config.toml`. `disable_signup=true`; before-user-created hook `pg-functions://postgres/private/hook_before_user_created` enabled. Verified: public signup refused ("Signups not allowed"); with signups briefly re-enabled, a stranger got 403 "This account is not authorised…" and no account was created. The Admin API (server key only) bypasses hooks. Google sign-in for existing users relies on linking by verified email; to be verified once the Google accounts exist.

**Send flow SQL (2026-09-13):** migrations `20260913160000_sends`, `20260913160100_dispatch_pause`. `tests/sends.test.ts` 10/10 live, `tests/isolation.test.ts` 9/9 (now also covers `sends`, `send_chunks`, `send_recipients` automatically). Decisions: chunk size 250 (to revisit once provider limits are known; fixed per approval); `recipient_id` sent to the provider = lowest customer external id behind the address; an address is suppressed at its chunk's first claim if ANY of its customers became ineligible, or if none of them still has that email ("Email address changed after approval"); a chunk that is not confirmed after 5 attempts ends failed, with the last error on each pending recipient; `record_send_chunk` requires a result for every pending recipient and is a no-op for the same batch twice; last sent = latest of portal approval, file `sent_at`, seed send-log `queued_at`; the confirm carries the previewed address count and is refused (VC422) if the audience moved. Custom SQLSTATEs: VC403/VC404/VC409/VC422. Dispatch pause is a lease (`pause_dispatch(minutes)`, max 60) so live tests cannot trigger real sends.

**Dashboard RPCs:** migration `20260913150000_dashboard_rpcs` applied. `dashboard_totals`, `dashboard_contactable_breakdown`, `dashboard_signups_per_day`, `dashboard_campaign_performance`: all four are SECURITY INVOKER, so forced RLS decides what they return. A rolled-back check signed in as a member of each brand passed 38/38: total = loaded contacts; breakdown adds up to total (Kilele 82,424 = 34,665 contactable + exclusions); 30 days with only today partial, in the brand's timezone; unique opens match a direct distinct count; a non-member gets no rows; anon is refused. Kilele timings: totals 1.8 s (cold), breakdown 1.3 s, signups 0.2 s, performance 0.4 s. Decision: "counted from events" figures are divided by the file's `reported_sent`, because seed events have no "delivered". Data facts: Karoo is 67% "complained" (the source file is ~20% complaints per event type, and complaints on any channel are a brand opt-out); Karoo and Marrakech have no signups in the last 30 days.

**Evidence:** migrations up to `20260913140000_import_merged_rows` applied to `dbedjxkhytvlvlkwdoma`; `process-imports` deployed (secret `IMPORT_CHUNK_BYTES=262144`); `tests/ingest.test.ts` 25/25 (chunked reads equal whole-file reads); `next build` passes. Seed loaded fresh, then again:

| Brand | Customers | Campaigns | Events | Historical sends |
|---|---|---|---|---|
| Kilele | 82,424 | 44 | 303,314 | 7 |
| Karoo | 12,406 | 19 | 69,100 | 0 |
| Marrakech | 918 | 6 | 307 | 0 |

- Every run: inserted + updated + unchanged + rejected + merged = rows.
- Second load: 0 inserted in every run (AC2.2).
- Delta: 1,681 new / 2,499 updated. One of the 2,500 corrections fixes a base row rejected for a future signup date, so it arrives as new (AC2.3 reading).
- Reloading the base after the delta re-applies the base's old values for the 2,499 corrected customers until the delta is loaded again — last load wins, by design.

**Branch:** `feat/1-campaign-portal`, 6 commits ahead of `origin/main`, pushed. Draft PR #2.

**Environment notes:** npm/npx shims break on the `&` in the worktree path — run CLIs with `node scripts/env-run.mjs <supabase|vitest|next>` (loads `.env.local`) or via junction `D:\vcp` with `cmd //c "cd /d D:\vcp && npm …"`. Secrets live in the user-written, gitignored `.env.local`. The Supabase token can also see unrelated production projects — only ever target `dbedjxkhytvlvlkwdoma`.

**Decisions made during execution:** status `pending` is not contactable; unsubscribes and complaints on any channel are a brand opt-out, only email bounces block email; a header row repeated mid-file is rejected as `repeated_header`. Edge Function CPU limit (2 s) → the loader reads files in byte ranges with a stored byte cursor and self-invocation; 1 MB event ranges hit the 8 s PostgREST statement timeout, so ranges are 256 KB. Runs load strictly in queue order per brand; a range that kills its worker 3 times fails the run. Seed runs are queued by the service role (no owners exist yet), `requested_by` empty; same bucket, queue and worker as upload. NUL characters are stripped with a warning. Zone-less `DD/MM/YYYY HH:MM` signups (1,200 Kilele rows) are read in the brand's local time with a warning. A repeated id within a file counts as "merged". The worker accepts only the `sb_secret` key (Edge Function env has no legacy service_role key) and Storage needs `apikey` with it.

**Next steps:** UI screens, shares, dispatch worker + poller + cron (after provider docs; cron also triggers `process-imports` for in-app uploads), Google OAuth, deploy, docs.

**User blockers:** six Google accounts + one non-allowlisted account (emails needed for the allowlist); email to Velocity.

**Resume action:** "Resume issue #1: build the UI screens (sign-in, dashboard, contacts, campaigns with send preview/confirm, imports)."

## What?

A client campaign portal for three brands (Kilele Rides, Karoo Coaches, Marrakech Express) on one Supabase database. Six users (owner + analyst per brand) sign in by password or Google, see only their brand's contacts, campaigns and dashboard, load data with visible rejections, send email campaigns through the Velocity messaging provider, track delivery/engagement, and publish password-protected result links.

## Why?

Velocity Growth Growth Engineer build task. Graded primarily on data correctness and guarantees: brand isolation, honest ingestion, correct numbers, safe sending, provider reconciliation, safe sharing.

## Decisions

**Access & isolation**

- Isolation lives in Postgres: RLS enabled and FORCED on every brand-data table, keyed on `brand_members(user_id, brand_id, role)`.
- Public signups disabled; a before-user-created auth hook rejects any email not on the allowlist.
- Six logins are Google accounts controlled by the user, each also given a password. Google and password identities link by verified email.
- Owners send, publish and upload; analysts only look (including import history and rejections).

**Ingestion**

- One brand-aware pipeline, used both by a seed script and by in-app upload.
- Per-brand parsers: Kilele comma + UTF-8 BOM; Karoo cp1252 with different column names/order; Marrakech `;` delimiter, decimal comma, French headers.
- Identity is `(brand, external_id)` for contacts and campaigns.
- Byte-identical duplicate rows collapse; conflicting rows with the same id: last row wins, delta file wins over base; conflicts logged.
- Kilele delta file is an upsert (corrections + new customers), never an append.
- Every run recorded in `import_runs`; every rejected row in `import_rejections` with row number, raw content and reason.
- Rejected, not rerouted: shifted-column rows, rows whose brand code is another brand, invalid emails, future signup dates, events for unknown campaigns, cross-brand parent campaign references.
- Events deduplicated by `event_id`; seed vocabulary `open/click/bounce/unsubscribe/complaint` mapped alongside provider `delivered/bounced/opened/unsubscribed`.
- Seed send-log (batch ids unknown to provider) is read-only history, never reconciled.
- Missing or malformed email: customer is kept (counts in total), email stored as NULL, raw value recorded as an import warning, non-contactable reason "invalid email".
- Country normalized to ISO-2 through an explicit map (e.g. `KEN`, `254` → `KE`); unmappable values (`ZZ`, `none`) become unknown and are excluded from country-filtered sends; every normalization logged.
- Karoo rows with a blank brand code are loaded as Karoo only when every field validates under the detected layout (with an import warning); otherwise rejected.

**Numbers**

- Total customers = distinct loaded customers for the brand.
- Contactable = contactable by email: valid email AND consent true (blank = false) AND not unsubscribed/bounced/complained AND not deleted/suppressed. Exclusion breakdown shown.
- Signups per day: last 30 days = today + 29 prior days, bucketed in brand local time (Africa/Nairobi, Africa/Johannesburg, Africa/Casablanca), zero-filled, today labelled partial.
- Campaign performance shows both "reported by source file" (`reported_*`) and "counted from events" (unique counts), each labelled with source and denominator.

**Send**

- Only email campaigns are sendable; SMS campaigns are view-only with the reason shown.
- Any email campaign can be sent; a previously sent campaign shows "last sent on <date>".
- Audience = contactable-by-email customers, filtered by `target_country` when set.
- Each confirm creates its own immutable approval: approver, time, audience rule, frozen recipient snapshot deduplicated by lowercase-trimmed email ("N customers → M addresses").
- One in-flight send per campaign, enforced in the database.
- Dispatch runs in the database via pg_cron in chunks, each provider call carrying an `Idempotency-Key`; per-recipient status recorded.
- Recipients who become ineligible after approval are suppressed with a reason; the approved count never changes.

**Provider feedback**

- Provider has no webhooks: pg_cron polls `GET /v1/messages/{batch_id}/events` with a stored cursor per open batch.
- Contact status derived by precedence (unsubscribe/complaint/bounce win), never by arrival order.
- Contacts are independent per brand; no signal crosses brands.

**Shared link**

- Random 128-bit token in URL, bcrypt-hashed password, SECURITY DEFINER function returns one campaign's aggregates only (no PII).
- Live results with an "as of" timestamp.
- 5 wrong attempts lock the link for 15 minutes; locked response is identical for right and wrong passwords.
- Links are revocable; share table has no direct anon access.

**Stack & secrets**

- Next.js on Vercel, Supabase. Provider key stored only in Supabase secrets, never in the repo or browser bundle.

## Definition of Done

### Pass 1: Access & isolation

- [x] Supabase project with brands, brand_members, allowlist, RLS forced on all brand-data tables
- [ ] Password and Google sign-in configured; signups disabled; allowlist auth hook
- [ ] Six users provisioned with roles
- [x] Automated isolation test that fails if RLS is removed or a new brand-data table lacks it (`tests/isolation.test.ts`, 9/9 live; the mutation case proves the rules catch weakened RLS and unprotected new tables)

### Pass 2: Loading

- [ ] Brand-aware ingestion pipeline (seed script + owner upload)
- [ ] import_runs / import_rejections and an Imports screen
- [x] Seed data loaded for all three brands, including Kilele delta
- [ ] Malformed fixture files for rejection tests

### Pass 3: Views, numbers, send

- [ ] Contacts view, campaigns view, dashboard
- [ ] Send flow: preview, confirm, immutable approval, snapshot, single-flight, pg_cron dispatch
- [ ] Dispatch interruption test hook

### Pass 4: Provider feedback & sharing

- [ ] pg_cron event polling with cursor, precedence-based contact status
- [ ] Fixture events (duplicates, out-of-order, cross-brand shared email)
- [ ] Publish/revoke share link and public results page

### Cross-cutting & submission

- [ ] Loading, empty and error states on every screen; bad input rejected
- [ ] Responsive at phone width
- [ ] Deployed to a public Vercel URL
- [ ] Public repo with real history, `schema.sql`, README
- [ ] Submission note (≤300 words)

## Acceptance Criteria

### Pass 1: Access & isolation

**AC1.1: Password sign-in lands in own portal**

Given one of the six users
When they sign in with email and password
Then they land in their own brand's portal with their role shown

**AC1.2: Google sign-in lands in the same portal**

Given an allowlisted user's Google account
When they sign in with Google
Then they land in the same brand portal and role as with their password

**AC1.3: Strangers get in nowhere**

Given a Google account or email that is not one of the six
When they try to sign in
Then they are refused, no account is created, and no portal is shown

**AC1.4: Analysts cannot send**

Given an analyst
When they view a campaign or request a send directly
Then no send control is offered and the direct request is refused

**AC1.5: No cross-brand data by any route**

Given a signed-in user of brand A
When they request brand B's customers, campaigns, events, sends, imports or shares, directly against Supabase or through the app
Then nothing from brand B is returned

**AC1.6: Signed-out requests get nothing**

Given no signed-in user
When brand data is requested with the public key
Then nothing is returned

**AC1.7: Tests catch removed isolation**

Given the test suite
When brand isolation is removed from any brand-data table, or a new brand-data table is added without it
Then a test fails

### Pass 2: Loading

**AC2.1: Marketer sees what did not load**

Given each brand's seed files
When they are loaded
Then the brand's Imports screen shows loaded and rejected counts and every rejected row with row number and reason (shifted columns, wrong brand, invalid email, future date, unknown campaign, cross-brand parent)

**AC2.2: Loading twice leaves one set**

Given an export that is already loaded
When it is loaded again
Then the customer count is unchanged and the run reports 0 new customers

**AC2.3: Delta file corrects and adds**

Given the Kilele delta file
When it is loaded
Then the 2,500 corrected customers show their new details and the 1,680 new customers are added, with no duplicates

**AC2.4: Bad uploads are refused**

Given an owner uploads a wrong-brand, unreadable, or missing-required-columns file
When the upload is processed
Then it is refused with a reason and nothing is stored

**AC2.5: Characters and amounts are preserved**

Given Karoo names with special characters and Marrakech decimal-comma amounts
When they are viewed
Then names display correctly and amounts equal the source values

**AC2.6: Analysts cannot load data**

Given an analyst
When they try to load a data file, in the app or directly
Then it is refused, while import history and rejections remain visible to them

### Pass 3: Views & numbers

**AC3.1: Big brand is as usable as small**

Given Kilele's ~86k customers
When the contacts view is opened, paged or searched
Then results appear within 2 seconds, as they do for Marrakech

**AC3.2: Campaigns show sendability**

Given the campaigns view
When it loads
Then each campaign shows channel and last-sent status, and SMS campaigns state why they cannot be sent here

**AC3.3: Total customers is stated**

Given the dashboard
When it loads
Then total customers equals distinct loaded customers and the counting rule is shown

**AC3.4: Contactable adds up**

Given the dashboard
When it loads
Then contactable-by-email is shown with an exclusion breakdown, and contactable plus exclusions equals total

**AC3.5: Signups per day are labelled**

Given the dashboard
When it loads
Then signups per day for today and the 29 prior days are shown in the brand's local timezone, with zero days present, today marked partial, and the timezone labelled

**AC3.6: Performance states its source**

Given campaign performance
When it is viewed
Then "reported by source file" and "counted from events" figures each state their source and denominator

**AC3.7: Screens say loading, empty or broken**

Given a screen that is loading, has no data, or fails
When it is viewed
Then it says which of those it is

### Pass 3: Send

**AC3.8: Owner sees exactly who**

Given an owner and an email campaign
When they prepare a send
Then they see the recipient list, the audience rule, "N customers → M addresses", and "last sent on <date>" if previously sent

**AC3.9: Approval stays approved**

Given an owner confirmed a send
When that send is viewed, now or a month later
Then it shows approver, time and the approved count, unchanged

**AC3.10: Double confirm sends once**

Given confirm is pressed twice, or from two sessions at once
When both requests arrive
Then exactly one send is created and the other is told a send is already in progress

**AC3.11: Interrupted send neither doubles nor half-sends silently**

Given a send is interrupted part-way
When it resumes
Then every address is messaged exactly once, per-recipient progress is visible, and it matches the provider's delivery record

**AC3.12: Late unsubscribes are honoured**

Given a recipient becomes ineligible after approval
When the send goes out
Then they are not messaged, are shown as suppressed with the reason, and the approved count is unchanged

**AC3.13: SMS and in-flight campaigns are refused**

Given an SMS campaign, or a campaign with a send in progress
When a send is attempted in the app or directly
Then it is refused

**AC3.14: Provider rejections are visible**

Given the provider rejects some recipients
When the send completes
Then those recipients are shown as failed with the provider's reason

### Pass 4: Provider feedback

**AC4.1: Events arrive while nobody is looking**

Given provider events arrive while nobody has the app open
When 5 minutes have passed
Then the dashboard's delivery and engagement figures reflect them

**AC4.2: Messy events do not distort numbers**

Given duplicate and out-of-order events
When figures are viewed
Then each event counts once, and an unsubscribed or bounced contact stays non-contactable even if a later-arriving open appears

**AC4.3: Unsubscribes stay within a brand**

Given the same email exists in Kilele and Karoo
When it unsubscribes from Kilele
Then the Karoo contact is unchanged

### Pass 4: Shared link

**AC4.4: Stranger sees one campaign, no personal data**

Given an owner published a campaign's results
When a stranger opens the link with the correct password
Then they see only that campaign's aggregate results with an "as of" time and no customer details

**AC4.5: Wrong passwords reveal nothing**

Given a wrong password
When it is submitted 5 times
Then nothing is revealed and the link is locked for 15 minutes, responding identically to right and wrong passwords

**AC4.6: Guessed links reveal nothing**

Given a guessed or altered link
When it is opened
Then it shows the same "not found" as a link that never existed

**AC4.7: Revoked links stop working**

Given a revoked link
When it is opened
Then no results are shown

**AC4.8: Shares unreachable with the public key**

Given the public key
When share records are requested directly against Supabase
Then nothing is returned

**AC4.9: Analysts cannot publish**

Given an analyst
When they try to publish or revoke a link
Then they are refused

### Cross-cutting

**AC5.1: Works on a phone**

Given a 390px-wide phone screen
When every flow is used
Then it works without horizontal scrolling

**AC5.2: Provider key stays secret**

Given the public repo and the deployed site
When both are searched for the provider key
Then it is not found

## Testability

**Test fixtures:** synthetic seed bundle (SHA-256 `4961a25b…683d35c`), copied into the repo's fixtures; malformed upload files; fixture events (duplicates, out-of-order, Kilele/Karoo shared email) — to be created

**Environment:** live URL on Vercel (TBD); Supabase project (TBD); provider base URL `https://dispatcher-production-72fc.up.railway.app` (key via Supabase secret, never committed)

**Setup:** seed script loads all three brands; dispatch interruption hook for AC3.11; first real provider send only through the finished portal

## Blockers

**User:** set `SUPABASE_ACCESS_TOKEN` and `VERCEL_TOKEN`; create six Google accounts + one non-allowlisted Google account; email Velocity about allowlisting their Google emails

**AI:** create Supabase project and config; deploy to Vercel; configure Google OAuth client via browser automation

## Implementation Approach

- Next.js (App Router) on Vercel with `@supabase/ssr`; Supabase for data, auth, storage, Edge Functions, cron.
- In-app upload: file goes to a brand-scoped Storage bucket, an import run is queued, and a cron-triggered Edge Function processes it in resumable chunks with the same parser as the seed script.
- Workers: pg_cron (every minute) calls Edge Functions through pg_net for dispatch and event polling; the provider key lives only in Edge Function secrets.
- Dispatch: recipients are split into frozen chunks at approval; `Idempotency-Key` = send id + chunk number; the batch id is recorded per chunk.
- Interruption test: a test-only environment flag makes the worker stop after the provider call and before recording the result.
- Tests: Vitest against the live project — cross-brand denial with real user sessions on the anon key, plus a catalog check over a direct Postgres connection that every brand-data table has forced RLS and policies.
- Secrets: gitignored `.env.local` in the worktree.
- Google OAuth client: configured through browser automation; on sign-in/2FA blockage, hand off a step checklist.

## Provider Spike (2026-09-13)

**Setup:** one recipient (Kilele `CT-037309`), three POST calls with `Idempotency-Key: spike-idem-001`. Provider batch `batch_c4d97ef065f290ff06ca` now exists on the delivery record.

**Replay:** identical body with the same key returns the same `batch_id` and response. A different body with the same key also silently returns the original response — no conflict error. Therefore a key must only ever be used for one frozen chunk.

**Events:** shape `{event_id, recipient_id, brand_code, type, occurred_at}` in pages `{batch_id, events, next_cursor, has_more}`. `brand_code` came back as `"account"`, not the brand sent — brand is taken from the send, never from events.

**Messiness observed:** the same event ids appeared twice in one page, and a forged event (`evt-batch_c4-forged`, recipient `CT-087796`, brand `KAROO`) appeared in the Kilele batch. Events are accepted only when their recipient belongs to that batch's frozen recipients; everything else is recorded as rejected.

**Cursor:** `since` takes the opaque `next_cursor`, not an `event_id` (contrary to the docs). When `next_cursor` is null, polling keeps the last known cursor or re-reads and relies on `event_id` deduplication.

**Errors:** unknown batch → `404 {"error":"not_found","message":"unknown batch_id"}`.

## Verification Plan

**Sanity (execute session):** migrations applied, forced RLS on every brand-data table, cron jobs scheduled; Edge Functions deployed and each worker runs once without error; `npm run build` passes and the live URL renders sign-in; README, `schema.sql` and these decisions present.

**Acceptance (separate ac-verify session):** AI verifies binary ACs; real sends for verification use Marrakech `MAR-0006` only (Kilele exercised through preview counts); user witnesses Google sign-in (AC1.2) and judges phone and client-grade feel (AC5.1).

## TBD

- Poll interval chosen within the 5-minute AC4.1 guarantee (planned: every minute)

<!-- Verify Phase: Use ac-verify skill for schema + workflow -->
