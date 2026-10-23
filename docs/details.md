# pi-zip reference

Everything the [README](../README.md) leaves out: what each line means, how the cache lifetime and token sizes are measured,
recall paging and recall files, other extensions, and what pi-zip writes into the session. The decision rule and its proofs are in
[design.md](design.md).

## What you see

One mark, ƶ, and three words: **zipped**, **unzip**, **summarized**. Only the new context size is bright. At most one line per turn, at the top of the turn, only when the context was zipped or summarized:

```
ƶ zipped 12 old outputs   74K → 43K   6 ms
  originals are kept · the model can unzip any of them
ƶ summarized 64 requests   182K → 41K   38.2 s · ready while you were away
```

The second line appears once per session. A summary that made you wait (only at Pi's compaction room) says so (`waited 8.4 s`, highlighted from 2 s on); one written in the background while the agent kept working says `written while you worked`. Click the line (or expand tool output with ctrl+o) to see what was zipped and why now (a cold return says `cache cold · away 47 min` or `cache cold · model switched`, a warm edit `cache warm · worth it at this size`):

```
ƶ zipped 12 old outputs   74K → 43K   6 ms
  bash npm test         14K   k3x9q2m7ab
  read src/payment.ts  9.1K   p8d2x1qa0m
  … 10 more
  cache cold · away 47 min
```

These lines are saved in the session, so they are still there after a restart, but they are never sent to the model. On narrow terminals the time goes first, then the words; the numbers always stay. A summary still shows up as Pi's own `[compaction]` block as well; the ƶ line next to it tells you who made it. The ƶ sizes use calibrated provider tokens, the same scale as Pi's context meter (which adds the newest reply's output). Once the request that carried the change has been answered, the size after is that request's real size. For a line that only zipped outputs, the size before (an estimate) is rescaled in the same proportion, so a misjudged estimate (the first request after a provider switch, say) no longer shows a zip that grew; a summary's size before stays Pi's own number. Pi's `Compacted from N tokens` is exact for Pi's own before-size at either summary door: a native compaction while Pi is idle at a typed prompt, or the first compaction draft at a turn end. pi-zip records that same before-size. Its calibrated planning estimate can differ from Pi's meter; exact agreement between the displayed number and the saved compaction does not make the token estimate exact.

A zipped output keeps its place in the transcript; its tool row gets a dim mark, so you can see what the model no longer sees in full:

```
 $ npm test  ƶ zipped
 read src/payment.ts  ƶ zipped
```

When the model fetches an original back, it looks like any other tool row and names what came back (ctrl+o shows the text):

```
 ƶ unzip bash npm test  /Expected/
 3 of 812 lines
```

Everything else uses the same grammar, and only when something changed:

```
ƶ pi-zip  on  older context gets zipped when the savings pay for the rewrite · /zip
ƶ pi-zip  on  a tool allowlist hides zip_recall · zipped outputs are read back from files in ~/.cache/pi-zip/recall
ƶ pi-zip  reread-only  a tool allowlist hides zip_recall · only re-readable outputs fold · allow zip_recall, read, grep or bash to fold more
ƶ pi-zip  paused  billion-context also manages context, so pi-zip only guards requests · to use pi-zip: pi remove the other one
```

The first one appears once per machine. At the compaction room, Pi's working line explains that the context is close to the window while the summary finishes. Everywhere else the agent continues while production runs in the background. `/zip` prints a small card into the transcript:

```
ƶ pi-zip  on
  model    zhipu/glm-5.3
  cache    each dot is one time you came back
                      6     5
               ●      ●     ●   ●
               ●      ●     ●   ●  ●
               ●      ●     ●   ●  ●   ● still there  19
           ━━━━━━━━━━━━━━━━┅┅┅┅┅┅┅┅┅┅───────────────────────────────────
                      ○         ○  ○ ○   ○    ○   ○   ○   ○   ○   ○  ○   ○ gone  74
                                   ○     ○    ○   ○   ○   ○   ○   ○  ○
                                         ○    ○   ○   ○   ○   ○   ○  ○
                                         ○    12  7   9   15  6   11 5
  away     30s     1m     2m        5m      10m         30m    1h     2h
           under 2 min: usually still there  ·  2–5 min: not sure yet  ·  over 5 min: gone
  session  30 zipped ~310K  ·  8 summaries $1.75  ·  2 unzips
  last     15:22  zipped 1 old output in 4 ms · cache cold · away 13 min
```


ƶ (U+01B6) is a plain Latin letter, one column wide everywhere, CJK terminals included. Most coding fonts have it; where one does not (Hack, Source Code Pro), the terminal draws it from a fallback font.

The chart shows how likely the cache is to survive a return. That probability prices the rewrite: edits need larger savings while the cache is warm; when it is certainly gone, eligible folds add no rewrite cost. Across (`away`) is how long you were gone, from 30 s to 2 h on a log scale. Every dot is one time you came back after that long: a filled dot above the axis is a time the cache was still there, an empty one below it a time it was gone, so the picture is your own history with this model, and a few gone samples take only a row or two. A column shows at most 4 dots a side; beyond that it shows 3 dots and the number at the far end of the stack (`12` = twelve times in that gap range). The axis is solid up to the longest gap that was (nearly) always safe, dashed while it is not sure, thin after it is mostly gone; the sentence under it says the same in words (`usually still there` when even the safe part had some misses). The counts are the learned ones, kept with older evidence halved after 16 newer observations of the same gap range, so they can be a little below the number of times you actually came back. Until something is learned there is no chart, one line only (`expires after ~5 min idle · a chart appears once you come back after a break`, from the cache lifetime the requests ask for). The chart needs 72 columns; where the legend does not fit beside it, it moves to one line under it, and in a narrower terminal only the sentence is shown. Notices state facts (how long you were away), not guesses: whether the cache really had expired is read from the provider's reply afterwards, so a wrong guess is not repeated.
## Learning and token counts

**The cache lifetime is learned, not configured.** Every response says how much of the prompt came from the cache. pi-zip compares that read with what the request re-sent unchanged (the previous prompt, or the untouched prefix before one of its own edits: on an automatic prefix cache every edit leaves the first 8K tokens alone, so even the response right after a fold says whether the cache survived) and so learns, per provider and model, whether the cache survived a gap of that length: a few counts per gap bin (30 s to 2 h, with bin edges on the 5-minute and 1-hour tiers), monotone in the gap; a gap of 2 h or more is not recorded and falls back to the requested cache lifetime, older evidence halved after 16 newer observations of the same bin, stored without any content in `~/.pi/agent/pi-zip/cache-survival.json`. Before any evidence the cache lifetime the requests ask for decides (5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`; too short a guess is cheaper than too long); beyond it one clean read overrides it, inside it a lone miss counts as noise (warm caches do miss now and then) and only repeated misses do. A GLM cache read in full after 365 s makes the next 365 s return warm; a Claude 5-minute cache that read nothing after 360 s stays dead. Whether the provider bills cache writes (explicit cache) or not (automatic prefix cache) is read from the first response too. `/zip` draws what it has learned as the dot chart above.

Protected from folding: the current user turn and the previous one. When the context is above the target, re-readable outputs of the previous turn (an unchanged file, a read-only command) can still be folded at a return after a pause (an absence at least as long as the requested cache lifetime) or a model switch (never at a return inside it, whatever the cache), and any output in either turn can be folded once it is 60 assistant requests old (so a long agent run that is a single user turn with hundreds of tool calls is not exempt from folding; the newest 59 requests' outputs always stay, and every fold stays recallable). Messages you type while the agent is running (steering, follow-up) belong to that turn and do not start a new one. Outputs you have already recalled, and `zip_recall` results themselves (or reads of a recall file), are never folded again. "Read-only" is a conservative whitelist: `find -delete` or `-exec`, command substitution, redirects, background jobs, `git diff --output` and the like are not.

**Token counts are calibrated, not guessed.** Sizes are estimated as chars/4 (Pi's rule), and real tokens are not proportional to that: every request carries a fixed prefix O (system prompt, tool definitions, the provider's own framing: 2-4K on a bare Pi, 30-55K with a large tool set) that no edit shrinks, and the conversation costs c real tokens per estimated one (about 0.7-1.1 on GLM and GPT, 1.5-2.2 on Claude, more on CJK-heavy text). So a size is O + c x the chars/4 estimate of the conversation. O is read from the session: what the provider still read from its cache on the request that first carried the newest summary (everything after the system prompt and tools had changed there), else the session's first request minus its small opening prompt, else 2 x the chars/4 of the system prompt and the tool definitions; a tool set that changed since moves it by the same factor. c = (real - O) / estimate for the newest reply that reports usage (input + cache read + cache write; clamped to 0.5-4, 1.5 before the first reply). Both depend on the provider's tokenizer, so only replies from the model the next request goes to count: right after a model switch to a model of another provider O and c fall back to the defaults until its first reply, while a switch between two models of one vendor on that vendor's own API (opus to sonnet on `anthropic`, say) keeps the scale the session measured (the defaults put the first cold return's sizes 10-20% off). A provider that serves several vendors (`github-copilot`, `openrouter`, a gateway) carries the scale only between models of one recognised family (Claude to Claude, GPT to GPT): a GPT-to-Claude switch there falls back to the defaults, since the two tokenizers differ by about 2x; and when that model has no O of its own, the previous model's O carries over in conversation units (O / c). Both are read from the session itself on every decision, so a restart, `pi -p` or a resumed session calibrates exactly like a long-lived one, and nothing extra is stored. The conversation estimate also counts what every tool call puts on the wire besides its arguments and output (the call id, twice, and the tool-use markup), since that does not shrink when an output is folded. On recorded sessions the next request's size comes out within 2.8% (p90; 31% with the single ratio of 0.2.9). The size a plan predicts for the request that carries it is a few percent off in the median after a fold that removed over half of the context, 12-15% at worst one time in ten (what is left has not been measured yet); from the next reply on it is measured again (within 4%). The cold cap counts the whole context and leaves at least half of it to the conversation; the compaction room is the whole context too (it is Pi's trigger); sizes in the notices, `/zip` and the ledger use the same scale.

The working view is capped at pi-zip's room when the window is known. A protected tail or fixed prefix can still make that target unreachable; the planner does not summarise protected work to force it.

## Recall

A folded block says what produced it (tool, command or path with offset/limit, the UTC time of the output, exit status and test counts for commands), its size, a handle and its key lines, so look-alike runs stay apart. A JSON document on one line (a status call, an API response) shows key fields instead: error and status fields first, the newest record's identity, and the end of the last long string, not its first 160 characters. It also tells the model to prefer `zip_recall` (original bytes, instant, free, no side effects) over re-running or re-reading, because a re-run may give a different result:

```
[folded by pi-zip · bash bun test test/api.test.ts · 10-11 02:31 UTC · exit 1, 79 passed, 2 failed · 5637 chars, 109 lines · handle k3f9a0x1qz]
key lines kept (original line numbers; up to 8):
1: (pass) suite 0 > case parse config ...
106: 2 fail
109: Command exited with code 1
Original kept byte for byte, recallable even after summaries or compaction: zip_recall("k3f9a0x1qz") (optional grep/range) is instant, free, no side effects; prefer it to re-running or re-reading (output may differ). Do not guess its content.
```

Placeholders are written once, when the fold is saved: sessions folded by an earlier version keep their old placeholder text unchanged. Summaries list each folded output with its handle, time (`MM-DD HH:MM`, local; a turn count would restart at every compaction) and outcome in the same way, and say at the top that the 10-character code next to a command, file or call is its handle and that what an output said is to be recalled rather than re-run or re-read. Rows that would read alike show the first line of their output that differs, and when every command runs after the same `cd <dir> &&`, that prefix is named once in the heading instead of on every row (with commands in several directories, every row keeps its own). A summary of an earlier summary merges it section by section (requests, files, commands, other calls, errors, handle table, handle index) instead of clipping its text: items are deduplicated, the oldest are dropped first under a per-section budget with a count of what was left out (zip_recall's grep without a handle searches every earlier output, so the lists are kept short: a summary is about a third smaller than in 0.3.0), user requests keep the session's first ones (they define the task) and the newest verbatim, shorten the ones between to their start (marked `≈`) and count the rest, and there is one narrative: the summary call reads the previous summary's narrative (not its lists) next to the new conversation and writes one updated narrative, newer values replacing older ones, finished todos dropped, durable facts kept (bounded: a longer previous narrative is sent as its head and tail). If that call fails, the previous narrative is carried as it was, marked as possibly stale with the time it was written, and the summary still goes in: a session whose narrative calls keep failing still compacts (0.4.0 and 0.4.1 dropped such a summary and called again at every trigger). A reply cut at the call's cap is not retried, since the same call stops the same way. The fallback is also final for a transient error (overload, network) or a reply slower than the call's time limit: that cut is not called again, as in 0.3.1, so its summary is the deterministic one. Pi's own free-text compaction summaries are merged the same way.

The model recalls by itself when it needs the content:

```
zip_recall({ handles: ["k3f9a0x1qz", "m2b7c4d8ww"] })
zip_recall({ handle: "k3f9a0x1qz", grep: "ERROR|FAIL" })
zip_recall({ handle: "k3f9a0x1qz", range: "120-240" })
zip_recall({ grep: "ECONNREFUSED" })     // no handle: searches every earlier tool output
```

Recall is batched, exact, and also works for outputs from before a compaction or a pi-zip summary (summaries carry a handle table and a budgeted index of older handles). Each recalled section is headed by the handle and the command or path that produced it, so a look-alike output (the same command run again, another slice of the same file) is easy to spot. Without a handle, `grep` searches every earlier tool output of the session (zip_recall results excepted, outputs from before a compaction included), newest output first, each match under its output's handle and command: this also reaches an output whose handle a long summary no longer lists. Output comes back in pages of 20,000 characters (8,000 for a search without a handle; a later page of a search covers the same outputs as its first page, so new output arriving in between does not shift it); the page says how to continue:

```
zip_recall({ handle: "k3f9a0x1qz", offset: 20000 })               // next page, by characters
zip_recall({ handle: "k3f9a0x1qz", offset: 20000, limit: 50000 }) // up to 50,000 characters per page
```

Paging is by characters, so even one 45,000-character line can be read in full, and the pages add up to the original byte for byte. `offset` and `limit` also page a `grep` or `range` selection. `grep` is a case-insensitive regular expression; patterns that could backtrack badly (nested quantifiers, quantified alternation, back-references, very long patterns) are searched as literal text instead.

### Recall through files

When a tool allowlist hides `zip_recall` (`pi --tools read,grep,bash`, sub-agent launchers) but `read`, `grep` or `bash` is active, pi-zip folds exactly as in full mode and points the model at a file instead of the tool:

```
Original kept byte for byte, even after summaries or compaction, in ~/.cache/pi-zip/recall/01a120cb-3d40-75a6-aeac-320e71967606/k3f9a0x1qz.txt: read it (offset/limit for pages) or grep it; prefer that to re-running or re-reading the source (output may differ). Do not guess its content.
```

The sentence names only the tools that are active (with bash alone: `sed -n` to page, `grep -n` to search), and summaries name the same files. A file does not exist until a tool asks for it: when `read`, `grep`, `find` or `ls` gets such a path (whatever comes before `pi-zip/recall/`: another machine, another user, a forked session), or a `bash` command contains one, pi-zip writes the original from the session (the current branch) and points the call at this machine's copy. A `grep`, `ls` or `find` of the session's directory writes every output the model no longer sees in full (folded or summarized away), so a grep over the directory searches them all. A read of a recall file is a recall: it is never folded and counts as an unzip, and the transcript draws it like zip_recall's row (`ƶ unzip …`). `/zip` says `on` (it is a full mode) and has one more row: `unzip    from files in ~/.cache/pi-zip/recall (a tool allowlist hides zip_recall)`, naming where the copies really are (see below; a narrow terminal drops the part in brackets). In a bash command the path is recognised as its own word, also after `X=`, `--file=` or inside `{a,b}`.

The copies live in `$XDG_CACHE_HOME/pi-zip/recall/<session id>/` (by default `~/.cache/pi-zip/recall/`, a place backups and dotfile sync conventionally skip; a relative `XDG_CACHE_HOME` is ignored, as the XDG spec says, since it would put them in the project folder): directories 0700, files 0600. The state line and `/zip` show the place in use. The same text is already in the session file, which Pi writes 0644. Only what the model asks for is copied, and every copy can be written again from the session at any time, so copies older than 14 days are deleted at the next session start; that cleanup touches nothing but pi-zip's own copies (`<handle>.txt` files in session-id directories, never through a symlink). A copy that no longer holds the original byte for byte (a bash command appended to it or edited it) is written again the next time a tool names it. If you delete a session file to get rid of a secret it contained, delete `<that place>/<its session id>/` too, or it stays until then. Without a session file (`pi --no-session`) nothing is copied: the outputs are in no file, so pi-zip keeps them off the disk too, folds only re-readable outputs and says so (`reread-only`). Without pi-zip loaded nothing is written, just as zip_recall would be missing.

## Coexistence

If another extension that manages context is loaded (for example billion-context, magic-context, pi-smart-compact, pi-hot-compact, pi-context-prune), pi-zip pauses folding, says so once, and keeps only its request guard and the session name it gives relays (see the FAQ), which edit nothing in the context. Two writers on the same view give unpredictable results. `/zip` shows `paused`.

An extension that only writes Pi's compaction summaries (a `session_before_compact` handler, like Pi's own `custom-compaction` example) does not pause pi-zip. If it supplies another summary in response to pi-zip's native ask, pi-zip discards the artifact whose prefix was replaced, keeps its cost in the totals, and sends folds only. If the native door is unavailable or cancelled, the ready summary waits for a turn_end; it never rides request-locally. A slow foreign handler is cancelled after 2 s by default (at the idle door, only while no run has been announced to pi-zip: a run announced meanwhile waits for the compaction, and that handler finishes; a run whose start an earlier extension's handler still delays at the deadline can be aborted), and another extension's compaction going in, a failure, or a second deadline miss in a row disables native insertion for the process. Timing alone does not: a compaction that goes in however slowly, or a single miss, keeps it (on sessions of 40-55K entries Pi's own work before it asks pi-zip's handler took 50-380 ms). The price: a handler that ignores the marker and finishes within the deadline runs, and is paid for, at each of pi-zip's compactions. On a session so large that Pi's own preparation passes 2 s, `PI_ZIP_NATIVE_MS` raises the deadline. A handler that cancels manual compactions can show Pi's red "Compaction cancelled" line once.

**If your extension handles every `session_before_compact`, return `undefined` when `event.customInstructions` starts with `[pi-zip native compaction`.** pi-zip answers its own ask; the marker never reaches Pi's default summariser. Every summary notice records its door (`native: "ok"`, or the reason it waited for a draft) in session metadata (`native`, `nativeMs`, `nativeAskMs`).

**Runs an extension starts.** A run triggered by `sendMessage` has no `input` event; it begins at `agent_start` (Pi 1.1.0) or at a `before_agent_start` whose `messageType` is `"custom"` (Pi 1.2.0), once either way. Its first request gets the same priced fold decision, and a ready summary waits for the first turn_end, where its compaction draft goes first: calling `ctx.compact()` at that start would abort the starting run. In the TUI, once the process has run, a ready summary instead goes in through Pi's compaction while Pi is idle, at the first moment the return's own decision takes it, and the next run, typed or started by an extension, carries it from its first request ([design](https://github.com/purboo/pi-zip/blob/master/docs/design.md#honest-limits)). A custom message that starts a run after the previous final answer ends the protected tail like a user prompt. Messages that steer an active run stay part of its current turn.

The guard has two parts. Before saving a fold or a summary it checks that the edit itself would not leave a tool result without its tool call (failed or aborted assistant turns, which the provider layer drops anyway, are ignored, as is any oddity the session already had). And before a request is sent it repairs a tool result that lost its tool call, instead of letting the provider reject the request and brick the session. The repair understands the request shapes of Pi's Anthropic, OpenAI chat completions (and Mistral), OpenAI Responses (Azure, Codex), Google Gemini/Vertex and Bedrock Converse providers; a request of any other shape is passed through untouched.

## FAQ

**Will it save money?** Mostly on cold returns, which is where a long session pays for a full cache rewrite. While the cache is warm an edit must pass the rent guard ([design](design.md#the-decision-in-plain-words)) (large contexts, near Pi's compaction trigger, outputs 60+ requests old). `/zip` shows what this session has folded (and roughly how many tokens that removed), its summaries with what their model calls cost, and its recalls. The numbers live in the session file, so a restart does not reset them.

**Does it cost extra?** Planning is local. A summary is one extra uncached model call with no tools, shown in `/zip`. The law prices the full call before production, and every unused or failed call stays in the totals. There is no one-unused-call or one-summary budget per warm stretch. Finished summaries are saved as `pi-zip/summary` entries and can be used after a restart while their range is still the prefix. A call running at exit is aborted and counted once as unused at its estimated input charge; a call that fails or ends partially on its own keeps its actual charge when the provider reports one. Recalled content re-enters the context at normal prices.

**Can the model lose information?** Folded outputs are replaced by a placeholder with key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your first and most recent requests verbatim (the ones between are shortened, then counted) and never paraphrase the model's reasoning. If the model ignores the handle and guesses, that is a model failure pi-zip cannot catch; this is why only re-readable outputs of the previous turn are folded after a pause; other outputs of the protected turns wait until they are 60 requests old.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries, projected per branch by Pi; the originals stay in the session file.

**What does pi-zip write into the session file?** It appends `context_edit` entries and compactions for the view, plus custom entries that never reach the model: `pi-zip/state` (off, quiet), `pi-zip/steer` (steering messages), `pi-zip/summary` (produced artifacts or lost calls, with their charges), `pi-zip/rent` (the accumulated rent), `pi-zip/commit` (the request that first carried edits), `pi-zip/notice` (the line you see), and `pi-zip/version` (the pi-zip and Pi versions the branch ran from `since` on: at the end of a run, when they differ from the newest such entry on the branch, so a `/tree` move or another session gets its own; it makes offline evaluation by version possible). A resumed process rebuilds growth, the last edited request, the cache clock and artifacts from its branch; it also reads learned survival and latency. Old `pi-zip/plan` and `pi-zip/unused-summary` entries remain readable for historical totals. Only a call still running at exit belongs solely to the old process.

**Which providers?** Anything Pi supports. The cache TTL is the lifetime the requests ask for: 5 minutes, or 1 hour when `PI_CACHE_RETENTION=long` (or the request itself asks for the 1-hour tier); no per-model table is read, and how long a provider really keeps its cache is learned. Pi's own idle cache refreshes count as a cache touch, and so does any other usage entry in the session (a pi-aside side question, say) that read at least what the last reply had cached, on the same provider and a nonempty model matching that reply's requested or responding model. These touches count during a run as well: trailing tool results and steering messages neither count as cache touches nor hide usage entries, and each request reads this filtered current branch before sampling cache survival. When the background-summary timer fires it selects the plan and deadline again from the current branch; a touch since arming postpones production to the new deadline. The idle compaction door also rereads the current clock when it fires and rearms after declining application. A different provider or model than the last request counts as cold. Providers that do not report cache usage still work; the stats are then estimates only.

Some relays rewrite `cache_control`, so the TTL actually written can differ from the one requested. pi-zip checks `usage.cacheWrite1h` (reported by the Anthropic messages API and Bedrock) on the newest few assistant messages of the current model: if you requested 1h but the provider wrote 5m, it uses the 5m TTL (and the reverse), and says so once per session unless `/zip quiet` is on. Without that field it keeps the requested TTL. Test-only TTL overrides take precedence; they are not user settings.

Some relays reject `PI_CACHE_RETENTION=long` with 400 `a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`, because they inject their own 5m `cache_control`. That is a provider issue: unset the variable.

**Relays that pool accounts** (sub2api, for example) keep a conversation on one upstream account, and so on one prompt cache, only when the request names the conversation. Claude Code does that in `metadata.user_id`; Pi does not, so such a relay picks the account from the newest cached text, and a typed prompt can land on another account and write the whole prefix again (measured on one sub2api relay: 19.5% of typed prompts lost the whole cache, against 0.65% for the tool-result requests between them). pi-zip therefore adds `metadata.user_id` to Anthropic-messages requests that have none, in Claude Code's legacy form `user_<sha256 of the session id>_account__session_<session id>`: nothing but the session id goes out. It is a field of the Anthropic Messages API. It is not added for api.anthropic.com or GitHub Copilot (nothing is pooled there), nor to a request that already speaks as Claude Code (Pi's OAuth path, which opens the system prompt with Claude Code's identity and uses an `sk-ant-oat` key, or a `claude-cli` user agent among the headers Pi resolves for the model from models.json): a relay would take that request for Claude Code itself and stop rewriting it as one. A user agent another extension sets in `before_provider_headers` comes after the request body is built and is not seen. A relay still moves the session when its account runs out (one cache write, as before), and may queue a request for a busy account (sub2api: up to 2 minutes by default). An endpoint that refuses the field fails one request (Pi does not retry it; send the prompt again): pi-zip stops sending the field to that model and endpoint when a refusal names it, at the first 400 of one that has never answered a request carrying it, or at the second 400 in a row of one that has, counted within one process (a 400 that says the prompt is too long does not count). The state of each model and base URL (answered, refused) is kept in `sticky.json` next to the learned cache stats, so the next process does not repeat the failure; delete that file to try again. A session started by a fork or `/new` has its own id. `/zip off` sends nothing; `PI_ZIP_STICKY=0` is an emergency off switch, not a setting.
