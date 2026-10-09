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

## Measured results (v0.2.0)

Live A/B runs on the same coding tasks (4 task templates × 4 seeds, the user away 6 minutes between prompts), paired by task, 95% bootstrap intervals. BC = [billion-context](https://github.com/ranxianglei/billion-context) with its defaults.

| Model | Cost vs BC | Speed | Quality (task done / planted facts recalled) |
|---|---|---|---|
| Claude Sonnet 5.5 | **0.79×** [0.72, 0.86] | p90 wait per prompt 53 s vs 85 s; same as plain Pi | 16/16 and 1.00, same as BC |
| GPT-6.1-sol (14 tasks so far) | 1.00× [0.91, 1.09] | median task 197 s vs 293 s | 14/14 and 1.00 vs 13/14 and 0.96 |

Against plain Pi on the same Claude runs: same speed, 0.45× the cost. Hidden-question probes on real long sessions (questions whose answer had been folded): 45–52% answered from the original via `zip_recall` vs 5% for BC's reconstruction, same number of wrong answers.

Known limits:

- **GLM** (automatic prefix cache that outlives its declared 5 minutes): v0.1 cost about 1.2× BC live. v0.2 learns the real cache lifetime and folds the previous turn after the declared TTL (offline 0.95–0.97× v0.1), but this was not verified live.
- **Long autonomous runs** (one prompt, hundreds of tool calls, e.g. sub-agents): roughly on par with BC, not better. Outputs are only folded inside a running turn once they are 60 requests old.
- **Tool allowlists** (`pi --tools read,bash`, and sub-agent launchers that pass one): Pi then hides `zip_recall`, so pi-zip folds only outputs the model can re-read (files, read-only commands) and the placeholder says to re-read. Add `zip_recall` to the list to get full folding.
- If you always answer within the cache lifetime, there is little to save, by design.

## What you see

At most one line per turn, only when something was folded:

```
pi-zip · folded 12 old outputs · 84.2K → 31.5K tokens · 0.9 ms · originals recallable
pi-zip · summarized 64 requests · 182K → 41K tokens · 8.4 s (done while you were away)
```

The line goes to the UI only; it never enters the model's context. Nothing else is added to the screen.

## The three rules

1. **Nothing is lost.** The session file stays the single source of truth. pi-zip only changes the view sent to the model, never deletes anything. User messages, tool-call arguments, the system prompt, tool definitions and thinking are never rewritten. Every folded block carries a handle and shows its key lines (errors, ids, first and last line).
2. **Edit only when the cache is already gone.** Provider prompt caches expire (the model's declared TTL, usually minutes). Changing the context while the cache is warm means paying to rewrite it; changing it after it expired is free, because the whole context is rewritten anyway, and a smaller context makes that rewrite cheaper. So when you come back after the TTL (or after switching model, or when the session was last touched longer ago than the TTL), pi-zip folds old outputs down to about 40K real tokens in one step, and every request of that turn sends the same bytes. While the cache is warm it does nothing, with one exception, the warm valve: above the 40K target it applies that plan, minus the previous user turn (a warm edit never folds the turn you just finished, except when you come back after the declared TTL: there the previous turn is eligible exactly as at a cold return, so a provider whose cache outlives its TTL does not keep it at every return), when the edit pays for the rewrite it causes, and never on the request right after an edited one (no back-to-back warm rewrites). That is one inequality, r Δ²/(2g) + η Δ ≥ K with K = (w − r)(P T − (1 − P) Δ): the reads the removed Δ tokens would cost while the context grows back at g tokens per request (measured in the session), plus, near Pi's compaction trigger, what Pi would charge for the same room (η), against the rewrite of the T = A tokens left after the edit (pricing only the suffix after the earliest edit fires warm edits earlier and lost quality in the offline evaluation; the suffix is logged as `Tsuf` for measurement). r and w are the read and rewrite price ratios of the cache class, never the model's price table: explicit write premium 0.1 / 1.25 x input (2 x on the 1-hour tier), automatic prefix cache 0.2 / 1 x input; the class is read from the provider's usage reports, and until the first response the old fixed rule applies. P is the probability that the cache is still warm. A cold return is P = 0, so K < 0 and it always fires; a single small fold never pays at a warm cache, a large one does.
3. **Never in the way.** Planning is local and takes milliseconds. Anything that needs a model call (a summary, only when folding is not enough and the same inequality prices the extra model call in) is prepared while you are away: if the cache is about to expire (0.8 x its lifetime after your last request) and you have not come back, a background timer writes the summary with a separate, uncached call. The timer is cancelled the moment you send a prompt. If you return before the summary finishes, only the remaining time is waited, Esc stops the waiting, and the notice says so. If you return while the cache is still warm and the valve does not fire, the prepared summary is discarded (its cost is still counted). In non-interactive modes (`-p`, `--mode json`) nothing is ever started in the background: a cold return that needs a summary computes it right then.

**The cache lifetime is learned, not configured.** Every response says how much of the prompt came from the cache. pi-zip compares that read with what the request re-sent unchanged (the previous prompt, or the untouched prefix before one of its own edits: on an automatic prefix cache every edit leaves the first 8K tokens alone, so even the response right after a fold says whether the cache survived) and so learns, per provider and model, whether the cache survived a gap of that length: a few counts per gap bin (30 s to 90 min, with bin edges on the 5-minute and 1-hour tiers), monotone in the gap, older evidence halved after 16 newer observations of the same bin, stored without any content in `~/.pi/agent/pi-zip/cache-survival.json`. Before any evidence the model's declared TTL decides, exactly as before (300 s when it declares none; too short a guess is cheaper than too long); beyond it one clean read overrides it, inside it a lone miss counts as noise (warm caches do miss now and then) and only repeated misses do. A GLM cache read in full after 365 s makes the next 365 s return warm; a Claude 5-minute cache that read nothing after 360 s stays dead. Whether the provider bills cache writes (explicit cache) or not (automatic prefix cache) is read from the first response too. `/zip status` shows the class, its price ratios, and the learned survival per bin with its sample count.

Protected from folding: the current user turn and the previous one. When the context is above the target, re-readable outputs of the previous turn (an unchanged file, a read-only command) can still be folded at a cold return or at any return after the declared TTL (never on a warm request inside it), and any output in either turn can be folded once it is 60 assistant requests old (so a long agent run that is a single user turn with hundreds of tool calls is not exempt from folding; the newest 59 requests' outputs always stay, and every fold stays recallable). Messages you type while the agent is running (steering, follow-up) belong to that turn and do not start a new one. Outputs you have already recalled, and `zip_recall` results themselves, are never folded again. "Read-only" is a conservative whitelist: `find -delete` or `-exec`, command substitution, redirects, background jobs, `git diff --output` and the like are not.

**Token counts are calibrated, not guessed.** Sizes are estimated as chars/4, which undercounts real tokens (typically by about 1.7x in coding sessions). So the cold cap, the compaction room and the law's token counts are all compared against `k` x the estimate, where `k` = real tokens / estimated tokens for the newest assistant message that reports usage (input + cache read + cache write, over the estimate of the context that request carried; clamped to 1 to 2.5). `k` is read from the session itself on every decision, so a restart, `pi -p` or a resumed session calibrates exactly like a long-lived one, and nothing extra is stored. With no usage to read (a brand-new session, or a provider that reports none) `k` is 1.7. Sizes in the notices, `/zip stats` and the ledger use the same scale.

The cold cap is kept below Pi's own compaction trigger (window minus `compaction.reserveTokens`), so on small windows Pi's lossy compaction does not get there first.

## Commands

| Command | Effect |
|---|---|
| `/zip status` | on / off / paused, cache TTL, what this session has folded, summarised and recalled, learned cache survival |
| `/zip stats` | this session's folds (with tokens removed), summaries and recalls; persisted in the session, so a restart does not reset them |
| `/zip off` | strict no-op: no folds, no summaries, requests left untouched (earlier folds stay recallable) |
| `/zip on` | resume |
| `/zip quiet` | toggle the per-turn notice (folding continues) |

`off` and `quiet` are remembered per session.

## Recall

A folded block says what produced it (tool, command or path with offset/limit, user turn, exit status and test counts for commands), its size, a handle and its key lines, so look-alike runs stay apart. It also tells the model to prefer `zip_recall` (original bytes, instant, free, no side effects) over re-running or re-reading, because a re-run may give a different result:

```
[folded by pi-zip · bash bun test test/api.test.ts · turn 12 · exit 1, 79 passed, 2 failed · 5637 chars, 109 lines · handle k3f9a0x1qz]
key lines kept (original line numbers; up to 8):
1: (pass) suite 0 > case parse config ...
106: 2 fail
109: Command exited with code 1
Original kept byte for byte, recallable even after summaries or compaction: zip_recall("k3f9a0x1qz") (optional grep/range) is instant, free, no side effects; prefer it to re-running or re-reading (output may differ). Do not guess its content.
```

Placeholders are written once, when the fold is saved: sessions folded by an earlier version keep their old placeholder text unchanged. Summaries list each folded output with its handle, turn and outcome in the same way. A summary of an earlier summary merges it section by section (requests, files, commands, other calls, errors, handle table, handle index) instead of clipping its text: items are deduplicated, the oldest are dropped first under a per-section budget with a count of what was left out, and the previous narrative survives as a short tail excerpt. Pi's own free-text compaction summaries are carried as a head-and-tail excerpt.

The model recalls by itself when it needs the content:

```
zip_recall({ handles: ["k3f9a0x1qz", "m2b7c4d8ww"] })
zip_recall({ handle: "k3f9a0x1qz", grep: "ERROR|FAIL" })
zip_recall({ handle: "k3f9a0x1qz", range: "120-240" })
```

Recall is batched, exact, and also works for outputs from before a compaction or a pi-zip summary (summaries carry a handle table and a budgeted index of older handles). Output comes back in pages of 20,000 characters; the page says how to continue:

```
zip_recall({ handle: "k3f9a0x1qz", offset: 20000 })               // next page, by characters
zip_recall({ handle: "k3f9a0x1qz", offset: 20000, limit: 50000 }) // up to 50,000 characters per page
```

Paging is by characters, so even one 45,000-character line can be read in full, and the pages add up to the original byte for byte. `offset` and `limit` also page a `grep` or `range` selection. `grep` is a case-insensitive regular expression; patterns that could backtrack badly (nested quantifiers, quantified alternation, back-references, very long patterns) are searched as literal text instead.

## Coexistence

If another extension that manages context is loaded (for example billion-context, magic-context, pi-smart-compact, pi-hot-compact, pi-context-prune), pi-zip pauses folding, says so once, and keeps only its request guard. Two writers on the same view give unpredictable results. `/zip status` shows `paused`.

The guard has two parts. Before saving a fold or a summary it checks that the edit itself would not leave a tool result without its tool call (failed or aborted assistant turns, which the provider layer drops anyway, are ignored, as is any oddity the session already had). And before a request is sent it repairs a tool result that lost its tool call, instead of letting the provider reject the request and brick the session. The repair understands the request shapes of Pi's Anthropic, OpenAI chat completions (and Mistral), OpenAI Responses (Azure, Codex), Google Gemini/Vertex and Bedrock Converse providers; a request of any other shape is passed through untouched.

## FAQ

**Will it save money?** Mostly on cold returns, which is where a long session pays for a full cache rewrite. While the cache is warm it edits only when the inequality above says the rewrite pays back (large contexts, near Pi's compaction trigger, outputs 60+ requests old). `/zip stats` shows what this session has folded (and roughly how many tokens that removed), its summaries with what their model calls cost, and its recalls. The numbers live in the session file, so a restart does not reset them.

**Does it cost extra?** Planning is free. A summary is one extra model call (the current model, no tools, no prompt cache), shown in `/zip stats`. A background summary you never use (you came back while the cache was warm) is counted there too. Recalled content re-enters the context at normal prices.

**Can the model lose information?** Folded outputs are replaced by a placeholder with key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your requests verbatim and never paraphrase the model's reasoning. If the model ignores the handle and guesses, that is a model failure pi-zip cannot catch; this is why only re-readable outputs of the previous turn are folded at a cold return; other outputs of the protected turns wait until they are 60 requests old.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries, projected per branch by Pi; the originals stay in the session file.

**Which providers?** Anything Pi supports. The cache TTL comes from the model's `promptCache` declaration (seconds) for the tier Pi uses (`short`, or `long` when `PI_CACHE_RETENTION=long`), falling back to 5 minutes. Pi's own idle cache refreshes count as a cache touch, and a different provider or model than the last request counts as cold. Providers that do not report cache usage still work; the stats are then estimates only.

Some relays rewrite `cache_control`, so the TTL actually written can differ from the one requested. pi-zip checks `usage.cacheWrite1h` (reported by the Anthropic messages API and Bedrock) on the newest few assistant messages of the current model: if you requested 1h but the provider wrote 5m, it uses the 5m TTL (and the reverse, when the model declares a 1h tier), and says so once per session unless `/zip quiet` is on. Without that field it keeps the declared TTL. `PI_ZIP_TTL_SECS` still wins.

Some relays reject `PI_CACHE_RETENTION=long` with 400 `a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`, because they inject their own 5m `cache_control`. That is a provider issue: unset the variable.

## Testing

```bash
bun test                                                                   # unit + invariant tests + integration with Pi itself
bun run build-check                                                        # bundles src/index.ts with Pi's packages external
```

`test/pi-integration.test.ts` runs the extension through Pi's real session manager, extension loader and `emitContext`, with a mid-conversation system update and an aborted tool-call turn in the session, and checks that the request is byte-identical before and after turn_end persists the edits.

Environment overrides exist for tests only and are not part of the product surface: `PI_ZIP_TTL_SECS` (cache TTL), `PI_ZIP_COLD_CAP` (fold target in tokens, default 40000), `PI_ZIP_FOLD_MIN` (smallest output worth folding, default 500 tokens), `PI_ZIP_KEEP_LINES`, `PI_ZIP_MIN_GAIN` (summary gain floor of the legacy rule used only when nothing is known about prices, default 10000), `PI_ZIP_INTURN_AGE` (age in assistant requests from which any output of the protected turns may fold, default 60; 0 = never), `PI_ZIP_CACHE_STATS=<path>` (where the learned cache survival lives; benches isolate it), `PI_ZIP_OFF=1` (register nothing), `PI_ZIP_LEDGER=<path>` (append a JSON line per decision; `prompt` records `ttlMs` and `ttlSource`, `declared` or `observed`; including the summary call's token usage; `cold_plan` records the calibration as `k`, `calReal`, `calEst`, `calSource`, next to the scaled `ctxBefore` and `ctxAfter`; `prompt` also records `gapS`, `pWarm`, `survSrc` and `cls`; `law` records every evaluation with `g`, `wr` (w/r), `pWarm`, `survSrc`, `prSrc` and per step `B`, `A`, `T` (= A), `Tsuf` (the suffix after the earliest edit, measurement only), `phi`, `K`, `eta`; `b2b_skip` marks a warm edit skipped right after an edited request; `cache_sample` records each learned survival observation).

Internally, `RELAX_PREV_TURN` in `src/plan.ts` selects whether re-readable outputs of the previous user turn may be folded on a cold return or a return after the declared TTL (default `true`; other warm plans never fold them).

## License

MIT
