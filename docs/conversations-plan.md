# Design: conversation view

## Context

Zajel listed and opened every message on its own. A reply sat in the Inbox as a new row with nothing tying it to the message it answered, and your own replies were only in Sent. Every established mail client groups these into one conversation. This document is the design that was built, and what it deliberately leaves out.

## What other clients do

Researched from the vendors' help pages (through search extracts; the pages themselves were not reachable from the build session). Where a behaviour is marked *known*, it is common product knowledge that the research could not source this time.

| | Gmail | Outlook (web) | Apple Mail | Fastmail |
|---|---|---|---|---|
| Groups by | Reply headers and subject; splits on a new subject or past 100 messages | Not documented | Not documented | Reply headers; splits on a new subject or past 100 |
| Other folders | Included (*known*) | Included, every folder | "Include related messages" setting | Included |
| Trash and Spam | Those lists show only their own messages | Option to hide deleted items (*known*) | — | Left out of conversations |
| List row | Names, count, latest snippet (*known*) | One row, expandable (*known*) | Most recent message, with a count | Conversations, not messages, are counted |
| Order when open | Oldest first, fixed | A setting | A setting | Oldest first (*known*) |
| Collapsing | Read messages collapsed, long threads condensed (*known*) | — | "Collapse Read Messages" (iOS) | Collapsed messages, click the header |
| Quoted text | Hidden behind "•••" ("Show trimmed content") | — | — | Hidden (*known*) |
| Archive | Whole conversation; a new reply brings it back | — | — | Whole conversation |
| Delete | Whole conversation, or "Delete this message" from a message's menu | — | — | Whole conversation in every folder, by default |
| Mute | Replies skip the Inbox | "Ignore": replies go to Deleted Items | Muted Thread Action | "Mute replies": replies go to Archive |
| Switch | Settings: "Conversation view" | "Message organization" | "Organize by Conversation" | "Show every message separately" |

What every one of them shares, and a reader therefore expects:

1. One list row per conversation, with a count.
2. Your own replies, and messages filed elsewhere, are part of it.
3. Opening it shows the messages in order with the ones already read out of the way.
4. Archive and Delete act on the conversation; one message can still be acted on alone.
5. A switch to turn grouping off.

## Decisions

**What a conversation is.** The mail server's thread (JMAP `Thread`, RFC 8621 §3): messages joined by References and In-Reply-To. The app adds no guessing of its own, so it agrees with any other JMAP client on the same account.

**Which messages count.** In Trash and Junk: only what is in that mailbox, since those lists are of what was thrown away. Everywhere else: every message of the thread not in Trash or Junk, wherever it is filed. Your replies in Sent belong to the conversation in the Inbox.

**The list row.**
- Names: one writer in full ("Dana Wade"); several by first name in order of first appearance, with "me" for you ("Dana, me, Sam"). Past three, the first, "…" and the last two. A name is bold while that person has an unread message.
- A count beside the names when there is more than one message.
- The subject, snippet and date are those of the row's own message: the newest in this list.
- Unread if any message is. "Draft" in red when it holds an unsent draft. The paperclip when any message has an attachment. Label chips for every label on any message.
- The list's count and paging are in conversations.

**Opened.**
- One subject line and one set of labels for the whole conversation, with the number of messages.
- Messages oldest first. Unread ones, the last one and the one that was asked for (from Search, a notification, a link) open; the rest are a line each: who, the start of what they said, when. A click opens or closes one.
- A run of four or more collapsed messages folds its middle into "N earlier messages".
- It opens scrolled to the first unread message, or to the last.
- In each message, the earlier messages it quotes are hidden behind "•••". A forward, which is nothing but its quote, is shown whole.
- An unsent draft appears in place as a draft, with Edit.
- Reply, Reply all and Forward at the end answer the last message; each message also has its own.

**Reading.** An open message is marked read after the usual delay (Settings → Messages); a collapsed one is not. So a conversation with three new replies opens all three and marks all three.

**Actions on a conversation** (the list's row buttons, its selection bar, drag and drop, and the toolbar above an open conversation):

| Action | Reaches |
|---|---|
| Archive, Move, Spam, Snooze, move to an Inbox tab | The messages in the list's own mailbox. Archiving from the Inbox leaves your replies in Sent. |
| Trash, a label | Every message of the conversation |
| Mark read | Every unread message |
| Mark unread, Star | The latest message. One unread message is enough to bring a conversation back, and a star says which message. |
| Unstar | Every starred message in it |

A reply to an archived conversation arrives in the Inbox, and the conversation is there again with all of its history: no special handling, it follows from the rules above.

**Actions on one message.** Each open message keeps its own Reply, Reply all, Forward, Star, Mark unread, Trash and Print.

**The switch.** Settings → Messages → Conversation view, on by default. Off, every list and view is exactly as before.

## Where it does not apply

- **Search** lists messages, not conversations: the result is the message that matched. Opening one opens its conversation with that message open.
- **A conversation of one message** opens in the single-message view, unchanged.
- **Unread counts** in the sidebar stay counts of messages, as in Outlook and Apple Mail. They are also what the Inbox's hold on new mail is worked out from.

## Not built

- **Mute** (replies to a conversation skip the Inbox). Every client has it; it needs a step in the new-mail pipeline and is the natural next piece.
- **Newest-first order** as a setting (Outlook and Apple Mail offer it; Gmail does not).
- **Keyboard**: next and previous message, expand all. The app has no single-key shortcuts yet.
- Expanding a conversation inside the list, splitting by branch, merging or renaming threads.

## How it is built

- `src/lib/threads.ts`: what counts, the row's summary, which messages an action reaches, which open expanded, what folds. Pure functions, tested.
- `src/lib/jmap/threads.ts`: `queryThreads` (one `Email/query` with `collapseThreads`, its rows, their threads, then the members in groups) and `getThread`.
- The Inbox, folder and Starred loaders return a `threads` map beside the rows. `GET /api/email/[id]/thread` and the message page's loader return an open conversation.
- `EmailListItem` draws a row from its message and its summary. `EmailList` and `EmailRowActions` send each action to the ids it reaches, through the existing bulk endpoint.
- `ConversationView.svelte` is the opened conversation. Each open message is the existing message view (`EmailDetail`) in an embedded mode, so invitations, sign-in codes, attachments, remote-image handling and unsubscribe all work inside a conversation as they do outside one.
