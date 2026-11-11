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

**Deleted**: `rules-scheduler.ts`, `rules-store.ts`, `rules.ts` (the JMAP-filter matcher), `jev/rules.ts`, `sieve.ts`, `/api/rules/jev-test`, `/api/rules/deploy`, `/api/jev/rule-feedback`, `/api/preferences/rules`, `/api/preferences/labels`. The two pickers, `FolderPicker` and `FolderLocationPicker`, become one `MailboxPicker`.

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
- **032**: `mail_pipeline` (the one cursor), `mail_arrivals` (what was seen and which rules fired; pruned after a week), `jev_user_tabs` (your own tab choices, replacing the fake "done" decision rows).
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
| 6 | Folders and labels consistent: `filing.ts`, one metadata API (031), one picker | Moves now leave every folder, not just the Inbox |
| 7 | One new-mail pipeline (032); `jev/worker.ts` split | The largest change |
| 8 | The two settings pages | UI only |
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

Stages 0 to 5 are done. Later stages follow one PR at a time.

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
- A `PATCH` replaces the fields it sends and goes through `parseRule`. To switch on a rule waiting to be rewritten, it must send `conditions` and `target` (the editor sends the whole rule); `{ enabled: true }` alone is refused.
- The preview counts a draft whose only problems are its name or target, and returns the problems with the count; problems with its conditions count nothing.
- The folder and label confirmations get the count from `GET /api/rules` before asking; the delete responses report `rulesDeleted`.
