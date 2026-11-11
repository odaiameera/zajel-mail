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

Stage 3 took 028 (`account_tasks`, one-time jobs per account such as retiring the Sieve script) and stage 4 takes 029, so the numbers below start at 030. Old tables stay until the last stage, so an interrupted upgrade loses nothing.

- **030 `rules`**: one row per rule, keyed by account id: position, enabled, name, conditions, one target (folder or label by id; Trash, Archive, Junk by role), `mark_read`, `star`, `stop`, an `attention` note, and the original rule kept as `legacy_json`.
  - Surviving actions: move, label, mark read, star (renamed from "mark important", which clashed with the Important tab), stop. "Delete" becomes a move to Trash.
  - A rule with several targets becomes adjacent rows, one per target.
  - **Rules with a Jev condition** are disabled and listed under "Needs your attention", never silently dropped.
  - **Rules that only set a tab** become sender pins when they are a simple sender match, and stay listed as a note saying which pin they became until the owner dismisses it; otherwise they are listed for attention, with the reason and, where they name a sender, a one-click pin. No conversion is silent.
  - Deleting a folder or label deletes its rules (the confirmation says how many).
- **`auto_reply_sent`** (with stage 4, numbered in order of shipping): account, sender address, day. One row per reply, so a sender gets at most one a day; pruned after a week.
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
| 4 | Out-of-office sent by the app (hooked into the existing new-mail run; moves into the pipeline in stage 7) | Replying to the wrong mail; guarded by the rules above and tests |
| 5 | Rules table (030) and validated saves | Splitting multi-target rules |
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

1. **Out-of-office per account?** The setting is stored per login today, so it would apply to every linked mail account. Should each account have its own?
2. **Rules to Junk**: should a rule be allowed to move mail to Junk?
3. **Mail delivered straight to another folder** (not the Inbox) is never seen by rules. Keep it that way?

## Status

Stages 0 to 3 are done. Later stages follow one PR at a time.

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
  - Mark done on success, and also when the server has no Sieve capability. Any other failure is retried on the next run and never blocks rules.
- **Auto-reply settings page**: removed from the settings navigation and redirected to `/settings` in this commit (it has never worked); stage 4 brings it back.

#### Stage 3 tests
- Preview and apply report the same matches for the same rule on the same Inbox (the test the plan asked for), including for "is", "starts with", NOT, and a body condition.
- Preview never writes; preview of a rule flagged for attention reports 0 without scanning.
- Apply ignores rules in the request body; unknown rule ids are refused; Cancel stops at the next page.
- `retire_sieve_script`: deactivates and destroys `mailrules`; leaves another active script alone; no Sieve capability marks it done; a failure retries; runs once.
- The form-action and route tests still pass with `/api/rules/deploy` gone.
