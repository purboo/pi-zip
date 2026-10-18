# Local validation: v0.4.9 versus workflow fixes

## Provenance

- Baseline: `031741781fb08a39440e6bd19d2731b2d971774e` (`v0.4.9`).
- Live candidate: `b38aae106b2834956e0206a2ac09c127a8b74c4b`.
- Final implementation: `b45bed8cd329237e6dbdba2b0f8a85c85a9ee8ff`.
- Pi 1.3.0, Bun 1.3.6; exact `openai-codex/gpt-6.1-sol`, reasoning `low`.
- Eight synthetic scenarios, three paired replicates each: 48 episodes, 66 model calls. Same fixture per pair; arm order alternated. No private conversation replay, model substitution, extension installation or npm publishing during validation.
- Published [evidence bundle](workflow-ab-evidence/README.md): all episode metrics, source/harness hashes, local view-comparison record and exploratory failures. Full raw fixtures, views and provider responses remain local and are not included. Aggregates: [workflow-ab-results.json](workflow-ab-results.json). Reproduction and scope: [workflow-ab.md](workflow-ab.md).

Two review-driven planning fixes followed the live run: reserve retained non-user text alongside mandatory user text; precompute encoded user-prefix sizes instead of repeatedly serializing growing prefixes. All **24 final candidate views**, including auxiliary planner fields, were rebuilt from the original fixtures and matched the live views byte-for-byte. The production delta is restricted to `src/plan.ts` and `src/user-text.ts`; recall definitions/execution are unchanged. Local comparison record: [view-equivalence.json](workflow-ab-evidence/view-equivalence.json). This records unchanged tested inputs, not an independent reproduction, a second live campaign or validation of every newly changed cut decision.

## Results

Success means exact graded answer, not subjective quality. Input is the mean **sum of input + cacheRead + cacheWrite across every call in an episode**, rounded here. Latency is the median whole episode in seconds, including tool execution; it is observational, not a controlled performance benchmark.

| Scenario | Correct baseline → candidate | Input baseline → candidate | Latency baseline → candidate |
|---|---:|---:|---:|
| Arc diff unneeded | 3/3 → 3/3 | 47,582 → 7,953 (**−83.3%**) | 3.81 → 2.88 |
| Arc diff needed via recall | 3/3 → 3/3 | 47,598 → 16,031 (**−66.3%**) | 2.61 → 6.77 |
| Arc without exact recall | 3/3 → 3/3 | 47,239 → 47,239 | 2.80 → 2.50 |
| Changed large partial read | 0/3 → 3/3 | 23,380 → 38,430 (**+64.4%**) | 2.49 → 2.74 |
| Hostile regex | 0/3 → 3/3 | 696 → 1,524 | 5.72 → 5.00 |
| Ordinary regex control | 3/3 → 3/3 | 1,483 → 1,521 (**+2.6%**) | 4.99 → 5.89 |
| Long user request | 0/3 → 3/3 | 2,291 → 1,465 | 6.33 → 2.63 |
| Many user requests | 0/3 → 3/3 | 3,630 → 3,048 | 4.90 → 2.30 |

Candidate: **24/24**; baseline: **12/24** on this deliberately targeted smoke sample.

- Arc savings survive counting the extra recall round trip, but retrieval is slower. Without exact recall, the candidate deliberately retains the old output: no savings claimed.
- Historical partial-read correctness costs more context. Small, unchanged, unbounded reads retain the existing verification path; nullable offset/limit are covered by tests.
- All three baseline hostile searches exceeded the external 3-second recall watchdog. Candidate searches completed. Unsupported regex constructs, including repetition, are now explicitly searched **literally**: this intentionally restricts regex compatibility, not a claim that arbitrary JavaScript regex remains supported. The ordinary alternation control stays correct with slightly higher tool-description overhead.
- User cases use the real `buildCut`, at a fixed cut protecting the two latest turns, with a deliberately failed narrative call. The final lossless JSON user section preserves the hidden approval code in both cases. Candidate views grow (4,390 → 6,699 and 6,997 → 14,165 serialized characters), but total episode input decreases here because the baseline makes a futile second recall call. No general compression improvement is claimed for preserving user requests.
- Provider cache hits occurred despite fresh session IDs: 47,104 baseline cache-read tokens in `arc-no-recall`, 7,936 candidate cache-read tokens in `arc-needed`. They are included in the table. Output tokens and cache totals are reported separately in the JSON. Subscription cost metadata is not actual marginal billing.

## Negative evidence retained

The [negative-evidence record](workflow-ab-evidence/negative-evidence.json) preserves these exploratory outcomes, excluded from final aggregates:

- Initial Arc no-recall pilot: optimization removed historical output without exact recall; baseline answered correctly, candidate failed. The exact-recall gate fixes this regression; the final three pairs both pass.
- Initial full campaign: interrupted after eight episodes when the harness's SIGTERM watchdog failed to stop a pathological baseline regex subprocess. Interrupted-episode usage is unknown, not zero or included above. The harness now uses SIGKILL only on its owned disposable subprocess.
- Regex pilot: candidate ordinary-regex episode took about 65 seconds versus baseline about six seconds. The final control remained somewhat slower. No universal latency claim.
- P1 review found underpriced retained non-user text and repeated quadratic user serialization. Both were reproduced and corrected. Actual `buildCut` size is now checked against a concrete planned cut; encoded-size equivalence and 4,000-message operation-count tests cover the linear preprocessing.

## Local validation

- Original installed-host suite: 595 passed, 78 failed, initially due to the changed Pi integration API.
- P1 live-candidate integrated suite: **686 passed, 0 failed**, 19 files; **40 integration mutants caught**; build passed.
- Final follow-up worker suite: **690 passed, 0 failed**, 20 files (raw tool transcript verified). After cherry-pick, the only source/test difference from that tested tree is removal of an inline comment. Final integrated focused validation: **86 passed, 0 failed**; build and whitespace checks passed. The 40-mutant run predates the last planning-only change and was not repeated.
- The no-UI test remains exact: one persisted compaction in each scenario and narrative calls `[1,1,2]`. The cold scenario prepares a second future artifact. This was reproduced on the API-only update before changing its stale expectation; the normalized digest remains checked. No assertions were skipped.

## Limits

This is a bounded synthetic replay with cold-return economics, default 40K target and fixed UNIT calibration, not a longitudinal autonomous-agent experiment, real cache-learning measurement or production Arc execution. User cases do not measure successful live narrative generation. Three pairs per scenario are not statistical evidence of universal quality or speed. Nonstandard tool aliases and complete read/write workflows were not live-benchmarked.

New summaries retain all available user **text** in chronological JSON strings, including duplicates and whitespace, without a length/count budget. Already-clipped legacy text can be restored only when originals exist on the active branch. Image preservation and future model compliance are not guaranteed. Larger mandatory histories can prevent economical compaction or exceed model context capacity; they are not silently truncated. The retained non-user allowance is conservative, not an exact prediction of all future narrative/mechanical output.
