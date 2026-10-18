# Published replay evidence

Small, synthetic-only export of the local campaign described in [the results](../workflow-ab-results.md):

- `episodes.jsonl`: all 48 final episodes, with exact-answer grades, expected/actual answers, usage, call counts, timing, tool-call summaries and fixture/view hashes. Checkout paths are omitted.
- `metadata.json`: original model, source commits/hashes, harness hash, runtime, scenarios and assumptions for each of the four batches. Local checkout/output paths are omitted.
- `view-equivalence.json`: the local comparison of all 24 candidate views before and after the final planning-only fixes. This records the comparison; it is not an independent reproduction.
- `negative-evidence.json`: exploratory failures and the interrupted campaign record, excluded from final aggregates. Unknown interrupted usage is not treated as zero.

Full synthetic fixtures/views and raw provider responses remain local and are not included. Hashes identify those original artifacts, not a portable fixture serialization: generated absolute paths can differ on another machine. The [harness](../workflow-ab.ts) and [instructions](../workflow-ab.md) generate fresh artifacts for reproduction. Live execution requires credentials and consumes quota; no credentials or private conversation history are included here.

Per-episode totals include every model round, including unsuccessful recall attempts. `inputIncludingCache` is `usage.input + usage.cacheRead + usage.cacheWrite`. Aggregates can be recomputed directly from `episodes.jsonl`; candidate success is 24/24 and baseline success 12/24 on this targeted sample. Neither these observations nor the local hashes establish universal quality, speed, cost, or cache behavior.
