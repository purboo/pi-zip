# Speed mode (default since 0.5.0-next.0)

Status: prerelease. Everything below was validated offline against a real Pi 1.4.0 `AgentSession` with synthetic providers. Provider acceptance, reasoning quality, cache reuse, upstream contention and latency have not been evaluated live, and no live speed or quality improvement is claimed.

## Why

In live paired runs on coding tasks, early folding saved little once routing effects were separated: most of the saving came from stable relay routing (`metadata.user_id`), which pi-zip keeps in both modes. Folding early also changed the model's trajectory and could lengthen the active wait for a solved task. Speed mode therefore leaves the model-visible context exactly as native Pi has it until Pi must compact anyway, prepares the summary in the background, and supplies it only when it is ready and valid, so summary generation leaves the foreground path. The priority is quality, then the active wait until the task is solved, then cost: a cheaper result that takes longer is not an improvement.

The previous economic folding policy remains available as `PI_ZIP_MODE=early`.

## Modes and byte-identity contract

`PI_ZIP_MODE=speed` is the default, including when unset. `PI_ZIP_MODE=early` explicitly selects the existing early-fold planner and its cold, warm-valve, and economic triggers. Invalid values select speed and produce one local status explanation. Existing `/zip on`, `/zip off`, `/zip quiet`, status, notices, renderers, and recall handles keep their meanings. Off remains a strict request no-op. Policy selection does not silently undo persisted edits or regenerate old placeholders.

In speed mode, before the pressure threshold, the main request's model-visible context is byte-identical to native Pi for the same branch, model, prompt options, explicit tool selection, and pending messages. This includes system messages, message order, tool definitions, public content, signed/encrypted reasoning, and provider cache controls. No zip instruction, placeholder, summary, or tool guideline is inserted. Expiry, model changes, learned prices, output age, and finished background work do not weaken this contract.

The whole HTTP request is not identical: supported relay requests carry stable `metadata.user_id` from request 1. That field is routing metadata, outside model-visible context. The identity test allows exactly that field difference, not arbitrary normalization of payloads.

Register `zip_recall` with `defaultActive: false` in speed mode. Keep the initial tool selection unchanged for the entire session, including failed and successful compactions; there is no activation transaction. Default persisted sessions use file recall through the already active read/grep/bash tools. Explicit tool allowlists, including an explicit recall tool, remain authoritative. No-session/in-memory sessions without a usable persisted file-recall route remain native-safe: v1 does not adopt there. Existing handles remain available through permitted tool/file recall on resume.

## V1 constraints

Speed v1 makes these choices:

1. Adopt only in Pi's supported automatic `session_before_compact` path (`threshold` or `overflow`). Return a ready immutable `CompactionResult` only after revalidating the exact frozen prefix, existing first-kept ID, guarded cut, and size against the current branch. Otherwise return `undefined`, allowing native compaction. No input-time adoption, local summary projection, manual `ctx.compact`, or fabricated IDs. A non-model-visible retained fence is future work; v1 uses existing message IDs only.
2. Fresh speed sessions register recall inactive and never change its activation. Default persisted sessions use the existing file-recall route throughout. Explicit tool selections stay fixed. Without a persisted session or any usable recall route, zip adoption is unavailable and Pi remains responsible for recovery.
3. Retain the existing two-user-turn guard and recent-token floor, with no deeper-cut exception. Recent requests, including long text and images, remain verbatim as kept messages. Prefix-bound reasoning in the retained suffix or an open reasoning/tool transaction makes zip adoption unavailable. Native fallback is a deliberate v1 limitation, including when that limits Anthropic adoption.
4. Unresolved virtual selections (`api: pi-virtual`) disable both zip production and adoption. Physical route resolution and its reserve-override semantics require a future public API.
5. Speed settings require nonnegative safe integers for reserve/recent values, including ordinary values shadowed by an override, and object-shaped selected override entries, matching Pi. Malformed settings disable zip adoption; no silent defaulting.
6. A candidate stores its preparation target `P`; at adoption it must fit `<= P` using that frozen target and current suffix/system overhead. A successful adoption rearms the next episode at `<=` that same `P`, including equality. New episodes compute their own forecast.

The pressure and preparation formulas remain unchanged. Zip's adoption opportunity is now Pi's automatic safety boundary, not every crossing of `T`. A ready candidate can therefore wait between `T` and Pi's strict native trigger `N`. An unusable candidate never suppresses native recovery.

## Exact pressure rule

Use the effective physical model's `contextWindow` and effective Pi compaction settings at every decision. Reserve precedence is `compaction.modelOverrides[provider/id].reserveTokens`, then `compaction.reserveTokens`, then Pi's 16,384 default. Read settings after resource reload. Keep the native enabled flag and its effective `keepRecentTokens` (default 20,000).

Define all quantities in tokens, without binary/decimal unit conversion:

```text
W = finite positive model.contextWindow
R = effective nonnegative safe-integer reserveTokens
N = W - R                                      # native shouldCompact triggers at U > N
M = min(8192, floor(0.05 * N))                  # estimation/one-boundary margin
T = N - M                                     # first permitted zip content change
```

Speed mode may supply a completed valid compaction only at Pi's automatic compaction hook with `U >= T` (or explicit overflow), never at input or a turn boundary. Below `T`, its context handler returns no transformation and its boundaries append no context edits or compaction. This is a pressure condition, independent of economic return. A background candidate's existence never counts as pressure.

`U` is Pi's current context count, including already persisted trailing input. Use the existing native-compatible `piContextTokens` against the exact projected entries and boundary drafts, so staged edits invalidate old usage. Pi 1.4.0 uses `estimateProjectedContextTokens`; usage uses `totalTokens`, or input + output + cache reads + cache writes, plus trailing message estimates. This differs from zip's input-only calibration. For an unavailable/unknown meter or a boundary with pending drafts, reuse `piContextTokens` (`src/plan.ts:63`) against the current projection and drafts; it already mirrors that native estimation and edit-invalidation rule. Verify parity for the supported Pi runtime and do not reuse stale usage across a compaction or context edit. Use the selected physical model's limits after a model switch. Test parity with Pi rather than importing a private installed module path. The count is an estimate, not a claim of exact tokenizer knowledge.

If the window/count/settings cannot be resolved safely, `N <= 0`, or automatic compaction is disabled, default mode makes no automatic zip content changes and leaves Pi's configured/manual behavior available. Do not substitute the 40K target for an unknown window. An explicitly requested manual `/compact` remains Pi's operation and can change context below `T`.

| W | R | N | M | T |
| ---: | ---: | ---: | ---: | ---: |
| 200,000 | 16,384 | 183,616 | 8,192 | 175,424 |
| 1,000,000 | 16,384 | 983,616 | 8,192 | 975,424 |
| 65,536 | 16,384 | 49,152 | 2,457 | 46,695 |
| 32,768 | 16,384 | 16,384 | 819 | 15,565 |

These thresholds are design constants to validate, not measured optimums. The tiny-window case can have no useful cut; it must not trigger repeated futile summaries.

## Background timing and candidate lifetime

Preparation changes no main context. Schedule it through the existing producer at safe completed-message/tool boundaries, after each real response updates the meter, and at session start/resume when pressure preparation is useful. Preserve 0.4.15's production support in TUI, RPC, print, and JSON while the process lives. Pressure preparation on opening a sufficiently full session is an explicit change from 0.4.15's future-only opening behavior, not a claim that it already starts calls on browse. Do not keep a print process alive solely to finish speculative work. No fixed fraction of TTL or minimum user absence controls preparation.

For a resolved window, use this initial timing model:

```text
g = max(2500, p90(last 20 positive same-epoch main-context growth deltas))
v = max(250, EWMA_0.1(positive growth / seconds between same-run main completions))
d = min(240, max(60, p95(last 20 successful summary durations, seconds)) + 5)
lead = ceil(v * d) + 2 * g
L = min(T - floor(N / 2), max(16384, lead))
P = T - L
```

Speed forecasting owns its own growth samples, separate from the economic learner. Main boundaries sample each increase once; repeated checks of the same completion add nothing. Worker readiness reevaluation neither adds a growth sample nor changes the main-completion timestamp, even if the current projection has grown since that observation. A session/model/base-URL/compaction-head epoch change resets growth and velocity. Summary duration history remains scoped to the physical model. Empty growth/duration samples use 2,500 tokens, 250 tokens/second, and 60 seconds respectively, so the initial duration budget including margin is 65 seconds. Percentiles use nearest rank. Use a monotonic clock, ignore cross-model/cross-compaction deltas, and floor elapsed intervals at 0.1 seconds. Do not update growth or usage with summary/warmer responses. These conservative starting values are hypotheses; record actual preparation slack and misses. Summary durations observed in earlier live runs were about 31-44 seconds, but they do not establish a portable service bound.

Start the one background worker when `U >= P` and a useful legal prefix exists. Freeze its prefix at an eligible completed transaction boundary. Target an adopted context at or below `P`, measured with the actual summary and retained suffix, so another transition is unnecessary until a later pressure episode. Preserve the most recent two user turns and at least the effective recent-token floor when choosing ordinary cuts. Never split a pending tool transaction. If those constraints leave no useful cut, record that fact and avoid producing the same impossible candidate repeatedly.

A candidate records session, compaction head, physical provider/model/base URL and capabilities, validated settings, first-kept entry ID, exact prefix digest, and frozen preparation target `P`. Only existing message cut IDs are used. There is no completed-turn/future-user fence in v1. The prefix includes projection edits and inherited summaries; changes invalidate it, while suffix appends are permitted only if the cut remains guarded and safe. Persist candidate identity with the existing artifact so restart can revalidate it; never mutate a ready candidate.

At most one job runs per session. Appends do not cancel a pending useful job. Each preparation check validates the running job's frozen prefix digest and existing cut ID, so an incompatible prefix edit cancels it. Completion releases the worker slot and queues a nonblocking reevaluation of the current projection; off, shutdown, session identity, and conflict guards prevent unwanted restarts. After it finishes, validate the current projected size and protected suffix locally. A ready candidate remains immutable. If growth makes it insufficient to reach `P`, prepare a larger replacement in the background; keep the previous candidate until a replacement is ready, but adopt only a candidate that passes current safety and size checks. Never send successive partial improvements to the main model. Cancel invalid work on branch/model changes, off, conflict, or shutdown, and account for all usage, including unused/failed candidates.

The worker has its own abort signal and a 240-second total deadline, matching the existing narrative limit. It is not owned by a foreground prompt's Esc signal. There is one bounded background retry for a transient failure within that deadline; deterministic effort/policy/cap errors do not trigger an identical retry. Retry preparation never owns a main-request lock.

## Main path and one prefix switch

The states are native, preparing, and ready, all with Pi's unchanged context. Only `session_before_compact` for automatic threshold/overflow can return a completed `CompactionResult`. It rechecks identity, current projection, safe cut, recall, cancellation, and post-compaction size. A pending, failed, invalid, or oversized candidate returns `undefined` immediately, allowing Pi's native summary. Zip never cancels a safety compaction, calls `ctx.compact()`, waits for its worker, or drafts a compaction in speed mode. Other handlers retain Pi's normal last-result/cancellation semantics; zip does not claim it can prevent another handler from cancelling or replacing a result.

Pi owns the append, projection refresh, and continuation. Zip's hook changes neither tools nor main context, and adds no separate local projection. Cancellation or foreign replacement therefore leaves no zip transaction to undo. Confirmation through `session_compact` is observational and checks the actual matching appended result. One adopted summary is immutable; later requests append to Pi's projection.

Pi 1.4.0 does not provide transactional append: `_appendEntry` updates `fileEntries`, `byId`, and `leafId` before `_persist`. A disk write failure can leave either a native or zip-supplied compaction in memory without a corresponding JSONL entry. Continuation can then contain that summary, and later writes can name the missing compaction as their parent. Reopening the JSONL file cannot recover the missing summary. Zip accepts native automatic-compaction persistence semantics and does not patch Pi, roll back its branch, or promise disk/memory atomicity. The lifecycle regression injects the same fault at `_persist` for both paths and checks disk contents, in-memory projection, continuation, tools, absence of zip context edits, and actual disk reopen. This inherited runtime limitation remains a release consideration.

A later episode rearms when the verified post-adoption size is `<=` the candidate's frozen `P`, including equality. Only the next episode recomputes `P`. If the suffix no longer fits, prepare a replacement in the background and leave native recovery available.

The single-rewrite invariant concerns zip-induced content discontinuities, not a promise that the provider will report a cache hit: TTL expiry, account loss, eviction, and external system/tool changes can independently miss. Observe reads/writes without silently retrying or recutting to improve the metric.

## Cache and routing invariants

1. Preserve native system, tools, cache breakpoints, retention tier, session affinity, and thinking/effort settings on main requests before adoption. No timestamps, preparation progress, candidate IDs, or status text enter that prefix. UI entries remain custom transcript entries, outside model context.
2. Preserve 0.4.15's existing stable Anthropic relay `metadata.user_id` derivation from the persisted session UUID, auth exclusions, and persisted accepted/refused state. It is present on the first eligible request and unchanged across prompts, summaries adopted by the main session, warmers, and process restarts. Use the existing explicit disable escape hatch. Respect existing metadata, direct Anthropic endpoints, Claude Code/OAuth identity, and Copilot; never overwrite caller identity. Preserve the current refusal behavior that disables unsupported metadata for that endpoint; this routing compatibility outcome is not permission to change content.
3. GPT Responses keeps Pi's native session/prompt-cache key and affinity headers. Do not send the Anthropic metadata format to Responses or claim it pins an upstream account. Account pinning there remains unverified.
4. Background summaries use a separate stable lane identity derived from session/model/compaction epoch, rather than a fresh UUID on each attempt. They do not replace the main session ID or teach the main cache learner from their responses. Eligible Anthropic relay summary requests carry `metadata.user_id` derived from that separate stable lane, using the same provider/auth/endpoint exclusions and persisted acceptance/refusal policy as main requests. Summary callbacks own their request key and refusal counter; they do not change the main request key, counter, or learner. Do not assume distinct lane identities mean distinct capacity.
5. Give the summary lane caching when the provider supports it. Build task instructions independently of conversation text, so a quoted instruction marker cannot change the prefix. Use a fixed summarizer system prompt and fixed task/budget instructions first, then deterministic public conversation messages in chronological order. Fix the output cap and word budget for the lane/epoch. Repeated attempts reuse identical prefixes; larger snapshots append messages. Keep mutable cutoff/budget bookkeeping out of the front. The speed lane uses a fixed previous-narrative allowance derived from `NARRATIVE_MAX`, independent of a candidate's skeleton or output budget. A previous adopted summary changes only at the next compaction epoch; early mode retains its existing skeleton-dependent allowance. Serialize tool calls/results as inert quoted conversation, with no tools executable by the summarizer. Strip thinking before serialization as today; opaque signatures are not summary material.
6. The summary system prompt differs from the main system prompt: this scheme can reuse summary-lane prefixes but does not promise shared main/summary cache entries. Do not rewrite main instructions to manufacture such sharing. Do not unfold an unbounded archive into a summary request; summarize the current projected prefix, carry its prior summary, and expand inherited placeholders only within the model's input budget.
7. Keep Pi core as the only warmer. Its current delay is `min(0.9 * TTL, TTL - 10 seconds)`, followed by another interval after completion. Preserve Pi's replayability, retention, configured mode, horizon, and economic checks. Do not add a zip warming timer or a pre-adoption warmer for a speculative prefix. Keep the existing producer/idle-door timers distinct from Pi's warmer; their presence does not make zip a second warmer. When adoption changes the projection, the old warmer must become stale and only the next real request may seed the new one. Unknown TTL means no guessed refresh.
8. Main requests have admission priority. A queued summary must yield to a main request or core refresh; no zip semaphore may serialize them behind a narrative. Already running side calls can still contend upstream. Do not add speculative traffic when concurrency is known to be one; if capacity is unknown, count contention as an unresolved latency risk. This design cannot manufacture a separate provider lane.

The warmer investigation therefore concludes that the observed triplicate was three legitimate refresh intervals, not three duplicate extension registrations. The existing fake-clock integration exercises three periodic refreshes; the new real AgentSession fixture checks that the old refresh becomes stale after adoption. Speed mode adds no warmer or economic timer.

## Summary effort and reasoning continuity

Replace the first-call behavior of 0.4.15's existing `lowEffort`/`EFFORT_REFUSED_RE` recovery with effort resolution from the actual provider/API and model capabilities before the first narrative request. The current process-local remembered retry is insufficient after restart; this is a correction to existing handling, not a new recovery mechanism. For a non-reasoning model, omit reasoning parameters. For a reasoning Responses model, select `low` when supported, otherwise the lowest supported non-off level from Pi's model capability mapping. A GPT reasoning model that rejects `none` (observed with `gpt-6.1-sol`) must send `low` on attempt 1, including after a fresh process. `off` mapped to `none` is not a valid discovery probe. For other APIs use Pi's supported thinking-level adapter rather than passing an OpenAI field indiscriminately; budget-based Anthropic thinking must fit the output cap. Pi's simple adapter adds the thinking budget to an explicit answer cap; reserve that budget before dispatch so the serialized `max_tokens` remains within the selected total cap in both speed and early modes. Pi looks up `xhigh`/`max` thinking budgets under `high`; normalize that budget key while retaining the chosen reasoning level. Wire assertions cover all six supported non-off levels, raw/simple adapters, both modes, and large/small model output limits. If a reasoning model declares no supported non-off level, fail preparation locally and leave recovery to native Pi; do not infer a provider default. Key decisions by provider/model/base URL and capability revision. Never alter foreground effort to fix a summary call.

Source inspection locates `drop_block` in Pi 1.4.0's `pi-ai/dist/api/anthropic-messages.js`, in the `supportsMidConvoEffort` path. It sets `thinking.block_binding.prefix_mismatch_behavior = "drop_block"`. A fold before a signed block can change the prefix that block binds to, so the server may discard thinking even when zip preserved the signature and the HTTP request succeeds. The GPT adapter instead replays encrypted reasoning from `thinkingSignature`. Neither behavior is tested by comparing archived signatures alone.

The fix has two parts:

- **Within an active reasoning epoch:** preserve all signed/redacted/encrypted blocks, tool call IDs, call arguments, results, and ordering exactly. Default mode makes no partial folds. A provider requiring prefix continuity forbids a cut or any earlier result edit while its assistant/tool transaction is still open, including a result waiting for the next assistant response. All transaction results being present does not alone prove the reasoning turn has ended. The v1 guard applies to speed adoption; early folding keeps its existing behavior and does not gain a new reasoning-safety guarantee.
- **At compaction:** keep the two newest user turns and effective recent floor verbatim as messages. No deeper cut is allowed. If retained Anthropic signed/redacted reasoning would bind to a changed prefix, or a transaction is open, return `undefined` for native recovery. Responses opaque reasoning and adjacent calls/results remain exact. Model switches follow Pi's native reasoning transformation. This conservative policy limits zip adoption on prefix-bound models; it makes no claim that native compaction preserves every old binding.

No signatures are forged or summarized. Server acceptance and quality remain a separate live-validation dependency, not part of this offline task. Early mode retains its existing fold policy; the new speed adoption guard must not silently change early-mode cut selection.

## Failure paths and practical limits

| Condition | Required behavior |
| --- | --- |
| Pending summary at `T`, with context still within native limits | Send unchanged native context; return from zip hooks without waiting. Keep the valid worker running. |
| Pending/failed/stale summary when Pi must compact (`U > N` or overflow) | Use a ready valid candidate if possible; otherwise allow native compaction/recovery. Never cancel safety compaction merely to avoid a latency measurement. Record `missed_ready` and native wait. |
| Sudden giant input/tool result, cold resume already above the threshold, single-capacity provider, or one long unclosed reasoning turn | There may be no time or legal boundary for preparation. Preserve native recovery and record the precise cause. No claim of universally nonblocking compaction is possible under unbounded growth/service time. |
| No useful cut, recent floor larger than available room, or inaccessible recall | Leave context unchanged, avoid repeated work for the same prefix, and retain manual/native recovery. No tiny-window summarization loop. |
| Narrative error, timeout, truncation, policy refusal, local admission refusal, or unsupported effort | Keep main context and any older valid candidate. Keep 0.4.15's failed/fallback artifact and usage accounting, but filter `llmOk=false` out of speed-mode adoption (early mode keeps its fallback policy). After the bounded transient retry, suppress another call for the same failed prefix/model/settings until those inputs change. A fallback is not a successful narrative; quality has priority. |
| Branch/model/settings change, external edit/compaction, or changed prefix digest | Cancel/invalidate the incompatible candidate. Appends alone do not invalidate it. No obsolete summary is installed by a late completion. |
| Provider-request failure around adoption | Zip adds no separate local edit; retain Pi's current projection for retries. Never oscillate back to the old prefix or regenerate a different summary. |
| Compaction disk-write failure | Match native Pi semantics: its in-memory append can survive the failed write, continuation can contain the summary, and disk reopen can lose it. Zip adds no tool/context transaction or rollback. |
| Off, conflict with another context manager, shutdown | Stop preparation; make no new zip context edits. Keep old handles/UI usable and account for completed unused calls. |
| Missing usage/prices/TTL | Use native estimation where available; keep uncertainty explicit. Zero configured dollar cost is not proof of free traffic or a working warmer. |

The nonblocking guarantee is precise: zip never waits for narrative generation on the main path, and a ready valid candidate eliminates narrative service from the switch. A hard-limit miss can still incur Pi's native blocking fallback. The fallback is a visible failure of the readiness objective, not a successful nonblocking adoption. Hiding this case with an unvalidated lossy fallback would violate the quality priority. Readiness misses, conservative reasoning fallback, and upstream contention are the remaining risks for review.

## Offline validation

Specific checks:

1. **Native bytes below pressure:** run the same frozen session through real Pi with the extension absent and with default speed mode. Compare provider-serialized context bytes, including tools/system/reasoning/cache controls. Allow only the documented sticky metadata difference in the full payload. Cover fresh sessions, warm/cold returns, first request, model switch, steering, restart, explicit tool selections, and inherited edits. Verify absence of zip edit entries below `T` and equality at `T - 1`.
2. **Pressure and settings:** table-driven window/reserve override cases, `T` inclusive and native `N` strict, unknown counts, trailing input, usage invalidation, native fallback for unresolved virtual selections with alternating physical limits, disabled compaction, and resource reload. Verify the preparation formula and no useful cut at small windows.
3. **Single rewrite:** start preparation with unchanged native requests, complete it, cross `T`, and capture the first adopted request plus subsequent requests/restart projection. Assert one atomic compaction, unchanged tools/file recall across that transition, identical persisted/local summary bytes, append-only continuation, and no late replacement or old warmer. Exercise provider failure/retry around persistence.
4. **Pending work:** hold the narrative promise unresolved. Foreground hooks and a main request must finish without resolving it, at preparation pressure and immediately below/at automatic pressure, including T - 1. At native safety pressure assert the explicit ready/native-fallback policy; also cover print/JSON without UI, timeout, Esc, off, and shutdown. No foreground hook may await `buildCut` or its worker in speed mode.
5. **Effort:** fresh-process GPT narrative sends supported `low` immediately, with one successful call and no `none`/400 discovery; cover non-reasoning, mapped/unsupported levels, other APIs, output budgets, and configuration changes. Separate transient retries from deterministic refusal.
6. **Thinking:** use real Anthropic and Responses serializers with signed/redacted/encrypted fixtures. Check unchanged bytes below `T`, exact opaque reasoning/call/result continuity, refusal of an unsafe fold/cut in an open reasoning turn, and native fallback for any retained invalid binding, with no deeper cut. Retain the existing early guard regressions without claiming a new early-mode reasoning guarantee. A request without HTTP rejection is not the sole assertion.
7. **Recall/UI and worker failures:** exact bounded recall before/after compaction, stable search pages, fork/restart handles, explicit allowlists including file recall and no-session limits, failed/unused cost accounting, failed-artifact adoption filtering without retry loops, notices outside context, candidate prefix validation, stale completions, and opt-in early behavior. Preserve `test/tz.test.ts`'s existing byte-identity assertions across time zones/locales; `run.ts:1681` remains a display-only concern.
8. **Cache/routing:** identical sticky ID on request 1/restart/warmer, existing metadata and excluded providers/auth, Responses native affinity unchanged, stable summary lane prefixes, one worker, and Pi's three sequential refresh intervals without multiplied timers. Extend the existing real-warmer overlap and sticky suites. Verify no main-lane learner updates from side traffic, absence of speed-mode rearming from warmer traffic, and the existing native deadline/foreign-handler protection with a driven run starting during compaction.

The lifecycle fixture uses Pi 1.4.0 packages through an ignored local dependency directory of links; no installation or installed-package changes are required. `test/setup.ts` isolates session/config/stats state and explicitly selects early mode for historical suites. Speed suites select speed or unset the variable to exercise the production default.

The coverage is in `test/speed-pressure.test.ts`, `test/speed.test.ts`, `test/speed-serializers.test.ts`, and `test/speed-lifecycle.test.ts`. Actual Anthropic and Responses serializers are captured before dispatch, with a throwing fetch as a second network fence. AgentSession tests use only synthetic native providers with model network refresh disabled. They verify persistence, exact file recall, restart, automatic N/N+1 behavior, one rewrite, native fallback, virtual routes, rejected settings, appended signed reasoning, and stale refreshes.

The lifecycle provider wrapper runs the real raw/simple serializer, calls the real payload hooks, and captures the final payload before throwing to stop dispatch. A throwing fetch provides a second network fence. Only after capture does the wrapper supply a synthetic assistant response so Pi can complete tools, persistence, and continuation. The extension-free control reopens a real JSONL copy of the identical branch. The full payload comparison removes only the permitted `metadata.user_id`; it does not normalize timestamps or context. Request-option comparison omits functions and the per-request abort signal and compares all remaining serializable fields.

Six mutations of the final source were each run against a separate copy; each relevant test file passed on the unmodified tree first, and each mutation then failed at its expected assertion:

| Area | Mutation | Observed assertion failure |
| --- | --- | --- |
| persistence | Move injected failure before Pi's in-memory append | Failed compaction missing from the branch |
| native payload | Restore active-by-default recall | Complete provider payload differs from native |
| worker replacement | Remove completion-triggered reevaluation | One summary instead of two |
| thinking cap | Revert the normalized thinking-budget key | Serialized `max_tokens` 30,336 instead of 16,000, in both modes |
| growth sampling | Let worker completion sample the main context | Main observation time changes from 0 to 99,000 ms |
| lane prefix | Restore skeleton-dependent previous-narrative allowance | Initial lane-message digest changes as the candidate expands |

Result for 0.5.0-next.0: `bun test` passed **806 tests across 20 files, 0 failures, 9,527 assertions**, including **90 speed tests and 20 real Pi AgentSession lifecycle cases**; `bun run build-check` passed. Validation used Bun 1.4.2, Pi 1.4.0 and the state isolation in `test/setup.ts`.

V1 does not resolve virtual routes for zip, create a new retained fence, deepen the two-user-turn cut, or activate tools during compaction. Pi owns handler ordering and cancellation: a foreign handler can cancel an operation or replace the result, and invalid native settings can still make Pi itself refuse compaction. Zip returns undefined rather than guessing around either case. A failed selection is excluded from reuse. Cancellation before append leaves native recovery available; a disk failure after Pi's in-memory append follows the inherited behavior described above.

Provider acceptance, reasoning quality, cache reuse, upstream contention, and latency remain unverified offline. A ready zip candidate removes zip narrative generation from the foreground path, but a readiness miss can still block on Pi's native summary. Pi's nontransactional append remains an accepted inherited limitation. No release performance or quality claim follows from these offline results.
