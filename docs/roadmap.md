# Engineering roadmap

The README's Roadmap section says where the product is going (IMAP and POP3, Tasks, Notes, a shared canvas). This document is the other half: what has to be fixed, finished or simplified in the code that already exists, in the order it should happen. It comes out of a full review of `main` at v0.6.0 on 2026-11-02, where every item was verified against the code before it was written down.

## How work flows

- `main` is production. Each area has a long-lived integration branch: `dev-mail`, `dev-calendar`, `dev-contacts`, `dev-AI`, `dev-search`, `dev-settings`, `dev-UI`.
- A change is made on a short branch off the area's `dev-*` branch (or off `main` when it crosses areas), reviewed as a pull request into `main`, and the branch is deleted when it merges.
- Phases are ordered by what a user loses if the item stays open: first mail or events that disappear and security holes, then things the app promises and does not do, then the code's own debt, then new features.
- An item is done when it has a test that would have caught it.

## Phase 1: stop the bleeding

Regressions from the v0.6.0 work, data loss that is live in production, and the security gaps a stolen session could use. All in one pull request so production gets them together.

| Done | Area | Item |
| --- | --- | --- |
| [x] | mail | Dropping a message on a sidebar label added the label but also took the message out of every folder (regression of the v0.6.0 move fix). The label is added and the folders are kept. |
| [x] | UI | The list of labels was read once when the app opened: labels created in Settings were invisible until a hard reload, and after switching accounts the first account's label ids were applied to the second. The label list now follows the page data. |
| [x] | AI (Jev) | Switching "Let Jev read new mail" off and on, or cancelling a run, left the rest of a backfill unreachable for good. Skipped and failed mail is offered again. |
| [x] | calendar | Editing a recurring series ("All events") from any occurrence re-anchored the series and dropped every exception; the event dialog rebuilt the recurrence rule lossily; cancelling one occurrence from an invitation deleted the series; an update to one occurrence in an invitation replaced the series. |
| [x] | AI | The agent could add calendar events without a confirmation card, from chat and from unattended jobs; the "Add and invite" card hid the description that goes to attendees; impossible dates rolled over silently. |
| [x] | search | A search with a folder or date filter and fewer than ten candidates returned the whole folder as semantic matches; one message the embedding endpoint rejected failed the seven others in its batch; one failing account stalled indexing for all. |
| [x] | settings | Change-password had no failure counter when no second factor is set, so a stolen session could guess the master password; linking an account skipped the step-up check and re-linked any account with the same address regardless of owner. |
| [x] | infra | The Docker image did not set `NODE_ENV`, so without `DATABASE_PATH` the database lived inside the container and vanished on rebuild. |
| [x] | UI | The composer's font and size setting never reached the editor (`:global()` in a plain CSS file is dropped by browsers); Ctrl/Cmd+Enter sent the open draft from any focused field on the page. |
| [x] | mail | New: folders and labels can be reorganised by dragging in the sidebar (reorder, nest) and with Move up/down in Settings. |

## Phase 2: data loss and security debt

Verified bugs that lose mail or events, or weaken the account, but need a user to do something unusual first. One pull request per bullet is fine.

**Mail (`dev-mail`)**
- [x] Every draft save and send destroys the previous draft in the same request that creates the new one, so a quota or size failure loses the message. Create first, destroy on success.
- [x] Snooze from Starred or Search trusts a client-named source mailbox and can leave the message in the Inbox while "returning" it to a label. Use the same leave-from-wherever-it-is logic as moves.
- [x] "Save & apply now" runs the rule on an approximate filter (negation inverted, no folder) and so acts on different mail than the rule matches.
- [x] Deleting a label that holds any message always fails (`onDestroyRemoveEmails: false` means "refuse if non-empty"); removing a label from a message that is only in that label silently does nothing.
- [x] Scheduled sends: a missing Scheduled folder drops the message silently; any JMAP method error fails permanently; no request timeout.
- [x] The rules scheduler re-reads the same page forever when 100+ messages share one second; the deploy route treats an empty result as failure and deactivates other Sieve scripts without saying so.
- [x] The quadratic regexes in email HTML rewriting run during server rendering (measured 449 ms for 48 KB); the image proxy buffers 10 MB per request with no concurrency cap. Left: stream the proxied image through instead of buffering it, which needs the SSRF-vetted fetcher in `avatars/net.ts` to expose the response.
- [x] Real attachments are hidden when they carry a Content-ID; the attachment Content-Type comes from the file-name extension only and its CSP lacks `sandbox`.
- [x] Non-ASCII mail passwords cannot be linked (`btoa` versus `Buffer`).

**Calendar (`dev-calendar`)**
- [x] `UNTIL` is written as `T235959Z`, off by a day outside UTC; `EXDATE`/`RDATE` ignore their own zone; unknown time zones become UTC and are saved that way.
- [x] The time grid positions events by elapsed milliseconds, so DST days draw an hour off and zero-length events vanish; a plain click on a resize handle saves the event.
- [x] `%2e%2e` in an event id escapes the calendar home; the calendars route has no `..` guard at all.
- [x] Reminders: only the polling tab schedules them; all-day reminders fire at UTC midnight; a rescheduled event gets no reminder; reminders more than a day out never fire.
- [x] Opening `/calendar` without a date uses the UTC day.
- [x] The RSVP card patches the stored copy and sends no iTIP reply; the UI does not say so. Left: push reminders for all-day events still use UTC midnight, since the push worker has no stored per-user zone; the reply goes as an attachment rather than an inline calendar part.

**Contacts, avatars, push (`dev-contacts`)**

Not started: the first attempt was stopped part way, and its partial work was set aside rather than merged.

- The account avatar endpoint serves SVG without the sandbox CSP its sibling has (stored XSS).
- The layout re-subscribes a device to push whenever the account preference is on, so a device the user turned off re-subscribes itself. Make push per device, using the `user_agent` and `last_sent_at` columns that are already written.
- Transient DNS and network failures are cached as "no avatar" for seven days; freemail domains get the provider's logo; the SSE stream stays bound to the account that was active when it connected.
- Renaming a contact keeps the old `name.components`, so other clients can restore the old name.

**AI, Jev, Telegram, jobs (`dev-AI`)**
- [x] Jev writes `mailboxIds` and keywords from a snapshot taken before the model call, so it can undo a move the user made meanwhile and pull mail out of Trash.
- [x] Hand-moving mail to Important leaves no row, so the next backfill re-sorts it; a failed contacts or Sent lookup in active spam mode makes a real contact's mail junk-able.
- [x] The agent's self tier is wider than the README admits: cap destructive counts per turn and treat reminders and drafts to outside addresses as needing a card, or document the current behaviour.
- [x] A restart mid-turn leaves no transcript of what the turn already did, so a retry duplicates it; an interrupted job counts as a failure.
- [x] Reminders are never expired, capped or pruned.
- [x] HTML-only mail is handed to Jev as raw markup; the privacy text undersells what is sent.
- [x] A rule with a Jev condition could move mail to Trash or Junk through "Move to folder". Left: pins act only while Jev is on (now said in Settings); Jev's mixed-batch failures still burn attempts; the dotted display-name false positive (jev#8).

**Search (`dev-search`)**
- [x] Vectors stored under a model are kept when a new tick switches model mid-batch; loaded vectors are never evicted on unlink; the first search after a restart loads synchronously. Also fixed: migration 026's late columns are repaired on databases that ran its first version.
- [x] The user-set embedding endpoint accepts internal hosts; note it in the UI.

**Settings and auth (`dev-settings`)**
- [x] Unlinking an account cascades away pending scheduled sends, agent jobs, the Telegram outbox and the search index while the UI promises they return on re-link.
- [x] The session cookie has a fixed 30-day lifetime while the server slides expiry; sessions outlive cookies as phantom devices.
- [x] Two simultaneous setup submissions can each create a master user. Fixed with an insert that only succeeds into an empty table; a one-time setup token is still worth adding.
- [x] A failed migration is logged and the next one runs; stop and refuse to serve instead.
- [x] With `ADDRESS_HEADER` unset, the per-IP login counter lets a stranger lock the owner out. The TOTP step no longer uses the per-IP lock and the log names `ADDRESS_HEADER` when a private address trips it; defaulting the header is still open.
- [x] Document backups: WAL mode means copying `ameera.db` alone can miss writes.

## Phase 3: make the app do what it says

Settings that store values nothing reads, copy that promises features that do not exist, and documentation that drifted.

- [x] Settings → Messages: implement conversation view, default sort, mark-read delay and single-key shortcuts, or remove the four controls and the README lines (111, 274-277) and the Keyboard shortcuts placeholder page. Default sort orders the Inbox, folders and Starred; conversation view and shortcuts are gone. Left: the reading view still waits a fixed second; it should read `markReadDelay` from the app layout's data (`page.data.markReadDelay`).
- [x] README: print a clean copy (prints the app page today); composer font (fixed in Phase 1); which agent abilities are Claude-only (jobs, reminders, scheduled jobs, task proposals); the `days` schedule kind; `AI_PROVIDER=claude`; `NODE_ENV`. The print claim is dropped. Task proposals turned out to be OpenAI and Ollama only, and the README says so. Left: a real print view (subject, sender, date and the whole body), which needs the reading view's Print button to open it.
- [x] `.env.example`: add `ANTHROPIC_*`, `AI_PROVIDER`, `TELEGRAM_BOT_TOKEN`, `EMBED_*`, `VAPID_SUBJECT`, `ADDRESS_HEADER`, `XFF_DEPTH`; fix the AI paragraph; drop "Raven" here and in the compose example. A test keeps the code, the README table and `.env.example` naming the same variables.
- [x] Import/Export and Reset pages: say what is really exported and reset (rules are neither; page size is exported and dropped on import). Left: neither re-deploys auto-reply to the mail server; the pages say so.
- [x] Settings → Search: "Paused" only when paused (fixed in Phase 1); the search help should mention search by meaning and relevance order.
- [x] Jev: pins act only while Jev is on; say so or apply them without Jev.
- [x] "Check" in Settings → Agent sends a real request only on Claude; check the fallback model too.
- [x] `scripts/ai-models.mjs` ignores the Anthropic and OpenAI keys. Retired: Settings → Agent lists every provider's models and Check tries them.
- [x] Add a request-level smoke test per form page (a real POST through the built server, expecting anything but a 500). Unit tests call action functions directly and never go through SvelteKit's own checks, which is how a `default` action beside named ones broke password sign-in from PR 51 to PR 74 unnoticed. It boots a Vite dev server rather than the built one, so it runs with `npm test`.
- [x] Move `tests/ics-qa.mjs` and `tests/caldav-discovery.mjs` under vitest (the `npx esbuild` they shell out to is no longer a dependency, and the mock server is not in the repo).
- [x] CI: add a linter, pin actions by SHA, add a `permissions` block; `.dockerignore` should exclude `local-data/`.
- [x] Move `JEV_PLAN.md` to `docs/` and trim it to what is not built.

## Phase 4: simplify

Changes that remove code and make the next fix cheaper. Each should be its own pull request with no behaviour change.

- One agent stack. The OpenAI/Ollama path (`ai/mail-agent.ts`, `mail-search.ts`, `calendar-actions.ts`, `/api/ai/calendar`, `/api/ai/tasks`, the rail's proposal cards) is about 1,200 lines that duplicate the Claude runtime and carry most of the open AI findings. Either put OpenAI behind a provider adapter in `agent/runtime.ts` or declare the non-Claude path answer-only and delete it.
- One preference API. `/api/preferences/*` validates per key; `/api/user-state/settings` writes the same row unvalidated. Fold page size into the first and delete the second.
- One popover. Six menus each carry their own open, close, position and keyboard code; one `Popover` primitive (anchor, align, portal, Escape, outside click) removes about 300 lines and fixes the menus that lack Escape.
- Split `ComposerShell.svelte` (draft lifecycle, attachments, formatting toolbar, send-later menu, editor setup) and `EmailDetail.svelte` (verification-code card, assistant panel, unsubscribe, spam verdict, body frame).
- One of each helper: JMAP filter builders (3), address normalisers (3), IANA zone validators (3), add-a-day helpers (4), `parsePagination` (4 copies), `schema()`/`str()` tool helpers (3), `formatSize` (3), the mail-route regex (4), "does Jev read this account" (4).
- Delete dead code: `RichTextEditor.svelte`, `queries/user-settings.ts`, `getFirstUser`, the `rules` context, `profilePhoto.hydrate()`, `readingPane.setFromViewport`, `forwardEmail`, `getReminder`, `queryAndFetchEmailsWithFilter`, `POST /api/ai/conversations`, `sortingEnabled`, `notifyUrgent`, the `/apps/[slug]` route, the mailto parse-and-discard.
- Fix stale comments next to the code they describe (listed in the review), and rename the `ameera` leftovers in service-worker cache names, notification tags and the scheduled-send symbol. Keep `ameera.db` and the HKDF salt: they are load-bearing.

## Phase 5: features

- Task proposals on Claude (Todoist, Linear, Notion, webhook): the README promises them and they only work on OpenAI/Ollama.
- Provider parity, or an honest matrix in the README of which abilities each provider has.
- Then the product roadmap in the README: IMAP and POP3 with Gmail first, Tasks and Notes on a local store, the shared canvas.
