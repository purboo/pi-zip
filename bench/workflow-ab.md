# Workflow A/B replay

`workflow-ab.ts` compares two checkout trees using the exact `openai-codex/gpt-6.1-sol` model, low reasoning, synthetic history only. It never runs model-proposed shell commands. File reads are restricted to generated fixture files; recall executes in an externally killable subprocess.

```sh
bun bench/workflow-ab.ts --baseline /path/to/v0.4.9 --candidate /path/to/candidate --out /tmp/pi-zip-ab-dry --reps 1
bun bench/workflow-ab.ts --baseline /path/to/v0.4.9 --candidate /path/to/candidate --out /tmp/pi-zip-ab-live --reps 3 --live
```

The default is dry-run. Live execution requires existing Pi credentials, makes real provider calls and consumes subscription quota or API credits. There is no model fallback. Choose a new output directory for each run. `--scenarios` accepts a comma-separated subset.

## Scenarios

| Scenario | Required evidence |
|---|---|
| `arc-unneeded` | A large previous-turn diff is not needed for the next task; answer remains correct while fewer input tokens are sent. |
| `arc-needed` | Retrieve an exact hidden value from that old diff; include all recall/model follow-up tokens. |
| `arc-no-recall` | The working copy changed and no exact recall mechanism exists; optimization must not remove the old diff. |
| `changed-large-read` | The previous partial read came from a file >2 MB, since modified at the same size; return the historical value, never the new value. |
| `regex-hostile` | Execute the requested `a+a+$` query over a 100K-character nonmatching line; finish, or record an external-watchdog timeout. |
| `regex-control` | Ordinary `ERROR|FAIL` alternation must retain its matching semantics. |
| `user-long` | A condition in the middle of a long user request must survive even if the narrative call fails. |
| `user-many` | An intermediate request among 40 user messages must retain its exact approval code. |

Each replicate uses a fresh historical value. Both arms share the exact fixture, prompt, task grader and tool definitions except for the package's own recall definition. Order alternates by scenario and replicate. Each episode has a fresh session ID and records cache reads rather than assuming caching is disabled. Provider exceptions, truncation and timeouts remain in the artifacts; provider failures stop the campaign rather than silently changing models or rerunning successes.

`metadata.json` records source commits and hashes, harness hash, model, runtime and assumptions. Per-episode files preserve fixtures, planned views, raw model responses, usage and tool results. `results.jsonl` contains compact metrics. Inspect tool calls as well as the exact-answer score: a correct guessed answer is weaker evidence than retrieval of the actual original.

## Interpretation limits

This is a bounded replay experiment, not an end-to-end session benchmark. It exercises the real planner at the default 40K target with the automatic-cache class and a cold return, using the same fixed `UNIT` token calibration for both arms. It does not reproduce cache learning, warm returns, long autonomous runs, background summaries or TUI scheduling; integration tests cover those separately. The `user-*` cases exercise the real `buildCut` at a fixed cut before the two protected turns, with an explicitly injected narrative-provider failure. They isolate deterministic user-text retention: GPT-6.1-sol answers from the resulting fallback summary. They do not measure successful narrative generation or its cost.

Three paired replicates per scenario are a smoke/regression sample, not proof of universal quality or latency improvements. Report failures and increased input costs alongside savings. Sum `input + cacheRead + cacheWrite` across all model calls; report output and cache usage separately. Subscription `cost` metadata is not marginal billing evidence. External watchdogs protect the benchmark from baseline hangs; they are not functionality present in the baseline package.

The baseline can clip user requests, and `zip_recall` only retrieves tool outputs. User-text preservation is checked independently of tool-output recall; this is not a guarantee that a model will obey every preserved instruction or that images are losslessly summarized.
