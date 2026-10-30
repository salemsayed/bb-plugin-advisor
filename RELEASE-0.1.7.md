# Release handoff

Implementation is prepared for independent Fable review. No push, PR, tag, release, registry publish, GitHub comment, live install or reload was performed.

## Verified 0.1.6 procedure

Sources: commit `4a0c865e5f4cb834dd96d695ae5166713d139661`, [PR #17](https://github.com/salemsayed/bb-plugin-advisor/pull/17), annotated tag `v0.1.6`, [GitHub release](https://github.com/salemsayed/bb-plugin-advisor/releases/tag/v0.1.6), and the [marketplace entry](https://github.com/get-bb/marketplace/blob/main/entries/advisor.json).

1. Bump package.json and both package-lock.json root version fields; add CHANGELOG entry.
2. Rebuild dist from a clean copy using Node 22.19.0, locked BB 0.47.1 and SDK 0.6.79. The release commit changed dist/app.meta.json and dist/server.meta.json version metadata. For 0.1.7 the server bundle and source map also change because implementation changes.
3. Run npm run verify (typecheck, all tests, build) and npm pack --dry-run. PR #17 records 139 passing tests for 0.1.6.
4. Commit as `Release 0.1.6` (4a0c865); push release/v0.1.6 and open PR #17 titled `Release Advisor v0.1.6`.
5. Merge with a merge commit: `2bd504786286a8b6fa7320f7a6d92a7c9fdfc839`. CI passed on the release commit and merge commit.
6. Create annotated tag `v0.1.6` at that merge commit, with annotation `Advisor v0.1.6`, and push the tag.
7. Create GitHub release `v0.1.6` targeting main, with user-facing release notes and verification/compatibility details. Published 2026-10-28T14:35:36Z; no release assets.
8. No npm publish step is evidenced: the public npm registry currently returns 404 for bb-plugin-advisor. The marketplace distributes directly from this GitHub repository using range `^0.1.0`, so a compatible tag makes the update available without a marketplace entry change.

These are reconstructed actions from repository/GitHub evidence, not a recovered shell transcript. Equivalent commands after review and authorization: push branch; `gh pr create --title 'Release Advisor v0.1.7' --body-file <notes>`; merge the reviewed PR with a merge commit; `git tag -a v0.1.7 <merge-sha> -m 'Advisor v0.1.7'`; `git push origin v0.1.7`; `gh release create v0.1.7 --verify-tag --title 'Advisor v0.1.7' --notes-file <release-notes>`. Verify CI and the final merge revision before tagging. Then notify issue #18's author as requested by Salem.

## Local verification

The SDK fake-host test saves the native Findings language setting, invokes advisor_review, and checks the prompt sent to threads.spawn. Pure prompt tests compare omitted, empty and whitespace settings byte-for-byte against the original prompt captured before editing. Additional tests cover Chinese, escaped control characters/quotes, and a 40 Unicode character cap including astral characters.

`fixtures/chinese-prompt.txt` is a full dry render for 简体中文, produced by the actual prompt builder. This does not test a live model's compliance or the host settings screen visually. No plugin was installed or reloaded in Salem's bb.
