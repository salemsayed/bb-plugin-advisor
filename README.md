# bb Advisor

`bb-plugin-advisor` adds an OMP-style independent reviewer to bb without changing bb core.

The plugin provides three complementary review paths:

- `advisor_review`: a mandatory agent tool for substantial work. It runs a hidden, review-only agent in the same environment and returns feedback before the primary agent's final answer.
- Post-turn review: after a primary thread becomes idle, the reviewer checks the completed answer. Actionable late findings are injected into the next turn's dynamic instructions.
- Review now: the thread UI can start the same review on demand. If the agent
  is still working, Advisor waits for the completed public answer instead of
  treating the missing answer as a finding.

The thread advertises the review lifecycle independently from the agent turn:
**Waiting for completed turn**, **Review pending**, **Approved**, **Changes
requested**, or **Review unavailable**. A late finding stays attached to the
completed turn and offers **Fix in new turn**, which starts an agent-only
corrective follow-up with the finding already in context. Unresolved findings
also continue to be injected when the user sends the next message. When more
than one finding is queued, Advisor carries the whole bounded queue into that
turn; delivering one finding never silently consumes its siblings.

The optional **Automatically continue on late findings** setting starts that
follow-up without a click. It is disabled by default, is idempotent per review
round, and can fire only once per finding chain so a persistent finding cannot
create an unattended review loop.

Reviews are persisted in the plugin's SQLite database, keyed by primary thread
and timeline sequence.

The advisor assigns each finding a stable `key` naming the defect itself. A
later round carrying the same key joins that finding's chain even when it is
reworded or rated differently, and the chain is stored at its strongest
severity — repetition means the primary agent was told and did not act, so a
finding can escalate but never soften.

Every finding carries its own lifecycle, and the thread tab shows it:

- **Queued** — found, but its text has not reached the primary agent yet.
- **Sent to the agent** — `sent_at`, set at the two moments the finding is
  actually handed over (the tool result, and injection into the next turn's
  instructions). It is deliberately not `delivered_at`, which only tracks the
  pending-advice queue. Queue delivery is recorded per finding.
- **Re-raised N×** — the advisor flagged it again, so it demonstrably was not
  addressed.
- **Advisor re-checked and closed it** — the reviewer is shown its own open
  findings each round and may name keys on a `resolved:` line that it verified
  are fixed. Silence never closes anything, it cannot close a key it did not
  raise on this thread, and it cannot raise and close the same defect in one
  result. Closure is provisional: a later round of the same key reopens the
  chain, because a finding that comes back is a regression.
- **Decided by the user** — `not-an-issue` or `wont-fix`, with an optional
  note, stored on the chain root. A user cannot self-certify a fix: **Fixed**
  is established only when a later Advisor round re-checks and closes the
  finding. Existing legacy `fixed` decisions remain readable. A user decision
  is authoritative: later matching rounds stay in history but never reopen it.
  Reopening clears the decision and any advisor closure together.

Findings resolved before decisions were recorded keep rendering as a plain
dismissal rather than being backfilled with a guess.

Matching normalized advice text is the fallback, used both when the advisor
supplies no key and when a keyed finding misses — which is how a chain that
predates keys stays continuous instead of splitting and softening on its first
keyed round. That fallback applies only above a length floor: terse generic
wording would otherwise merge unrelated findings and hand one an inherited
severity it never earned. A turn that already ran the tool is not reviewed again
after it goes idle.

Reviewer threads are hidden and reused so the advisor keeps its own context. A
session is bound to the environment it was spawned into; if the primary thread
moves, the reviewer is respawned rather than left inspecting the old checkout.

When the advisor cannot run — the provider does not support the reviewer's
permission mode and no advisor model is configured, the reviewer thread fails to
start, the review exceeds the timeout, or the primary turn fails or ends without
a completed public answer — the
tool reports `Advisor unavailable` with the reason. That is deliberately not a
pass, no review row is recorded, and pending advice from an earlier turn stays
pending. A waiting **Review now** request is settled as unavailable and can be
retried instead of remaining stuck in a waiting state. Cancelling the primary
turn stops the reviewer thread.

## Install

From GitHub:

```sh
bb plugin install git:https://github.com/salemsayed/bb-plugin-advisor.git@main
```

From a local checkout:

```sh
bb plugin install . --yes
```

Configure it in **Settings → Extensions → Advisor**. The model section loads
the live provider/model catalog independently from every connected bb machine.
Selections are stored by stable host id, not as one global model string. Each
machine selection includes a reasoning level populated from that model's live
supported-reasoning metadata; choosing "Model default" tracks the model's
reported default.

**Auto-continue on late findings** is also available on that settings page and
is disabled by default. When enabled, Advisor starts one corrective follow-up
turn for a newly raised finding chain; repeat rounds do not create an
unattended loop.

At review time the plugin routes discovery through the primary thread's
environment and revalidates that machine's saved selection. A machine without
a selection follows the primary thread's provider/model. A disconnected
machine, a model that was removed, or a reasoning level the model no longer
supports also falls back to the primary model.
The picker only offers providers that can host a reviewer in one of the
accepted permission modes, and it never accepts models from an unverified
fallback catalog returned after a provider probe failure.

Falling back to the primary model is checked, not assumed: if the primary
thread's own provider cannot run a reviewer in any accepted mode and that
machine has no advisor model configured, the review reports as unavailable
instead of failing at spawn. A catalog that cannot be read is treated as
inconclusive, so a transient outage does not disable reviews.

Place project-specific reviewer policy in `WATCHDOG.md` at the workspace root. The filename is configurable.

The reviewer's permission mode is negotiated per review against what the
provider actually advertises, narrowest first: `readonly` when bb offers it,
otherwise `accept-edits`. Pinning either would be wrong — `readonly` reports
every review as unavailable on a bb released before that mode existed, and
`accept-edits` keeps handing the reviewer workspace write access on a bb that
has something narrower. bb only gained a first-class `readonly` mode
recently, so on an older build the reviewer is still a behavioural boundary
rather than an enforced one: it is instructed to use read-only operations and
runs in the narrowest mode available, but it is not sandboxed. A session
spawned under a wider mode is retired rather than reused once a narrower one
becomes available, so upgrading bb tightens the reviewer without any action.

When the catalog cannot be read the mode is probed narrowest-first rather than
assumed: the reviewer asks for `readonly`, and only a refusal moves it to
`accept-edits`. A mode the host accepted before is tried first, so the probe
costs nothing on the common path. A transient outage therefore neither
disables reviews nor silently widens them.

The exact tool set exposed in a given mode remains the provider's
responsibility, so provider-specific non-workspace capabilities must still be
assessed by that provider.

## Inspect

```sh
bb advisor status
bb advisor reviews <thread-id>
bb plugin logs advisor -f
```

## Verify

```sh
npm ci
npm run verify
npm pack --dry-run
```

The GitHub Actions workflow runs the same typecheck, test, build, and package
checks on pushes to `main` and on pull requests.

## License

MIT © 2026 Salem Sayed Abdel Gawad. See [LICENSE](./LICENSE).
