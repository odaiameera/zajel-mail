# Plan: folders, labels, rules and Jev, re-architected

## Context

Rules, labels, folders and Jev all work, but they grew into each other. Mapping the code showed where the complexity comes from:

- **Rules have six evaluators.** The rules scheduler, the Jev worker, the apply endpoint, the preview endpoint (a JMAP filter with different matching), the Jev rule test, and a Sieve script compiled on every save. One rule with a plain-English condition hands *all* rules to the Jev worker (`jevHandlesRules`, `src/lib/server/jev/rules.ts:61`).
- **A message's tab has six deciders**, in a fixed priority: spam layer, a rule's "set tab", a sender pin, learning, Jev's pick, your own move (`src/lib/server/jev/worker.ts:300-322, 611, 729`).
- **Three background loops, three cursors**: rules scheduler, Jev worker, push worker. The first two duplicate their cursor logic.
- **"Move" means three things** (rules remove only the Inbox; the UI leaves the source or every non-label mailbox; Sieve does a plain `fileinto`). Label colour and icon have two write APIs. Metadata and rules are keyed by email, everything Jev by account id.
- **Settings are four pages** (Folders, Labels, Rules, Jev) for what is one job.

Decisions already made by the owner:

1. **Jev owns the four Inbox tabs**, and nothing else about filing.
2. **Rules own folders and labels, exact-match only.** Plain-English (Jev) conditions are removed.
3. **Rules lose "set tab".** "Always put this sender in tab X" is a Jev sender pin.
4. **Folders and labels stay two things**: a folder is where a message lives; a label is a tag.
5. **Jev's spam layer and urgent alerts stay**, as separate optional add-ons.
6. **Two settings pages**: "Folders & labels" and "Inbox tabs".
7. **Staged.** Each stage is its own change, starting with stages 1 and 2.

Intended outcome: one definition of each concept, one engine for rules, one pipeline for new mail, and far less code.

## Target model

| Concept | What it is on the mail server | Who changes it |
|---|---|---|
| **Folder** | A mailbox not under `Labels`. A message lives in exactly one. | You, rules, the assistant, the spam add-on (Junk and Inbox only) |
| **Label** | A child mailbox of the top-level `Labels` mailbox. Many per message. | You, rules, the assistant |
| **Tab** | A `$cat_*` keyword on Inbox mail; Important means none. | You, sender pins, Jev |
| **Rule** | Exact conditions and one target: a folder or a label. | You, from that folder or label |

**What happens to a new Inbox message**, in one pass:

1. It is discovered and recorded.
2. **Rules** run in order. Labels accumulate; the first matching move wins. Rules never wait on Jev.
3. If a rule moved it out of the Inbox, stop.
4. **One Jev call**, only if a Jev feature is on: tab, spam and urgent questions together.
5. **Spam add-on** (active mode, confident, sender not trusted): move to Junk and stop.
6. **Tab**: your own earlier choice, then a pin, then Jev's confident pick, otherwise it stays in Important.
7. **Write**, after re-reading where the message is, so your own move always wins. The "sorted" marker that ends the Inbox hold goes in the same write.
8. **Record** what happened, then send any urgent alert.

Two behaviour changes follow from this:
- **Pins work whenever tabs are on, even with Jev off.** Needed so converted "set tab" rules keep working.
- **The Inbox hold also applies with Jev off** when an enabled move rule exists, so mail a rule files never flashes in the Inbox. The two-minute limit is unchanged.

## Target code structure

**New: `src/lib/server/mail-pipeline/`** replaces `rules-scheduler.ts`, the loop in `jev/worker.ts`, and both 20-second catch-ups in `src/hooks.server.ts:303-312`.
- `index.ts`: `startMailPipeline()` and `requestPass(...)`. One cron, one catch-up. Reuses the no-overlap and merged-rerun logic from `sortNewMailSafe` (`worker.ts:841-875`).
- `arrivals.ts`: the single cursor and discovery (reuses the stepping at `worker.ts:504-525`).
- `write.ts`: `writeUpdates` (`worker.ts:360-392`), the placement re-check, the marker.
- `stream.ts`: moved from `jev/stream.ts`; refreshed on settings and rule saves.
- `hold.ts`: moved from `jev/hold.ts`. `src/lib/inbox-hold.ts` is unchanged.

**`src/lib/server/rules/`**
- `engine.ts`: from `rules-engine.ts`, pure. Reuses `exactValue`, `ruleHolds`, `matcherProperties`, `outcomeToUpdate`.
- `schema.ts`: `parseRule()`, the only way a rule is saved (today the client's JSON is stored unvalidated).
- `store.ts`, `run.ts`: `runRules()` for the pipeline; `scanInbox(rules, {dryRun})` for both preview and apply, so they always agree.

**New: `src/lib/server/filing.ts`**, the functions every caller uses (UI endpoints, rules, the assistant's tools, jobs):
- `moveToFolder()`: leaves every non-label mailbox, keeps labels, refuses labels and the `Labels` container.
- `addLabel()` / `removeLabel()`: wrap `src/lib/jmap/labels.ts:239-268`; the Archive fallback always applies.
- `mailboxKind()`: system, folder, label, labels-root or special.
- `nextMailboxIds()`: the pure core, extracted from `updateEmailMailboxes` (`src/lib/jmap/email.ts:654-670`).

**`src/lib/server/jev/`**: `worker.ts` (887 lines) is split and deleted.
- `judge.ts`: fetching and the Jev call.
- `tab.ts`: pure `decideTab()` (merging three "is the tab still open" checks) and `setTab()` with learning, used by the bulk endpoint and the assistant.
- `spam.ts`: gains the spam plan. `urgent.ts`: moved from `telegram/urgent.ts`.
- `health.ts`: rate-limit and outage state. `step.ts`: the short orchestration. `backfill.ts`, `record.ts`.

**New: `src/lib/server/auto-reply.ts`**: out-of-office sent by the app (see "Out-of-office" below).

**Deleted**: `rules-scheduler.ts`, `rules-store.ts`, `rules.ts` (the JMAP-filter matcher), `jev/rules.ts`, `sieve.ts`, `/api/rules/jev-test`, `/api/rules/deploy`, `/api/jev/rule-feedback`, `/api/preferences/rules`, `/api/preferences/labels`. `FolderPicker` becomes `MailboxPicker` (stage 6); `FolderLocationPicker` keeps its select, built from the same folder list.

**Sieve is removed entirely.** Stage 0 was run on the owner's server: out-of-office was switched on and saved without error (so the script was uploaded and activated), a message was sent from Outlook, and no reply arrived in Outlook's Inbox or Junk. Stalwart on this deployment is not running the user's Sieve script at delivery, which matches the comment at `src/lib/server/rules-scheduler.ts:12-13`. So:
- The Sieve copy of the rules has never done anything; removing it changes no behaviour.
- Out-of-office has never worked. It moves into the app.
- The `mailrules` script already on the server is deactivated once per account, so it can't start acting if the server's configuration changes later.

**Out-of-office, sent by the app** (owner's choice): the new-mail pipeline sends the reply itself.
- Sent with `sendEmail` (`src/lib/jmap/email.ts:267`), marked `Auto-Submitted: auto-replied`, with `In-Reply-To` set.
- At most one reply per sender per day (a small `auto_reply_sent` table).
- Never to automatic or bulk mail: reuses the header facts already computed for Jev (`src/lib/server/jev/facts.ts:28-45`: `Auto-Submitted`, `Precedence`, list headers, no-reply senders).
- Only to mail addressed to the account directly, never to mail that went to Junk, never to the account's own addresses.
- It replies only while the app is running, like rules. The settings page says so.

## Data model

Stage 3 took 028 (`account_tasks`, one-time jobs per account such as retiring the Sieve script) and stage 4 took 029 (`auto_reply_log`), so the numbers below start at 030. Old tables stay until the last stage, so an interrupted upgrade loses nothing.

- **030 `rules`**: one row per rule, keyed by account id: position, enabled, name, conditions, one target (folder or label by id; Trash, Archive, Junk by role), `mark_read`, `star`, `stop`, an `attention` note, and the original rule kept as `legacy_json`.
  - Surviving actions: move, label, mark read, star (renamed from "mark important", which clashed with the Important tab), stop. "Delete" becomes a move to Trash.
  - A rule with several targets becomes adjacent rows, one per target.
  - **Rules with a Jev condition** are disabled and listed under "Needs your attention", never silently dropped.
  - **Rules that only set a tab** become sender pins when they are a simple sender match, and stay listed as a note saying which pin they became until the owner dismisses it; otherwise they are listed for attention, with the reason and, where they name a sender, a one-click pin. No conversion is silent.
  - Deleting a folder or label deletes its rules (the confirmation says how many).
- **029 `auto_reply_log`** (stage 4): account, sender address, time, message. One row per reply, written before it is sent; a sender gets at most one a day and a login at most 30 an hour, across all its accounts; pruned after 30 days.
- **031 `mailbox_meta`**: colour, icon and display name for folders and labels in one table, keyed by account id (merges `label_meta` and `folder_meta`).
- **032**: `mail_pipeline` (the one cursor), `mail_arrivals` (what was seen and which rules fired; pruned after a week), and `jev_settings.sort_cursor` renamed `jev_since`. `jev_user_tabs` (your own tab choices, replacing the fake "done" decision rows) moved to the clean-up stage.
- **033**: drop `user_rules`, `rules_cursor`, `label_meta`, `folder_meta`, `jev_rule_feedback` and the unused Jev columns.

## Settings

- **Folders & labels** (`/settings/folders-labels`): the folder tree and label list, each with colour, icon, rename, reorder, delete. Each row opens to its rules with "Add rule" (target already set). The rule editor shows how many recent Inbox messages match, using the real engine. A "Needs your attention" list at the top. A collapsed "All rules, in order" list for reordering.
- **Inbox tabs** (`/settings/inbox-tabs`): show tabs; let Jev sort new mail; sender pins; sort existing mail; usage. An "Add-ons" section for the spam check. Urgent alerts stay under Notifications.
- The old Folders, Labels, Rules and Jev pages redirect to these.

## Stages

Each is its own PR, migrates data automatically, and leaves the app correct.

| # | Goal | Main risk |
|---|---|---|
| 0 | **Done.** Tested on the real server: Stalwart does not run the Sieve script at delivery | — |
| 1 | **Done.** Rules become exact-match only; Jev rule conditions and their endpoints removed | Accounts with Jev rules switch runner |
| 2 | **Done.** Tabs belong to Jev: "set tab" removed from rules, tab rules become pins | Pins now act with Jev off |
| 3 | **Done.** One engine: preview and apply share it; Sieve removed; the old script deactivated on the server | Low: the script wasn't running |
| 4 | **Done.** Out-of-office sent by the app (hooked into the existing new-mail run; moves into the pipeline in stage 7) | Replying to the wrong mail; guarded by the rules above and tests |
| 5 | **Done.** Rules table (030) and validated saves | Splitting multi-target rules |
| 6 | **Done.** Folders and labels consistent: `filing.ts`, one metadata API (031), one picker | Moves now leave every folder, not just the Inbox |
| 7 | **Done.** One new-mail pipeline (032); `jev/worker.ts` split | The largest change |
| 8 | **Done.** The two settings pages: Folders & labels, Inbox tabs | UI only |
| 9 | Clean-up (033): a small "why is this here" on the tab chip, a `tab:` search operator, dead code | Low |

Stages 1 and 2 remove the most complexity for the least risk, and can ship before anything structural moves. Between stages 3 and 4 the Auto-reply settings page is hidden, since it does nothing today either. The README's Jev section and `docs/jev-plan.md` are updated in each stage.

## Verification

- Every stage: `npm run lint`, `npm run check`, `npx vitest run`.
- **Stage 1–2**: unit tests for the rule conversion (Jev rules flagged, tab rules to pins); keep the existing tests that rules run before the Inbox hold and while Jev is unreachable; drop the mixed-rule tests in `worker.test.ts:607-730`.
- **Stage 3**: a test that preview and apply return the same messages for the same rule.
- **Stage 4–5**: migration fixtures in the style of `src/lib/server/db/migrate.test.ts` (multi-target, Trash, missing target, interrupted run); extend `moves.test.ts` and `labels.test.ts`.
- **Stage 6**: port `worker.test.ts` by behaviour; add tests for the rules-only hold, cursor seeding and a restart mid-pass.
- **On the owner's Stalwart** (none is available in CI):
  1. Out-of-office (stage 4): a message from another address gets one reply; a second the same day gets none; a newsletter gets none.
  2. An exact rule files mail while Jev is unreachable.
  3. With Jev off, a pinned sender lands in its tab without flashing in Important.
  4. New mail reaches its tab within seconds; a dropped event stream falls back to the minute run.
  5. Removing a message's only label sends it to Archive.

## Open questions for the owner

1. **Out-of-office per account?** Answered: one setting for all linked accounts, with optional start and end dates (stage 4).
2. **Rules to Junk**: answered: yes, as the owner's exact rule; no spam-training keywords are set (stage 5).
3. **Mail delivered straight to another folder** (not the Inbox) is never seen by rules. Keep it that way?

## Status

Stages 0 to 8 are done. Later stages follow one PR at a time.

## Design notes

The designs each stage was built to, kept for the reasons behind them.

### Stage 3 design: one matcher, Sieve removed

#### Why
- "How many emails match" (preview) and "Save & apply" disagree today. Preview counts with a mail-server search over every folder (`buildJmapFilter`, `src/lib/server/rules.ts`), which is word-based and can't express "is", "starts with" or "ends with". Apply uses the real engine on the Inbox. The apply endpoint's own comment calls the search approach wrong (`src/routes/api/rules/apply/+server.ts`, the comment above the scan loop).
- Apply acts on rules sent in the request body instead of the saved ones.
- Sieve does nothing on this server but is compiled and uploaded on every save, and can switch off a script made in another mail client.

#### 3a. One scan for preview and apply
New `src/lib/server/rules-scan.ts`:
- `scanInbox(client, accountId, rules, opts)` pages the Inbox newest first and runs each page through the existing engine (`matcherProperties`, `updatesForEmails` in `src/lib/server/rules-engine.ts`).
- `opts.apply`: when false it only counts; when true it writes, with the batching and rejected-write accounting that the apply endpoint has today (moved here, not rewritten).
- `opts.limit`: stop after this many messages. `opts.onProgress`, `opts.cancelled` as today.
- Returns `{ scanned, matched, applied, failed, failedReason, total }`.

`/api/rules/preview`:
- Takes the rule being edited (unsaved), passes it through the same guard a saved rule gets (`isRunnable`, and the save-time conversion in `src/lib/server/rules-upgrade.ts`), then `scanInbox` with `apply: false`.
- Limit: the newest 500 Inbox messages; 200 when the rule has a body condition (bodies are fetched).
- Returns `{ matched, scanned, total }`. The editor shows "12 of your newest 500 Inbox messages match", or "12 Inbox messages match" when the whole Inbox was scanned.

`/api/rules/apply`:
- Takes `{ ruleIds?: string[] }` and loads those rules from the store (all enabled rules when omitted). Rules in the request body are no longer accepted. The page saves first, then applies, which it already does.
- Keeps its preflight (missing or unset targets), its progress stream and Cancel.

Deleted: `src/lib/server/rules.ts` and the tests for `buildJmapFilter`.

#### 3b. Sieve removed
- Deleted: `src/lib/server/sieve.ts`, `/api/rules/deploy` and its test, the Sieve tests in `rules-engine.test.ts`, the deploy call and both Sieve banners on the rules page, Sieve mentions in comments and the README.
- **The script already on the server is retired once per account.** New migration `028_account_tasks.sql`: `account_tasks(account_id, name, done_at)`, cascading from `mail_accounts`. On an account's next rules run (it has the credentials), task `retire_sieve_script`:
  - `SieveScript/get`; if a script named `mailrules` exists, deactivate it if it is the active one (`onSuccessDeactivateScript`) and destroy it. A script with any other name is never touched.
  - Mark done on success, and also when the server has no Sieve capability. Any other failure never blocks rules and is retried an hour later (kept in memory, so a restart may retry once); the warning is logged on the first failure and then at most once a day.
- **Auto-reply settings page**: removed from the settings navigation and redirected to `/settings` in this commit (it has never worked); stage 4 brings it back.

#### Stage 3 tests
- Preview and apply report the same matches for the same rule on the same Inbox (the test the plan asked for), including for "is", "starts with", NOT, and a body condition.
- Preview never writes; preview of a rule flagged for attention reports 0 without scanning.
- Apply ignores rules in the request body; unknown rule ids are refused; Cancel stops at the next page.
- `retire_sieve_script`: deactivates and destroys `mailrules`; leaves another active script alone; no Sieve capability marks it done; a failure retries an hour later, not on the next minute's run, and is logged at most once a day; runs once.
- The form-action and route tests still pass with `/api/rules/deploy` gone.

### Stage 4 design: out-of-office sent by the app

Owner's choices: one setting for all linked accounts; optional start and end dates.

#### Settings
Stored per login, as today (`auto_reply_enabled`, `auto_reply_subject`, `auto_reply_body` in `src/lib/preference-keys.ts`), plus:
- `auto_reply_from`, `auto_reply_until`: optional dates (`YYYY-MM-DD`). Either or both may be empty.
- `auto_reply_tz`: the browser's time zone at the moment of saving, so the dates mean the owner's days.
- `auto_reply_since`: set by the server when out-of-office is switched on or its dates change. No reply is sent to mail that arrived before it.

Out-of-office is **active** when it is enabled, the message is not empty, today (in `auto_reply_tz`) is on or after `from` if set, and on or before `until` if set. It applies to every linked mail account of that login.

The page (`src/routes/(app)/settings/auto-reply/+page.svelte`, back in the navigation):
- Switch, "From" and "Until" date fields (optional), Subject (optional), Message.
- Its own **Save** button; nothing is sent on change. (It moves to the shared Save bar in the settings pass.)
- A status line: "Off", "On", "Starts 20 Nov", "On until 28 Nov", "Ended 28 Nov".
- Plain statement of the rules: sent by Zajel while it is running; at most one reply per sender per day; never to newsletters, mailing lists or automatic mail.
- "Replies sent" with the last few recipients and times, from the log below.

#### Where it runs
In the rules scheduler's per-account run (`runApply` in `src/lib/server/rules-scheduler.ts`), which already sees each new Inbox message exactly once and runs whether or not Jev is on. Changes:
- The run proceeds when the account has enabled rules **or** out-of-office is active for its login (today it returns early with no rules).
- The message fetch adds what the reply decision needs: `from`, `to`, `cc`, `replyTo`, `messageId`, `references`, `subject`, `receivedAt`, `keywords`, and the headers `auto-submitted`, `precedence`, `list-id`, `list-unsubscribe`, `x-auto-response-suppress`, `x-spam-status`.
- The reply decision is made on the message as it arrived, before rules move it. It moves into the single pipeline in stage 7.

#### New `src/lib/server/auto-reply.ts`
`shouldAutoReply(email, ctx)`: pure, returns the address to reply to, or a reason not to. No reply when any of these holds:
1. Out-of-office is not active, or the message arrived before `auto_reply_since`, or more than 24 hours ago (so a restart after downtime doesn't answer old mail).
2. `Auto-Submitted` is present and not `no`; `Precedence` is `bulk`, `list` or `junk`; any `List-Id` or `List-Unsubscribe`; `X-Auto-Response-Suppress` contains `All`, `OOF` or `AutoReply`. (Reuse the header reading in `src/lib/server/jev/facts.ts`.) A delivery report or read receipt: `Return-Path` empty or `<>`, or a `multipart/report` Content-Type.
3. From is not exactly one address with an `@` (none, several, or a group), or its local part is a robot: the no-reply pattern Jev's facts use (`sender_looks_automated`: `no_reply`, `noreply-billing`, `bounce-12345`, `notification`, `alerts`, `do_not_reply` and the like), plus `mailer-daemon` and `postmaster`. Or the message failed sender authentication (`dmarc=fail` in its `Authentication-Results`, read as Jev's spam facts do); a message with no such header is judged on the rest.
4. The sender is one of the owner's own addresses (any linked account or identity).
5. The account's address (or one of its identities) is not in To or Cc.
6. The message is marked as spam (`$junk` keyword, or `X-Spam-Status: Yes`).
7. That sender was already answered in the last 24 hours from **any** of the login's accounts (so mail to two of the owner's addresses gets one reply).
8. The login has sent 30 automatic replies in the last hour, across its accounts (a cap, in case of a loop).

`sendAutoReply(...)`:
- To: the message's From address, always. Reply-To is never used: anyone can set it, so it would let a stranger aim the reply at a third party or a list, and dodge the once-a-day limit by changing From. The daily check, the log row and the "Replies sent" list all use that address, lower-cased.
- Subject: the saved subject if set, otherwise `Automatic reply: <original subject>`.
- Body: the saved message, as plain text.
- Headers: `Auto-Submitted: auto-replied`, `X-Auto-Response-Suppress: All`, `In-Reply-To` and `References` from the original. (`buildEmailCreate` in `src/lib/jmap/email.ts` already sets custom headers this way.)
- Sent from the account's primary identity. The copy is created in one request and submitted in a second, so its id is always known; it is deleted after sending (`onSuccessDestroyEmail`) so Sent doesn't fill with automatic replies, and when the submission did not surely succeed it is destroyed (one attempt, a failure only logged).
- The log row is written **before** sending, so a crash can't cause a second reply, in one transaction with a fresh check of the login's daily and hourly limits, so two accounts' runs can't both answer one sender. It is removed only when the server **definitely refused**: the copy wasn't created, or the submission came back `notCreated` or with a method-level error. On anything uncertain (timeout, dropped connection, a 5xx) the row stays and the event is logged as uncertain: the mail may have gone, so the sender gets no more replies that day.

#### Data
Migration `029_auto_reply.sql`: `auto_reply_log(account_id, sender, sent_at, email_id)`, cascading from `mail_accounts`, indexed by `(account_id, sender, sent_at)`. Rows older than 30 days are pruned on the daily pass. Rows are per account, but the daily check and the hourly cap read them per login, joined to `mail_accounts` on `user_id`.

#### Stage 4 tests
- `shouldAutoReply`: one test per rule above, each failing without its rule; the active-window logic across time zones and at both date boundaries; empty dates.
- One reply per sender per day; a second message the same day gets none; the next day gets one.
- The hourly cap.
- The reply's recipient (From, never Reply-To), subject, headers and thread references; the copy is destroyed; a refused send removes the log row, an uncertain one keeps it; a refused copy is never submitted.
- One reply per person across the login's accounts; the hourly cap is the login's.
- The scheduler runs with out-of-office active and no rules; no reply to mail from before it was switched on, or on first sight of an account.
- Page: nothing saved until Save; status line for each state; dates validated (until not before from).

#### Verification on the owner's server (stage 3 and 4 together)
1. After deploying, the `mailrules` script is gone from Stalwart; any other script is untouched.
2. Rule editor: the match count agrees with what "Save & apply" then moves.
3. Out-of-office on: a message from Outlook gets one reply; a second the same day gets none; a newsletter gets none; a message from before switching on gets none.
4. With an end date of today, no reply tomorrow.

#### Risks
- **Replying to the wrong mail.** Guarded by rules 2 to 8, the cap, and one-per-day. Stalwart's own spam filtering has already filed most spam into Junk, which is never seen here; mail Jev later moves to Junk may get a reply first.
- **Preview cost.** Up to 500 messages are fetched per preview (200 with bodies), debounced as today.
- **Replies only while the app runs.** Stated on the page.

### Stage 5 design: rules in their own table, saved one at a time, validated

#### Why
- Rules are one JSON blob per mail **address** (`user_rules`), while everything else about an account is keyed by the account row. Removing an account leaves its rules behind.
- The page saves by posting the whole list; the server stores whatever it is sent (`saveRules`, `src/lib/server/rules-store.ts`). There is no validation and no way to reorder.
- A rule holds a free list of actions. The agreed model is simpler: a rule files into **one** place (a folder or a label), and may also mark as read, star, or stop later rules.

#### The rule, after this stage
```
id, name, enabled, logic (all / any), conditions[]
target:  none | folder <mailbox id> | label <mailbox id> | trash | archive | junk
markRead, star, stop        (booleans)
attention, legacy, note     (set by the server only)
```
- `star` is today's "mark important", renamed because it clashed with the Important tab. `delete` becomes target `trash`.
- `target: none` is allowed, for rules that only mark as read or star.
- Order matters and is stored as `position`. Running in order: labels add up; the **first** matching rule that moves a message decides its folder; `stop` ends evaluation. (Today two matching move rules leave a message in both folders; a message lives in one folder, so the first wins.)
- Rules may move mail to Junk (the owner's exact rule; no spam-training keywords are set). Mail delivered straight to another folder is still not seen by rules. Both as today.

#### Data
Migration `030_rules.sql`: table `rules` (`id`, `account_id` cascading from `mail_accounts`, `position`, `enabled`, `name`, `logic`, `conditions_json`, `target_kind`, `target_mailbox_id`, `target_role`, `mark_read`, `star`, `stop`, `attention`, `note_json`, `legacy_json`, `created_at`, `updated_at`), indexed by `(account_id, position)`.

One-time data step `data/rules_to_table` (the `DATA_STEPS` runner in `src/lib/server/db/migrate.ts`; runs after the two existing rule steps, so it reads rules that are already exact-only and tab-free):
- For each `user_rules` row whose address has a mail account (exact match, then case-insensitive) and whose account has no rows in `rules` yet, convert each stored rule and insert, all in one transaction.
- A rule with several filing actions becomes adjacent rows, one per target, in the original order: same name, same conditions; `markRead` and `star` on the first row; `stop` on the last. Rows after the first carry a dismissible note: "This rule filed mail in several places, so it is now N rules."
- Flagged rules (`jev_condition`, `tab_rule`, `tab_pinned`, `tab_removed`) keep their flag, note and `legacy` exactly.
- A rule whose target mailbox no longer exists is carried over unchanged (the engine already skips it; the page marks it "target missing").
- Addresses with no account are left where they are. `user_rules` and `rules_cursor` are not dropped or written by this stage (dropped in the last stage), so a failed or interrupted upgrade loses nothing.
- Unlinking an account now deletes its rules: add the count to `unlinkLosses` (`src/lib/server/auth/accounts.ts`) so the unlink confirmation says so.

#### Code
Create `src/lib/server/rules/` and move what exists into it (imports updated, no behaviour change): `rules-engine.ts` → `rules/engine.ts`, `rules-scan.ts` → `rules/scan.ts`, `rules-upgrade.ts` → `rules/upgrade.ts`. New:
- `rules/schema.ts`: `parseRule(input, mailboxes)`, the only way a rule enters the store. It returns a clean rule or a list of plain-English problems. Checks: name (1–120 characters); logic; 1–20 conditions with known field and operator, value up to 500 characters, a number for size; at least one usable condition; target mailbox exists and is of the stated kind (reuse `isLabelMailbox` / `labelMailboxIds` in `src/lib/types/labels.ts`; never the `Labels` container, Remind Me Later or Scheduled); role targets exist on the account; the rule does something (a target, mark read or star). Unknown fields are dropped; `attention`, `note` and `legacy` can never be set by a client.
- `rules/store.ts`: `listRules`, `getRule`, `createRule`, `updateRule`, `deleteRule`, `reorderRules`, `dismissNote`, `deleteRulesForMailbox`, all by account id.
- `rules/engine.ts`: evaluates the new shape. `evaluateRulesForEmail` and `updatesForEmails` keep their names and callers (scheduler, scan).

API (all for the active account; every write goes through `parseRule`):
- `GET /api/rules`, `POST /api/rules` (create).
- `PATCH /api/rules/[id]` (edit, enable/disable), `DELETE /api/rules/[id]`.
- `POST /api/rules/reorder` `{ ids }` (must be exactly the account's rule ids).
- `POST /api/rules/[id]/dismiss`: clears a `tab_removed` or split note; deletes a `tab_pinned` stub.
- `POST /api/rules/[id]/pin`: the existing "Pin <sender> to <tab>" for a flagged tab rule, done in one server call (create or replace the pin, delete the rule).
- A flagged rule (`jev_condition`, `tab_rule`) can only be enabled by a `PATCH` that makes it a valid exact rule, which clears the flag ("Save as exact rule").
- `/api/rules/preview` takes a draft through `parseRule` (problems are returned, not thrown); `/api/rules/apply` is unchanged (`{ ruleIds }`).
- Deleted: `/api/preferences/rules`, `rules-store.ts`, `db/queries/rules.ts`'s rule functions (the cursor functions stay), the `mail_rules` cookie import, and the save-time conversion (no whole-list saves remain to convert).

Deleting a folder or label (`/api/folders`, the label delete in `src/lib/jmap/labels.ts` callers) also deletes the rules that file into it; the confirmation says how many.

#### The page
`src/routes/(app)/settings/rules/` keeps its place until the settings pass, but is rebuilt on the new API:
- New `src/lib/components/settings/RuleEditor.svelte` (reused by the "Folders & labels" page in stage 8): name; conditions; "Then": one target picker (a folder, a label, Trash, Archive, Junk, or nothing) and three checkboxes (mark as read, star, stop processing later rules); the live match count; **Save**, **Save & apply**, Cancel, Delete. Nothing is sent until Save. Validation problems from the server are shown beside the fields.
- The list: each rule as "conditions → target", with its on/off switch, and **move up / move down** (there is no way to reorder today).
- "Needs your attention" as now, using the new dismiss and pin calls.
- Rules are loaded by the page's own server load, not by the app layout on every navigation.

#### Tests
- `parseRule`: each check, with the message it returns; unknown fields dropped; client-set `attention` ignored; a label id given as a folder (and the reverse) refused; the `Labels` container refused.
- Store: create / update / delete / reorder; another account's rule id is "not found"; reorder with a missing or foreign id refused; cascade on account delete.
- Data step: single-action rules; a rule with two labels and a move becomes three rows with flags and `stop` placed as designed and the note on rows two and three; `delete` → Trash; `markImportant` → star; each flagged kind carried over intact; missing target; address without an account left alone; case-different address; running twice changes nothing; a failure half-way leaves no rows and no marker.
- Engine: labels add up; first move wins; `stop`; mark read and star; flagged or disabled rules never run; target missing is skipped.
- API: every route requires sign-in and the active account; enabling a flagged rule without fixing it is refused; dismiss and pin behave per kind.
- Folder / label delete removes its rules and reports the count.
- Page and editor: nothing sent until Save; server problems shown; move up / down calls reorder; Save & apply applies the saved rule.
- Scheduler, scan, preview and apply tests still pass on the new shape (preview and apply still agree).

#### Verification on the owner's server
1. After deploying, every rule is still listed, in the same order, and files the same mail (try two that were multi-action before).
2. Reorder two rules; create, edit and delete one; "Save & apply" on one.
3. Delete a label that a rule files into: the confirmation names the rule count, and the rule is gone.

#### Risks
- **Splitting multi-target rules** changes how the list looks; the note on the extra rows says why.
- **First move wins**: mail that two move rules used to leave in two folders now goes to the first rule's folder only.
- **Size**: storage, API, engine shape, migration and the editor in one stage. It is built as three commits (storage and migration; API and engine; page and editor), each passing on its own.

#### As built
- `target_kind` is stored as `none`, `folder`, `label` or `role`, with the role in `target_role`; the API's target is `{ kind: 'none' | 'folder' | 'label' | 'trash' | 'archive' | 'junk', mailboxId? }`. Rule ids are unique per account (primary key `(account_id, id)`): ids from the old lists are kept, and the extra rows of a split rule are `<id>~2`, `<id>~3`.
- The split note is a new `RuleAttention`, `split`, with `note.splitInto`. A split rule that was already flagged keeps its flag on every row (a rule waiting to be rewritten must not run in part), and its extra rows carry the split note beside the flag.
- A folder with the role Trash, Archive or Junk given as a folder is stored as that role. The Inbox, Sent and Drafts are refused as targets.
- A `PATCH` of only `enabled` and/or `name` is a small edit: only those are checked (a name of 1–120 characters) and saved, so a rule the upgrade carried over (21 conditions, a deleted folder, a stop-only rule) can always be switched off, renamed, or (unflagged) switched on. A `PATCH` with any of `logic`, `conditions`, `target`, `markRead`, `star`, `stop` is a full edit and goes through `parseRule`; the editor sends a rename alone as a small edit.
- A rule waiting to be rewritten (`jev_condition`, `tab_rule`, `tab_pinned`) is switched on, and its flag, note and `legacy` cleared, only by a full edit that passes `parseRule` and carries `rewrite: true` ("Save as exact rule"). Any other edit of it is saved but leaves it flagged and off; asking to switch it on without `rewrite` is refused. The editor has a plain **Save** and a separate **Save as exact rule**, which for a `jev_condition` rule first asks: "This rule also required: “…”. Save it without that?"
- A rule that only stops later rules is valid: "does something" is a target, mark read, star or stop.
- The main list holds every rule that can run, in its real order, a split or `tab_removed` rule included with its note and "Got it" on its row. "Needs your attention" holds only the rules switched off by a flag, without move buttons. Move up / down swaps a rule with its neighbour in the main list and sends the whole order with just those two exchanged.
- The data step never gives an account another spelling's list when a `user_rules` row with its exact address exists, even an empty or unreadable one: the old engine read only that one.
- The preview counts a draft whose only problems are its name or target, and returns the problems with the count; problems with its conditions count nothing.
- Deleting a folder or label deletes the rules that only file into it. A rule that also marks read, stars or stops later rules is kept with its target set to none, so the rules below it don't start acting on mail it used to stop. The delete responses report `rulesDeleted` and `rulesKept`; the confirmations work both out from `GET /api/rules` before asking and name each count that isn't 0.

### Stage 6 design: folders and labels behave one way everywhere

#### Why
"Where does this message live" is decided differently depending on who asks:
- A hand move leaves the source folder, or every folder, or (from a label view) the **label**, depending on the caller. A rule's move leaves only the Inbox. The assistant's snooze leaves one folder; the app's snooze leaves all.
- "Move to…" offers labels, Remind Me Later and Scheduled as if they were folders. Picking a label there takes the message out of its folder. The move endpoints and the assistant accept the `Labels` container as a destination.
- Removing a message's only label sends it to Archive from the app, and silently does nothing from the assistant.
- Colour and icon live in two tables keyed by mail address, written through three APIs (label colour is written twice on edit); deleting a folder leaves its row behind; the sidebar reads label colour from the server and folder colour from a client store.
- Six pieces of code each decide what kind of mailbox something is, and disagree.

#### The rules, in one place
A message is in **exactly one folder** and **any number of labels**.

Kinds of mailbox (one function decides, see below):
- `system`: has a role (Inbox, Archive, Sent, Drafts, Junk, Trash…).
- `special`: Remind Me Later and Scheduled (found as today, by role or by name at the top level).
- `labels-root`: the top-level mailbox named `Labels`.
- `label`: a direct child of `labels-root`.
- `folder`: everything else.

Operations:
1. **Move to a folder.** Allowed destinations: a `folder`, or the system folders Inbox, Archive, Junk, Trash. Never a label, the labels root, Remind Me Later, Scheduled, Drafts or Sent. Afterwards the message is in the destination and keeps all its labels; it has left every other non-label mailbox, whichever one the caller thought it was in.
2. **Add a label.** The label is added; nothing else changes.
3. **Remove a label.** The label is removed. If that would leave the message in no mailbox at all, it goes to Archive. Always, from every caller.
4. Trash, Archive, Spam, Not spam, Snooze are moves under rule 1 with their existing extras (`$junk` / `$notjunk` keywords, destroying mail already in Trash, creating the reminder). Reminder return and cancel stay as they are (the message is only in Remind Me Later, plus labels).
5. Scheduled send's own handling of Drafts/Sent is out of scope.

#### Code

**New `src/lib/mailboxes.ts`** (pure, used by server and client):
- `mailboxKind(mailbox, mailboxes)` → the five kinds above. Replaces the inline checks in `src/lib/utils/folder-tree.ts` (`filterUserFolders` is rebuilt on it), `src/routes/api/folders/+server.ts` (`isSystem` / `isLabel`), `src/lib/server/rules/schema.ts` (`parseTarget`), `src/lib/server/agent/tools.ts` (`list_folders`), `Sidebar.svelte` (`pseudoRole`), and the scattered Remind Me Later name checks. `src/lib/types/labels.ts`'s `findLabelsParentId` / `isLabelMailbox` / `labelMailboxIds` stay as the low-level helpers it uses.
- `canMoveInto(mailbox, mailboxes)` → rule 1's destination test.
- `nextMailboxIds(current, op, mailboxes)` → the resulting `mailboxIds` for `{move: id}`, `{addLabel: id}`, `{removeLabel: id, archiveId}`. The one place the rules above are written. Extracted from `updateEmailMailboxes` (`src/lib/jmap/email.ts` ~654-670).
- `folderOptions(mailboxes)` → the folder tree as a flat, indented list (from `buildFolderTree`), for pickers.

**New `src/lib/server/filing.ts`**: `moveToFolder(client, accountId, ids, targetId)`, `addLabel(...)`, `removeLabel(...)`. Each loads the mailboxes, refuses a bad target with a plain error, computes with `nextMailboxIds`, writes whole `mailboxIds` objects (the existing Stalwart all-digit-id workaround), and reports rejected writes.
- `src/lib/jmap/email.ts`: `moveAway` and the `leave` / `sourceMailboxId` logic are deleted. `moveEmail(s)`, `trashEmail`, `archiveEmail`, `markAsSpam`, `markAsNotSpam` and their bulk forms are rebuilt on `filing.ts` (or replaced by it where the caller is server code); `sourceMailboxId` parameters disappear from them and from the endpoints' bodies (accepted and ignored for one release so an open tab doesn't break).
- `src/lib/jmap/labels.ts` `applyLabel` / `removeLabel` become the `filing.ts` functions; `deleteLabelMailbox`'s detach keeps its Archive fallback through `nextMailboxIds`.
- Callers moved onto `filing.ts`: `src/routes/api/email/[id]/+server.ts`, `src/routes/api/email/bulk/+server.ts`, `src/routes/api/email/[id]/label/+server.ts`, `src/routes/api/reminders` (snooze), `src/lib/server/agent/tools.ts` (`move_to_folder`, `set_label`, `archive`, `move_to_trash`, `snooze`), `src/lib/server/jobs/runner.ts`, `src/lib/server/telegram/notifier.ts`, the Jev worker's Junk move and rescue, and the rules engine (`src/lib/server/rules/engine.ts`: a rule's move now uses `nextMailboxIds`, so it leaves every folder, not just the Inbox).
- A `moveTo` request whose target is a label is treated as **add label** (the sidebar's drop on a label, and old clients). A target that is the labels root, Remind Me Later, Scheduled, Drafts or Sent is refused with 400.
- `/api/folders`: Remind Me Later and Scheduled can no longer be renamed, moved or deleted.

**Pickers**
- New `src/lib/components/MailboxPicker.svelte` replaces `FolderPicker.svelte` (used in `EmailList.svelte` and `EmailDetail.svelte`). Two sections: **Move to** (Inbox, Archive, Junk, Trash, then the folder tree, indented) and **Label** (the labels; picking one adds the label and does not move the message). No Remind Me Later, Scheduled or labels root.
- `modals/FolderLocationPicker.svelte` and the target select in `settings/RuleEditor.svelte` keep their `<select>` form but are built from `folderOptions` / `mailboxKind`, so all three list the same folders in the same order.
- The sidebar: dropping on Remind Me Later is no longer allowed (it created no reminder).

**Metadata**
- Migration `031_mailbox_meta.sql`: `mailbox_meta(account_id, mailbox_id, color, icon, display_name, created_at, updated_at)`, all three values nullable, primary key `(account_id, mailbox_id)`, cascading from `mail_accounts`. Filled in the same migration from `label_meta` and `folder_meta` by joining the address to `mail_accounts.email` (exact match first, then case-insensitive only for addresses with no exact match). The old tables are left alone (dropped in the last stage).
- One store, `src/lib/server/db/queries/mailbox-meta.ts`, keyed by account id; a value can be set back to nothing (today's `COALESCE` upsert can't clear one).
- One API: `PATCH /api/mailboxes/[id]/meta` `{ color?, icon?, displayName? }` (null clears). Deleting a folder or a label deletes its row server-side.
- The app layout returns the active account's metadata; the sidebar reads label **and** folder colour and icon from it. `src/lib/stores/userState.ts` loses its folder and label parts.
- Deleted: `/api/user-state/labels/**`, `/api/user-state/folders/**`, the `updateColor` action of `/api/preferences/labels`, `db/queries/label-meta.ts`, `db/queries/folder-meta.ts`. `CreateMailboxModal.svelte` writes metadata once, through the new route. (`/api/preferences/labels` create / rename / delete stays until the settings pages are merged.)

**The old keyword-label migration** (`migrateKeywordLabelsIfNeeded`, `src/lib/server/labels.ts`): runs only when the `mail_labels` cookie is present (today it runs on every page load until a marker cookie is set); writes through `filing.ts` (it uses a patch form the code elsewhere says Stalwart rejects, and ignores the result); checks the result before deleting the cookie.

#### What the owner will notice
1. "Move to…" lists folders as a tree, and labels in their own "Label" section. Picking a label adds it; it no longer takes the message out of its folder.
2. Moving a message while looking at a label keeps the label (it used to drop the label and leave a copy in the old folder).
3. A message that was in two folders ends up only in the one it is moved to.
4. A rule's move takes the message out of every folder, not just the Inbox.
5. Snoozing from the assistant or Telegram behaves like snoozing in the app.
6. Taking the last label off a message always sends it to Archive.
7. Remind Me Later and Scheduled can't be renamed or deleted, and aren't offered as places to move mail.
8. Colours and icons carry over; a folder's or label's colour can now be cleared.

#### Tests
- `mailboxes.test.ts`: `mailboxKind` for each kind (including a label's child, a top-level folder called "Scheduled", an account with no `Labels`); `canMoveInto` for each; `nextMailboxIds` for: move from one folder; move when in two folders; move keeps labels; move from a label-only message; add label; remove label; remove the only label → Archive; remove a label that isn't on the message.
- `filing.test.ts`: each bad destination refused; rejected writes reported; bulk.
- `src/routes/api/email/bulk/moves.test.ts` updated: moving to a folder from a label view now gives the folder **and** the label (today's assertion at ~138 changes); a `moveTo` onto a label adds it and keeps the folder; the labels root, Remind Me Later, Scheduled, Drafts, Sent refused.
- Rules engine: a move leaves every folder and keeps labels. Jev worker: Junk move and rescue unchanged in result for Inbox mail.
- Agent tools: `move_to_folder` refuses the labels root / specials; `set_label` off on a label-only message → Archive; `snooze` leaves every folder; `list_folders` kinds.
- `/api/folders`: Remind Me Later and Scheduled protected.
- Metadata: the migration (label and folder rows, case-different address, address without an account, both tables holding the same mailbox id); clearing a colour; folder delete and label delete remove the row; another account's mailbox id refused; the layout provides metadata.
- `MailboxPicker`: sections, order, tree indentation, nothing special listed; picking a label calls add-label.
- Keyword migration: not run without the cookie; cookie kept when a write is refused.

#### Verification on the owner's server
1. Move a message from a label view to a folder: it is in the folder and still has the label.
2. "Move to…" → a label: the message keeps its folder and gains the label.
3. Remove a message's only label (one that is in no folder): it appears in Archive.
4. Folder and label colours and icons look as before; clear one and reload.

#### Risks
- **Behaviour changes 2, 3 and 4** are deliberate and visible; they are the point of the stage.
- **Many callers move at once.** Three commits, each passing on its own: (1) `mailboxes.ts`, `filing.ts` and every mail-moving caller; (2) metadata; (3) pickers and the keyword migration.

#### Done means
Every test point has a test seen to fail without its behaviour; `npm run lint` clean, `npm run check` 0 errors, full `npx vitest run` passing on each commit; README and `docs/organising-mail-plan.md` updated (stage 6 marked done, this design added to its notes).

#### As built
- `mailboxKind`, `canMoveInto`, `nextMailboxIds` and `folderOptions` are in `src/lib/mailboxes.ts`, with the folder tree helpers (`buildFolderTree`, `flattenFolderTree`, `filterUserFolders`, `byPosition`), `isScheduledMailbox` and the Remind Me Later and Scheduled names. `src/lib/utils/folder-tree.ts` and `src/lib/jmap/mailbox.ts` re-export them. Remind Me Later is found by name at the top level, without a role (no server gives it one).
- `nextMailboxIds` returns null when taking a label off would leave a message in nothing and no Archive is known yet; `filing.ts` then finds or makes Archive and asks again, so Archive is only made when it is needed.
- `filing.ts` also has `fileInto` (the endpoints' "Move to": a label adds it, anything else is a move), `moveToTrash`, `moveToArchive`, `markSpam`, `markNotSpam` and `snoozeEmail`. Snoozing from the app, the assistant and Telegram all use `snoozeEmail`: the message comes back to the folder the caller named only if it is really in it, otherwise to the first folder it is in, otherwise the Inbox. Telegram names the Inbox. The assistant can now snooze a message that is only in a label (it comes back to the Inbox).
- The rules engine and the Jev worker's Junk move and rescue keep their own batched writes and refusal records; their moves go through `nextMailboxIds` (`RuleOutcome` is now `moveTo` plus `labels`), not through `filing.ts`'s writes.
- Trash deletes for good only on an explicit `permanent: true` for a message really in Trash (see "After review"). `sourceMailboxId` is ignored by every mail endpoint; only the reminder endpoint still reads it, as a hint for where a snoozed message comes back to, used only when the message is really there. "Trust sender" brings a message out of Junk when it is really in Junk, whatever the view.
- `list_folders` says `folder` (mail can be moved into it), `label`, or `not for filing`.
- The sidebar no longer accepts a drop on Remind Me Later from the first commit on, since the server refuses that move from then.
- `mailbox_meta`: a row with no values left is removed. Where both old tables had the same mailbox for an account, the colour and icon changed last win (on a tie, the folder's). A display name comes only from `label_meta`, and a `folder_meta` row with no colour or icon brings nothing. An empty icon, colour or name became NULL.
- `PATCH /api/mailboxes/[id]/meta` takes the active account's folders and labels only: an id the account doesn't have is 404; a system folder, Remind Me Later, Scheduled or the Labels container is 400.
- Labels' colours still reach the sidebar in the label list (`listLabels`), because a label with no colour of its own gets one from the automatic palette; the list is built from `mailbox_meta` in the same page load as `mailboxMeta`.
- The create and edit dialog writes colour and icon only, in one call, and has a "No color" choice so a colour can be cleared. Renaming a label clears any stored display name, so the label's own name shows. A colour sent with `/api/preferences/labels` `create` is still stored, for an open tab of the older app. `Label.createdAt` is gone (it came from `label_meta` and nothing read it).
- The keyword-label migration no longer sets or reads the `mail_labels_migrated` marker. It asks for marked messages from the start each round (the old code moved its position forward while clearing the keyword, so it skipped messages), and clears the keyword with `false` in the same write as the label.

#### After review
Principle: never take a message out of a mailbox the app can't identify, and never destroy mail unless the person is looking at Trash.
- **A label made during a pass is kept.** A move leaves every mailbox the list knows and calls something other than a label; an id the list doesn't know is kept. The Jev worker and the rules scheduler fetch the mailbox list once more, at most once a pass, when a message about to be written is in a mailbox the list doesn't know.
- **Deleting for good needs `permanent: true`** on the single and bulk Trash, and the message really being in Trash. Without it, Trash on a message already in Trash changes nothing. The app sends it only from the Trash list itself: its rows, its bulk Trash, its reading pane, and a message opened from it (`/email/<id>?from=trash`). Never from a label, Search, Starred, the assistant or Telegram.
- **Undo after Trash** uses a new `restore` action: `{ action: 'restore', mailboxId }` takes a message out of Trash, labels kept, back to any folder or system folder, Sent and Drafts included. Remind Me Later, Scheduled, a label, the Labels container, Trash or an unknown id send it to the Inbox. A message no longer in Trash is left alone.
- **One answer to "can mail go here"**: `canDropOn` in `src/lib/mailboxes.ts` (the sidebar's), on top of `canMoveInto`, which now also refuses a folder named "Sent Messages", as the old picker and sidebar did.
- **The old keyword-label migration** gives the cookie's colour only to a label it made, and after a run that leaves the cookie it waits an hour before trying again for that account (in memory; the warning is logged the first time, then at most once a day).
- **Bulk actions** write 50 updates to an `Email/set` (`EMAIL_SET_BATCH`, also used by the rules) and answer 200 with `failed: [ids]` when at least one message was written, 500 when none was. Spam corrections are recorded for the written ones only. The list says "3 messages couldn’t be moved" (or archived, moved to Trash, deleted, moved to Spam) and refreshes.
- **Telegram's Archive button** answers "No Archive folder" when there is none and none can be made.
- **The label endpoint** answers with the message's resulting `mailboxIds`, and the open message shows them, so taking off its only label shows it in Archive without a reload.

#### Notes for the PR
- A tab left open across the deploy can't change folder or label colours until it is reloaded: the routes it used are gone (404 / 400). No mail is affected.

### Stage 7 design: one pipeline for new mail

#### Why
Two loops handle the same new Inbox message today, each with its own cursor, guard, catch-up and write code:
- The rules scheduler (`src/lib/server/rules-scheduler.ts`, keyed by mail address, cursor in `rules_cursor`, an in-memory `lastHandled`), which also hosts out-of-office and the one-time account tasks.
- The Jev worker (`src/lib/server/jev/worker.ts`, 914 lines, keyed by account id, cursor in `jev_settings.sort_cursor`), which calls the rules scheduler from inside its own pass (`applyRulesNow`) when the account has a rule.

Consequences found in the code:
- Rules act within seconds only on accounts that happen to have a Jev stream; otherwise they wait for the minute run. Out-of-office never rides the fast path.
- A stream pass during a Jev outage returns early and runs no rules.
- Rule writes don't re-read where the message is, so they can undo a move you made a moment earlier; a rules run from the cron is not serialised against Jev's write.
- Discovery, cursor stepping, batched writes, the no-overlap guard, the minute cron and the 20-second catch-up all exist twice.
- With rules only (no Jev, no pins) there is no Inbox hold, so mail a rule files shows in the Inbox first.

#### What a pass does
One pass per account, keyed by **account id** throughout. In order:

1. **Needs.** `pipelineNeeds(accountId)` (new, the one place that reads the switches) returns what is on: runnable rules, a runnable rule that moves mail out of the Inbox, out-of-office active, Jev sorting (enabled and configured), tabs shown, pins, spam mode, urgent alerts, and from those `hold` and `wantsArrivals`. One-time account tasks run first, as today, and never block.
2. **Nothing on** (`wantsArrivals` false): the cursor is set to now and the pass ends without asking the mail server anything.
3. **Discover.** Inbox mail received after the cursor minus a 60-second look-back, oldest first, 100 at a time (plus Junk while the spam add-on is on). Each message not seen before is recorded in `mail_arrivals`; that table, not memory, is what stops a message being handled twice. The cursor then steps exactly as today (a full page steps to its last second; a full page all in one second moves past it; otherwise to now).
4. **Out-of-office**, for new Inbox arrivals, on the message as it arrived (`answerNewMail`, unchanged rules).
5. **Rules**, on new Inbox arrivals, in order (the stage 5 engine).
6. **First write.** Rule changes are written now, so rules never wait for Jev. If Jev will not be asked anything in this pass, this write is held back and merged with the next one.
7. **Jev queue.** Inbox arrivals a rule did not move out (and Junk arrivals while spam is on), received on or after "Jev on since", are queued for Jev. Marking the arrival handled and queueing it happen in one database transaction.
8. **Jev step** (only if Jev sorting, pins, spam or urgent is on): up to 25 queued messages; one call per message asking tab, spam and urgent together, as today; spam plan; tab from `decideTab` (your own choice, then a pin, then Jev's confident pick, else Important).
9. **Second write**: tab, spam move, and the "sorted" marker for held Inbox mail, together.
10. **Record** decisions, then send urgent alerts.
11. **Backfill** ("sort existing mail"), only on scheduled passes, as today.

Every write goes through one function that **re-reads where each message is first**: a message that has left the mailbox it was found in is not touched (your move wins); a message whose tab changed keeps the rule changes but not the tab; the update is computed against the current placement. This is Jev's existing re-check, now also covering rule writes.

#### Behaviour changes
1. **Rules, out-of-office and pins act within seconds** on any account where one of them is on, because the account gets an event stream whenever `wantsArrivals` is true (today only with Jev or pins).
2. **The Inbox hold also applies when an enabled rule moves mail out of the Inbox**, whatever the Jev and tab settings, so mail a rule files never shows in the Inbox first. Every new Inbox message on such an account is hidden until the pass has looked at it: normally a second or two, and never longer than the existing two-minute limit. Rules that only label, star or mark as read do not switch the hold on.
3. **A stream pass during a Jev outage still runs rules, out-of-office and pins**; only the Jev call is skipped.
4. **Rule writes respect a move you just made.**
5. **A pass that fails part-way is picked up again**: arrivals not yet handled are retried on the next pass, up to 5 attempts, then given up with a log line.
6. Accounts are run side by side on the minute run, so a slow Jev call for one account no longer delays rules for another.

Unchanged on purpose: rule changes and the tab are still two writes when Jev is asked (rules first); Jev is never sent mail from before it was switched on; pins act with Jev off, during an outage and during a rate-limit pause; the marker rules; backfill; spam modes; urgent alerts; out-of-office rules.

#### Data
Migration `032_mail_pipeline.sql`:
- `mail_pipeline(account_id PRIMARY KEY → mail_accounts ON DELETE CASCADE, cursor TEXT, updated_at)`.
  - Seeded for each account from the earlier of its `rules_cursor.last_run` (matched by address: exact, then case-insensitive only where no exact row exists) and `jev_settings.sort_cursor`; no row when it has neither (the first pass then starts at now). Do this in SQL or as a one-time data step, whichever compares the two timestamp formats correctly; test it.
- `mail_arrivals(account_id → mail_accounts ON DELETE CASCADE, email_id, mailbox TEXT ('inbox' | 'junk'), received_at, seen_at, handled_at NULL, attempts INTEGER DEFAULT 0, rules_json NULL, PRIMARY KEY (account_id, email_id))`. `rules_json` holds the ids of the rules that matched. Rows older than 7 days are pruned on the daily job that prunes the auto-reply log.
- `jev_settings.sort_cursor` is renamed `jev_since`. It keeps the meaning it already has at the edges (set to now when Jev is switched on, null when off) and is **no longer advanced**. The pass sets it to null whenever Jev sorting is not on (disabled, or enabled but not configured) and to now when it finds Jev on with no value, judging nothing in that pass.
- `rules_cursor` is no longer read or written (dropped in the last stage). `jev_decisions` stays Jev's queue and record, unchanged. The plan's `jev_user_tabs` table is **not** part of this stage (moved to the clean-up stage); "you chose this tab yourself" keeps coming from `correctedEmailIds`.

#### Code

**New `src/lib/server/mail-pipeline/`**
- `needs.ts`: `pipelineNeeds(accountId)`.
- `arrivals.ts`: the cursor, discovery, `mail_arrivals` queries (record new, list unhandled, mark handled + queue for Jev in one transaction, count an attempt, prune).
- `write.ts`: the change set (rule outcome, tab keywords, spam move, marker per message), `flush()` with the re-read, batched `Email/set`, and the refusal accounting from today's `writeUpdates` / `noteWrites`.
- `pass.ts`: `runPass(accountId, auth, { fromStream })`, the eleven steps above and nothing else.
- `index.ts`: `startMailPipeline()` (one `* * * * *` cron over `listSchedulableAuths()`, accounts side by side; the daily prune), `requestPass(accountId, auth, opts)` with the no-overlap guard and merged re-run taken from `sortNewMailSafe`, error handling as today (`JMAPAuthError` → `markNeedsReauth`; anything else logged once and noted), and `refreshPipeline()`.
- `stream.ts`: moved from `jev/stream.ts`. Targets: accounts where `wantsArrivals` is true. Refreshed every minute and by `refreshPipeline()`, which is called from the Jev settings and pin routes (as now) **and** from every rule write (`/api/rules/**`, and folder / label deletion when it changes rules) and the out-of-office save.
- `hold.ts`: moved from `jev/hold.ts`. `inboxHoldOn(accountId)` = `pipelineNeeds(accountId).hold` = (tabs shown and (Jev sorting or pins)) or an enabled runnable rule that moves mail out of the Inbox. `src/lib/inbox-hold.ts` is unchanged.

**`src/lib/server/jev/`**: `worker.ts` is split and deleted.
- `judge.ts`: `fetchEmailsForJev`, `judgeEmails`, `PREVIEW_LIMIT`, the property list.
- `tab.ts`: gains pure `decideTab({ tabsOn, userChose, currentTab, pin, jevPick })`, replacing `tabToApply`, `planFor`'s open check, `tabOpen` and the `wantsTabs && !chosen` argument. `setTab` stays.
- `spam.ts`: gains the spam plan (junk, rescue, or record only) from `judgeAndApply`.
- `urgent.ts`: moved from `telegram/urgent.ts`.
- `health.ts`: rate-limit pause, outage flag, log de-duplication (`forgetRateLimits`, `noteFailure`, `noteRecovered`).
- `step.ts`: the Jev step (steps 8 and 10): given the queued ids and the needs, returns changes for `write.ts` and what to record. `backfill.ts`, `record.ts`.

**Deleted**: `src/lib/server/rules-scheduler.ts` (and `applyRulesNow`, `applyRulesForUser`, `lastHandled`), `jev/worker.ts`, `jev/stream.ts`, `jev/hold.ts`, `telegram/urgent.ts`, the rules-cursor query functions, and one of the two 20-second catch-ups in `src/hooks.server.ts` (the remaining one calls `requestPass` for the request's active account, throttled by account id). `startRulesScheduler` and `startJevScheduler` become `startMailPipeline`.

`runAccountTasks`, `answerNewMail` / `outOfOfficeFor` take an account id instead of an address. Stale comments that say "on the account's next rules run" are updated.

Not in this stage: merging the push worker's own event stream with this one; `jev_user_tabs`.

#### Tests
Port by behaviour, not by file. The report must include a table mapping **every** existing test in `jev/worker.test.ts` (64), `rules-scheduler.test.ts` (12), `jev/stream.test.ts` (6) and `jev/hold.test.ts` (7) to the new test that covers it, or to a reason it no longer applies (allowed reasons: it tested `applyRulesNow` waiting and re-running, `lastHandled`, or the pins-only cursor clamp; for the clamp, the replacing tests are "switching pins / tabs / Jev on never acts on mail from before"). Groups that must survive: cursor stepping; failure accounting; no overwrite of your move or tab; write refusals; TypeSafe refusals and rate limits; your own tab choices; pins, history, backfill; urgent alerts; switching Jev off mid-pass; spam modes; every marker case; rules before the marker with the two writes in order; rules while TypeSafe is down; a rule needing a rewrite never runs; stream passes are new mail only and make no TypeSafe call while it is failing; pins with Jev off, unconfigured, in an outage, per-message failure and rate-limit pause; out-of-office (first sight, only unseen mail, a failure doesn't stop rules); account tasks never block; stream open / debounce / 401 / relink / stall; `inboxHoldOn` and the unread maths.

New tests:
- One cursor: rules-only, Jev-only, both, neither (no mail-server call at all), pins with Jev off.
- Migration 032: seeded from the earlier cursor; from only one; from none; case-different address; `jev_since` renamed with its value kept; cascade on account removal.
- `mail_arrivals`: a message is handled once across passes and the look-back; a pass that throws after discovery leaves its arrivals unhandled and the next pass handles them; given up after 5 attempts; handled + queued atomically; pruning.
- Hold: on for a rules-only account with a move rule (tabs off and on), off with only label / star / read rules, off when the rule is disabled or flagged; held Inbox mail on such an account is marked in the pass, in the same write as its rule changes when Jev is not asked.
- Stream: opens for a rules-only account and for out-of-office only; a rule save and an out-of-office save refresh it.
- Out-of-office answered on a stream pass with no rules; `answerNewMail` tested directly, not only through mocks.
- A stream pass during an outage runs rules and pins and makes no TypeSafe call.
- Rule write re-read: a message you moved between discovery and write is left alone; one whose tab you changed keeps its rule label.
- Two accounts on one tick: a slow Jev call for one does not delay the other's rule write.
- `decideTab`: every row of its truth table.
- Hooks: one start function, one catch-up, throttled by account id.

#### Verification on the owner's server
1. An exact rule files a new message within a few seconds, with Jev off and no pins, and the message never shows in the Inbox.
2. With that rule on, an ordinary new message appears in the Inbox within a second or two.
3. New mail still reaches its tab within seconds with Jev on; a pinned sender lands in its tab with Jev off.
4. Out-of-office answers within seconds.
5. Restart the app: no message is filed, answered or alerted twice.

#### Risks
- **The largest change in the plan.** Mitigated by building it as three commits, each passing on its own: (1) `jev/worker.ts` split into the files above with no behaviour change; (2) the pipeline, arrivals and cursor, with the scheduler and the worker loop removed; (3) the hold for move rules, stream targets, refresh on rule and out-of-office saves, docs.
- **Hold for rules-only accounts** delays every new Inbox message until the pass has run. If the stream is down that is up to a minute (20 seconds while the app is open), capped at two minutes.
- **First pass after upgrade** starts from the earlier of the two old cursors, so up to a minute of mail may be looked at again: rules re-evaluate it (writes only differences), Jev's queue ignores what it already has, out-of-office's once-a-day check prevents a second reply.

#### Done means
Every test point above has a test seen to fail without its behaviour; the mapping table is complete; `npm run lint` clean, `npm run check` 0 errors, full `npx vitest run` passing on each commit; README (Jev and rules sections), `docs/jev-plan.md` and `docs/organising-mail-plan.md` updated.

#### As built
Built as three commits: the split of `jev/worker.ts` with no change in behaviour; the pipeline; then the hold for rules that move mail, the event streams and these docs.

- **The cursor** is stored as the Jev worker kept its own: after a partial page it is set a minute back from the pass (never back past where it was), and the next pass reads mail received after it. That is the 60-second look-back. Reading a further minute back from a stored "now" would have re-read a full page of mail stamped in one second for ever.
- **When the rules wait for the next write** (Jev isn't asked anything in the pass: no Jev, Jev rate-limited, or a stream pass while TypeSafe is failing), the arrivals are marked handled, and queued for Jev in the same transaction, after that one write rather than before Jev's step. So a pass that fails before writing leaves the arrivals unhandled, and the next pass runs their rules again. When Jev is asked, the order is as designed: the rules' write, then handled and queued together, then Jev.
- **`jev_since`**: when a pass clears it (Jev switched on but not configured on the server) or sets it (Jev found configured again, or after the upgrade for an account that had no place), new arrivals still queued for Jev are withdrawn. The pass that sets it runs Jev's step as with Jev off: pins act and held mail is marked, Jev is asked nothing, and nothing from that pass is queued for it later.
- **Queued for Jev**: with Jev off, the Inbox's new mail is queued for pins as before (and recorded as never sorted when no pin takes it), but only mail received within the hold's two minutes, so after a stretch with no passes pins never reach back over older mail. Junk is read, and its arrivals recorded, only while the spam add-on is on. The transaction that marks arrivals handled reads the Jev settings again, and queues only what the settings allow then (Jev switched off and on during a pass queues nothing from before).
- **Arrivals no longer in the Inbox** when the pass reads them (moved within seconds of arriving) are handled with nothing done: no reply, no rules, nothing queued.
- **The hold** applies on the Inbox page with the tabs off too, when a rule moves mail. Mail the pass doesn't queue for Jev is marked in the rules' write; mail queued for Jev is marked once Jev has answered, as before.
- **`refreshPipeline()`** is called by: creating, editing, deleting and reordering rules; dismissing a note that deletes a rule; pinning a rule's sender; deleting a folder or label when that changed rules; saving out-of-office; and, as before, Jev's settings and pins.
- **Rule writes** share Jev's refusal accounting and log line (`write_refused`, now logged under `mail`). A refused rule write is not retried, as before; the message is where it was, so it is treated as staying in the Inbox: queued for Jev (or the pins) and marked in that pass.
- **The minute's run** starts every account's pass at once and waits for all of them.
- **The rules-cursor data step** from stage 1 (`data/rules_exact_only`) still rewinds `rules_cursor`, which nothing reads now. A database upgrading from before stage 1 straight to this version loses that rewind; its pipeline starts from the earlier of the two old places as usual.
- **Tests**: the old worker, scheduler, stream and hold tests are ported by behaviour into `src/lib/server/mail-pipeline/` (`pass.test.ts`, `stream.test.ts`, `hold.test.ts`), with `needs.test.ts` and `migration.test.ts` new. The tests of `applyRulesNow` and the pins-only cursor clamp are gone with them, replaced by "switching pins, tabs or Jev on never acts on mail from before".

After review:
- **Arrivals are handled on their own.** Reading new mail, out-of-office, the rules, their write, and marking the arrivals handled and queued complete whatever happens in Jev's step. A failure in the step (reading mail for Jev or the pins, planning, its write, recording, backfill) is logged once while it lasts (`jev_step_failed`, under `mail`) and leaves the queue to the next pass; the emails it was planning are charged a Jev attempt on scheduled passes, so a batch that can never be read gives way under Jev's own limit. When Jev isn't asked, the rules, the pins' tabs and the marker still go out in one write; if the step can't be planned, the rules' changes go out alone. A refused password still stops the pass from anywhere.
- **One bad message.** When the read of new mail for out-of-office and the rules fails, the messages are read one at a time; only one that can't be read is left for the next pass (`arrival_read_failed`, once while it lasts). Attempts are counted at most once a minute per arrival (`mail_arrivals.last_attempt_at`), and after five an arrival is handled without out-of-office or the rules, and still queued for Jev or the pins.
- **The hold starts when it is switched on.** `mail_pipeline.hold_since` is set when the hold is found on (by `refreshPipeline()` after any change that can switch it, or at the start of a pass) and emptied when it is off. Only mail received since then is held, by every reader (the Inbox list and tab counts, the layout's unread count, the account badges, push), and only that mail is marked. Saving a first move rule, or switching tabs on with a pin, no longer hides mail already showing.
- **A message id seen again with another `receivedAt`** is treated as a new message.
- **The pipeline's start flag and its per-account guard** live on `globalThis`, like the event streams, so a reload can't start a second minute's run or a second pass beside one already running.

### Stage 8 design: two settings pages

Builds on stage 7 (after its review fixes). UI and routes only; no change to how mail is filed or sorted.

#### Why
One job is spread over four pages (Folders, Labels, "Filters & Rules", Jev), which were written separately:
- Folders and Labels are near-copies of each other (same reorder, delete and edit code), report errors with `alert()`, and neither has a test.
- The rules page has its own fixed two-column layout that doesn't work on a phone; a rule can't be started from the folder or label it files into; its apply-progress dialog lives in the page, so nothing else can use "Save & apply".
- The Jev page mixes tabs, sorting, pins, backfill, a preview and the spam add-on in an order that doesn't match how they depend on each other.
- Labels are created, renamed and deleted through `/api/preferences/labels` while folders use `/api/folders`.

#### Routes and navigation
- New: `/settings/folders-labels` ("Folders & labels") and `/settings/inbox-tabs` ("Inbox tabs"). In `src/lib/config/settings-nav.ts` they replace the four entries `folders`, `labels`, `rules`, `jev`, in that order, in the Organization group.
- Old routes become redirect-only pages (a lone `+page.server.ts`, as `settings/advanced` and `settings/mail` are today), status 308: `/settings/folders`, `/settings/labels` and `/settings/rules` → `/settings/folders-labels`; `/settings/jev` → `/settings/inbox-tabs`.
- Every link and text that names the old pages is updated: the three "Settings → Jev → Pinned senders" links (now "Settings → Inbox tabs → Pinned senders", `/settings/inbox-tabs#pinned-senders`), `src/lib/telegram/urgent-state.ts` (`/settings/inbox-tabs`, label "Inbox tabs"), "No labels yet. Create one in Settings." in `EmailDetail.svelte` (now a link to `/settings/folders-labels`), the API error texts that say "from the Labels settings", README and docs.

#### Page 1: Folders & labels (`settings/folders-labels/`)

Load (`+page.server.ts`): the active account's rules (`listRules`) plus the layout's `mailboxes`, `labels`, `mailboxMeta`.

Top to bottom:

1. **Header.** "Folders & labels", one sentence: a folder is where a message lives, a label is a tag, and rules file new mail into either. Buttons "New folder", "New label".
2. **Needs your attention** (only when there are flagged rules): the rules switched off by a flag (`jev_condition`, `tab_rule`, `tab_pinned`), as rows. Opening one shows today's explanation panel and editor (same texts, same "Save as exact rule" confirmation, same one-click pin, same "Got it").
3. **Folders.** The folder tree, indented as today. Each row: icon, name, unread count, "N rules" when it has any, "View", Move up, Move down, Edit, Delete.
   - A row with rules can be opened. Opened, it lists the rules that file into that folder (name, conditions in words, on/off switch; a row opens the editor) and an **Add rule** button, which opens the editor on a new rule with "File it in" already set to that folder. The target can still be changed.
4. **Labels.** The same rows and behaviour for labels.
5. **System folders.** As today (name and role, not editable). Archive, Junk and Trash rows can be opened in the same way, since rules can file into them.
6. **All rules, in order** (collapsed by default; opened automatically when the address has `#rules`): every rule that can run, in its real order, each with its on/off switch, what it does ("conditions → target"), any note with its "Got it", and Move up / Move down. Rules that file nowhere (mark as read, star or stop only) are reachable only here. "New rule" here opens the editor with no target set. One sentence explains the order: labels add up, the first rule that moves a message decides its folder.

Behaviour kept exactly: nothing is sent until Save; server problems shown beside the fields; reorder sends the full order with two rules exchanged and skips flagged rules; a plain Save keeps a flagged rule flagged; Save & apply applies the saved rule by id with progress and Cancel; the live match count and its wording; delete confirmations including the rules sentence (now computed from the rules the page already has, no extra request); going to the Inbox when the folder being viewed is deleted.

Changes:
- **The rule editor opens in a dialog** (full width on a phone), not a side column. The page is a single column inside the normal settings width.
- **Errors appear in the page** (an alert line at the top of the section, `role="alert"`), never `window.alert`. `window.confirm` stays for deletes until the settings pass.
- **One move-up / move-down control** (the icon buttons Folders and Labels use) for folders, labels and rules.
- Wording: "color" everywhere in UI text (the modal's error text said "colour"); the page title and nav label agree.

### Code
- `src/lib/components/settings/MailboxRow.svelte`: one row for a folder, label or system folder, with its expandable rules. Replaces the two copies of row markup, `step()`, `rulesNote()` and the delete flow.
- `src/lib/components/settings/RuleDialog.svelte`: the dialog holding the attention panel (moved from the rules page) and `RuleEditor`.
- `src/lib/components/settings/RuleApplyDialog.svelte` and `src/lib/rules/apply.ts` (`streamApply`): moved out of the rules page unchanged.
- `RuleEditor.svelte`: new optional prop `initialTarget`, used only when `rule` is null. It also shows the `problems` the preview returns (today it ignores them).
- `CreateMailboxModal.svelte`: unchanged in behaviour, but labels are created, renamed and deleted through `/api/folders` (see below).
- **One endpoint for folders and labels.** `/api/folders` `create` accepts `kind: 'label'` (creating the `Labels` container when needed, with the code `/api/preferences/labels` uses today), and `rename` / `delete` accept labels with the same checks and the same `{ rulesDeleted, rulesKept }` answer. `/api/preferences/labels` is deleted.
- Deleted: `settings/folders/+page.svelte`, `settings/labels/+page.svelte`, `settings/rules/+page.svelte` (their `+page.server.ts` become the redirects).

#### Page 2: Inbox tabs (`settings/inbox-tabs/`)

Load: the Jev page's load, unchanged. Sections, in this order, with the existing controls, texts and endpoints (`/api/jev/*`):

1. **Inbox tabs**: what the four tabs are; "Show tabs" per account.
2. **Let Jev sort new mail**: the connection status line, "What Jev is sent", the per-account switch with this month's usage.
3. **Pinned senders** (`id="pinned-senders"`): per account, with the existing warning when tabs are off for that account.
4. **Sort the mail already in your Inbox** and **Try Jev** (active account, only when configured), as today.
5. **Add-ons**: "Spam checks" with its explanation, the per-account Off / Watch only / Active choice, and the spam report. One line pointing to Notifications for urgent alerts.

Changes: the header is "Inbox tabs" with one sentence; the tab grid and the preview's count grid get phone breakpoints (one or two columns under `md`). Settings still save on change here; they move to the shared Save bar in the settings pass, with the rest of Settings.

Deleted: `settings/jev/+page.svelte` (its `+page.server.ts` logic moves to `inbox-tabs`, and `jev` becomes a redirect). `PREVIEW_LIMIT` and friends are imported from wherever stage 7 put them.

#### Tests
- **Folders & labels page** (`settings/folders-labels/page.test.ts`), following the harness in today's `settings/rules/page.test.ts`:
  - All 25 existing rules-page tests, ported: the report must map each to its new test. (List summary and target missing; nothing sent until Save; create; problems beside fields; reorder up and down, past a split rule, past a flagged rule; notes and "Got it"; disabled while busy; Save & apply by id; no apply when the save is refused; on/off; delete; count wording; the eleven "Needs your attention" tests.)
  - New: folders render as a tree and labels as a list; the rule count on a row; opening a row lists exactly the rules that file into it; "Add rule" on a folder, a label and Trash opens the editor with that target and saves a rule with it; a rule that files nowhere appears only under "All rules"; `#rules` opens that section; create, edit (rename, move, color, icon, "No color") and delete a folder and a label, with the delete confirmation naming the rule counts and omitting a zero count; move up / down for a folder and a label; an error from the server appears in the page and `window.alert` is never called; deleting the folder being viewed goes to the Inbox.
- **Inbox tabs page** (`settings/inbox-tabs/page.test.ts`, none exists today): each switch and select sends the right body for the right account; the status line for off / mock / live; the Jev switch disabled when not configured; add, change and remove a pin, and the warning when tabs are off; spam select disabled unless Jev is on; backfill and preview shown only when configured.
- **Routes**: each old path redirects with 308 to its new page; the nav has the two new entries and none of the four old ones; `urgent-state` points at `/settings/inbox-tabs`.
- **`/api/folders` for labels**: create (including when no `Labels` container exists), rename, delete with `{ rulesDeleted, rulesKept }`, another account's label refused; the existing folder tests unchanged. No caller of `/api/preferences/labels` remains (a grep in the report).
- `RuleEditor`: `initialTarget` is used for a new rule and ignored for an existing one; preview problems are shown.
- Every new test seen to fail with its behaviour removed.

A browser check with Playwright against a temporary harness route (deleted before committing) for the two pages at desktop and phone width: screenshots saved to the scratchpad folder named in the task, and anything that looks wrong listed in the report.

#### Verification on the owner's server
1. The old addresses (`/settings/rules`, `/settings/jev`, `/settings/folders`, `/settings/labels`) land on the new pages.
2. On a label row, "Add rule" → Save & apply files matching Inbox mail under that label.
3. Create, rename, recolor and delete a label and a folder.
4. Inbox tabs: switch tabs off and on; add and remove a pin.
5. Both pages on a phone.

#### Risks
- **Label create / rename / delete move to another endpoint.** Covered by the endpoint tests; a tab left open across the deploy must be reloaded to manage labels.
- **A large page.** Built as three commits, each passing on its own: (1) shared pieces extracted with the old pages still in place (`MailboxRow`, `RuleDialog`, `RuleApplyDialog`, `apply.ts`, `initialTarget`, `/api/folders` for labels); (2) the Folders & labels page, the three redirects, nav and links; (3) the Inbox tabs page, its redirect, README and docs.

#### Done means
The test mapping is complete; `npm run lint` clean, `npm run check` 0 errors, full `npx vitest run` passing on each commit; README (the Settings mentions and the Jev section) and `docs/organising-mail-plan.md` updated; no file imports a deleted page or endpoint.

#### As built
Built as three commits: the shared pieces with the old pages still on them; the Folders & labels page with the three redirects; the Inbox tabs page with its redirect and these docs.

- **Shared pieces.** Besides the files named above, the notes on a rule an upgrade changed are their own component, `RuleAttention.svelte` (the old rules page used it until it went, and `RuleDialog` uses it now), and what a rule says in words (its conditions, target, notes, pin wording) is in `src/lib/rules/describe.ts`. `Toggle` takes an optional `ariaLabel`, so a rule's switch is named after the rule.
- **Every folder and label row opens**, not only one with rules, and so do Archive, Junk and Trash: "Add rule" is the way to start a rule from a folder that has none yet. A row says "N rules" when it has any. The Inbox, Sent and Drafts don't open. Each row is a group named after its mailbox. A rule switched off by an upgrade is listed under its folder too, with the warning mark in place of its switch.
- **On a phone** a row hides its unread count and its "View" link, so the name and the rule count fit; the rule dialog fills the screen.
- **The rule dialog** closes after Save, Delete or "Save & apply" (whose progress then shows), and when its rule goes away (a pin made from it, a "Got it" on a rule that became a pin). A change made from inside it (a pin, a "Got it") that the server refuses is shown at the top of the dialog. After a plain Save a short "Saved" shows, as before.
- **Preview problems.** When the conditions don't hold up yet, the count reads "Not counted yet:" and the server's reason. A missing name or target is said only on Save, beside its field, so a new rule doesn't open full of complaints.
- **Rules' switches** are the settings `Toggle`, in the rows and in "All rules, in order"; "Got it" on a running rule's note stays on its row there.
- **`/api/folders` and labels**: a label is created with `kind: 'label'` (empty names refused); `rename` and `delete` find a label like a folder (another account's id is 404) and use the label calls (`renameLabelMailbox`, which clears a stored display name, and `deleteLabelMailbox`, whose mail only in the label goes to Archive). The Labels container can be neither renamed nor deleted (400), even when empty. The create and edit dialog renames a label through `rename`, and its error text says "color".
- **Inbox tabs**: the first section is headed "The four tabs", so it doesn't repeat the page title. Its switches are named for their account ("Show tabs for …", "Let Jev read new mail for …"). The "Sort the mail already in your Inbox" card puts its button under the text when they don't fit side by side, as "Try Jev" does.
- **Tests**: the rules page's 25 tests moved to `settings/folders-labels/page.test.ts`, each marked with what it was, adapted to the dialog and the collapsed list; new tests there for the rows, the dialog started from a folder, label and Trash, and creating, editing, moving and deleting folders and labels. `settings/inbox-tabs/page.test.ts`, `settings/redirects.test.ts`, `config/settings-nav.test.ts`, `RuleEditor.test.ts` and `rules/apply.test.ts` are new; `api/folders/server.test.ts` covers labels.
