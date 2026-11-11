# Jev: what is left to build

Jev is TypeSafe's decision model. Zajel Mail uses it to sort the Inbox into tabs and to act as a spam layer. The README's [Jev section](../README.md#jev-an-inbox-that-sorts-itself) describes what is built: tabs, learning from your moves and pins, the spam layer with its watch-only mode, and sorting the mail already in the Inbox.

This page keeps what is not built yet, and the rules any new Jev work has to keep.

A redesign of how rules, folders, labels and Jev fit together is under way, staged in [organising-mail-plan.md](organising-mail-plan.md): Jev keeps the four tabs, and rules go back to exact matches that file into folders and labels. Its first two stages are done: rules are exact-match only, and Jev no longer judges rule conditions or runs rules at all; and a rule can no longer put mail in a tab, which is now a sender pin's job, with Jev on or off.

---

## Still to build

- **An urgency `score`**, so notifications fire only for urgent mail. Telegram alerts already ask Jev whether mail is urgent; browser and push notifications don't.
- **A Jev activity log**, with undo for each move.

---

## Rules new Jev work keeps

1. **Jev never deletes.** Trash empties itself, so a misjudgement there would become permanent. Spam goes to Junk, which can be undone. Rules can move mail to Trash, but a rule is an exact match you wrote, and Jev has no part in it (rule 9).
2. **Act only above a confidence threshold, and require more for bigger moves.** Categories need a minimum `choice` confidence. Moving mail to Junk needs at least 0.9; rescuing it from Junk needs spam at most 0.1.
3. **When Jev is unsure, nothing happens.** No keyword means the message stays in Important; a failed call is retried, then given up on, and the message stays where it is.
4. **Jev's own moves never train Stalwart.** Only your Spam and Not spam clicks set `$junk` and `$notjunk`.
5. **What Jev sees is fixed:** sender, recipients, subject, list headers, the facts our code works out (in their own fields, so the email can't pose as one), and the first 2,000 characters of the plain-text body without quoted replies. `jev_decisions` keeps answers and probabilities, never the email text.
6. **Opt-in for each linked account**, since that account's mail is what leaves the server.
7. **Every decision explains itself** in the message view.
8. **Holding new mail for sorting is short, and never hides it.** While something sorts an account's new mail into tabs (Jev, or sender pins, which act with Jev off too), the Inbox tabs, their counts and new-mail notifications wait for a message until the sorting pass marks it `$jev_sorted`, whatever the outcome. They wait no longer than `INBOX_HOLD_MS` (two minutes) after it arrived, and never for mail dated further ahead than that ([inbox-hold.ts](../src/lib/inbox-hold.ts)). Rules run before the mark is written (every pass asks the rules scheduler for a run first), so their moves and labels are in place when the message shows; they never wait on TypeSafe. Mail is never parked in a holding folder, so mail is still delivered and visible elsewhere when the app is down.
9. **Jev has no part in rules.** A rule matches exactly (sender, recipient, subject, body, size, attachment) and only the rules scheduler runs it, so rules behave the same with Jev on, off or unreachable. A stored rule that still has a condition Jev used to judge is never run on its remaining conditions, which would widen it: it is switched off, flagged for its owner, and refused by the engine until it is rewritten.
10. **Tabs are Jev's and your pins', never a rule's; and a pin needs no Jev.** With tabs on, a pinned sender's new mail goes to its tab whether Jev is on, off, rate-limiting or unreachable, and nothing is sent to TypeSafe for it. The order for a message still in Important is: your own choice of tab, then your pin, then Jev's confident pick. A confident spam verdict (active mode, sender not known to you) still takes a pinned sender's mail to Junk.

---

## Risks and open questions

- **Non-English mail** is more likely to get low confidence. That is safe, because it ends up in Important or is left to Stalwart, but it is less useful.
- **TypeSafe's default retention** isn't documented, and zero data retention is enterprise-only. Recheck before turning Jev on for a sensitive account.
- **Thresholds belong to a model version.** Revisit them before moving the pin from `jev-1.13.0`.
- **Some mail waits the whole two minutes.** Mail Jev judged before it could be marked gets no mark, so the Inbox holds it until its two minutes are up. That covers mail judged while the tabs were off and then switched on, mail from Junk you mark Not spam right after it arrived (with spam checks on), and mail moved back into the Inbox within two minutes of arriving. So does every new message while TypeSafe is down or rate-limiting, except a pinned sender's, which goes to its tab at once.
- **Mail let through unsorted can still move later.** After an outage, a message that waited its two minutes shows in Important, and when Jev answers on a retry it moves to its tab. That one move is the price of never hiding mail.
- **The hold now covers accounts without Jev.** An Inbox with tabs and at least one sender pin holds every new message, pinned or not, until the pass has looked at it. With Jev off that is the push stream's second or so; if the stream is down it is the minute's run, and never more than the two minutes.
- **An email can argue with Jev.** Its text can only move probabilities on fixed questions; facts sit in separate fields, moves need high confidence, contacts are never sent to Junk, and the worst automatic result can be undone.

---

## Sources

- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Models, limits and data handling](https://docs.typesafe.ai/models)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Patterns](https://docs.typesafe.ai/patterns)
- [Legal](https://docs.typesafe.ai/legal)
