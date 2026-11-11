# Jev: what is left to build

Jev is TypeSafe's decision model. Zajel Mail uses it to sort the Inbox into tabs, judge plain-English rule conditions, and act as a spam layer. The README's [Jev section](../README.md#jev-an-inbox-that-sorts-itself) describes what is built: tabs, Jev conditions in rules, learning from your moves and pins, the spam layer with its watch-only mode, and sorting the mail already in the Inbox.

This page keeps what is not built yet, and the rules any new Jev work has to keep.

A redesign of how rules, folders, labels and Jev fit together is planned in [organising-mail-plan.md](organising-mail-plan.md): Jev keeps the four tabs, and rules go back to exact matches that file into folders and labels.

---

## Still to build

- **An urgency `score`**, so notifications fire only for urgent mail. Telegram alerts already ask Jev whether mail is urgent; browser and push notifications don't.
- **A Jev activity log**, with undo for each move.

---

## Rules new Jev work keeps

1. **Jev never deletes.** A rule with a Jev condition can't delete or move mail to Trash, since Trash empties itself and a misjudgement would become permanent. Spam goes to Junk, which can be undone.
2. **Act only above a confidence threshold, and require more for bigger moves.** Categories need a minimum `choice` confidence. Rule conditions use the rule's strictness: Loose 0.6, Normal 0.8, Strict 0.95. Moving mail to Junk needs at least 0.9; rescuing it from Junk needs spam at most 0.1.
3. **When Jev is unsure, nothing happens.** No keyword means the message stays in Important; a failed call is retried, then treated as if every Jev condition were false.
4. **Jev's own moves never train Stalwart.** Only your Spam and Not spam clicks set `$junk` and `$notjunk`.
5. **What Jev sees is fixed:** sender, recipients, subject, list headers, the facts our code works out (in their own fields, so the email can't pose as one), and the first 2,000 characters of the plain-text body without quoted replies. `jev_decisions` keeps answers and probabilities, never the email text.
6. **Opt-in for each linked account**, since that account's mail is what leaves the server.
7. **Every decision explains itself** in the message view.
8. **Holding new mail for Jev is short, and never hides it.** While Jev sorts an account's tabs, the Inbox tabs, their counts and new-mail notifications wait for a message until Jev marks it `$jev_sorted`, whatever the outcome. They wait no longer than `INBOX_HOLD_MS` (two minutes) after it arrived, and never for mail dated further ahead than that ([inbox-hold.ts](../src/lib/inbox-hold.ts)). Rules Jev doesn't judge run before the mark is written, so their moves and tabs are in place when the message shows; they never wait on TypeSafe. Mail is never parked in a holding folder, so mail is still delivered and visible elsewhere when the app is down.

---

## Risks and open questions

- **Non-English mail** is more likely to get low confidence. That is safe, because it ends up in Important or is left to Stalwart, but it is less useful.
- **TypeSafe's default retention** isn't documented, and zero data retention is enterprise-only. Recheck before turning Jev on for a sensitive account.
- **Thresholds belong to a model version.** Revisit them before moving the pin from `jev-1.13.0`.
- **Some mail waits the whole two minutes.** Mail Jev judged before it could be marked gets no mark, so the Inbox holds it until its two minutes are up. That covers mail judged while the tabs were off and then switched on, mail from Junk you mark Not spam right after it arrived (with spam checks on), and mail moved back into the Inbox within two minutes of arriving. So does every new message while TypeSafe is down or rate-limiting.
- **Mail let through unsorted can still move later.** After an outage, a message that waited its two minutes shows in Important, and when Jev answers on a retry it moves to its tab. That one move is the price of never hiding mail.
- **An email can argue with Jev.** Its text can only move probabilities on fixed questions; facts sit in separate fields, moves need high confidence, contacts are never sent to Junk, and the worst automatic result can be undone.

---

## Sources

- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Models, limits and data handling](https://docs.typesafe.ai/models)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Patterns](https://docs.typesafe.ai/patterns)
- [Legal](https://docs.typesafe.ai/legal)
