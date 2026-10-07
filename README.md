# pi-zip

Keeps long [Pi](https://github.com/earendil-works/pi) sessions cheap without losing anything.

pi-zip folds old tool output out of the context **only when the prompt cache has already gone cold**, so the edit costs nothing extra, and every folded output can be fetched back byte for byte. No configuration, no proxy process, no footer.

## Install

```bash
pi install npm:pi-zip
# or
pi install git:github.com/purboo/pi-zip
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
2. **Edit only when the cache is already gone.** Provider prompt caches expire (the model's declared TTL, usually minutes). Changing the context while the cache is warm means paying to rewrite it; changing it after it expired is free, because the whole context is rewritten anyway, and a smaller context makes that rewrite cheaper. So when you come back after the TTL (or after switching model, or when the session was last touched longer ago than the TTL), pi-zip folds old outputs down to about 60K tokens in one step, and every request of that turn sends the same bytes. While the cache is warm it does nothing, with one exception, the warm valve: above V = min(160K, 80% of the window, window minus Pi's compaction reserve minus a margin) tokens it applies that same plan, because by then every later request pays to read the oversized context.
3. **Never in the way.** Planning is local and takes milliseconds. Anything that needs a model call (a summary, only when folding is not enough and it removes at least 10K tokens and 15% of the context) is prepared while you are away: if the cache is about to expire (0.8 x its lifetime after your last request) and you have not come back, a background timer writes the summary with a separate, uncached call. The timer is cancelled the moment you send a prompt. If you return before the summary finishes, only the remaining time is waited, Esc stops the waiting, and the notice says so. If you return while the cache is still warm and the context is below V, the prepared summary is discarded (its cost is still counted). In non-interactive modes (`-p`, `--mode json`) nothing is ever started in the background: a cold return that needs a summary computes it right then.

Protected from folding: the current user turn and the previous one (the previous turn's outputs can still be folded when they are re-readable, for example an unchanged file or a read-only command, and the context is above the target). Messages you type while the agent is running (steering, follow-up) belong to that turn and do not start a new one. Outputs you have already recalled, and `zip_recall` results themselves, are never folded again. "Read-only" is a conservative whitelist: `find -delete` or `-exec`, command substitution, redirects, background jobs, `git diff --output` and the like are not.

The cold cap and V are kept below Pi's own compaction trigger (window minus `compaction.reserveTokens`), so on small windows Pi's lossy compaction does not get there first.

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

Recall is batched, exact, and also works for outputs from before a compaction or a pi-zip summary (summaries carry a handle table). Output comes back in pages of 20,000 characters; the page says how to continue:

```
zip_recall({ handle: "k3f9a0x1qz", offset: 20000 })               // next page, by characters
zip_recall({ handle: "k3f9a0x1qz", offset: 20000, limit: 50000 }) // up to 50,000 characters per page
```

Paging is by characters, so even one 45,000-character line can be read in full, and the pages add up to the original byte for byte. `offset` and `limit` also page a `grep` or `range` selection. `grep` is a case-insensitive regular expression; patterns that could backtrack badly (nested quantifiers, quantified alternation, back-references, very long patterns) are searched as literal text instead.

## Coexistence

If another extension that manages context is loaded (for example billion-context, magic-context, pi-smart-compact, pi-hot-compact, pi-context-prune), pi-zip pauses folding, says so once, and keeps only its request guard. Two writers on the same view give unpredictable results. `/zip status` shows `paused`.

The guard has two parts. Before saving a fold or a summary it checks that the edit itself would not leave a tool result without its tool call (failed or aborted assistant turns, which the provider layer drops anyway, are ignored, as is any oddity the session already had). And before a request is sent it repairs a tool result that lost its tool call, instead of letting the provider reject the request and brick the session. The repair understands the request shapes of Pi's Anthropic, OpenAI chat completions (and Mistral), OpenAI Responses (Azure, Codex), Google Gemini/Vertex and Bedrock Converse providers; a request of any other shape is passed through untouched.

## FAQ

**Will it save money?** Only on cold returns, which is where a long session pays for a full cache rewrite. If you always answer within the cache TTL, pi-zip does nothing by design. `/zip stats` shows an estimate based on the model's declared prices: avoided cache writes and reads, minus summary calls, minus the cost of content you recalled. It is an estimate (token counts are chars/4), and it can be negative.

**Does it cost extra?** Planning is free. A summary is one extra model call (the current model, no tools, no prompt cache), shown in `/zip stats`. A background summary you never use (you came back while the cache was warm) is counted too. Recalled content re-enters the context at normal prices.

**Can the model lose information?** Folded outputs are replaced by a placeholder with key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your requests verbatim and never paraphrase the model's reasoning. If the model ignores the handle and guesses, that is a model failure pi-zip cannot catch; this is why re-readable outputs are folded more readily than the ones that cannot be re-created.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries, projected per branch by Pi; the originals stay in the session file.

**Which providers?** Anything Pi supports. The cache TTL comes from the model's `promptCache` declaration (seconds) for the tier Pi uses (`short`, or `long` when `PI_CACHE_RETENTION=long`), falling back to 5 minutes. Pi's own idle cache refreshes count as a cache touch, and a different provider or model than the last request counts as cold. Providers that do not report cache usage still work; the stats are then estimates only.

## Testing

```bash
bun test                                                                   # unit + invariant tests + integration with Pi itself
bun run build-check                                                        # bundles src/index.ts with Pi's packages external
```

`test/pi-integration.test.ts` runs the extension through Pi's real session manager, extension loader and `emitContext`, with a mid-conversation system update and an aborted tool-call turn in the session, and checks that the request is byte-identical before and after turn_end persists the edits.

Environment overrides exist for tests only and are not part of the product surface: `PI_ZIP_TTL_SECS` (cache TTL), `PI_ZIP_COLD_CAP` (fold target in tokens, default 60000), `PI_ZIP_FOLD_MIN` (smallest output worth folding, default 500 tokens), `PI_ZIP_KEEP_LINES`, `PI_ZIP_MIN_GAIN` (summary gain floor, default 10000), `PI_ZIP_OFF=1` (register nothing), `PI_ZIP_LEDGER=<path>` (append a JSON line per decision, including the summary call's token usage).

Internally, `RELAX_PREV_TURN` in `src/plan.ts` selects whether re-readable outputs of the previous user turn may be folded on a cold return (default `true`).

## License

MIT
