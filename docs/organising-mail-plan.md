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
7. **Staged.** Nothing is implemented until the owner picks a stage to start.

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

**New: `src/lib/server/auto-reply.ts`**: deploys the out-of-office on its own.

**Deleted**: `rules-scheduler.ts`, `rules-store.ts`, `rules.ts` (the JMAP-filter matcher), `jev/rules.ts`, the rule half of `sieve.ts`, `/api/rules/jev-test`, `/api/rules/deploy`, `/api/jev/rule-feedback`, `/api/preferences/rules`, `/api/preferences/labels`. The two pickers, `FolderPicker` and `FolderLocationPicker`, become one `MailboxPicker`.

**Sieve**: rules leave Sieve; only the out-of-office stays. Sieve can't share the engine's matching (it differs on body, attachments and size), can't sort existing mail, and saving rules currently deactivates any script made in another mail client. Stage 0 confirms what the server actually does first.

## Data model

Next migration number is 028. Old tables stay until the last stage, so an interrupted upgrade loses nothing.

- **028 `rules`**: one row per rule, keyed by account id: position, enabled, name, conditions, one target (folder or label by id; Trash, Archive, Junk by role), `mark_read`, `star`, `stop`, an `attention` note, and the original rule kept as `legacy_json`.
  - Surviving actions: move, label, mark read, star (renamed from "mark important", which clashed with the Important tab), stop. "Delete" becomes a move to Trash.
  - A rule with several targets becomes adjacent rows, one per target.
  - **Rules with a Jev condition** are disabled and listed under "Needs your attention", never silently dropped.
  - **Rules that only set a tab** become sender pins when they are a simple sender match; otherwise they are listed for attention.
  - Deleting a folder or label deletes its rules (the confirmation says how many).
- **029 `mailbox_meta`**: colour, icon and display name for folders and labels in one table, keyed by account id (merges `label_meta` and `folder_meta`).
- **030**: `mail_pipeline` (the one cursor), `mail_arrivals` (what was seen and which rules fired; pruned after a week), `jev_user_tabs` (your own tab choices, replacing the fake "done" decision rows).
- **031**: drop `user_rules`, `rules_cursor`, `label_meta`, `folder_meta`, `jev_rule_feedback` and the unused Jev columns.

## Settings

- **Folders & labels** (`/settings/folders-labels`): the folder tree and label list, each with colour, icon, rename, reorder, delete. Each row opens to its rules with "Add rule" (target already set). The rule editor shows how many recent Inbox messages match, using the real engine. A "Needs your attention" list at the top. A collapsed "All rules, in order" list for reordering.
- **Inbox tabs** (`/settings/inbox-tabs`): show tabs; let Jev sort new mail; sender pins; sort existing mail; usage. An "Add-ons" section for the spam check. Urgent alerts stay under Notifications.
- The old Folders, Labels, Rules and Jev pages redirect to these.

## Stages

Each is its own PR, migrates data automatically, and leaves the app correct.

| # | Goal | Main risk |
|---|---|---|
| 0 | Find out on the real server whether Stalwart runs the Sieve script at delivery (turn on out-of-office, send a test) | None; decides how stage 3 handles out-of-office |
| 1 | Rules become exact-match only; Jev rule conditions and their endpoints removed | Accounts with Jev rules switch runner |
| 2 | Tabs belong to Jev: "set tab" removed from rules, tab rules become pins | Pins now act with Jev off |
| 3 | One engine: preview and apply share it; rules leave Sieve | If Sieve was running, filing moves from delivery to seconds later |
| 4 | Rules table (028) and validated saves | Splitting multi-target rules |
| 5 | Folders and labels consistent: `filing.ts`, one metadata API (029), one picker | Moves now leave every folder, not just the Inbox |
| 6 | One new-mail pipeline (030); `jev/worker.ts` split | The largest change |
| 7 | The two settings pages | UI only |
| 8 | Clean-up (031): a small "why is this here" on the tab chip, a `tab:` search operator, dead code | Low |

Stages 1 and 2 remove the most complexity for the least risk, and can ship before anything structural moves. The README's Jev section and `docs/jev-plan.md` are updated in each stage.

## Verification

- Every stage: `npm run lint`, `npm run check`, `npx vitest run`.
- **Stage 1–2**: unit tests for the rule conversion (Jev rules flagged, tab rules to pins); keep the existing tests that rules run before the Inbox hold and while Jev is unreachable; drop the mixed-rule tests in `worker.test.ts:607-730`.
- **Stage 3**: a test that preview and apply return the same messages for the same rule.
- **Stage 4–5**: migration fixtures in the style of `src/lib/server/db/migrate.test.ts` (multi-target, Trash, missing target, interrupted run); extend `moves.test.ts` and `labels.test.ts`.
- **Stage 6**: port `worker.test.ts` by behaviour; add tests for the rules-only hold, cursor seeding and a restart mid-pass.
- **On the owner's Stalwart** (none is available in CI):
  1. Does the Sieve script run at delivery? (Stage 0.)
  2. An exact rule files mail while Jev is unreachable.
  3. With Jev off, a pinned sender lands in its tab without flashing in Important.
  4. New mail reaches its tab within seconds; a dropped event stream falls back to the minute run.
  5. Removing a message's only label sends it to Archive.

## Open questions for the owner

1. **Out-of-office**: if stage 0 shows Stalwart does not run Sieve, out-of-office is not working today and should move to the server's own vacation setting.
2. **Rules to Junk**: should a rule be allowed to move mail to Junk?
3. **Mail delivered straight to another folder** (not the Inbox) is never seen by rules. Keep it that way?

## Status

Plan only. No stage has started; the owner picks which to begin with. Stage 0 needs nothing built: turn on out-of-office, send the account a message from another address, and see whether a reply comes back.
