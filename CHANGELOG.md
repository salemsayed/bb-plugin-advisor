# Changelog

## 0.1.1

- Restore plugin loading and model discovery on BB 0.40 and later using the current tool presentation and provider permission APIs.
- Add an Advisor switch for existing threads and `bb advisor enable`, `disable`, and `follow` commands. Thread choices override the global default in either direction.
- Honor a thread being switched off while a review is running, including automatic corrective turns. Explicit review and fix requests remain available.
- Align the build with BB 0.43.1 and SDK 0.4.87. Verify dependency pins and bundle metadata, and reject obsolete vendored SDK files.
- Include frontend tests in strict typechecking and add a public SDK import check.
- Document Codex's existing-session tool limitation and Claude Code's reviewer command approvals, and add a marketplace overview.

Requires BB 0.40 or later and plugin SDK 0.4.21 or later. New threads continue to follow the global Advisor setting.
