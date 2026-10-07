# pi-zip

Keeps long [Pi](https://github.com/earendil-works/pi) sessions cheap without losing anything.

pi-zip folds old tool output out of the context **only when the prompt cache has already gone cold**, so the edit costs nothing extra, and every folded output can be fetched back byte for byte. No configuration, no proxy process, no footer.

## Install

```bash
pi install npm:pi-zip
# or
pi install git:github.com/<owner>/pi-zip
```

Try it for one run without installing: `pi -e npm:pi-zip`.

## What you see

At most one line per turn, only when something was folded:

```
pi-zip · folded 12 old outputs · 84.2K → 31.5K tokens · 0.9 ms · originals recallable
pi-zip · summarized 64 requests · 182K → 41K tokens · 8.4 s (done while you were away)
```

The line goes to the UI only; it never enters the model's context. Nothing else is added to the screen.

## The three rules

1. **Nothing is lost.** The session file stays the single source of truth. pi-zip only changes the view sent to the model, never deletes anything. User messages, tool-call arguments, the system prompt, tool definitions and thinking are never rewritten. Every folded block carries a handle and shows its key lines (errors, ids, first and last line).
2. **Edit only when the cache is already gone.** Provider prompt caches expire (the model's declared TTL, usually minutes). Changing the context while the cache is warm means paying to rewrite it; changing it after it expired is free, because the whole context is rewritten anyway, and a smaller context makes that rewrite cheaper. So when you come back after the TTL, pi-zip folds old outputs down to about 60K tokens in one step, and every request of that turn sends the same bytes. While the cache is warm it does nothing, unless the context passes 80% of the window (fold) or 85% (summarise), where the alternative is Pi's lossy compaction.
3. **Never in the way.** Planning is local and takes milliseconds. Anything that needs a model call (a summary, only when folding is not enough and it removes at least 10K tokens and 15% of the context) is prepared in the background while you are away. If you return before it finishes, only the remaining time is waited, and the notice says so.

Protected from folding: the current user turn and the previous one (the previous turn's outputs can still be folded when they are re-readable, for example an unchanged file or a read-only command, and the context is above the target). Outputs you have already recalled are never folded again.

## Commands

| Command | Effect |
|---|---|
| `/zip status` | on / off / paused, cache TTL, totals |
| `/zip stats` | tokens folded, estimated $ saved versus doing nothing, summaries, recalls |
| `/zip off` | strict no-op: no folds, no summaries, requests left untouched (earlier folds stay recallable) |
| `/zip on` | resume |
| `/zip quiet` | toggle the per-turn notice (folding continues) |

`off` and `quiet` are remembered per session.

## Recall

Folded blocks tell the model how to get the original back, and it does so by itself when it needs the content:

```
zip_recall({ handles: ["k3f9a0x1qz", "m2b7c4d8ww"] })
zip_recall({ handle: "k3f9a0x1qz", grep: "ERROR|FAIL" })
zip_recall({ handle: "k3f9a0x1qz", range: "120-240" })
```

Recall is batched, exact, and also works for outputs from before a compaction or a pi-zip summary (summaries carry a handle table). Large outputs come back in pages; use `grep` or `range` for the rest.

## Coexistence

If another extension that manages context is loaded (for example billion-context, magic-context, pi-smart-compact, pi-hot-compact, pi-context-prune), pi-zip pauses folding, says so once, and keeps only its request guard. Two writers on the same view give unpredictable results. `/zip status` shows `paused`.

The guard repairs a tool result that lost its tool call before a request is sent, instead of letting the provider reject the request and brick the session.

## FAQ

**Will it save money?** Only on cold returns, which is where a long session pays for a full cache rewrite. If you always answer within the cache TTL, pi-zip does nothing by design. `/zip stats` shows an estimate based on the model's declared prices: avoided cache writes and reads, minus summary calls, minus the cost of content you recalled. It is an estimate (token counts are chars/4), and it can be negative.

**Does it cost extra?** Planning is free. A summary is one extra model call (the current model, no tools), shown in `/zip stats`. A background summary you never use (you came back while the cache was warm) is counted too. Recalled content re-enters the context at normal prices.

**Can the model lose information?** Folded outputs are replaced by a placeholder with key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your requests verbatim and never paraphrase the model's reasoning. If the model ignores the handle and guesses, that is a model failure pi-zip cannot catch; this is why re-readable outputs are folded more readily than the ones that cannot be re-created.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries, projected per branch by Pi; the originals stay in the session file.

**Which providers?** Anything Pi supports. The cache TTL comes from the model's `promptCache` declaration (seconds), falling back to 5 minutes. Providers that do not report cache usage still work; the stats are then estimates only.

## Testing

```bash
bun test                                                                   # unit + invariant tests
bun build src/index.ts --target=node --external '@earendil-works/*'        # build check
```

Environment overrides exist for tests only and are not part of the product surface: `PI_ZIP_TTL_SECS` (cache TTL), `PI_ZIP_COLD_CAP` (fold target in tokens, default 60000), `PI_ZIP_FOLD_MIN` (smallest output worth folding, default 500 tokens), `PI_ZIP_KEEP_LINES`, `PI_ZIP_MIN_GAIN` (summary gain floor, default 10000), `PI_ZIP_OFF=1` (register nothing), `PI_ZIP_LEDGER=<path>` (append a JSON line per decision).

Internally, `RELAX_PREV_TURN` in `src/plan.ts` selects whether re-readable outputs of the previous user turn may be folded on a cold return (default `true`).

## License

MIT
