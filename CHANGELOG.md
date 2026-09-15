# Changelog

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
