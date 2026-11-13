# Changelog

## 0.1.11

- Skip routine completed turns. A turn with no tool calls or edits and a short answer (1,500 characters or less) is no longer reviewed on its own; the next review includes everything it skipped, so nothing goes unreviewed. A new **Completed-turn schedule** setting picks **Substantive turns** (the default), **Every completed turn** (the 0.1.10 behaviour), or every 2nd, 3rd or 5th substantive turn. A turn deferred while child threads run, or whose review was unavailable, makes the next turn due even when that turn is routine. The `advisor_review` tool and **Review now** are unchanged.
- Send the reviewer only what is new. A reused reviewer gets the primary timeline after the sequence it last reviewed, with the same rules and result format, instead of another copy of the recent chat. A new reviewer, a reviewer whose context was compacted or cleared, and the first review after upgrading get the full bounded timeline. Both are rendered as readable entries instead of raw JSONL: tool output is cut to 80 lines or 8,000 characters and edit diffs to 300 lines or 8,000 characters, keeping the start and the end with a marked elision; secrets are redacted before anything is cut; user messages and the final answer are always kept, and older entries that do not fit the transcript budget are replaced by a marked gap.
- Record a usage ledger. Every review run, including unavailable and skipped ones, is stored in the `advisor_review_runs` table with its trigger, outcome, evidence mode and size, the skipped turns it carried, the reviewer's provider, model and reasoning level, elapsed time, and the reviewer's input, cached, output and reasoning tokens and cost as the provider reported them. Usage that could not be read stays empty rather than zero. `bb advisor reviews` shows it (`--json` for scripts) and the `reviewLedger` RPC returns it.
- Review threads other plugins start, such as bot coordinators, Auto Effort workers and automation workers, the same way as your own threads. A new **Review plugin-created threads** setting (on by default) turns this off, and a thread's own Advisor switch still wins. Advisor's own reviewer threads, composer predictions and workflow subagents are never reviewed, and your own hidden threads stay excluded as before.

Requires BB 0.49.0 or later and plugin SDK 0.6.132 or later.

## 0.1.10

- Wait for running child threads before reviewing a completed turn. A turn that ends while threads it started are still working is an honest wait, and bb wakes the agent when they report, so Advisor no longer reviews it on its own: the thread shows **Waiting for child threads**, and the turn that ends once they have finished is reviewed. Every review prompt also lists the thread's running child threads and says that an answer honestly waiting for them is not a finding (#25, reported by @k0d3r1s).
- Treat a finding chain as one occurrence of a problem. A key joins only a chain that is still open; after the advisor closes a chain, the same key starts a new one, and a round that raises a key while naming it as resolved closes the old occurrence and starts a new chain. The reviewer sees which open findings already reached the agent. "Told before and did not resolve it" now only follows a chain the agent actually left unresolved (#26, reported by @k0d3r1s).
- Keep a review whose wait fails: a dropped poll is retried inside the budget, a verdict written before a missed deadline is read back from the reviewer thread, and a reviewer still busy with an earlier round gets a short grace before it is interrupted and the new round resent. Thanks to @pavelmaksimov (#24).
- Build against bb 0.49.1-nightly.43076974886.1 and plugin SDK 0.6.140. The thread header verdict is now a header thread action (on phones it sits at the top of the thread menu), and panels open through the panel controller, replacing two retired APIs.

Requires BB 0.49.0 or later and plugin SDK 0.6.132 or later. BB 0.47.1 to 0.48.x keep Advisor 0.1.9.

## 0.1.9

- Archive and delete the hidden reviewer together with its primary thread. bb now owns the reviewer's lifecycle, so it is archived when the primary is archived and deleted when the primary is deleted, even while Advisor is disabled or not loaded. Deleting a primary used to leave its reviewer behind as an archived thread, and archiving one while Advisor was off left the reviewer live. Reviewers created by earlier versions are still archived by Advisor as before. Thanks to @ymichael (#22).

Requires BB 0.47.1 or later and plugin SDK 0.6.79 or later.

## 0.1.8

- Spell out in the review prompt that the result block is read by a program: its markers, field names, colons and severity value are fixed English tokens that the Findings language preference does not cover, and a block that does not have exactly that shape is discarded as if the review had never run. A non-English Findings language used to make reviewers translate the block and lose a substantively valid review (#18).
- Add an **Additional instructions** setting. Free text appended to the end of the advisor prompt, after the result format, so a review can be tuned without forking the plugin. It is fenced and explicitly cannot change the block's shape, field names, severity values or markers; the fence grows with the text so it cannot be closed from inside; empty adds nothing.

Requires BB 0.47.1 or later and plugin SDK 0.6.79 or later.

## 0.1.7

- Add a free-text Findings language setting under Settings → Extensions → Advisor for finding titles, explanations and suggestions. Empty keeps the current behavior; plugin UI stays unchanged. Thanks to @GEFNENEN (#18).

Requires BB 0.47.1 or later and plugin SDK 0.6.79 or later.

## 0.1.6

- Settle a finding when you dismiss it from the banner, the same as resolving it in the panel. The reviewer no longer treats it as open, so the agent stops getting it again on later turns. If the advisor later raises it at a higher severity, it reopens, so dismissing a nit cannot silence a blocker. Thanks to @k0d3r1s (#15, #16).
- Send a reopened finding to the agent once. Rounds the advisor raises while a finding is dismissed or resolved no longer wait to reach the agent all together.
- Say a finding was raised before, in the banner and in the agent's message, only when an earlier round actually reached the agent.

Requires BB 0.47.1 or later and plugin SDK 0.6.79 or later.

## 0.1.5

- Build with BB 0.47.1 and plugin SDK 0.6.79. The Advisor panel now registers as a thread tab through `experimental_tab`, because BB removed the old thread panel slot. The tab keeps its id, so panels users already opened still restore.
- Accept any reasoning level a provider's model catalog reports. Catalogs now report reasoning as plain strings, and Advisor no longer rejects a level it does not know. A level literally named `default` is not offered, because **Model default** already uses that value.
- Mark the reviewer's provider, model, permission mode and reasoning level as explicit when spawning it, so `message.dispatch` hooks see them as deliberate choices, not core defaults. Thanks to @JackALaing (#13).

Requires BB 0.47.1 or later and plugin SDK 0.6.79 or later. Older BB releases cannot load this version and stay on 0.1.4.

## 0.1.4

- Deliver late findings as an agent-only Advisor message when the next turn starts. A running agent session ignores changed instructions, so findings used to be marked sent without reaching the agent.
- Tell an agent once, in its next turn, when Advisor was switched on after its session started. If that turn ends before the agent reads the message, it follows in a short extra turn.
- Show the switch the moment the composer opens, count every tap with the last one winning, and ignore refetches that arrive after a newer change.
- Keep the switch interactive while saving so a tap never moves focus out of the editor, and count taps that land just outside it.
- Document which Advisor changes reach an existing agent session, and when.

## 0.1.3

- Make the Advisor switch respond to taps on iPhone and in the iOS home-screen app. Tapping it with the keyboard open used to dismiss the keyboard and minimize the composer without changing the switch.
- Keep focus in the editor when the switch or its retry button is pressed, so the keyboard stays open and the switch stays in view after it changes.

## 0.1.2

- Bound model discovery calls to five seconds and keep healthy provider results when another provider fails or stalls.
- Show provider-specific discovery errors and a Refresh models action instead of leaving settings loading indefinitely.
- Validate only the selected provider when saving; retain the visible saved selection without reloading every catalog.

## 0.1.1

- Restore plugin loading and model discovery on BB 0.40 and later using the current tool presentation and provider permission APIs.
- Add an Advisor switch for existing threads and `bb advisor enable`, `disable`, and `follow` commands. Thread choices override the global default in either direction.
- Honor a thread being switched off while a review is running, including automatic corrective turns. Explicit review and fix requests remain available.
- Align the build with BB 0.43.1 and SDK 0.4.87. Verify dependency pins and bundle metadata, and reject obsolete vendored SDK files.
- Include frontend tests in strict typechecking and add a public SDK import check.
- Document Codex's existing-session tool limitation and Claude Code's reviewer command approvals, and add a marketplace overview.

Requires BB 0.40 or later and plugin SDK 0.4.21 or later. New threads continue to follow the global Advisor setting.
