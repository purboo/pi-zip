# Changelog

## 0.5.0-next.0

- Speed mode is the default. It preserves native context and tools until Pi's automatic compaction, prepares summaries in
  the background, and supplies only a ready, validated summary. Zip never makes the foreground wait for its worker;
  unavailable or unsafe candidates leave Pi's native recovery available, which can wait for Pi's own summary.
  Set `PI_ZIP_MODE=early` to select the existing economic folding policy.
- Recent requests remain verbatim under the two-user-turn guard and recent-token floor. Unsafe retained reasoning,
  unresolved virtual models, invalid settings, and sessions without a usable recall route defer to native recovery.
  Default persisted sessions recall originals through the existing file tools; compaction never activates a tool.
- Summary lanes have stable routing identity and instruction prefixes, including a fixed previous-narrative allowance
  within each compaction epoch. Effort is selected before dispatch, and thinking budgets stay within the serialized output
  cap for every supported level, including `xhigh` and `max`, in both modes.
- Worker completion checks current readiness and prepares a replacement when suffix growth makes the first candidate
  insufficient. Incompatible prefix edits cancel obsolete work. Readiness checks do not record main growth or reset its
  clock; forecast history stays separate from economic learning and resets with its session/model/compaction epoch.
- Offline regressions compare complete Anthropic Messages and OpenAI Responses requests against native Pi, including disk
  reopen, opaque reasoning, a completed recall turn, and continuation. Mutation checks demonstrate that the acceptance
  assertions detect the reviewed failures.
- Pi 1.4.0 appends in memory before writing to disk. Native and zip compactions share that persistence limitation: a failed
  write can leave a summary in memory that is absent after reopening the session file. Pi remains unpatched.
- Validated offline only. Provider acceptance, reasoning quality, cache reuse, upstream contention and latency have not
  been evaluated live; no live performance improvement is claimed. `PI_ZIP_MODE=early` restores the 0.4.15 behavior.

## 0.4.15

- No behavior change. Removed local machine paths, a session name and private provider names from comments, docs and
  tests.

## 0.4.14

- Model-visible timestamps in folded placeholders, summary rows and narrative labels now use explicit UTC, so the same
  persisted session renders identically across process time zones and locales. Existing persisted labels remain unchanged.
  On upgrade, sessions whose context contains old local-time text may see one cache miss when that text is rebuilt.

## 0.4.13

- A side request that rewrites a cold prefix no longer teaches pi-zip that the provider kept the old cache alive through the
  entire absence. Survival learning censors an interval after a matching usage entry without a qualifying full-prefix read;
  a later full-prefix read or successful main response starts a clean interval. A write alone still does not refresh the
  prefix-read clock. The rule uses branch order, including equal timestamps, survives restarts, and accepts any usage kind
  with the existing real provider/model identities. Partial reads and incomplete usage reports conservatively lose that
  interval; cache class and growth still learn. No new setting or API call; the cost formula and planner are unchanged.
- Survival snapshots belong to each main assistant context, so Pi's streaming cache refreshes cannot replace the censor,
  gap, prefix expectation or edit state while the main response is still running. Refresh payloads still receive repair
  and relay metadata guarding; a refused main request retains successful intervening warm touches.

## 0.4.12

- A side question no longer makes pi-zip think the cache went cold. Extensions such as pi-aside answer a side question on
  the main conversation's cached prefix, which keeps that cache alive, and record the request in the session with Pi's own
  usage entry. pi-zip only counted the main conversation's requests and Pi's idle cache refreshes, so a prompt typed a few
  minutes after an aside, but more than the cache lifetime after the last main reply, was planned as a cold return: it
  rewrote a prefix that was still cached (about $0.70 on a 150K-token session). Now any usage entry in the session counts as
  a cache refresh when it read at least everything the last main reply had cached, on the same provider and model. A smaller
  read, another model's request, or an entry without usage counts for nothing, as before; Pi's own refreshes count as before.
  Expect fewer rewrites after asides. What pi-zip learns about how long your provider keeps its cache now counts from the
  aside too, so a cache an aside kept warm is no longer taken for a provider that keeps its cache longer. pi-zip does not
  depend on pi-aside: it reads only Pi's entry format. Qualifying usage refreshes also count during a long tool call and
  before each survival sample. The background-summary timer rechecks the current deadline and plan when it fires, so a
  recent refresh postpones the call; the idle compaction door likewise rereads the clock and rearms. Missing or empty model
  names never match a response's absent model alias. No new setting, no extra call; src is 5,857 lines (5,865 before).

## 0.4.11

- The session records which pi-zip and Pi versions it ran: a `pi-zip/version` custom entry (`v`, `pi`, `since`), written at
  the end of a run only when the versions differ from the newest such entry on the branch (so a `/tree` move to a point before
  it, or another session in the same process, gets its own entry). It never reaches the model and changes no request. Until
  now a session's pi-zip version could only be guessed from release times, so an offline evaluation could not attribute a
  request to the code that planned it. No extra call; src stays at 5,865 lines.

## 0.4.10

- A slow compaction no longer closes Pi's compaction path for the rest of the process. pi-zip read more than 250 ms between
  asking Pi to compact and its entry going in as another extension's handler at work, and from then on applied no ready summary
  at either door (the idle door, the typed prompt) until Pi restarted. On sessions of 40-55K entries Pi's own work before it asks
  pi-zip's handler took 50-380 ms; on a 553 MB one it passed 250 ms once, and then for 12 hours, 21 returns after the cache expired rewrote the
  whole context with a summary ready, and 19 summaries went unused (about $15-20). The notices of that session record the
  timings (`nativeMs`, `nativeAskMs`). Now another extension's compaction going in, a failure, or a second deadline miss in a
  row (2 s with nothing in) ends the path; a single miss cancels that compaction only, and a compaction that goes in resets the
  count. One constant fewer, no extra call.

## 0.4.9

- Relays that pool accounts keep a session on one account. Pi does not name the conversation in its requests, so a relay
  such as sub2api picked the account from the newest cached text: on one relay 19.5% of typed prompts (and 11% of the
  tool-result requests right after them) lost the whole cache, against 0.65% for the others. pi-zip now adds
  `metadata.user_id` to Anthropic-messages requests that carry none, in Claude Code's legacy form built from the session id
  alone; not for api.anthropic.com or Copilot, and not to a request that already speaks as Claude Code (Pi's OAuth path, a
  `claude-cli` user agent in the headers Pi resolves from models.json). No extra call. An endpoint that refuses the field
  fails one request (Pi does not retry it; one that answered it before, two in a row): the model and its endpoint are then
  remembered in `sticky.json` next to the cache stats and not sent the field again, in any process.
  `PI_ZIP_STICKY=0` is an emergency off switch. See `docs/details.md` (FAQ, relays that pool accounts).
- Some try/catch blocks (`src/run.ts`, `src/recallfile.ts`, `src/placeholder.ts`) use the existing `attempt()` helper (no
  behaviour change).

## 0.4.8

- A zip line's two sizes are on one scale again. Once the request that carried the zip is answered, the size after is its
  real size, but the size before stayed the estimate. When the estimate was off (the first request after a provider switch:
  82K estimated after the zip, 184K real), the line read `93.1K → 184K`, a zip that grew. The size before is now rescaled in
  the same proportion (`209K → 184K`). A summary's size before is Pi's own number (its `Compacted from N tokens`) and is
  kept. Display only.
- `/zip`: a `last` or `errors` time from an earlier day carries its date (a failure from yesterday read as today's).

## 0.4.7

- Pi's compaction path (the idle door and the typed-prompt door) was refused for good in a session that ever held a compaction
  another extension supplied, however old. One live session kept 6 from its first days (an extension removed since), followed by
  158 of pi-zip's: neither door could apply a summary there, so an extension's run after a pause still wrote the whole folded
  context first (152K tokens) and took the summary a turn later. Only the newest compaction an extension supplied counts now:
  when it is another extension's, its `session_before_compact` handler would run for pi-zip's too, and the doors stay shut as before.

## 0.4.6

- A summary that was ready before a run began, and is applied at that run's turn_end, now says "ready while you were away"
  instead of "written while you worked" (mostly runs an extension's message starts).
- New: the idle door (TUI). A run an extension's message starts has no `input` event, so a
  summary prepared for its return waited for the run's first turn_end: the first request rewrote the whole folded context (one
  session: 230K tokens, then the summarized 44K a turn later), and once that request had warmed the cache again the summary
  usually no longer paid and was never applied. The idle door asks the typed-prompt door's decision, unchanged, while Pi is idle:
  when a summary finishes and then at each moment the return's P(warm) changes. A summary it takes goes in through Pi's
  compaction, and the next run, whoever starts it, carries it from its first request. On the recorded sessions of 10-12 to
  10-14 it would have applied 30 summaries those runs wrote around, about 1 % of their spend at list prices. pi-zip makes no
  extra call for it (it applies a summary already written, only once the return's own decision takes it), so it is on, with no setting;
  `PI_ZIP_IDLE_DOOR=0` is an emergency off switch. It opens only after a run of the process (opening a session compacts
  nothing). A slow foreign `session_before_compact` handler is cancelled after the typed door's deadline (2 s), as there, so
  its own summary call is not left to run; text typed in those 2 s comes back to the editor, as at the typed door. Once
  pi-zip has seen a run start (an extension's message), that run waits for the compaction instead, however long another
  handler holds it, and starts on it (checked in a real TUI on Pi 1.1.0 and 1.2.0); that handler's call then runs to its
  end. A run Pi has begun but whose start an earlier extension's handler still delays at the deadline can be aborted.
- Small cleanup: host calls that may throw go through one helper.

## 0.4.5

- A `/model` in the middle of a run no longer makes every later turn look like a model switch. Requests were booked under the model
  the run started with, so after a mid-run switch each turn_end judged the new model's cache cold (P(warm) = 0, where any edit is
  free) and folded one old output per turn, each a full rewrite of the warm cache: on one session 23 rewrites of ~130K tokens in 25
  minutes for 1-15K saved each, under a notice that said "cache warm". Requests now carry the session's current model, and pi-zip
  follows Pi's `model_select`. Replayed on that session, the fixed code makes none of those edits.
- Narratives work on reasoning models that refuse a request without reasoning. pi-ai sends effort "none" when none is asked for;
  gateway's gpt-6.1-sol answers "'none' is not supported", so every narrative on it failed (84 calls in 56 minutes with 0.4.1, a
  skeleton-only summary with 0.4.4). Such a refusal is now asked again once with low effort, and that model gets low effort from
  then on. Checked live on that model.
- The notice's "why" line of a turn_end edit says what that decision assumed: "cache cold · model switched" or "cache likely cold ·
  N min since the last response" when it judged the cache cold, instead of always "cache warm".
- A summary of a stretch with no user request of its own (a run driven by an extension) says "summarized earlier turns", not
  "summarized 0 requests".
- `bench/replay-seq.ts` replays a stretch of a recorded session through this tree, turn by turn, and prints where it would edit
  next to what the live process did.

## 0.4.4

- No more UI stalls on long sessions. Every turn_end and every run start passed each bash command of the whole branch through an
  unanchored regex that looks for recall-file paths (about 40 us a command, quadratic in a long word). On a 32,000-entry session that
  was 0.3 s per turn_end, 0.6 s on a loaded machine, at every tool round. The literal is now checked first: same answers, 15 ms.
- The end of a run (settle) priced up to ~30 plans and read the whole branch and its token scale again for each: 0.16 s, 0.85 s on a
  loaded machine. They are now read once per settle: 13 ms. Session start went from 0.5 s to 0.06 s.
- Decisions are unchanged: same tests, same formal verdicts, and the same ledger on a recorded 32,000-entry session. Two new
  integration checks bound these costs, each with a mutant that re-introduces the old code.

## 0.4.3

- Documentation only; the code is the same as 0.4.2. The README is a quarter of its former length and has no formulas, which
  package pages do not render. The theory (rules, algorithm, claims and proofs, limits) moved to `docs/design.md`, the full
  reference (notices, cache learning, token calibration, recall, coexistence, session entries) to `docs/details.md`.

## 0.4.2

- Summaries work again on long sessions. 0.4.0 and 0.4.1 capped the narrative call at its 4,000-token budget. A real model writes
  more than that when it merges a long previous narrative, CJK text needs about twice the tokens of the chars/4 estimate, and
  reasoning counts against the cap. On one real session every call hit the cap (59 in 3 hours, no compaction) while the context grew
  from 161K to 437K. The call may now write up to 16,000 tokens or the model's own output limit; the budget still sets what it is asked
  for and how it is priced.
- A failed narrative still makes a summary, as in 0.3.1: the deterministic sections, with the previous narrative carried and marked
  as possibly stale. 0.4.0 and 0.4.1 dropped it and called again at every trigger, so a narrative that kept failing kept the session
  from ever compacting. A reply cut at the cap is no longer retried as an identical call. The fallback is final for its cut, as in
  0.3.1: a transient error (overload, network, or a reply slower than the 240 s limit) no longer gets a new call at a later trigger.
- `/zip` shows how many narrative calls failed in this session and why the newest did. A call that threw records its error.
- New checks: integration tests with a provider that cuts a long reply at the cap, three mutants that reintroduce this bug, and a
  release check with a real model on a real session (`formal/live/narrative.sh`). The mutant runner now fails when a mutation site is
  missing; one existing mutant had silently stopped testing anything and is fixed.

## 0.4.1

- The typed-prompt door works again on Pi 1.2.0. A summary that is ready when you type a prompt goes in through Pi's own compaction
  from Pi's `input` event, where Pi 1.1.0 and 1.2.0 are both idle and wait for pi-zip before the run starts. 0.4.0 asked at
  `before_agent_start`, which Pi 1.2.0 counts as busy, so there the first requests of the run carried the whole old history (a cold
  return measured in a real TUI: 147,039 tokens instead of 28,278).
- What the prompt's input decided goes to that prompt's run only. A prompt that starts no run (another extension handles it, the model
  or its credentials are refused) leaves pi-zip as it was; a summary that already went in stays, with its exact "Compacted from" number.
  If another compaction goes in or another model is chosen between the prompt and its run, the run decides afresh. Two inputs that
  overlap ask for at most one compaction.
- A run an extension's message starts on Pi 1.2.0 (which now fires `before_agent_start` for it) begins once, as a driven run.
- All three doors (typed prompt, driven run, mid-run) are checked in a real TUI on Pi 1.1.0 and on Pi 1.2.0, each with Pi's exact
  "Compacted from" number.
- Correction to the 0.4.0 notes: 0.3.1 does not behave the same on Pi 1.2.0; with the door closed it carries the summary in the
  run's own requests.

## 0.4.0

Compared with 0.3.1:

- Five axioms now explain one shared decision: keep originals and recent work, price each edit, prepare slow work in the background, and learn from use. Warm edits use a rent guard: apply when rent pays the rewrite, or when the read savings pay and at least a tenth of the rewrite price has been paid in rent.
- Summaries run in the background in terminal sessions and sub-agents alike. A missing summary leaves the agent free to continue with eligible folds. Only a turn end at the compaction room can wait, 8,192 tokens below Pi's own threshold.
- Finished summaries are saved in the session and survive a restart. Every call stays in the totals, including unused calls and a call still running at exit. The one-unused-call budget and one-summary limit per warm stretch are removed; successive summaries must pay their prices.
- Summaries enter only through Pi's native compaction at a typed idle prompt or as the first draft at a turn end. Driven runs defer them to that boundary. Pi's displayed “Compacted from” number exactly matches the saved before-size at both doors.
- One producer and one production timer replace the separate warm-return path, fixed timer at 80% of the cache lifetime, warming fallback timers and first-key listener. The timer uses learned survival and call time, re-plans on the current branch, and never starts a call merely because an old session was opened.
- Protection and recall remain: the latest two user turns stay out of summaries; eligible previous-turn re-readable outputs may fold after a pause, and outputs at least 60 requests old may fold during long runs. Recalled originals are never folded again.
- The README gives the decision, model-qualified theorems, proof sketches and measured limits. Lean 4 + Mathlib checks the stated T2-T5 parts: 22 proved, one original statement refuted and corrected, zero missing. The remaining claims are paper proofs, supported separately by offline implementation checks. Proof files are excluded from the npm package.
- Known limit on Pi 1.2.0: Pi now counts a starting run as busy during `before_agent_start`, so the typed-prompt door stays closed and a summary ready at a typed prompt enters at the first turn end instead (same summary and exact number; the first requests still carry the old history). Pi 1.1.0 keeps both doors. (Fixed in 0.4.1; the claim that 0.3.1 behaves the same was wrong, see 0.4.1.)

## 0.3.1

- **A warm return's summary starts when the run ends** (rule A). When even a warm return (your next prompt while the cache is
  alive) would summarise, its summary is written in the background as soon as the run ends, not at 0.8 x TTL. A session restarted
  while its cache is alive starts it on the first key of a prompt.
- **No wait for a summary while the cache is warm** (rule B), unless the context is at Pi's compaction room. A finished summary goes
  in through Pi's compaction before the prompt (`Compacted from N` is pi-zip's size before); otherwise the request goes out
  unchanged, the summary is written in the background and a later turn end puts it in.
- At most one background summary started this way goes unused per warm stretch; the away timer replacing one does not count. Once
  it is spent, a warm plan whose cut moved changes nothing until the context reaches Pi's compaction room (no call, no wait).
  Every discarded or lost summary is booked when it is discarded (`pi-zip/unused-summary`), a running one at its estimated input.
- RPC mode (which binds a UI on Pi 1.1) gets these rules too; `-p` and `--mode json` decide as in 0.3.0: session and requests are byte
  for byte those of 0.3.0 with the new summary and placeholder format below.
- **Summaries: one merged narrative.** A summary of an earlier summary reads that summary's narrative next to the new
  conversation and writes one updated narrative (newer values replace older ones, finished todos are dropped), instead of
  carrying the old one as a clipped tail. On a 22-summary session, contradictions fell from 11 to 6 and superseded facts carried
  from 40 to 10. If the call fails, the previous narrative is carried, marked as possibly stale.
- **Summaries: about a third smaller,** with per-section budgets. User requests keep the first ones and the newest verbatim;
  the ones between are shortened (`≈`) and then counted. Recall questions on held-out sessions: 74% → 77% answered directly
  (paired +2.5 pts, 95% CI [−3.7, +8.6]).
- **Rows that can be told apart:** times as local `MM-DD HH:MM` instead of `turn N`; a `cd <dir> &&` prefix shared by every
  command is named once in the heading; look-alike rows show their first differing output line; a JSON document on one line shows
  its key fields (errors and status first).
- Learned cache-survival classes with no samples are dropped unless they were set explicitly.
- Fix: a display-only message an extension posts after the final answer (durable-subagents' "1 workflow was paused" at startup)
  made the plans made before your prompt (first key after a restart, the away timer) cut one turn later than the prompt's own plan,
  so the summary started early was thrown away and you waited for a second one in full. Your prompt joins that message's turn, and
  the early plans now count it so.
- Fix: the ledger's and `/zip` stats' `waitedMs` for a summary computed during the prompt of a session with a prepared plan was 0;
  it is now the time waited. Ledgers of the same session can differ from 0.3.0 there; sessions and requests do not.
- Fix: the warm plan that carries a summary Pi's compaction just put in no longer falls back to a plan on the compacted session
  (`native_mismatch`) when the real prompt comes out smaller than announced.
