// The per-session shell behind index.ts: Pi's events, the run plan (F8) and the warm valve (F10) carried out and persisted at
// turn_end, the producer and its timer for the summary (F12). The decisions themselves are pure functions in core.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheActivity, lastMessageMs, lastPrompt, modelKey, payloadRetention, refused, ttlFor, type ColdInfo } from "./cache.ts";
import { agentDir, curve, describe, lawPrices, loadStats, pWarm, record, sample, statsPath, GAP_EDGES, type Entry } from "./learn.ts";
import { repairPayload } from "./guard.ts";
import { artifactsOf, candidateOf, decideEdits, checkEdits, clock, decideRun, inRunClock, requestBranch, want, decideTurnEnd, grow, headOf, planOpts, readyOf, rentOf, runPlanOf, scaleOf, unusedOf, valvePlanOf, SUMMARY_CUSTOM, type Artifact, type Avail, type Env, type Learned } from "./core.ts";
import { fmtK, Stats, noticeDesc, noticeText, type NoticeAction, type NoticeData, type ZipControl } from "./notice.ts";
import { applyPlanToMessages, buildBlocks, countUserTurns, G0, keepRecentTokensFor, piCanCompact, piContextTokens, reserveTokensFor, sizeOf, wireTokensOf, UNIT, type Block, type Cut, type FoldTarget, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
import { handleFor, PH_MARK, RECALL_TOOL } from "./placeholder.ts";
import { branchOutputs, recalledHandlesFromBranch, resolveHandlesInBranch } from "./recall.ts";
import { cleanupRecall, commandNamesRecall, fileRecallFor, materialize, parseRecallPath, recallRoot, recallRootShown, rewriteCommand, sidDir, type FileRecall } from "./recallfile.ts";
import { buildCut, type SummaryLane } from "./summary.ts";
import { type Any, attempt, COMMIT_CUSTOM, envInt, PRODUCT, piTokensOf, textOf, tok4, tokensOf } from "./util.ts";
import { pendingSummary, replayGrowth } from "./state.ts";
import { afterSize, digest, prefixDigest, pressure, safeCut, speedPlan, zipMode, type SpeedStamp } from "./speed.ts";
import { fmtLife, type CardData, type ChartBin, type StateWord } from "./ui.ts";

export const PLAN_CUSTOM = "pi-zip/plan";
export const STATE_CUSTOM = "pi-zip/state";
export const STEER_CUSTOM = "pi-zip/steer";
export const VERSION_CUSTOM = "pi-zip/version", PZ_VERSION: string = attempt(() => String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version), "?"); // the pi-zip and Pi versions a session ran from `since` (ms) on, for offline evaluation
const WARM_WHY = "cache warm · worth it at this size";
const fmtAway = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(Math.round(s / 360) / 10).toFixed(1)} h`);
export const NOTICE_CUSTOM = "pi-zip/notice"; // a fold/summary notice kept in the transcript (rendered by index.ts, never sent to the model)
export { checkEdits, SUMMARY_CUSTOM };
const LEGACY_UNUSED_CUSTOM = "pi-zip/unused-summary"; // written by 0.3.x for a background summary nobody adopted: still read, so older totals stay honest
// Other context managers rewrite the view too (F14); two writers give unpredictable results, so we pause and keep only the Guard.
const CONFLICT_RE = /billion-context|bc-pi|magic-context|smart-compact|hot-compact|context-prune|pi-vcc|context-mode|prefix-cache/i;

/** The summary call in flight in the background (the user away, or working on while it is written): at most one. It has its own
 *  AbortController: no run owns it. When it ends with a summary, that summary is recorded (a pi-zip/summary entry, Artifact) and is
 *  ready for any plan whose cut is not shallower (core.ts adopt); the call itself is gone. */
interface Bg {
	speed?: SpeedStamp; // frozen speed configuration and prefix; early policy does not use it
	key: string; // firstKeptEntryId of the cut it is written for
	head: string; // the head of the projection it reads (core.ts headOf)
	aborted: boolean;
	promise: Promise<Cut | null>;
	controller: AbortController;
	estUsd: number; // what the call is billed for its input if it is aborted after the provider took it: the prefix it reads, uncached
}

/** Resolves with the promise's value, or null as soon as the signal aborts (Esc: Pi cancels the prompt; the call goes on). */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(null);
		const onAbort = () => resolve(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, () => resolve(null)).finally(() => signal?.removeEventListener("abort", onAbort));
	});
}

const errText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
/** A compaction another extension supplied (through session_before_compact): not Pi's own summary, not pi-zip's. */
const foreignCompaction = (e: Any): boolean => e?.type === "compaction" && !!e.fromHook && e.details?.by !== PRODUCT;

/** pi-zip's own compaction takes milliseconds: the summary is done. Pi runs every extension's session_before_compact handler for it, so
 *  one that is not finished by this deadline has another handler at work (writing its own summary, say): pi-zip cancels it then, so it
 *  can never land during the run, and the draft path takes the summary (the idle door's, only while no run is announced). A compaction
 *  that goes in never ends the native path however slow (Pi's own work before pi-zip's handler grows with the branch: 50-380 ms at
 *  40-55K entries); a single miss neither. Two in a row do (Pi's own work past the deadline twice counts too: PI_ZIP_NATIVE_MS). */
const nativeDeadlineMs = () => envInt("NATIVE_MS", 2_000);
/** The idle door (research pi-tricks §1b variant 4, "\u03b5"): on; PI_ZIP_IDLE_DOOR=0 is an emergency off switch, not a setting. */
const idleDoorOn = () => process.env.PI_ZIP_IDLE_DOOR !== "0";
/** A relay that pools accounts (sub2api, say) keeps a conversation on one account only when the request names it, as Claude Code's
 *  metadata.user_id does; without it the relay hashes the newest cached text, so a typed prompt can land on another account and write
 *  the whole prefix again. Claude Code's legacy form, made of the session id alone. PI_ZIP_STICKY=0 is an emergency off switch. */
export const stickyUserId = (sid: string): string | undefined => process.env.PI_ZIP_STICKY === "0" || !/^[0-9a-f-]{36}$/i.test(sid) ? undefined
	: `user_${createHash("sha256").update(sid).digest("hex")}_account__session_${sid}`;
/** Sent on an Anthropic-messages request without metadata, not to Copilot, and not on one that already speaks as Claude Code (Pi's OAuth
 *  system prompt; Zip.providerRequest also asks the registry for a claude-cli user agent or an OAuth key): a relay would take it for
 *  Claude Code and stop rewriting it. Not to api.anthropic.com either: nothing is pooled there. */
const stickyFits = (m: Any, p: Any): boolean => !!p && typeof p === "object" && p.metadata == null && m?.api === "anthropic-messages"
	&& m.provider !== "github-copilot" && !/^You are Claude Code/.test(String(Array.isArray(p.system) ? p.system[0]?.text : (p.system ?? "")));
const idleOf = (ctx: Any): boolean => attempt(() => ctx?.isIdle?.() === true, false);
/** The customInstructions pi-zip passes on its own ctx.compact() (Pi hands them to every session_before_compact handler as
 *  event.customInstructions). A handler that supplies its own summaries for every compaction (a model call, say) should return undefined
 *  when event.customInstructions starts with this: pi-zip answers this one itself, and its summary is already written. pi-zip answers or
 *  cancels every compaction that carries it, so Pi's default summariser never receives it as an instruction. */
export const NATIVE_MARKER = "[pi-zip native compaction: handlers of session_before_compact return undefined, pi-zip answers this one]";

/** The prompt of Pi's input event (its raw text, before a /template or /skill is expanded, and its images), as the projected entry
 *  without an id Pi appends when the run starts: the plan made before it counts its size. */
function pendingPrompt(e: Any): Any | null {
	if (typeof e?.text !== "string") return null;
	const m = { role: "user", content: [{ type: "text", text: e.text }, ...(Array.isArray(e.images) ? e.images : [])], timestamp: Date.now() };
	return { sourceEntry: { type: "message", message: m }, messages: [m] };
}

type NativeRun = { cut: Cut; before: number; after: number; o: PlanOpts; cal: Scale; p: PlanResult };
/** The start of a run, read once: the return it is (core.ts clock), the settle plan's targets and, for a prompt, what its idle input
 *  decided (the native summary that went in, or why none did). A prompt's input hands it to that prompt's run at agent_start. */
interface Start {
	clk: ColdInfo;
	settleIds: string[];
	note: { native: string; ms?: number; askMs?: number } | null;
	nat: NativeRun | null;
	foreign: boolean;
	head: string; // the projection's head once the input is done: another compaction before the run voids the carried decision
	model: string; // the model it was read for: another model chosen before the run (a before_agent_start handler, say) voids it too
}

export class Zip implements ZipControl {
	off = false;
	quiet = false;
	conflict: string | null = null;
	readonly stats = new Stats();
	private readonly speed = zipMode() === "speed";
	private speedTried = new Set<string>();
	private speedRejected = new Set<string>();
	private speedSelected: SpeedStamp | null = null;
	private speedDurations = new Map<string, number[]>();
	private speedVelocity = 250;
	private speedDeltas: number[] = [];
	private speedEpoch = "";
	private speedSample: { head: string; model: string; tokens: number; at: number; run: number } | null = null;
	readonly recalled = new Set<string>();
	private cold = false;
	private coldReason = "";
	private runChecked = true; // the first request of the run has been looked at
	private runEdits = false; // this run carries an edit plan that turn_end has yet to persist
	private runPlan: RunPlan | null = null;
	private lastReqMs = 0; // the real-time cache clock: newest request start or end
	private reqMsBefore = 0; // the clock before the request in flight started: what a refused request gives back
	private lastModelKey = ""; // provider/model of the newest request: a cache entry belongs to one model
	private stickyKey: string | null = null; // the model the request in flight named its session to (stickyUserId)
	private sticky: Record<string, unknown> | null = null; // stickyOf: model key@base URL -> "ok" (answered) | "off" (refused)
	private readonly stickyAuth = new Map<string, Promise<boolean>>(); // model key@base URL -> its auth speaks as Claude Code (resolved once)
	private sticky400 = 0; // 400s in a row to requests that carried the field
	private settleIds: string[] = []; // entries the settle plan folded: only used to label a plan as prepared
	private bg: Bg | null = null;
	private mine: Artifact[] = []; // the pi-zip/summary records this process made (the branch has them once written)
	private unwritten: Artifact[] = []; // ... made inside a run: written as drafts at its next turn_end or at settle
	private inRun = false; // from the start of a run to its settle (or agent_end)
	private timer: ReturnType<typeof setTimeout> | null = null;
	private timerGen = 0;
	private wireLedgered = false;
	private model: Any;
	private conflictNoticed = false;
	private ttlNoticed = false;
	private runUserSeen = 0;
	private steerTs = new Set<number>(); // timestamps of steering/follow-up user messages not yet marked in the session
	private steerIds = new Set<string>(); // marked: user entries that are NOT new user turns
	// the law's inputs (round 5): P(warm) of this run's return, growth g, and the free cache signal of every response
	private pWarm = 1;
	private pause = false; // this run is a return after a pause or a model switch (the previous user turn's re-readables may fold: plan.ts PlanOpts.pause)
	private survSrc = "no prior request";
	private ent: Entry | undefined; // learned class + survival of the current model (learn.ts)
	private g = G0; // EWMA(0.1) of real-token growth between consecutive responses, capped at the p90 of the last 20 deltas
	private deltas: number[] = [];
	private prevTotal = 0; // prompt size (input + cacheRead + cacheWrite) of the newest response, and its model
	private prevKey = "";
	private nextEdit: number | null = null; // the next request is the first to carry a new edit: its untouched prefix (real tokens)
	private pending: { censored: boolean; gapS: number; expect: number; edited: boolean; key: string } | null = null;
	private rentHead = "";
	private rent = 0; // R14: accumulated planned savings, persisted at each boundary
	private justEdited = false; // the newest response answered a request that first carried an edit: the next request gets no warm edit
	// pi-zip's own ctx.compact() in flight: the only compaction session_before_compact answers (compaction null = cancel a late ask)
	private nativeAsk: { compaction: Any | null; answered: boolean; askedAt: number; askedWall: number; until: number } | null = null;
	/** What became of the native path for this run, for the notice (the session file alone says why a summary went the draft way). */
	private nativeNote: { native: string; ms?: number; askMs?: number } | null = null;
	// the native path ended for this process, and why: another extension took part in pi-zip's compaction (answered, cancelled or
	// replaced it, or missed the deadline twice in a row), or Pi's compaction failed. Summaries then wait for a turn_end draft.
	private nativeOff: string | null = null;
	private nativeLate = 0; // pi-zip's compactions cancelled at the deadline since the last one that went in
	// this run's return went in through another extension's compaction (it answered pi-zip's): the run plan adds no summary on top of
	// it (folds only, a summary only at Pi's compaction room), and the summary prepared for the context it replaced is discarded
	private foreignRun = false;
	// the native summary already went in; its joint decision supplies the first request's folds and notice sizes
	private nativeRun: NativeRun | null = null;
	// the idle door (armDoor): its timer, the evaluation in flight, the inputs seen, and the decision the next run carries (any run)
	private doorTimer: ReturnType<typeof setTimeout> | null = null;
	private doorGen = 0;
	private door: Promise<void> | null = null;
	private inputs = 0;
	private idleNat: { nat: NativeRun; note: Start["note"]; head: string; model: string } | null = null;
	private ranHere = false; // a run of this process in this session: the idle door opens only after one
	version = { v: PZ_VERSION, pi: "", since: Date.now(), last: null as Any }; // pi: set by index.ts; last: the newest version entry on this branch
	private readyAtStart = new Set<string>(); // summaries ready when the run began: one taken at its turn_end was ready while the user was away
	// the cache tier (PI_CACHE_RETENTION) of the current model's requests: the payload of its newest request when seen, else the
	// provider-scoped env resolved once per run (research pi-tricks §3.1); null = nothing known, the process env decides (cache.ts)
	private retention: { key: string; tier: "short" | "long"; src: "env" | "provider env" | "payload" } | null = null;

	constructor(private pi: ExtensionAPI) {}

	active = () => !this.off && !this.conflict;

	/** How the model gets a folded output back, checked at session start and before every run (index.ts): "tool" = zip_recall is declared;
	 *  "file" = a `--tools` allowlist hides it but read, grep or bash is active (placeholders name a recall file, written on demand);
	 *  "reread" = none of those either: only re-readable outputs fold. */
	recallMode: "tool" | "file" | "reread" = "tool";
	private recallTools = { read: false, grep: false, bash: false };
	/** index.ts registered the transcript renderer for NOTICE_CUSTOM (Pi versions without registerEntryRenderer fall back to a status line). */
	entryRenderer = false;
	private coldWhy = ""; // the expanded notice's "why now" for this run
	private turnWhy = ""; // the same for an edit chosen at turn_end: what that decision assumed about the cache
	private noticed = false; // a transcript notice was written in this process (the branch may not show it yet)
	setRecallMode(mode: "tool" | "file" | "reread", tools: { read: boolean; grep: boolean; bash: boolean }, ctx?: Any) {
		if (mode !== this.recallMode) this.ledger({ type: "recall_available", ok: mode === "tool", mode, ...tools });
		this.recallMode = mode;
		this.recallTools = tools;
		if (!ctx) return;
		if (mode === "file" && this.fileRecall(ctx)) this.stateLine(ctx, "on", `${this.speed ? "original outputs" : "a tool allowlist hides zip_recall · zipped outputs"} are read back from files in ${recallRootShown()}`, true, "on:file");
		else if (mode === "file") this.stateLine(ctx, "reread-only", "a tool allowlist hides zip_recall · only re-readable outputs fold · no session file (--no-session), so no recall copies are written either", true, "reread-only:no-session");
		else if (mode !== "tool") this.stateLine(ctx, "reread-only", "a tool allowlist hides zip_recall · only re-readable outputs fold · allow zip_recall, read, grep or bash to fold more");
	}
	/** The recall files this session's placeholders name; undefined outside file mode, and without a session file (`--no-session`: the
	 *  outputs are in no file, so none is written for them either): then only re-readable outputs fold. */
	private fileRecall(ctx: Any): FileRecall | undefined {
		if (this.recallMode !== "file") return undefined;
		const sid = this.recallSid(ctx);
		return sid ? fileRecallFor(sid, this.recallTools) : undefined;
	}
	/** The session id recall copies are written under: none without a session file (`pi --no-session` keeps the session in memory). */
	private recallSid(ctx: Any): string {
		return attempt(() => typeof ctx?.sessionManager?.getSessionFile?.() === "string", false) ? this.sessionId(ctx) : "";
	}
	private sessionId(ctx: Any): string {
		return attempt(() => { const sid = ctx?.sessionManager?.getSessionId?.(); return typeof sid === "string" ? sid : ""; }, "");
	}

	/** Folded tool outputs of the current branch by toolCallId -> handle (the transcript marks them). */
	readonly foldedCalls = new Map<string, string>();
	foldedHandle = (toolCallId: string): string | undefined => this.foldedCalls.get(toolCallId);
	/** handle -> what was folded ("read src/learn.ts"), from the placeholders of this branch: the recall row names it. */
	readonly labels = new Map<string, string>();
	labelOf = (handle: string): string | undefined => this.labels.get(handle);
	refreshFolded(ctx: Any) {
		const branch = this.branch(ctx);
		const byId = new Map(branch.map((e: Any) => [e?.id, e]));
		this.foldedCalls.clear();
		this.version.last = null; // and the newest version entry: /tree may have moved to a branch another version ran
		for (const e of branch) {
			if (e?.type === "custom" && e.customType === VERSION_CUSTOM) this.version.last = e.data;
			const ph = String(e?.replacement?.content?.[0]?.text ?? "");
			if (e?.type !== "context_edit" || !ph.startsWith(PH_MARK)) continue;
			const h = handleFor(e.targetId);
			// older placeholders wrote a read slice as "offset=1 limit=2000": show it the way Pi does ("path:1-2000")
			const label = ph.slice(0, ph.indexOf("\n") >>> 0).split(" · ")[1]?.replace(/ offset=(\d+)(?: limit=(\d+))?$| limit=(\d+)$/, (_m, o, l, l2) => {
				const st = o ? +o : 1, li = l ?? l2;
				return `:${st}${li ? `-${st + +li - 1}` : ""}`;
			});
			if (label) this.labels.set(h, label);
			const id = byId.get(e.targetId)?.message?.toolCallId;
			if (typeof id === "string") this.foldedCalls.set(id, h);
		}
	}

	// ---- the real size of the request that carried a plan (notices, research pi-tricks §3.4) ---------------------------------------
	private liveCtx: Any = null; // the newest handler context: its sessionManager resolves to the current session at call time
	private realMemo = new Map<number, { real: number | undefined } | { n: number }>();
	/** input + cacheRead + cacheWrite of the first assistant message stamped at or after reqTs (errors and aborts skipped): the request
	 *  that carried the plan. undefined until that response exists (the notice keeps its estimate); 0 when it reports no usage. A user
	 *  message stamped after reqTs before it ends the search for good: what follows answers a later run (a valve plan committed at a run's
	 *  last turn_end, a plan whose request failed), so the estimate stays. The run's own prompt is stamped before reqTs (its millisecond at
	 *  the latest). A found value is kept; a miss is looked at again only when the session has grown. */
	realSizeAfter(reqTs: number): number | undefined {
		const memo = this.realMemo.get(reqTs);
		if (memo && "real" in memo) return memo.real;
		const got = attempt(() => { const sm: Any = this.liveCtx?.sessionManager; return { sm, n: typeof sm?.getEntryCount === "function" ? sm.getEntryCount() : -1 }; }, null);
		if (!got) return undefined;
		const { sm, n } = got;
		if (memo && n >= 0 && memo.n === n) return undefined;
		for (const e of attempt((): Any[] => sm?.getBranch?.() ?? [], [])) {
			const m = e?.type === "message" ? e.message : null;
			if (m?.role === "user" && Number(m.timestamp) > reqTs) {
				this.realMemo.set(reqTs, { real: undefined }); // a later prompt came first: no response can be this plan's any more
				return undefined;
			}
			if (m?.role !== "assistant" || !(Number(m.timestamp) >= reqTs) || m.stopReason === "error" || m.stopReason === "aborted") continue;
			const u = m.usage, real = u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
			this.realMemo.set(reqTs, { real });
			return real;
		}
		this.realMemo.set(reqTs, { n });
		return undefined;
	}

	/** /zip output in the transcript (custom entry, never sent to the model). */
	show(ctx: Any, data: NoticeData): boolean {
		if (ctx?.mode !== "tui" || !this.entryRenderer) return false;
		return attempt(() => (this.pi.appendEntry(NOTICE_CUSTOM, data), true), false);
	}

	/** A state change as one transcript line ("ƶ pi-zip  paused  …"); each word once per session unless always. */
	stateLine(ctx: Any, word: StateWord, reason: string, once = true, key: string = word) {
		const text = `${PRODUCT}  ${word}  ${reason}`;
		if (ctx?.mode !== "tui" && word !== "paused") return; // print/json/rpc (sub-agents): no transcript to keep it in
		if (once && (this.statesShown.has(key) || this.branch(ctx).some((e: Any) => e?.type === "custom" && e.customType === NOTICE_CUSTOM && e.data?.kind === "state" && (e.data?.key ?? e.data?.word) === key))) return;
		this.statesShown.add(key);
		this.ledger({ type: "state", word, reason });
		// a state is not tied to this turn's edits: append now, so it sits where it happened
		if (!this.show(ctx, { v: 2, kind: "state", word, reason, text, before: 0, after: 0, desc: "", ...(key !== word ? { key } : {}) })) this.notify(ctx, text);
	}
	private statesShown = new Set<string>();

	/** First pi-zip session on this machine: one line that explains when older context changes. */
	welcome(ctx: Any) {
		if (ctx?.mode !== "tui" || !this.entryRenderer || this.off || this.conflict) return;
		const flag = `${dirname(process.env.PI_ZIP_CACHE_STATS || statsPath())}/welcomed`;
		if (attempt(() => existsSync(flag) || (mkdirSync(dirname(flag), { recursive: true }), writeFileSync(flag, new Date().toISOString() + "\n"), false), true)) return;
		this.stateLine(ctx, "on", this.speed ? "native context until automatic compaction · originals stay recallable from files · /zip" : "older context gets zipped when the savings pay for the rewrite · /zip");
	}

	ledger(rec: Record<string, unknown>) {
		const path = process.env.PI_ZIP_LEDGER; // test only
		if (!path) return;
		attempt(() => (mkdirSync(dirname(path), { recursive: true }), appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...rec }) + "\n")), undefined);
	}

	/** keep = a fold/summary notice: written to the session as a custom entry, so it stays in the transcript (also after a restart)
	 *  next to Pi's own "[compaction]" block instead of a status line the next status overwrites. Custom entries never reach the model. */
	private notify(ctx: Any, text: string, keep?: NoticeData) {
		this.stats.notices++;
		this.ledger({ type: "notice", text });
		if (keep && ctx?.mode === "tui" && this.entryRenderer) {
			setTimeout(() => attempt(() => this.pi.appendEntry(NOTICE_CUSTOM, keep), undefined), 0); // after Pi has appended this turn's edits
			return;
		}
		if (ctx?.ui?.notify && (ctx.mode === "tui" || ctx.mode === "rpc")) {
			attempt(() => ctx.ui.notify(text, "info"), undefined);
		}
	}

	/** Inside one core want() call, which prices up to ~30 plans of one view synchronously: the branch and each view's token scale are
	 *  read once (each read walks the whole branch: ~5 ms per plan on a 30K-entry session). Nothing is appended in between. */
	private frozen: { branch: Any[]; scales: Map<Any[], Scale> } | null = null;

	private branch(ctx: Any): Any[] {
		if (this.frozen) return this.frozen.branch;
		return attempt(() => ctx.sessionManager.getBranch() as Any[], []);
	}

	private reserve(ctx: Any): number {
		return attempt((): number | null => reserveTokensFor(this.pi.getSettings?.(), ctx?.model), null) ?? reserveTokensFor(undefined, ctx?.model);
	}

	/** The system prompt and the declared tools from Pi's API: only used when the transcript records no system message (plan.ts calibrate). */
	private sysInfo(ctx: Any): SysInfo {
		const active = attempt(() => new Set(this.pi.getActiveTools?.() ?? []), new Set());
		return { text: attempt((): string => ctx?.getSystemPrompt?.() ?? "", ""), tools: attempt((): Any[] => (this.pi.getAllTools?.() ?? []).filter((t: Any) => active.has(t?.name)), []) };
	}

	/** The cache tier of `model`'s requests, when known (see `retention`). */
	private tier(model?: Any): "short" | "long" | undefined {
		const r = this.retention;
		return r && r.key === modelKey(model ?? this.model) ? r.tier : undefined;
	}
	/** Once per run: PI_CACHE_RETENTION as Pi resolves it for this model's provider (the credential's env in auth.json first, then the
	 *  process env). A tier read from this model's newest request payload is the truth about that request and stays. */
	private async resolveRetention(ctx: Any): Promise<void> {
		const key = modelKey(ctx?.model);
		if (!key || (this.retention?.key === key && this.retention.src === "payload")) return;
		let scoped: string | undefined;
		try {
			const r = await ctx?.modelRegistry?.getApiKeyAndHeaders?.(ctx.model);
			const v = r?.env?.PI_CACHE_RETENTION;
			if (typeof v === "string" && v) scoped = v;
		} catch {}
		const v = scoped ?? process.env.PI_CACHE_RETENTION;
		const next = { key, tier: v === "long" ? ("long" as const) : ("short" as const), src: scoped ? ("provider env" as const) : ("env" as const) };
		if (next.tier !== this.retention?.tier || next.key !== this.retention?.key || next.src !== this.retention?.src) this.ledger({ type: "retention", ...next });
		this.retention = next;
	}

	/** The token scale (O, c) read from the branch: stateless, so a fresh process calibrates exactly like a long-lived one. */
	scaleOf(ctx: Any, entries?: Any[]): Scale {
		return attempt(() => scaleOf(entries ?? ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []), this.branch(ctx), this.sysInfo(ctx), ctx?.model ? modelKey(ctx.model) : undefined), UNIT);
	}

	/** The token scale of model `key` ("provider/id"), read from the branch. */
	private scaleAt(ctx: Any, entries: Any[] | undefined, key: string): Scale {
		return scaleOf(entries ?? [], this.branch(ctx), this.sysInfo(ctx), key);
	}

	/** What the planner reads of Pi besides the branch (core.ts Env). */
	private env(ctx: Any): Env {
		const fileRecall = this.fileRecall(ctx);
		const rereadOnly = this.recallMode === "reread" || (this.recallMode === "file" && !fileRecall);
		return { model: ctx?.model, cwd: (ctx?.cwd as string) ?? process.cwd(), sys: this.sysInfo(ctx), reserve: this.reserve(ctx), recalled: this.recalled, steerIds: this.steerIds, rereadOnly, ...(fileRecall ? { fileRecall } : {}) };
	}
	/** Λ for the model of `ctx` (core.ts Learned): its learned entry once loaded (loadEnt), its tier, growth and the session facts. */
	private lam(ctx: Any): Learned {
		const m = ctx?.model ?? this.model;
		return { model: m, ent: this.entKey === modelKey(m) ? this.ent : undefined, tier: this.tier(m), g: this.g, justEdited: this.justEdited };
	}

	/** Plan options at P(warm) `pWarm`, after a pause or not, with the token scale read from the branch (core.ts planOpts). */
	private opts(ctx: Any, pending: boolean, entries: Any[], pWarm: number, pause: boolean, cutAt?: string, foldsOnly = false, ready?: readonly string[]): { o: PlanOpts; cal: Scale } {
		const branch = this.branch(ctx);
		if (this.rentHead !== headOf(branch)) { this.rent = rentOf(branch); this.rentHead = headOf(branch); }
		const env = this.env(ctx), f = this.frozen;
		if (f) {
			let s = f.scales.get(entries);
			if (!s) f.scales.set(entries, (s = scaleOf(entries, branch, env.sys, env.model ? modelKey(env.model) : undefined)));
			env.scale = s;
		}
		const r = planOpts(entries, branch, env, this.lam(ctx), pending, pWarm, pause, cutAt, foldsOnly, ready);
		r.o.rent = this.rent;
		return r;
	}

	/** A model's metadata.user_id state, kept across processes (sticky.json next to the cache stats; other processes write it too). */
	private stickyOf(key: string, set?: "ok" | "off"): unknown {
		const path = `${dirname(process.env.PI_ZIP_CACHE_STATS || statsPath())}/sticky.json`;
		const read = (): Record<string, unknown> => attempt(() => { const j = JSON.parse(readFileSync(path, "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; }, {});
		this.sticky ??= read();
		if (set && this.sticky[key] !== set) {
			this.sticky = { ...read(), [key]: set };
			attempt(() => (mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, JSON.stringify(this.sticky))), undefined);
		}
		return this.sticky[key];
	}

	private entKey = "";
	private loadEnt(key: string) {
		this.entKey = key;
		this.ent = loadStats().models[key];
	}

	/** Ledger form of the law's evaluations: Phi, K, eta, T next to g, w/r, P(warm) and where the inputs came from. */
	private lawLedger(where: string, o: PlanOpts) {
		const l = o.law!, pr = l.pr, rd = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x > 0 ? "inf" : null);
		this.ledger({
			type: "law", where, g: Math.round(l.g), pWarm: rd(l.pWarm), survSrc: where === "run" ? this.survSrc : "in-run", cls: pr.cls, wr: rd(pr.w / pr.r), prSrc: pr.src,
			steps: (o.trace ?? []).map((t) => ({ at: t.where, ok: t.ok, B: Math.round(t.B), A: Math.round(t.A), T: Math.round(t.T), ...(t.Tsuf !== undefined ? { Tsuf: Math.round(t.Tsuf) } : {}), phi: rd(t.phi), K: rd(t.K), eta: rd(t.eta) })),
		});
	}

	/** Ledger only (research pi-tricks §3.5): entries another context manager wrote into this branch, each logged once: a context_edit
	 *  that is neither pi-zip's placeholder nor Pi's own omission (null), or a compaction an extension other than pi-zip supplied.
	 *  Nothing is decided from it. */
	private foreignSeen = new Set<string>();
	private logForeign(ctx: Any, where: string) {
		if (!process.env.PI_ZIP_LEDGER || this.off) return; // the ledger is the only reader
		for (const e of this.branch(ctx)) {
			if (typeof e?.id !== "string" || this.foreignSeen.has(e.id)) continue;
			let rec: Record<string, unknown> | null = null;
			if (e.type === "context_edit" && e.replacement != null) {
				const text = textOf(e.replacement.content);
				if (!text.startsWith(PH_MARK)) rec = { kind: "context_edit", targetId: e.targetId ?? null, chars: text.length, head: text.slice(0, 60) };
			} else if (foreignCompaction(e)) rec = { kind: "compaction", by: e.details?.by ?? null, firstKeptEntryId: e.firstKeptEntryId ?? null, chars: String(e.summary ?? "").length };
			if (!rec) continue;
			this.foreignSeen.add(e.id);
			this.ledger({ type: "foreign_edit", where, id: e.id, ...rec });
		}
	}

	private detectConflict(ctx: Any) {
		let found: string | null = null;
		try {
			const items: Any[] = [...(this.pi.getAllTools?.() ?? []), ...(this.pi.getCommands?.() ?? [])];
			for (const it of items) {
				if (it.name === "zip_recall" || it.name === "zip") continue;
				const hay = `${it.name} ${it.sourceInfo?.path ?? ""} ${it.sourceInfo?.source ?? ""}`;
				const m = CONFLICT_RE.exec(hay);
				if (m) { found = m[0]; break; }
			}
		} catch {}
		this.conflict = found;
		if (found && !this.conflictNoticed) {
			this.conflictNoticed = true;
			this.stateLine(ctx, "paused", `${found} also manages context, so pi-zip only guards requests · to use pi-zip: pi remove the other one`, true);
		}
	}

	// ---- events ----------------------------------------------------------------------------------------------
	sessionStart(ctx: Any) {
		this.liveCtx = ctx;
		this.start = null; // a decision carried for a run of the session before is never handed to a run of this one
		this.startKind = null;
		this.cancelDoor(); // the idle door opens only after a run of this session (opening old history never compacts it)
		this.ranHere = false;
		this.idleNat = null;
		const branch = this.branch(ctx);
		this.version.since = Date.now(); // index.ts then calls refreshFolded, which reads the newest version entry
		for (let i = branch.length - 1; i >= 0; i--) {
			const en = branch[i];
			if (en?.type === "custom" && en.customType === STATE_CUSTOM) {
				this.off = !!en.data?.off;
				this.quiet = !!en.data?.quiet;
				break;
			}
		}
		for (const en of branch) if (en?.type === "custom" && en.customType === STEER_CUSTOM && Array.isArray(en.data?.ids)) for (const id of en.data.ids) if (typeof id === "string") this.steerIds.add(id);
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		this.model = ctx?.model;
		this.ttlNoticed = false;
		this.restoreState(branch);
		if (this.speed && process.env.PI_ZIP_MODE && process.env.PI_ZIP_MODE !== "speed") this.stateLine(ctx, "on", "unknown PI_ZIP_MODE; using speed", true, "mode:invalid");
		this.nextEdit = pendingSummary(branch) ? this.scaleOf(ctx).O : null;
		this.detectConflict(ctx);
		const recallFilesRemoved = attempt(cleanupRecall, 0); // recall copies older than 14 days (they can be written again from the session)
		this.ledger({ type: "session_start", off: this.off, quiet: this.quiet, conflict: this.conflict, ...(recallFilesRemoved ? { recallFilesRemoved } : {}) });
	}

	/** Opening a session only arms a future producer deadline; browsing old history never starts a call. */
	armProducer(ctx: Any) {
		if (this.speed) return this.prepareSpeed(ctx);
		this.want("timer", ctx, undefined, undefined, true);
	}

	/** What a process that never left would know: growth g and "the newest response carried an edit" are functions of the session,
	 *  rebuilt from the branch (state.ts; a restart, a resume or a fork plans like the live process),
	 *  and so are the summaries produced in the background (pi-zip/summary entries, read where they are used). */
	private restoreState(branch: Any[]) {
		try {
			const r = replayGrowth(branch, G0);
			this.g = r.g;
			this.deltas = r.deltas;
			this.justEdited = r.justEdited;
			this.rent = rentOf(branch);
			this.rentHead = headOf(branch);
			const ready = readyOf(branch).length;
			if (branch.length) this.ledger({ type: "state_restored", g: Math.round(this.g), justEdited: this.justEdited, ...(ready ? { ready } : {}) });
		} catch (err) {
			this.ledger({ type: "error", where: "restore_state", error: errText(err) });
		}
	}

	// ---- recall through files (research pi-tricks §2) -----------------------------------------------------------------------
	/** This machine's directory for this session's recall files. */
	private localRecallDir(ctx: Any): string | null {
		const sid = this.recallSid(ctx);
		return sid ? join(recallRoot(), sidDir(sid)) : null;
	}
	/** Write the originals of these handles (from the current branch) if they are not on disk as they are: their local paths. */
	private materializeHandles(ctx: Any, handles: string[]): Map<string, string> {
		const sid = this.recallSid(ctx);
		if (!sid || !handles.length) return new Map();
		const { items } = resolveHandlesInBranch(this.branch(ctx), handles);
		const found = items.filter((it): it is typeof it & { text: string } => it.text !== null);
		const out = materialize(recallRoot(), sid, found.map((it) => ({ handle: it.handle, text: it.text })));
		this.ledger({ type: "recall_file", handles: found.map((it) => it.handle), missing: handles.length - found.length, chars: found.reduce((a, it) => a + it.text.length, 0) });
		return out;
	}
	/** Every output this session's model no longer sees in full (folded, or summarised away): what a grep, ls or find over the directory needs. */
	private materializeAll(ctx: Any): string | null {
		const sid = this.recallSid(ctx);
		if (!sid) return null;
		let visible = new Set<string>();
		try {
			const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
			visible = new Set(entries.filter((pe) => pe?.sourceEntry?.type === "message" && pe.messages?.[0]?.role === "toolResult" && !textOf(pe.messages[0].content).startsWith(PH_MARK)).map((pe) => pe.sourceEntry.id));
		} catch {}
		const zipped = branchOutputs(this.branch(ctx)).filter((o) => o.tool !== RECALL_TOOL && !visible.has(o.entryId));
		materialize(recallRoot(), sid, zipped.map((o) => ({ handle: o.handle, text: o.text })));
		this.ledger({ type: "recall_file", all: true, count: zipped.length, chars: zipped.reduce((a, o) => a + o.text.length, 0) });
		return join(recallRoot(), sidDir(sid));
	}
	/**
	 * tool_call: a built-in read, grep, find or ls whose path names a recall file (or this session's recall directory), or a bash command
	 * that does, gets this machine's copy, written now from the current branch if it is not on disk yet. Any prefix is accepted (another
	 * machine, another user, a forked session's id): the handle is resolved against the current branch. Never blocks a call.
	 */
	toolCall(e: Any, ctx: Any): undefined {
		try {
			const input = e?.input, name = e?.toolName;
			if (!input || typeof input !== "object") return undefined;
			if ((name === "read" || name === "grep" || name === "find" || name === "ls") && typeof input.path === "string") {
				const ref = parseRecallPath(input.path);
				if (!ref) return undefined;
				if (ref.handle) {
					const local = this.materializeHandles(ctx, [ref.handle]).get(ref.handle);
					if (local) input.path = local;
				} else if (name !== "read") {
					const dir = this.materializeAll(ctx);
					if (dir) input.path = dir;
				}
			} else if (name === "bash" && typeof input.command === "string" && commandNamesRecall(input.command)) {
				const dir = this.localRecallDir(ctx);
				if (!dir) return undefined;
				const r = rewriteCommand(input.command, dir);
				if (r.dir) this.materializeAll(ctx);
				else this.materializeHandles(ctx, r.handles);
				input.command = r.command;
			}
		} catch (err) {
			this.ledger({ type: "error", where: "tool_call", error: errText(err) });
		}
		return undefined;
	}

	shutdown() {
		this.cancelTimer();
		this.cancelDoor();
		this.ranHere = false; // a door reading its clock now never arms again
		// a call still running is lost with the process: aborted, recorded as one unused call at the input it is billed for (a restarted
		// process decides without it, as without any summary in flight); finished summaries are in the session already, or written now
		this.discardBg("shutdown");
		this.writeUnwritten();
	}

	/** What the idle input of the newest prompt decided, until that prompt's run takes it at agent_start (start). Every other run start
	 *  and every later idle input drops it; a prompt that starts no run (another extension handled it, Pi refused the model or its auth)
	 *  leaves only this, which the next of those drops. */
	private start: Start | null = null;
	/** What the newest before_agent_start announced, until its agent_start: the prompt's run, or (Pi 1.2.0) a run an extension's message
	 *  starts, already begun there. Pi 1.1.0 emits only agent_start for the latter (sendMessage with triggerTurn: pi-runway's owed-drive,
	 *  durable-subagents' attention). */
	private startKind: "prompt" | "driven" | null = null;
	private starting: Promise<void> | null = null;
	private inputBusy = false; // an idle input is being handled (its native compaction may be in flight): a second one is not
	private runStarts = 0; // runs announced so far: an input's decision goes to no run that started while it was being handled

	/** Pi's input event of a prompt (typed, or an extension's sendUserMessage). Pi waits for it before it expands the prompt and starts the
	 *  run, and is idle here on Pi 1.1.0 and 1.2.0 (1.2.0 counts the starting run as busy from before_agent_start on, and compact() would
	 *  abort it): the one place a summary prepared while the user was away goes in through Pi's compaction. The run is not entered here:
	 *  the idle timer stays armed (re-armed after a compaction) and nothing of the run is set, so a prompt that starts no run leaves pi-zip
	 *  as it was, apart from the compaction, which is pi-zip's own summary with its exact size before. A steer or a follow-up (Pi is
	 *  streaming) belongs to the run in progress. */
	async input(e: Any, ctx: Any): Promise<void> {
		if (this.speed) return; // automatic compaction owns adoption; input has no fresh user ID yet
		if (e?.streamingBehavior) return;
		this.inputs++;
		if (this.door) await this.door; // the idle door at work: it sees this input and stays shut, or its compaction (milliseconds) ends first
		// Pi emits the same idle input for steer()/followUp() called while idle (RPC, the TUI's queue after a compaction): no field tells it
		// from a prompt. Two inputs can overlap (that queue sends a prompt and then its rest without waiting): the second gate check could
		// pass before the first ctx.compact() sets Pi's controller (compact awaits abort() first). The later one is skipped and changes nothing.
		if (this.inputBusy) return void this.ledger({ type: "native_skip", reason: "an earlier input is still being handled" });
		this.inputBusy = true;
		try {
			await this.idleInput(e, ctx);
		} finally {
			this.inputBusy = false;
		}
	}

	private async idleInput(e: Any, ctx: Any): Promise<void> {
		// not idle: Pi refuses this prompt (a run is starting or in progress: what it announced stays as it is), or a Pi that cannot say so
		if (!idleOf(ctx)) return;
		this.start = null; // a new prompt: what an earlier one decided (it started no run) is dropped
		this.startKind = null;
		if (!this.active()) return; // its run (if any) reads its own start
		this.detectConflict(ctx);
		if (!this.active()) return;
		this.liveCtx = ctx;
		const runs = this.runStarts;
		const s = await this.readStart(ctx, true);
		const ready = readyOf(this.branch(ctx), this.mine).length > 0;
		if (s.clk.cold && this.bg && !ready) s.note = { native: "summary not finished when the prompt came" };
		if (ready) await this.compactReady(ctx, e, s, "input");
		s.head = headOf(this.branch(ctx));
		if (runs === this.runStarts) this.start = s; // a run that started meanwhile is not this prompt's: it read its own start
		else this.ledger({ type: "start_dropped", reason: "a run started while the prompt's input was handled", native: !!s.nat });
	}

	/** before_agent_start: the prompt's run (its input carried the decision), or on Pi 1.2.0 a run an extension's message starts
	 *  (messageType "custom"), which begins here, once, as a driven run. */
	async beforeAgentStart(ctx: Any, e?: Any): Promise<void> {
		if (this.speed) { this.startKind = e?.messageType === "custom" ? "driven" : "prompt"; this.detectConflict(ctx); return; }
		this.runStarts++;
		if (e?.messageType === "custom") {
			this.start = null;
			this.startKind = "driven";
			await this.drivenStart(ctx);
			return;
		}
		this.startKind = "prompt";
	}

	/** agent_start: the run begins (a prompt that fails between before_agent_start and here, in Pi's image normalisation, enters none). The
	 *  prompt's run takes what its input decided; a run an extension's message started (no before_agent_start on Pi 1.1.0) gets the same
	 *  start-of-run handling, minus Pi's compaction (ctx.compact() aborts the run that is starting): a prepared summary waits for turn_end. */
	async agentStart(ctx: Any): Promise<void> {
		if (this.speed) { this.runStarts++; this.inRun = true; this.runUserSeen = this.startKind === "driven" ? 1 : 0; this.startKind = null; this.liveCtx = ctx; this.model = ctx.model; return; }
		const kind = this.startKind, s = this.start;
		this.runStarts++;
		this.startKind = null;
		this.start = null;
		if (kind === "driven") return;
		if (kind !== "prompt") return this.drivenStart(ctx);
		this.promptStart = true; // its first message says whether it really is the prompt's run (messageEnd)
		await this.beginRun(ctx, true, s).catch((err) => this.ledger({ type: "error", where: "agent_start", error: errText(err) })); // Pi awaits it before the first request
	}

	private drivenStart(ctx: Any): Promise<void> {
		const door = this.door ?? Promise.resolve(); // the idle door's compaction in flight goes in first: the run starts on it
		this.starting = door.then(() => this.beginRun(ctx, false))
			.catch((err) => this.ledger({ type: "error", where: "agent_start", error: errText(err) }))
			.then(() => {
				this.runUserSeen = 1; // no prompt in this run: a user message that comes later is steering
				this.ledger({ type: "driven_run" });
			});
		return this.starting;
	}

	/** Set at an agent_start taken for the prompt's run: before_agent_start fired, but a prompt can still fail before its run starts (Pi's
	 *  image normalisation), and then on Pi 1.1.0 the next agent_start belongs to a run an extension's message starts. A prompt's run
	 *  begins with the user message; a driven run with the custom message: seen at that first message_end, before the run's first request. */
	private promptStart = false;

	agentEnd() {
		this.startKind = null;
		this.promptStart = false;
		this.inRun = false;
		this.writeUnwritten();
		const s = this.version, d = { v: s.v, pi: s.pi, since: s.since }; // at the end of a run, unless the newest entry on this branch says the same
		if (!(s.last?.v === d.v && s.last?.pi === d.pi)) attempt(() => this.pi.appendEntry(VERSION_CUSTOM, (s.last = d)), undefined);
	}

	/** The start of a run read from the branch now (Start without the native decision): at a prompt's idle input, or at the start of
	 *  any other run. */
	private async readStart(ctx: Any, viaPrompt: boolean): Promise<Start> {
		const branch = this.branch(ctx);
		this.rent = rentOf(branch);
		this.rentHead = headOf(branch);
		this.loadEnt(modelKey(ctx.model));
		await this.resolveRetention(ctx);
		const clk = clock(branch, { model: ctx.model, ent: this.ent, tier: this.tier(ctx.model) }, Date.now(), { reqMs: this.lastReqMs, modelKey: this.lastModelKey });
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		let settleIds: string[] = [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const en = branch[i];
			if (en?.type !== "custom" || en.customType !== PLAN_CUSTOM) continue;
			if (en.data?.policy === PRODUCT && clk.cold && Array.isArray(en.data.targets)) settleIds = en.data.targets.map((t: Any) => (typeof t === "string" ? t : t?.entryId)).filter((x: Any) => typeof x === "string");
			break;
		}
		return { clk: { ...clk, pause: viaPrompt && clk.pause }, settleIds, note: null, nat: null, foreign: false, head: headOf(branch), model: modelKey(ctx.model) };
	}

	private async beginRun(ctx: Any, viaPrompt: boolean, carried: Start | null = null): Promise<void> {
		this.liveCtx = ctx;
		this.inRun = true;
		this.cancelTimer(); // the user is back: nothing is started behind their back any more
		this.cancelDoor();
		this.ranHere = true;
		const door = this.idleNat;
		this.idleNat = null;
		this.model = ctx?.model;
		this.cold = false;
		this.turnWhy = ""; // a turn_end's judgement belongs to its run
		this.pause = false;
		this.runChecked = true;
		this.runEdits = false;
		this.runPlan = null;
		this.nativeRun = null;
		this.foreignRun = false;
		this.settleIds = [];
		this.wireLedgered = false;
		this.runUserSeen = 0;
		this.logForeign(ctx, "run");
		if (!this.active()) return;
		this.detectConflict(ctx);
		if (!this.active()) return;
		const branch = this.branch(ctx);
		// another compaction went in between the prompt's input and its run (Pi's own, say): the decision priced another projection
		// or another model was chosen (the clock, the settings and the retention were read for the old one)
		const changed = !carried ? null : carried.head !== headOf(branch) ? "the projection" : carried.model !== modelKey(ctx.model) ? "the model" : null;
		if (carried && changed) {
			this.ledger({ type: "start_dropped", reason: `${changed} changed between the prompt and its run`, native: !!carried.nat });
			carried = null;
		}
		const s = carried ?? (await this.readStart(ctx, viaPrompt));
		// a summary that went in through the idle door: this run carries its decision, as a typed prompt's run carries its input's
		if (door && !s.nat) {
			const moved = door.head !== headOf(branch) ? "the projection" : door.model !== modelKey(ctx.model) ? "the model" : null;
			if (moved) this.ledger({ type: "start_dropped", reason: `${moved} changed after the idle door`, native: true });
			else [s.nat, s.note] = [door.nat, door.note];
		}
		this.readyAtStart = new Set(readyOf(branch, this.mine).map((a) => a.key));
		if (!this.prevKey) ({ key: this.prevKey, total: this.prevTotal } = lastPrompt(branch)); // fresh process: the session's newest response
		const { cold, reason, ttl, pWarm: p, src, gapS, pause } = s.clk;
		this.cold = cold;
		this.pause = pause;
		this.pWarm = p;
		this.survSrc = src;
		this.runChecked = false; // the first request decides (cold: the cold plan; warm: only above the cap, if the law fires)
		this.coldReason = reason;
		this.coldWhy = src === "model switch" ? "cache cold · model switched" : cold && gapS !== null ? `cache cold · away ${fmtAway(gapS)}` : ""; // the warm form says "cache warm · worth it at this size"
		this.settleIds = s.settleIds;
		this.ledger({ type: "prompt", cold, reason, ttlMs: ttl.ms, ttlSource: ttl.source, settleTargets: this.settleIds.length, gapS: gapS === null ? null : Math.round(gapS), pWarm: Math.round(p * 1000) / 1000, survSrc: src, cls: this.ent?.cls ?? null });
		if (ttl.note && !this.ttlNoticed) {
			this.ttlNoticed = true; // once per session
			if (!this.quiet) this.stateLine(ctx, "cache", ttl.note.replace(`${PRODUCT} · `, ""));
		}
		// a summary written in the background went in through Pi's compaction at the prompt's idle input (input), cold return or warm
		this.nativeRun = s.nat;
		this.foreignRun = s.foreign;
		this.nativeNote = s.note;
		const ready = readyOf(branch, this.mine).length > 0;
		if (!viaPrompt && (ready || this.bg)) this.nativeNote = { native: "run started by an extension's message: draft path (compact() would abort it)" };
		else if (!carried && ready) this.nativeNote = { native: "no idle input before this prompt's run" };
	}

	/** Read the actual selected model and settings at every speed decision; unavailable information fails closed. */
	private speedState(ctx: Any, entries?: Any[], drafts: Any[] = []) {
		if (!this.active() || !this.recallSid(ctx)) return null;
		if (this.recallMode !== "tool" && !this.fileRecall(ctx)) return null;
		try {
			const settings = this.pi.getSettings?.(), model = ctx.model;
			if (!settings || typeof settings !== "object") return null;
			const branch = this.branch(ctx), view = entries ?? ctx.sessionManager.buildSessionProjection().entries;
			const epoch = digest([this.sessionId(ctx), headOf(branch), modelKey(model), model?.baseUrl]);
			if (this.speedEpoch !== epoch) {
				this.speedEpoch = epoch;
				this.speedDeltas = [];
				this.speedVelocity = 250;
				this.speedSample = null;
			}
			const p = pressure(model, settings, this.speedDeltas, this.speedVelocity, this.speedDurations.get(modelKey(model)) ?? []);
			if (!p) return null;
			const identity = digest([this.sessionId(ctx), headOf(branch), model, settings?.compaction ?? {}, this.sysInfo(ctx), this.recallMode, this.fileRecall(ctx)]);
			const tokens = piContextTokens(view, branch, drafts);
			if (!Number.isFinite(tokens) || tokens < 0) return null;
			return { p, settings, branch, view, identity, model, scale: this.scaleOf(ctx, view), tokens };
		} catch { return null; }
	}

	/** Speed candidates are scoped by configuration as well as head/cut; keep an older valid model's artifact on a switch back. */
	private speedArtifacts(branch: Any[]): Artifact[] {
		const byPrefix = new Map<string, Artifact>();
		for (const a of [...artifactsOf(branch), ...this.mine]) if (a.speed && a.head === headOf(branch)) byPrefix.set(digest([a.speed.identity, a.speed.prefix]), a);
		return [...byPrefix.values()];
	}

	private fittingSpeed(a: Artifact, state: NonNullable<ReturnType<Zip["speedState"]>>) {
		const { cut, speed } = a;
		if (cut?.llmOk !== true || typeof cut.text !== "string" || !cut.text.trim() || !speed || !Number.isSafeInteger(speed.target) || speed.target <= 0 || speed.target >= state.p.T || this.speedRejected.has(digest(speed)) || speed.identity !== state.identity || a.head !== headOf(state.branch)) return null;
		const blocks = buildBlocks(state.view, this.steerIds), at = blocks.findIndex(b => b.entryId === cut.firstKeptEntryId);
		if (at < 1 || prefixDigest(blocks, at) !== speed.prefix || !safeCut(blocks, at, state.model)) return null;
		if (blocks.slice(at).reduce((n, b) => n + piTokensOf(b.msg), 0) < state.p.keep) return null;
		const after = afterSize(blocks, at, cut.text, state.scale);
		return after <= speed.target ? { after, cut, speed } : null;
	}

	/** Fire and forget: no caller awaits a worker or its cancellation. Existing artifacts retain all charges. */
	private prepareSpeed(ctx: Any, entries?: Any[], drafts: Any[] = [], sample = true) {
		if (ctx?.signal?.aborted) return; // Esc belongs to the foreground; a valid worker keeps its own signal
		this.liveCtx = ctx;
		const state = this.speedState(ctx, entries, drafts);
		if (!state) { this.discardBg("replaced"); return; }
		const { branch, view, model, identity, tokens, scale } = state;
		const head = headOf(branch);
		// Only main boundaries observe growth. A worker wake checks readiness against the current projection.
		if (sample) {
			const now = performance.now(), mk = modelKey(model), prior = this.speedSample;
			if (prior && prior.head === head && prior.model === mk && tokens > prior.tokens) {
				const delta = tokens - prior.tokens;
				this.speedDeltas = [...this.speedDeltas.slice(-19), delta];
				if (this.inRun && prior.run === this.runStarts) this.speedVelocity = .9 * this.speedVelocity + .1 * delta / Math.max(.1, (now - prior.at) / 1000);
			}
			this.speedSample = { head, model: mk, tokens, at: now, run: this.runStarts };
		}
		const p = pressure(model, state.settings, this.speedDeltas, this.speedVelocity, this.speedDurations.get(modelKey(model)) ?? [])!;
		state.p = p;
		const artifacts = this.speedArtifacts(branch);
		if (this.bg) {
			const blocks = buildBlocks(view, this.steerIds), at = blocks.findIndex(b => b.entryId === this.bg!.key);
			if (this.bg.head !== head || this.bg.speed?.identity !== identity || at < 1 || prefixDigest(blocks, at) !== this.bg.speed.prefix) this.discardBg("replaced");
		}
		if (tokens < p.P || this.bg || artifacts.some(a => this.fittingSpeed(a, state))) return;
		const desired = speedPlan(view, model, p, scale, this.steerIds, identity);
		if (!desired?.speed || artifacts.some(a => !a.cut?.llmOk && a.speed?.identity === identity && a.speed?.prefix === desired.speed!.prefix)) return;
		// A now-oversized ready result stays immutable while a deeper legal prefix is prepared.
		const blocks = desired.blocks;
		const skip = new Set(artifacts.filter(a => a.cut?.llmOk && a.speed?.identity === identity && prefixDigest(blocks, blocks.findIndex(b => b.entryId === a.key)) === a.speed.prefix).map(a => a.key));
		const plan = skip.size ? speedPlan(view, model, p, scale, this.steerIds, identity, skip) : desired;
		if (!plan?.speed) return;
		if (this.fileRecall(ctx)) plan.fileRecall = this.fileRecall(ctx);
		const tried = digest([plan.speed.identity, plan.speed.prefix]);
		if (this.speedTried.has(tried) || [...artifactsOf(branch), ...this.mine].some(a => a.head === head && a.speed?.identity === identity && a.speed?.prefix === plan.speed!.prefix)) return;
		this.speedTried.add(tried);
		this.startBg(plan, ctx);
	}

	private speedCompaction(e: Any, ctx: Any) {
		if (!ctx || !["threshold", "overflow"].includes(e?.reason) || e.signal?.aborted) return undefined;
		const state = this.speedState(ctx);
		const miss = () => { this.ledger({ type: "missed_ready", reason: e.reason }); return undefined; };
		if (!state || digest(e.branchEntries) !== digest(state.branch) || state.tokens < state.p.T && e.reason !== "overflow") return miss();
		for (const a of this.speedArtifacts(state.branch).reverse()) {
			const fit = this.fittingSpeed(a, state);
			if (!fit) continue;
			this.speedSelected = fit.speed;
			return { compaction: { summary: fit.cut.text, firstKeptEntryId: fit.cut.firstKeptEntryId,
				tokensBefore: state.tokens, usage: fit.cut.usage,
				details: { by: PRODUCT, via: "speed", target: fit.speed.target, after: fit.after } } };
		}
		return miss();
	}

	sessionCompacted(e: Any, ctx: Any) {
		if (!this.speed) return;
		const saved = e.compactionEntry;
		if (!this.branch(ctx).some(en => en.id === saved?.id)) return;
		this.discardBg("replaced");
		this.speedSelected = null;
		this.speedEpoch = "";
		this.speedSample = null;
		this.speedDeltas = [];
		this.speedVelocity = 250;
		if (saved?.details?.by !== PRODUCT || saved.details.via !== "speed") return;
		const a = [...this.mine, ...this.branch(ctx).filter(en => en.customType === SUMMARY_CUSTOM).map(en => en.data)].find(a => a.speed && a.cut?.text === saved.summary && a.key === saved.firstKeptEntryId);
		if (!a || saved.details.after > a.speed!.target) return;
		this.stats.summaries++;
		this.ledger({ type: "summary", via: "speed", waitedMs: 0, target: a.speed!.target, after: saved.details.after });
	}

	/** Reject the selection after failure. Pi may already have changed its in-memory branch before a disk write fails. */
	sessionCompactFailed() {
		if (this.speedSelected) this.speedRejected.add(digest(this.speedSelected));
		this.speedSelected = null;
	}

	/** session_before_compact: answers ONLY the compaction pi-zip itself asked for a moment ago (nativeAsk): its own summary and its own
	 *  tokensBefore. Pi's threshold and overflow compactions, /compact and other extensions' compactions get undefined and run untouched.
	 *  Once pi-zip has given up on its compaction (compaction null), a late ask of it is cancelled, never one with a live signal: that is
	 *  another compaction (pi-zip's own was aborted). */
	sessionBeforeCompact(e?: Any, ctx?: Any): Any {
		if (this.speed) return this.speedCompaction(e, ctx);
		const a = this.nativeAsk;
		if (typeof e?.customInstructions === "string" && e.customInstructions.startsWith(NATIVE_MARKER)) {
			// pi-zip's own compaction: answered, once, while its ask is open; cancelled otherwise (never left to Pi's default summariser, which
			// would write a summary of the whole transcript with the marker as its instruction)
			if (a && !a.answered && a.compaction && Date.now() <= a.until) {
				a.answered = true;
				a.askedAt = performance.now();
				a.askedWall = Date.now();
				return { compaction: a.compaction };
			}
			if (a && !a.answered) {
				a.answered = true;
				a.askedAt = performance.now();
				a.askedWall = Date.now();
			}
			return { cancel: true };
		}
		if (!a || a.answered || Date.now() > a.until) return undefined;
		if (e?.reason !== undefined && e.reason !== "manual") return undefined; // ctx.compact() is a manual compaction
		if (!a.compaction && e?.signal && e.signal.aborted !== true) return undefined;
		a.answered = true;
		a.askedAt = performance.now();
		a.askedWall = Date.now();
		return a.compaction ? { compaction: a.compaction } : { cancel: true };
	}

	/** The native path ends for the rest of the process (logged once): later summaries wait for turn_end. */
	private endNative(reason: string) {
		if (this.nativeOff) return;
		this.nativeOff = reason;
		this.ledger({ type: "native_off", reason });
	}

	/** Why Pi's own compaction cannot take this summary now (null: it can). Each reason defers the summary
	 *  to a turn_end compaction draft. */
	private nativeGate(ctx: Any, branch: Any[], pre: Any[]): string | null {
		if (this.nativeOff) return "off for this process";
		if (typeof ctx?.compact !== "function") return "no ctx.compact";
		if (typeof ctx?.abort !== "function") return "no ctx.abort"; // what cancels a compaction another handler holds up
		// another extension's compaction is the newest an extension supplied (its handler would run for pi-zip's too); an older one, from an extension since removed, says nothing
		if (foreignCompaction(branch.filter((en: Any) => en?.type === "compaction" && en.fromHook).at(-1))) return "another extension's compaction is the newest in this branch";
		if (!idleOf(ctx)) return "not idle"; // compact() aborts whatever runs first: only ever called while Pi is idle
		if (branch[branch.length - 1]?.type === "compaction") return "already compacted";
		if (!piCanCompact(pre, keepRecentTokensFor(attempt(() => this.pi.getSettings?.(), undefined), ctx?.model))) return "nothing to compact";
		return null;
	}

	/**
	 * A summary prepared while the user was away goes into the session through Pi's own compaction, at the prompt's input (research pi-tricks
	 * §1b, variant 1): ctx.compact() with session_before_compact answering pi-zip's summary and pi-zip's own tokensBefore (the notice's
	 * "before", provider scale), so Pi's "[compaction] Compacted from N tokens" shows that number. It takes milliseconds: the summary is
	 * done. The run plan folds the resulting projection; a closed native door defers the summary to turn_end.
	 * Pi runs every extension's session_before_compact handler for it (the last answer wins, a cancel stops it): another extension's
	 * compaction going in, or a failure, ends the native path for the process (endNative). A compaction not finished by the deadline is
	 * cancelled (at the idle door, while no run is announced); the second such miss in a row ends the path too, and a summary prepared for a context another extension's compaction has replaced is never used (its head is gone).
	 */
	private async nativeSummary(ctx: Any, e: Any, s: Start, door: "input" | "idle" = "input"): Promise<void> {
		const branch = this.branch(ctx);
		const pre = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		const skip = (reason: string) => {
			s.note = { native: reason };
			this.ledger({ type: "native_skip", reason });
		};
		// Select once with the prompt Pi is about to append; its jointly priced folds become the first request's plan.
		const pending = pendingPrompt(e), entries = pending ? [...pre, pending] : pre;
		const { pWarm, pause, cold } = s.clk;
		const d = decideEdits({ at: "native", justEdited: this.justEdited, pWarm, entries, ready: this.ready(branch),
			opts: (cutAt, foldsOnly, ready) => this.opts(ctx, !pending, entries, pWarm, pause, cutAt, foldsOnly, ready) });
		for (const n of d.notes) this.ledger(n);
		if (d.kind === "b2b") return skip("a warm return right after an edited request makes no edit (b2b)");
		const { o, cal, p } = d;
		const art = p && p.cutIdx !== null ? readyOf(branch, this.mine).find((a) => a.key === p.firstKeptEntryId) : undefined;
		if (!p || !art?.cut) return skip(!p || p.cutIdx === null ? "the summary does not fit this plan: the plan at the prompt has no cut" : this.bg?.key === p.firstKeptEntryId ? "summary not finished when the prompt came" : "the summary does not fit this plan: the plan at the prompt cuts elsewhere");
		const cut = art.cut;
		if (p.folds.some((t) => p.blocks.findIndex((b) => b.entryId === t.entryId) < p.cutIdx!)) throw new Error("native fold target must be kept after the cut");
		if (checkEdits(p.blocks, p.userTurns, p.folds, cut)) return skip("guard");
		const gate = this.nativeGate(ctx, branch, pre);
		if (gate) return skip(gate);
		const before = Math.round(p.ctxTokens);
		const trigger: Cut["trigger"] = cold ? "cold" : "valve"; // the return that adopts it labels it (written early for a warm one, say)
		const compaction = { summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: before, details: { by: PRODUCT, via: "native", trigger, ...(door === "idle" ? { door } : {}) }, usage: cut.usage };
		const known = new Set(branch.map((en: Any) => en?.id));
		const ask = { compaction: compaction as Any | null, answered: false, askedAt: 0, askedWall: 0, until: Infinity };
		this.cancelTimer(); // no producer call starts while Pi compacts (input arms the timer again)
		this.nativeAsk = ask;
		const runs0 = this.runStarts;
		const deadline = nativeDeadlineMs(), t0 = performance.now();
		const res = await new Promise<{ ok: boolean; err?: string; late?: boolean }>((resolve) => {
			let settled = false;
			const finish = (r: { ok: boolean; err?: string; late?: boolean }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(r);
			};
			const timer = setTimeout(() => {
				// the idle door's compaction, once a run is announced (Pi does not hold an extension's message back), goes in however long it
				// takes: that run waits on it (drivenStart), ctx.abort() would end it too. Before that, a slow handler is cancelled as at input
				if (door === "idle" && this.runStarts !== runs0) return;
				if (!ask.answered) ask.compaction = null; // asked after this, pi-zip cancels: never Pi's own summary on pi-zip's behalf
				ask.until = Date.now() + 60_000;
				finish({ ok: false, late: true });
			}, deadline);
			timer.unref?.();
			const done = (r: { ok: boolean; err?: string }) => {
				if (this.nativeAsk === ask) this.nativeAsk = null; // pi-zip's compaction is over: nothing is answered for it any more
				finish(r);
			};
			try {
				ctx.compact({ customInstructions: NATIVE_MARKER, onComplete: () => done({ ok: true }), onError: (err: Any) => done({ ok: false, err: err instanceof Error ? err.message : String(err) }) });
			} catch (err) {
				done({ ok: false, err: errText(err) });
			}
		});
		const ms = Math.round(performance.now() - t0), askMs = ask.askedAt ? Math.round(ask.askedAt - t0) : null;
		// what went in: compactions added since the call (pi-zip's is the one carrying its summary; Pi keeps the last handler's answer)
		const added = this.branch(ctx).filter((en: Any) => en?.type === "compaction" && !known.has(en?.id));
		const last = added[added.length - 1] ?? null;
		const entry = last && last.summary === cut.text ? last : null;
		// still pending at the deadline: cancel it now, before the run starts (Pi checks its abort signal right before it appends; at the idle
		// door, no run was announced to pi-zip at the deadline, and only microtasks ran since)
		if (res.late && !last) attempt(() => ctx.abort?.(), undefined);
		// logged only: the time before ours (askMs: Pi's own preparation and earlier handlers) plus, for handlers after ours, our answer to the
		// entry's own append (appendCompaction stamps it), without Pi's work after the append (context refresh, projection, chat rebuild).
		const appendedAt = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
		const handlerMs = entry && askMs !== null ? askMs + (Number.isFinite(appendedAt) && ask.askedWall ? Math.max(0, appendedAt - ask.askedWall) : 0) : ms;
		// a slow compaction that went in ends nothing (on a large branch Pi's own work alone passed 250 ms, closing both doors for 12 h);
		// a deadline miss cancels this one, and a second in a row ends the native path (a handler at work at every compaction)
		this.nativeLate = entry ? 0 : res.late && !last ? this.nativeLate + 1 : this.nativeLate;
		const lateWhy = ask.answered ? `Pi's compaction was not done ${deadline} ms after pi-zip answered` : `another session_before_compact handler ran before pi-zip's for ${deadline} ms`;
		const off = entry
			? added.length > 1 ? "another compaction went in as well" : null
			: last ? "another extension's compaction went in instead of pi-zip's"
			: res.late ? (this.nativeLate >= 2 ? `${lateWhy}, twice in a row (cancelled)` : null)
			: `Pi's compaction failed: ${res.err ?? "no compaction entry"}`;
		if (off) this.endNative(off);
		s.note = { native: entry && !off ? "ok" : (off ?? (res.late ? `${lateWhy} (cancelled)` : "failed")), ms, ...(askMs !== null ? { askMs } : {}) };
		if (!entry?.id) {
			this.ledger({ type: "native_fail", ms, askMs, handlerMs, answered: ask.answered, error: res.late ? "deadline" : (res.err ?? "no compaction entry"), foreign: !!last, ...(res.late ? { late: this.nativeLate } : {}) });
			if (last) {
				// Another extension replaced this summary's prefix: discard it and use only folds for the first request.
				this.discardBg("replaced");
				s.foreign = true;
			}
			return; // nothing went in: the prepared summary waits for turn_end
		}
		// the summary is in the session from now on, whatever the run does: book it here (commit() does not book it again), the way a
		// draft of the same kind is booked: a cold return's saves a rewrite, a warm one is a valve edit of the warm cache
		const cutSaved = Math.round(p.scale.c * (cut.prefixTokens - cut.summaryTokens));
		this.rent = 0;
		s.nat = { cut, before, after: Math.round(p.ctxAfterFolds - cutSaved), o, cal, p };
		const st = this.stats;
		st.summaries++;
		st.summarizedTokens += cutSaved;
		st.activeSaved += cutSaved;
		if (cold) st.writeSavedTokens += cutSaved;
		else {
			st.pressureEdits++;
			st.pressureRewriteTokens += before;
		}
		this.ledger({ type: "summary", via: "native", ...(door === "idle" ? { door } : {}), handlerMs, trigger, source: cold ? "settle" : "valve", count: cut.count, tokensBefore: before, prefixTokens: Math.round(p.scale.c * cut.prefixTokens), summaryTokens: Math.round(p.scale.c * cut.summaryTokens), ms: cut.ms, compactMs: ms, askMs, waitedMs: 0, llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
	}

	private cancelDoor() {
		this.doorGen++;
		if (this.doorTimer) clearTimeout(this.doorTimer);
		this.doorTimer = null;
	}

	/**
	 * The idle door ("\u03b5"): a summary ready while Pi is idle goes in through Pi's compaction at the first moment the return's own
	 * decision (the typed door's, unchanged: decideEdits "native" at the return's P(warm)) takes it: now (`now`: a summary just finished),
	 * then at each moment that P(warm) changes. The next run, typed or started by an extension's message, carries it from its first
	 * request (before, an extension's run wrote the whole folded context first). Armed only after a run of this process; TUI only: it
	 * queues what is typed while Pi compacts, where RPC (sub-agents) refuses the prompt.
	 */
	private armDoor(ctx: Any, now: boolean) {
		this.cancelDoor();
		if (!idleDoorOn() || !this.ranHere || ctx?.mode !== "tui" || !this.active() || this.inRun || this.idleNat || this.nativeOff || typeof ctx?.compact !== "function") return;
		try {
			const branch = this.branch(ctx), t = Date.now(), at = !readyOf(branch, this.mine).length ? null : now ? t : this.doorNext(ctx, branch, t);
			if (at === null) return;
			const gen = this.doorGen;
			this.doorTimer = setTimeout(() => {
				this.doorTimer = null;
				if (gen === this.doorGen && !this.door) this.door = this.idleDoor(ctx).finally(() => { this.door = null; });
			}, Math.max(0, at - t));
			this.doorTimer.unref?.();
		} catch (err) {
			this.ledger({ type: "error", where: "idle_door_arm", error: errText(err) });
		}
	}

	/** The next moment after `nowMs` at which a return's P(warm) differs from a return's now (null: it never changes again). */
	private doorNext(ctx: Any, branch: Any[], nowMs: number): number | null {
		const touch = Math.max(this.lastReqMs, lastMessageMs(branch));
		if (!touch) return null;
		this.loadEnt(modelKey(ctx.model));
		const lam = { model: ctx.model, ent: this.ent, tier: this.tier(ctx.model) }, last = { reqMs: this.lastReqMs, modelKey: this.lastModelKey };
		const c = clock(branch, lam, nowMs, last), tau = c.ttl.ms / 1000;
		for (const g of [...new Set([...GAP_EDGES, tau])].sort((a, b) => a - b)) {
			const t = touch + (g + 1) * 1000; // just past the edge: the bins are [edge, next edge), the TTL prior is 1 up to the TTL itself
			if (t > nowMs && clock(branch, lam, t, last).pWarm !== c.pWarm) return t;
		}
		return null;
	}

	/** One evaluation of the idle door (armDoor), nothing while a run, an input or a compaction is under way: the typed door's gates (not
	 *  idle: Pi compacting, a run just ending; the next moment decides), its decision and its compaction. */
	private async idleDoor(ctx: Any): Promise<void> {
		if (!idleDoorOn() || !this.active() || !ctx?.model || this.inRun || this.inputBusy || this.nativeAsk || this.idleNat) return;
		// a prompt's decision not taken by a run yet (another extension handled the prompt, or Pi refused it): the next moment decides
		if (this.start || this.startKind) return void (this.ledger({ type: "idle_door", taken: false, reason: "a prompt's start is pending" }), this.armDoor(ctx, false));
		const inputs = this.inputs, runs = this.runStarts, gen = this.doorGen;
		this.inputBusy = true; // the typed door and the idle door never overlap
		let again = false; // only the door was armed again meanwhile (a summary finished): it asks once this evaluation ends
		try {
			this.liveCtx = ctx;
			const s = await this.readStart(ctx, false);
			if (inputs !== this.inputs || runs !== this.runStarts || this.inRun || gen !== this.doorGen || !this.active()) { // that prompt or run reads its own start
				again = inputs === this.inputs && runs === this.runStarts && !this.inRun;
				return void this.ledger({ type: "idle_door", taken: false, reason: "a prompt, a run, /zip or a new summary came while the door read its clock" });
			}
			await this.compactReady(ctx, undefined, s, "idle");
			this.ledger({ type: "idle_door", taken: !!s.nat, pWarm: Math.round(s.clk.pWarm * 1000) / 1000, gapS: s.clk.gapS === null ? null : Math.round(s.clk.gapS), ...(s.nat ? {} : { reason: s.note?.native ?? null }) });
			if (s.nat) this.idleNat = { nat: s.nat, note: { ...s.note, native: "idle" }, head: headOf(this.branch(ctx)), model: s.model };
			else if (!this.inRun) this.armDoor(ctx, false);
		} catch (err) {
			this.ledger({ type: "error", where: "idle_door", error: errText(err) });
		} finally {
			this.inputBusy = false;
			if (again) this.armDoor(ctx, true);
		}
	}

	/** A door's compaction (nativeSummary); the producer's timer, stopped for it, armed again unless a run started meanwhile. */
	private async compactReady(ctx: Any, e: Any, s: Start, door: "input" | "idle") {
		const gen = this.timerGen;
		try {
			await this.nativeSummary(ctx, e, s, door);
		} catch (err) {
			const a = this.nativeAsk as Zip["nativeAsk"]; // set again inside nativeSummary
			if (a && !a.answered) a.compaction = null; // a late ask of pi-zip's compaction is cancelled, never left to Pi's own summary
			this.ledger({ type: "error", where: "native_summary", ...(door === "idle" ? { door } : {}), error: errText(err) });
		}
		if (gen !== this.timerGen && !this.inRun) this.armProducer(ctx);
	}

	private cancelTimer() {
		this.timerGen++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** End the call unused and book its estimated input at once, including its in-memory artifact.
	 *  Its asynchronous cancellation persists the record; shutdown flushes it before exit. */
	private discardBg(why: "replaced" | "shutdown" | "off") {
		const b = this.bg;
		if (!b || b.aborted) return;
		b.aborted = true;
		this.stats.summaryUsd += b.estUsd;
		this.ledger({ type: "unused_summary", key: b.key, why });
		this.record({ head: b.head, key: b.key, usd: b.estUsd, estimated: true, lost: why }, true);
		b.controller.abort();
		void Promise.resolve().then(() => { if (!this.inRun) this.writeUnwritten(); });
	}

	/** A record is readable from `mine` at once. Completed calls append a custom entry between runs; inside a run it waits for drafts.
	 *  Cancellation queues it for the call's asynchronous flush or shutdown, so a timer never appends an entry itself. */
	private record(a: Artifact, deferred = false) {
		this.mine.push(a);
		if (this.inRun || deferred) this.unwritten.push(a);
		else this.write(a);
	}
	private write(a: Artifact) {
		attempt(() => this.pi.appendEntry(SUMMARY_CUSTOM, a), undefined);
	}
	private writeUnwritten() {
		for (const a of this.unwritten.splice(0)) this.write(a);
	}
	/** The records made inside the run, as drafts of a turn_end or settle. */
	private drafts(): Any[] {
		return this.unwritten.splice(0).map((a) => ({ type: "custom", customType: SUMMARY_CUSTOM, data: a }));
	}

	/** The summaries a plan of this branch may take: the ready ones, and the call in flight when it reads this branch's projection. */
	private avail(branch: Any[]): Avail[] {
		const out: Avail[] = readyOf(branch, this.mine).map((a) => ({ key: a.key, running: false, summaryTokens: a.cut!.summaryTokens }));
		const b = this.bg;
		if (b && !b.aborted && b.head === headOf(branch) && !out.some((a) => a.key === b.key)) out.push({ key: b.key, running: true });
		return out;
	}

	/** The ready summaries of this branch, as plans take them (a call still running is not ready: nobody waits for it). */
	private ready(branch: Any[]): Avail[] {
		return readyOf(branch, this.mine).map((a) => ({ key: a.key, running: false, summaryTokens: a.cut!.summaryTokens }));
	}


	/**
	 * The one wait (theory 1.4, R9): at a turn_end whose view after the decision's edit is still at Pi's compaction room, the plan's own
	 * cut is summarised while the turn waits (Pi would stop for its own, lossy compaction otherwise). A call running for that very cut
	 * is awaited (Esc ends the wait, not the call); any other call is ended first, so there is never a second one in flight. A call
	 * made here is a pi-zip/summary entry and in the session totals at once, like a background one, so a summary the commit then
	 * refuses is neither lost nor missing from the totals. null: the call threw or pi-zip cancelled it (a narrative that failed, timed out or was
	 * aborted by the provider still yields its fallback summary).
	 */
	private async roomWait(c: PlanResult, ctx: Any): Promise<{ cut: Cut; ms: number } | null> {
		this.cancelTimer(); // the room owns the slot; invalidate queued ordinary replacements before awaiting cancellation
		const gen = this.timerGen, owns = () => gen === this.timerGen && this.active() && !ctx?.signal?.aborted;
		const head = headOf(this.branch(ctx)), key = c.firstKeptEntryId, b = this.bg, w0 = performance.now();
		const running = !!b && !b.aborted && b.key === key && b.head === head;
		this.ledger({ type: "room_wait", key, running });
		const got = await this.working(ctx, `${PRODUCT}: finishing a summary (the context is close to the window)`, (async () => {
			if (!running) {
				this.discardBg("replaced");
				if (b) await waitFor(b.promise, ctx?.signal); // keep the slot until the provider acknowledges cancellation; Esc ends only the wait
				if (!owns()) return null;
				if (!this.startBg(c, ctx, true)) return null;
			}
			const call = running ? b : this.bg;
			return call && !call.aborted && call.head === head && call.key === key ? waitFor(call.promise, ctx?.signal) : null;
		})());
		return owns() && got?.firstKeptEntryId === key ? { cut: { ...got, trigger: "valve", prepared: true }, ms: performance.now() - w0 } : null;

	}


	async context(e: Any, ctx: Any): Promise<Any> {
		if (this.speed) {
			this.liveCtx = ctx;
			this.detectConflict(ctx);
			if (!this.active()) this.discardBg("replaced");
			this.requestStart(ctx);
			return undefined; // even malformed native payloads stay byte-identical
		}
		if (!this.active()) return void this.requestStart(ctx);
		if (this.starting) await this.starting; // agent_start's start-of-run handling of a driven run
		if (ctx?.signal?.aborted) return undefined;
		const first = !this.runChecked;
		let rentNext = this.rent;
		if (first) {
			this.runChecked = true;
			try {
				rentNext = await this.computeRunPlan(ctx);
			} catch (err) {
				// no plan was sent, so none may be persisted: end the edit run here
				this.runPlan = null;
				this.runEdits = false;
				this.ledger({ type: "error", where: "context/run_plan", error: errText(err) });
			}
		}
		if (ctx?.signal?.aborted) return undefined; // Esc (Pi cancelled the prompt): this request never goes out, so nothing is applied or announced
		this.rent = rentNext; // only a request that passed cancellation earns rent or ends the stretch
		const plan = this.runPlan && !this.runPlan.persisted ? this.runPlan : null;
		const out = plan ? applyPlanToMessages(e.messages, plan) : null;
		if ((first && this.pWarm < 0.5) || out || plan?.native) this.rent = 0; // R14: an applied rewrite or a cold request ends the rent stretch
		if (plan && (out || plan.native)) { // a native summary is already in the request Pi built: it still goes out with this request
			if (!plan.sent) this.nextEdit = plan.untouched ?? 0;
			plan.sent = true;
			const applied = (plan.applied = out?.applied ?? plan.applied ?? new Set<string>());
			plan.noticeTs ??= Date.now();
			if (!plan.noticed && (plan.cut || plan.native)) { // folds alone wait for the boundary: a room summary can join their one notice
				plan.noticed = true;
				const live = plan.folds.filter((t) => applied.has(t.entryId));
				this.noticeFor(ctx, plan, live, plan.cut ?? plan.native ?? null, plan.ctxBefore, sizeOf(plan.scale, (out?.messages ?? e.messages).filter((m: Any) => m.role !== "system").reduce((n: number, m: Any) => n + wireTokensOf(m), 0)));
			}
		}
		this.requestStart(ctx);
		return out ? { messages: out.messages } : undefined;
	}

	/** While the user waits for a summary, Pi's working line says what for. */
	private async working<T>(ctx: Any, text: string, p: Promise<T>): Promise<T> {
		const ui = ctx?.mode === "tui" ? ctx?.ui : null;
		attempt(() => ui?.setWorkingMessage?.(text), undefined);
		try {
			return await p;
		} finally {
			attempt(() => ui?.setWorkingMessage?.(undefined), undefined);
		}
	}

	/** ONE plan per edit run: computed at the first request (the new prompt is in the session), applied to every request until turn_end persists the same set. */
	private async computeRunPlan(ctx: Any) {
		const t0 = performance.now();
		const now = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		// Pi kept the native decision's fold targets by ID: carry that decision, looking up positions in this projection.
		const nat = this.nativeRun, foreign = this.foreignRun;
		this.nativeRun = null;
		this.foreignRun = false;
		const d = decideRun({
			cold: this.cold, justEdited: this.justEdited, nat, foreign, now, ready: this.ready(this.branch(ctx)),
			opts: (entries, cutAt, foldsOnly, ready) => this.opts(ctx, false, entries, this.pWarm, this.pause, cutAt, foldsOnly, ready),
		});
		// no warm edit on the request right after an edited one (no back-to-back warm rewrites); the summary the plan wants is still
		// produced. A summary Pi's compaction already put in the session (nativeSummary skips such a return, so only defensively) is never dropped here: the run plan below carries it
		// R14: context() finalizes this transition after cancellation and actual application are checked.
		// Selected edits keep paid rent until they go out; no-edit requests earn rent only if they proceed.
		const rentNext = !d.p || nat ? d.rentNext : this.rent;
		if (d.produce) this.want("run", ctx, d.produce);
		if (d.kind === "b2b") {
			this.ledger({ type: "b2b_skip", where: "run" });
			return rentNext;
		}
		for (const n of d.notes) this.ledger(n);
		const { o, cal, p } = d;
		if (!nat) this.lawLedger("run", o);
		// A cut with no ready summary is produced while the guarded folds ride this run.
		const native = nat?.cut ?? null;
		if (!p && !native) return rentNext; // the law does not fire (below the working view, or a rewrite that does not pay back)
		this.runEdits = true;
		const trigger = this.cold ? "cold" : "valve";

		const foldMs = performance.now() - t0, settleIds = this.settleIds;
		// a plan that cannot be persisted must never be sent: the request view would differ from what turn_end can write (I1)
		const r = runPlanOf({ p, cal, cold: this.cold, native, nat, folds: p?.folds ?? [], settleIds, ms: foldMs, now });
		if (r.drop) this.ledger(r.drop);
		const { folds } = r;
		this.runPlan = r.plan;
		const { source, ctxBefore, ctxAfter } = r.plan;
		this.ledger({ type: "cold_plan", trigger, source, folds: folds.length, summary: !!native, ...(native ? { via: "native" } : {}), ...this.calOf(cal), ctxBefore: Math.round(ctxBefore), ctxAfter: Math.round(ctxAfter), ms: Math.round(foldMs) });
		return rentNext;
	}

	/** Ledger form of a calibration; ctxBefore/ctxAfter next to it are already real (O + c x estimate). */
	private calOf(cal: Scale) {
		return { O: Math.round(cal.O), c: Math.round(cal.c * 1000) / 1000, oSource: cal.oSource, calReal: cal.real, calEst: Math.round(cal.est), calSource: cal.source };
	}

	private usageOf(cut: Cut) {
		const u = cut.usage;
		return u ? { summaryUsage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } } : {};
	}

	/** Settle writes pending artifact records and prepares another return in every mode. */
	async settle(e: Any, ctx: Any): Promise<Any> {
		if (this.speed) {
			this.inRun = false;
			const records = this.drafts();
			this.prepareSpeed(ctx, e.context.contextEntries, e.entries);
			return records.length ? { entries: [...e.entries, ...records] } : undefined;
		}
		this.inRun = false;
		const recs = this.drafts();
		this.want("settle", ctx, undefined, e.context.contextEntries);
		this.armDoor(ctx, false); // a summary ready now was priced by this run's last turn_end at this P(warm): the next change decides
		return recs.length ? { entries: [...e.entries, ...recs] } : undefined;
	}

	/** The shell for core.want: one background start and one timer slot, shared by all three triggers. */
	private want(at: "run" | "turn_end" | "settle" | "timer", ctx: Any, candidate?: PlanResult | null, entries?: Any[], futureOnly = false) {
		const decision = at === "run" || at === "turn_end";
		if (!this.active() || !ctx?.model || (!decision && this.inRun)) return;
		try {
			this.liveCtx = ctx;
			this.loadEnt(modelKey(ctx.model));
			const branch = this.branch(ctx), view = entries ?? ctx.sessionManager.buildSessionProjection().entries;
			const now = Date.now(), ttlMs = ttlFor(ctx.model, branch, this.tier(ctx.model));
			// Only a call whose range left the current prefix may be replaced outside the room.
			if (this.bg && (this.bg.head !== headOf(branch) || !(candidate ? candidate.blocks.some((b) => b.entryId === this.bg!.key) : view.some((e: Any) => e.sourceEntry?.id === this.bg!.key)))) this.discardBg("replaced");
			const outer = this.frozen;
			this.frozen = { branch: this.branch(ctx), scales: new Map() }; // read after a discard above, which may have appended its record
			let w: ReturnType<typeof want>;
			try {
				w = want({ at: decision ? "decision" : at, now, lastTouch: Math.max(this.lastReqMs, lastMessageMs(branch)), ttlMs, avail: this.avail(branch), candidate,
					survival: (g) => process.env.PI_ZIP_TTL_SECS ? (g <= ttlMs / 1000 ? 1 : 0) : pWarm(this.ent, g, ttlMs / 1000).p,
					plan: (p, pause, have) => {
						return candidateOf(view, (cutAt, foldsOnly, ready) => this.opts(ctx, true, view, p, pause, cutAt, foldsOnly, ready), have, "want").r.p;
					}, latency: (p) => this.ent?.call ? this.ent.call.ms * p.scale.c * p.prefixTokens / this.ent.call.tokens : 0,
				});
			} finally {
				this.frozen = outer;
			}
			if (!decision) this.cancelTimer();
			if (decision && candidate) this.ledger({ type: "produce", where: at, key: candidate.firstKeptEntryId, ...(this.bg ? { running: this.bg.key } : {}) });
			if (!w) return;
			const delay = w.start - now;
			this.ledger({ type: "want", at, key: w.p.firstKeptEntryId, start: w.start, gapS: w.gapS, timerMs: Math.max(0, Math.round(delay)) });
			if (delay <= 0) {
				if (!futureOnly && (!this.bg || this.bg.aborted)) this.startBg(w.p, ctx);
				// After the warm start, ask the same rule for the pause's deadline.
				if (at === "settle") this.want("timer", ctx, undefined, view);
			} else if (!decision && (!futureOnly || delay > 0)) {
				const gen = ++this.timerGen;
				this.timer = setTimeout(async () => {
					this.timer = null;
					if (gen !== this.timerGen || this.inRun || !this.active()) return;
					const branch = this.branch(ctx);
					if (this.bg && this.bg.head !== headOf(branch)) this.discardBg("replaced");
					if (this.bg) {
						if (!this.bg.aborted) return;
						await this.bg.promise;
						if (gen !== this.timerGen || this.inRun || !this.active()) return;
					}
					this.want("timer", ctx); // re-read touches, deadline and plan after the timer (or an aborted call) waited
				}, Math.max(0, delay));
				this.timer.unref?.();
			}
		} catch (err) { this.ledger({ type: "error", where: "want", error: errText(err) }); }
	}

	/** Pi's idle warming is a cache touch, never a producer wake or an answer to Pi's decision. */
	cacheWarmingDecision(e: Any, ctx: Any): undefined {
		if (this.speed) return undefined; // Pi alone owns refresh scheduling, no content decision here
		if (e?.action === "warm") this.lastReqMs = Date.now();
		this.want("timer", ctx);
		if (e?.action === "warm") this.armDoor(ctx, false); // the touch moved the door's moments
		return undefined;
	}

	/** Each completed call teaches its starting model and books its artifact once, whether it ran at the room or in the background.
	 *  A failed narrative still yields a summary (the deterministic sections, the previous narrative carried and marked possibly stale):
	 *  dropping it left a session whose every narrative failed (a cap below the reply, 0.4.0/0.4.1) without any summary, retrying forever. */
	private completed(c: Cut, model: string, head: string, key: string, estimated = 0, prefixReal = c.prefixTokens, speed?: SpeedStamp) {
		const learned = record(model, { explicit: false, total: 0, call: { ms: c.ms, tokens: Math.max(1, prefixReal) } });
		if (this.entKey === model) this.ent = learned;
		const usd = c.llmOk || c.costUsd > 0 ? c.costUsd : estimated;
		this.stats.summaryUsd += usd;
		if (speed && c.llmOk) this.speedDurations.set(model, [...(this.speedDurations.get(model) ?? []).slice(-19), c.ms / 1000]);
		this.record({ head, key, cut: c, usd, ...(speed ? { speed } : {}), ...(c.llmOk || c.costUsd > 0 ? {} : { estimated: true }) });
	}

	/** Write the summary for `p` in the background (its own abort signal: nothing is running, so the run's would be stale). Nothing
	 *  when one for the same cut of the same projection is ready or being written (false); any other call in flight is ended first. */
	private startBg(p: PlanResult, ctx: Any, room = false): boolean {
		const branch = this.branch(ctx), head = headOf(branch), key = p.firstKeptEntryId, model = modelKey(ctx.model);
		if (key === null) return false;
		if (this.bg) {
			if (this.bg.aborted && !p.speed) {
				const gen = this.timerGen;
				void this.bg.promise.then(() => { if (gen === this.timerGen && this.active() && headOf(this.branch(ctx)) === head) this.startBg(p, ctx, room); });
			}
			return false;
		}
		if (!room && readyOf(branch, this.mine).some((a) => a.key === key && (!p.speed || a.speed?.identity === p.speed.identity && a.speed?.prefix === p.speed.prefix))) return false;
		const controller = new AbortController();
		const prevSum = p.blocks[0]?.kind === "summary" ? p.blocks[0].tokens : 0;
		const estUsd = (p.scale.c * Math.max(0, p.prefixTokens - prevSum) * (Number(ctx?.model?.cost?.input) || 0)) / 1e6;
		const bg: Bg = { key, head, aborted: false, promise: Promise.resolve(null), controller, estUsd, speed: p.speed };
		const gen = this.timerGen, sid = this.sessionId(ctx);
		const end = () => {
			if (this.bg !== bg) return;
			this.bg = null;
			// Release the only worker slot first. Re-read the current projection, never the captured plan.
			if (p.speed) queueMicrotask(() => {
				const current = this.liveCtx ?? ctx;
				if (gen === this.timerGen && this.active() && this.sessionId(current) === sid) this.prepareSpeed(current, undefined, [], false);
			});
		};
		bg.promise = buildCut(p, ctx, controller.signal, p.speed ? this.summaryLane(ctx, head, p.speed.identity) : undefined)
			.then((c) => {
				if (bg.aborted || !c) return null;
				this.completed(c, model, head, key, estUsd, p.scale.c * c.prefixTokens, p.speed);
				this.ledger({ type: "away_summary", key, ms: c.ms, llmOk: c.llmOk, ...(c.llmOk ? {} : { llmError: c.llmError }), costUsd: c.costUsd, ...this.usageOf(c) });
				if (!this.speed && !this.inRun) this.armDoor(this.liveCtx ?? ctx, true); // finished while Pi is idle: the door asks now (a run's settle asks otherwise)
				return c;
			})
			.catch((err) => {
				if (!bg.aborted) {
					this.stats.summaryUsd += estUsd;
					const error = err instanceof Error ? err.message : String(err);
					this.record({ head, key, usd: estUsd, estimated: true, lost: "failed", error, ...(p.speed ? { speed: p.speed } : {}) });
					this.ledger({ type: "error", where: "away_summary", error });
				}
				return null;
			})
			.finally(end);
		this.bg = bg;
		this.ledger({ type: "away_summary_start", key });
		return true;
	}

	async turnEnd(e: Any, ctx: Any): Promise<Any> {
		if (this.speed) {
			const fresh = this.collectSteer(e);
			if (e.message?.stopReason !== "error" && e.message?.stopReason !== "aborted") this.prepareSpeed(ctx, e.context.contextEntries, e.entries);
			const records = [...this.drafts(), ...(fresh.length ? [{ type: "custom", customType: STEER_CUSTOM, data: { ids: fresh } }] : [])];
			return records.length ? { entries: [...e.entries, ...records] } : undefined;
		}
		this.logForeign(ctx, "turn_end");
		if (!this.active()) return undefined;
		try {
			const fresh = this.collectSteer(e); // marked before anything is validated: a steering message is part of its turn
			const out = await this.onTurnEnd(e, ctx);
			const previousRent = rentOf(this.branch(ctx));
			const recs = [...this.drafts(), ...(this.rent !== previousRent ? [{ type: "custom", customType: "pi-zip/rent", data: { rent: this.rent } }] : [])]; // summaries recorded during the run, after the turn's edits (a compaction goes first)
			if (!fresh.length && !recs.length) return out;
			if (fresh.length) this.ledger({ type: "steer", ids: fresh });
			return { entries: [...(out?.entries ?? e.entries), ...(fresh.length ? [{ type: "custom", customType: STEER_CUSTOM, data: { ids: fresh } }] : []), ...recs] };
		} catch (err) {
			this.ledger({ type: "error", where: "turn_end", error: errText(err) });
			return undefined;
		}
	}

	/** Steering and follow-up user messages (typed during a run) are not new user turns; Pi does not mark them, so we persist the ids. */
	private collectSteer(e: Any): string[] {
		if (!this.steerTs.size) return [];
		const ids: string[] = [];
		for (const pe of e.context?.contextEntries ?? []) {
			const src = pe.sourceEntry;
			const m = src?.type === "message" ? src.message : null;
			if (m?.role === "user" && typeof m.timestamp === "number" && this.steerTs.has(m.timestamp) && src.id && !this.steerIds.has(src.id)) ids.push(src.id);
		}
		this.steerTs.clear();
		for (const id of ids) this.steerIds.add(id);
		return ids;
	}

	private async onTurnEnd(e: Any, ctx: Any) {
		const msg: Any = e.message;
		const failed = msg?.stopReason === "error" || msg?.stopReason === "aborted";
		const t0 = performance.now();
		const blocks = buildBlocks(e.context.contextEntries, this.steerIds);
		if (!blocks.length) return undefined;
		const userTurns = countUserTurns(blocks);
		const u = msg?.usage;
		const usageTotal = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
		const o = { t0, blocks, userTurns, usageTotal };
		// P(warm) in-run: the learned curve at the time since the newest response (a long tool call is an absence like any other)
		const m = ctx?.model ?? this.model, branch = this.branch(ctx);
		const touch = Math.max(this.lastReqMs, msg?.stopReason === "error" ? 0 : Number(msg?.timestamp) || 0); // the response that ended this turn is the newest touch
		// a recall made in this run by a built-in tool on a recall file (file recall) is in the branch only: zip_recall's own hook
		// marks its handles at once, a read, grep or bash of a recall file would otherwise be folded again at this turn_end, by its
		// decision or its room wait (RC)
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		const clk = inRunClock(branch, { model: m, ent: this.entKey === modelKey(m) ? this.ent : undefined, tier: this.tier(m) }, Date.now(), { reqMs: touch, modelKey: this.lastModelKey });
		const pIn = clk.pWarm;
		// the notice's "why now" says what this decision assumed (P(warm) at this turn_end), not the run's start
		this.turnWhy = pIn >= 0.5 ? WARM_WHY : clk.src === "model switch" ? "cache cold · model switched" : `cache likely cold · ${clk.gapS !== null ? `${fmtAway(clk.gapS)} since the last response` : clk.src}`;
		const carried = this.runEdits ? this.runPlan : null;
		this.runEdits = false;
		if (carried && !carried.sent) this.runPlan = null;
		const runPlan = carried?.sent ? carried : null;
		// A failed response still persists the folds its request actually carried, but makes no new edit.
		const ents = e.context.contextEntries;
		const d = decideTurnEnd({ failed, justEdited: this.justEdited, pWarm: pIn, ready: this.ready(branch), entries: ents, runPlan, opts: (cutAt, foldsOnly, ready) => this.opts(ctx, false, ents, pIn, false, cutAt, foldsOnly, ready) });
		if (runPlan) runPlan.folds = d.runPlan!.folds;
		if (d.kind === "none") return runPlan ? this.commit(e, ctx, runPlan, o) : undefined;
		if (d.kind === "b2b") this.ledger({ type: "b2b_skip", where: "turn_end" });
		else {
			for (const n of d.notes) this.ledger(n);
			if (d.o.trace?.length) this.lawLedger("turn_end", d.o);
		}
		const rentNext = d.p && pIn >= 0.5 ? this.rent : d.rentNext;
		let p = d.kind === "plan" ? d.p : null, cut: Cut | null = null, ready = false, waitMs = 0, away = false;
		if (p && p.cutIdx !== null) {
			const art = readyOf(branch, this.mine).find((a) => a.key === p!.firstKeptEntryId);
			if (art?.cut) {
				[cut, ready, away] = [{ ...art.cut, trigger: "valve", prepared: true }, true, this.readyAtStart.has(art.key)];
				this.ledger({ type: "take", where: "turn_end", key: p.firstKeptEntryId });
			}
		}
		if (d.room) { // one post-edit judgement, shared by carried folds, b2b and ordinary decisions
			const waiting = this.roomWait(d.room, ctx), gen = this.timerGen;
			const got = await waiting;
			if (gen !== this.timerGen || !this.active()) return undefined; // deactivation also voids edits selected before the wait
			if (got) [p, cut, waitMs, ready] = [d.room, got.cut, got.ms, false];
		}
		if (cut) this.discardBg("replaced");
		const plan = p ? { ...valvePlanOf(p, cut, ready, waitMs, performance.now() - t0), ...(ready && away ? { ready: "away" as const } : {}),
			...(runPlan ? { source: runPlan.source, sent: runPlan.sent, carriedIds: runPlan.applied, native: runPlan.native, noticed: runPlan.noticed, noticeTs: runPlan.noticeTs } : {}) } : runPlan;
		const out = plan ? this.commit(e, ctx, plan, o) : undefined;
		this.rent = out ? 0 : rentNext; // a selected warm edit resets paid rent only after the commit validates it
		if (runPlan && plan) runPlan.persisted = plan.persisted;
		if (!cut && d.produce) this.want("turn_end", ctx, d.produce);
		return out;
	}

	/**
	 * The transcript notice for one plan. Facts only, no claims: what changed (sizes), how long it took, and, expanded, why now
	 * ("cache cold · away 47 min") and what was folded. Whether the cache really was cold is learned from the response, silently (/zip shows it).
	 * `realAfter`: the resulting request or persisted projection, counted with the plan's token scale.
	 */
	private noticeFor(ctx: Any, plan: RunPlan, live: FoldTarget[], cut: Cut | null, ctxTokens: number, realAfter: number) {
		if (this.quiet || (!live.length && !cut)) return;
		const valve = plan.source === "valve";
		const waitMs = cut ? (plan.waitMs ?? 0) : 0;
		const notices: NoticeAction[] = [];
		if (live.length) notices.push({ kind: "fold", count: live.length, tokensBefore: ctxTokens, tokensAfter: realAfter, ms: plan.ms, pressure: valve });
		if (cut) {
			// finished while the user was away (or while the run went on): report the real production time, not the zero wait
			const prepared = (plan.source === "settle" || plan.ready === "away") && waitMs < 500;
			const background = !prepared && plan.ready === "background" && waitMs < 500;
			notices.push({ kind: "summary", count: cut.count, tokensBefore: ctxTokens, tokensAfter: realAfter, ms: Math.max(cut.ms, waitMs), waitMs, prepared, ...(background ? { background } : {}), pressure: valve });
		}
		for (const t of live) this.labels.set(handleFor(t.entryId), `${t.tool}${t.args ? " " + t.args : ""}`);
		const ITEMS = 8;
		const items = live.slice(0, ITEMS).map((t) => ({ label: `${t.tool}${t.args ? " " + t.args : ""}`, tokens: Math.round(plan.scale.c * t.entryTokens), handle: handleFor(t.entryId) }));
		const why = valve ? this.turnWhy || WARM_WHY : !this.cold ? WARM_WHY : this.coldWhy;
		// reqTs identifies the first request carrying the final view: a folds-only notice keeps its first-request time when announced
		// at the boundary; a newly joined room summary uses the boundary time, because only the next request can carry it.
		const data: NoticeData = { v: 2, text: noticeText(notices), before: Math.round(notices[0].tokensBefore), after: Math.round(notices[notices.length - 1].tokensAfter), desc: noticeDesc(notices), why: why || undefined, items, more: Math.max(0, live.length - ITEMS) || undefined, first: !this.noticed && !this.branch(ctx).some((en: Any) => en?.type === "custom" && en.customType === NOTICE_CUSTOM), reqTs: plan.cut ? Date.now() : (plan.noticeTs ?? Date.now()), ...(cut && this.nativeNote ? { native: this.nativeNote.native, ...(this.nativeNote.ms !== undefined ? { nativeMs: this.nativeNote.ms } : {}), ...(this.nativeNote.askMs !== undefined ? { nativeAskMs: this.nativeNote.askMs } : {}) } : {}) };
		this.noticed = true;
		this.notify(ctx, data.text, data);
	}

	private commit(e: Any, ctx: Any, plan: RunPlan, o: { t0: number; blocks: Block[]; userTurns: number; usageTotal: number }) {
		plan.persisted = true;
		const sc = plan.scale, c = sc.c; // one scale for the whole run: stats, notices and the ledger agree with what the plan compared against the limits
		const ctxTokens = plan.cut ? piContextTokens(e.context.contextEntries, this.branch(ctx), e.entries) : sizeOf(sc, o.blocks.reduce((a, b) => a + b.tokens, 0));
		const byId = new Map(o.blocks.map((b) => [b.entryId, b]));
		const live = plan.folds.filter((t) => byId.has(t.entryId));
		const stale = plan.folds.length - live.length; // e.g. Pi auto-compaction removed them from the projection
		const cut = plan.cut && byId.has(plan.cut.firstKeptEntryId) ? plan.cut : null;
		if (!live.length && !cut) {
			this.ledger({ type: "cold_noop", turnIndex: e.turnIndex, ctx: Math.round(ctxTokens), ...(stale ? { staleTargets: stale } : {}) });
			return undefined;
		}
		const bad = checkEdits(o.blocks, o.userTurns, live, cut);
		if (bad) {
			this.ledger({ type: "guard_drop", turnIndex: e.turnIndex, reason: bad, folds: live.length, source: plan.source });
			plan.persisted = false; // keep the request-local view: never switch the fold set mid-run
			return undefined;
		}
		const sentBefore = !!plan.sent;
		const mixed = sentBefore && plan.carriedIds && live.some((t) => !plan.carriedIds!.has(t.entryId));
		if (!sentBefore || cut || mixed) this.nextEdit = plan.untouched ?? 0; // a new room summary is first sent with the next request
		const ours: Any[] = live.map((t) => ({ type: "context_edit", targetId: t.entryId, replacement: { content: [{ type: "text", text: t.ph }] } }));
		for (const t of live) if (t.toolCallId) this.foldedCalls.set(t.toolCallId, handleFor(t.entryId));
		// the compaction draft goes FIRST: Pi writes its tokensBefore from the newest usage only while no edit follows that usage, so a
		// fold drafted before it would make Pi's "Compacted from N tokens" the chars/4 of a half-applied projection (research pi-tricks §1a)
		if (cut) ours.unshift({ type: "compaction", summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, details: { by: PRODUCT, trigger: cut.trigger, carried: false }, usage: cut.usage });
		ours.push({ type: "custom", customType: COMMIT_CUSTOM, data: { carried: sentBefore, ...((cut || mixed) && sentBefore ? { next: true } : {}), ...(mixed ? { carriedIds: [...plan.carriedIds!] } : {}) } }); // says who first carried these edits (state.ts, plan.ts calibrate)
		const before = Math.round(c * live.reduce((a, t) => a + t.entryTokens, 0));
		const after = Math.round(c * live.reduce((a, t) => a + t.phTokens, 0));
		const cutSaved = cut ? Math.round(c * (cut.prefixTokens - cut.summaryTokens)) : 0;
		const kept = cut ? o.blocks.slice(o.blocks.findIndex((b) => b.entryId === cut.firstKeptEntryId)) : o.blocks;
		const folds = new Map(live.map((t) => [t.entryId, t]));
		const ctxAfter = sizeOf(sc, (cut ? tokensOf({ role: "compactionSummary", summary: cut.text }) : 0) + kept.reduce((n, b) => n + (folds.get(b.entryId!)?.phTokens ?? b.tokens), 0));
		const waitMs = cut ? (plan.waitMs ?? 0) : 0;
		const s = this.stats;
		s.folds += live.length;
		s.foldedTokens += before - after;
		s.activeSaved += before - after + cutSaved;
		if (plan.source === "valve") {
			if (!plan.native) { // a warm native summary booked this valve edit already (nativeSummary)
				s.pressureEdits++;
				s.pressureRewriteTokens += ctxTokens;
			}
		} else {
			s.writeSavedTokens += before - after + cutSaved;
		}
		if (cut) {
			s.summaries++;
			s.summarizedTokens += cutSaved;
			s.summaryMs += waitMs;
			if (!cut.prepared) s.summaryUsd += cut.costUsd; // a prepared one was counted when it was produced
		}
		if (live.length) this.ledger({
			type: "fold", trigger: plan.source, turnIndex: e.turnIndex, count: live.length, entries: live.map((t) => t.entryId), tools: live.map((t) => t.tool),
			recoverability: live.map((t) => t.recover ?? "?"), trigs: live.map((t) => t.trig), handles: live.map((t) => handleFor(t.entryId)),
			entryTokensBefore: before, entryTokensAfter: after, ctxBefore: Math.round(ctxTokens), ctxAfter: Math.round(ctxAfter), O: Math.round(sc.O), c: Math.round(sc.c * 1000) / 1000, usageTotal: o.usageTotal,
			coldReason: this.coldReason, prepared: plan.source === "settle", ...(stale ? { staleTargets: stale } : {}),
		});
		if (cut) this.ledger({ type: "summary", trigger: cut.trigger, source: plan.source, tokensBefore: ctxTokens, count: cut.count, prefixTokens: Math.round(c * cut.prefixTokens), summaryTokens: Math.round(c * cut.summaryTokens), ms: cut.ms, waitedMs: Math.round(waitMs), llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
		// Native summaries were announced with their request; boundary summaries join the folds in one notice.
		if (!plan.noticed) this.noticeFor(ctx, plan, live, cut, ctxTokens, ctxAfter);
		plan.noticed = true;
		return { entries: [...e.entries, ...ours] }; // append, never overwrite other extensions' drafts
	}

	/** Pi's model_select (/model, cycling, restore): a switch in the middle of a run is not seen by any run start. */
	modelSelect(model: Any) {
		if (this.speed) this.discardBg("replaced");
		if (model) this.model = model;
	}

	/** Main context preparation owns this snapshot; Pi's warmer replays payload hooks without another context transform. */
	private requestStart(ctx: Any) {
		// the request goes to the session's current model: a /model in the middle of a run switches it without a run start, and a
		// request booked under the run's first model would make every later turn_end see a "model switch" (P(warm) = 0: any edit is free)
		if (ctx?.model) this.model = ctx.model;
		const now = Date.now(), key = modelKey(this.model), activity = cacheActivity(requestBranch(this.branch(ctx ?? this.liveCtx))), last = Math.max(this.lastReqMs, activity.ms);
		const edited = this.nextEdit !== null;
		// the free cache signal: this response's cacheRead against what this request re-sent unchanged, after this gap (same model only)
		this.pending = { censored: activity.censored, gapS: last && (this.lastModelKey || this.prevKey) === key ? (now - last) / 1000 : -1, expect: edited ? this.nextEdit! : this.prevTotal, edited, key };
		this.nextEdit = null;
		this.reqMsBefore = this.lastReqMs;
		this.lastReqMs = now;
		this.lastModelKey = key;
		this.stats.readSavedTokens += this.stats.activeSaved;
	}
	providerRequest(e: Any, ctx?: Any): Any {
		const m = ctx?.model ?? this.model, key = modelKey(m), p: Any = e.payload;
		const seen = payloadRetention(p); // what this very request asked the provider for: it wins over any environment
		if (seen && key && (seen !== this.retention?.tier || this.retention?.key !== key || this.retention?.src !== "payload")) {
			this.retention = { key, tier: seen, src: "payload" };
			this.ledger({ type: "retention", ...this.retention });
		}
		if (process.env.PI_ZIP_LEDGER && this.cold && !this.wireLedgered && p && Array.isArray(p.messages)) {
			this.wireLedgered = true; // proof that the FIRST request after a cold return is already small (real scale: O + c x the wire's content)
			let tok = 0;
			for (const m of p.messages) if (m?.role !== "system" && m?.role !== "developer") tok += tok4(JSON.stringify(m?.content ?? "")) + 8;
			this.ledger({ type: "cold_wire", tokens: Math.round(sizeOf(this.runPlan?.scale ?? UNIT, tok)), messages: p.messages.length, folds: this.runPlan && !this.runPlan.persisted ? this.runPlan.folds.length : 0, summary: !!this.runPlan?.cut, source: this.runPlan?.source ?? null });
		}
		const sk = `${key}@${m?.baseUrl ?? ""}`, was = this.stickyKey;
		this.stickyKey = null; // set again below when this request names its session: the request a refusal answers
		if (this.off) return undefined; // strict no-op
		const uid = stickyFits(m, p) && this.stickyOf(sk) !== "off" ? stickyUserId(this.sessionId(ctx)) : undefined;
		if (!uid) return this.guarded(p, false);
		return this.stickyPayload(p, ctx, this.sessionId(ctx)).then((payload) => {
			if (!payload) return this.guarded(p, false);
			if (was !== sk) this.ledger({ type: "sticky", key: sk });
			this.stickyKey = sk;
			return this.guarded(payload, true);
		});
	}
	/** Shared routing policy; callers own their request key and refusal counter. */
	private async stickyPayload(p: Any, ctx: Any, sid: string): Promise<Any> {
		const m = ctx?.model ?? this.model, sk = `${modelKey(m)}@${m?.baseUrl ?? ""}`;
		const uid = !this.off && stickyFits(m, p) && this.stickyOf(sk) !== "off" ? stickyUserId(sid) : undefined;
		if (!uid) return undefined;
		// Pi's resolved auth may add identity headers or a different endpoint not present on ctx.model.
		if (!this.stickyAuth.has(sk)) this.stickyAuth.set(sk, Promise.resolve(attempt(() => ctx?.modelRegistry?.getApiKeyAndHeaders?.(m), null)).then((a: Any) =>
			/claude-cli/i.test(JSON.stringify(a?.headers ?? {})) || /sk-ant-oat/.test(String(a?.apiKey ?? "")) || /^https?:\/\/api\.anthropic\.com/i.test(String(a?.baseUrl ?? m.baseUrl ?? "")), () => false));
		return await this.stickyAuth.get(sk) ? undefined : { ...p, metadata: { user_id: uid } };
	}
	private stickyResponse(sk: string | null, m: Any, strikes: number): number {
		const err = String(m?.errorMessage ?? ""), ok = !!sk && this.stickyOf(sk) === "ok";
		if (sk && m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			strikes = 0;
			if (!ok) { this.stickyOf(sk, "ok"); this.ledger({ type: "sticky_ok", key: sk }); }
		}
		const in400 = !!sk && refused(m) && /^4(00|22)\b/.test(err) && !/too long|exceed/i.test(err) && ++strikes >= (ok ? 2 : 1);
		if (sk && refused(m) && (/metadata|user_id/i.test(err) || in400)) {
			this.stickyOf(sk, "off");
			strikes = 0;
			this.ledger({ type: "sticky_off", key: sk, error: err.slice(0, 200) });
		}
		return strikes;
	}
	private summaryLane(ctx: Any, head: string, identity: string): SummaryLane {
		const hash = digest([this.sessionId(ctx), head, identity]);
		const laneCtx = { model: ctx.model, modelRegistry: ctx.modelRegistry };
		// The existing relay format takes a UUID-shaped session id; keep the summary lane separate and deterministic.
		const sid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
		let sent = false, strikes = 0;
		const sk = `${modelKey(ctx.model)}@${ctx.model?.baseUrl ?? ""}`;
		return { sessionId: `zip-summary-${hash}`, cacheRetention: this.tier(ctx.model) ?? "short",
			onPayload: async (p: Any) => { const out = await this.stickyPayload(p, laneCtx, sid); sent = !!out; return out; },
			onResult: (m: Any) => { strikes = this.stickyResponse(sent ? sk : null, m, strikes); },
		};
	}
	private guarded(p: Any, changed: boolean): Any {
		if (this.speed) return changed ? p : undefined;
		const r = repairPayload(p);
		if (r) this.ledger({ type: "guard_repair", repaired: r.repaired });
		return r ? r.payload : changed ? p : undefined;
	}

	messageEnd(m: Any, ctx?: Any) {
		if (this.promptStart) {
			this.promptStart = false;
			if (m?.role === "custom" && ctx) void this.drivenStart(ctx); // the agent_start was a driven run's: its start of run, now
		}
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") this.lastReqMs = Date.now(); // the response is complete: the entry was refreshed when it finished
		else if (refused(m)) this.lastReqMs = Math.max(this.reqMsBefore, lastMessageMs(requestBranch(this.branch(ctx ?? this.liveCtx)))); // the provider refused the request: it touched no cache (cache.ts lastMessageMs reads the branch the same way)
		this.sticky400 = this.stickyResponse(this.stickyKey, m, this.sticky400);
		if (m?.role === "user" && this.active()) {
			// the first user message of a run is the prompt; later ones (steering, follow-up) are part of that run's turn. Pi does not mark them, we do.
			if (this.runUserSeen++ > 0 && typeof m.timestamp === "number") this.steerTs.add(m.timestamp);
		}
		const u = m?.usage;
		if (m?.role === "assistant" && u) this.ledger({ type: "usage", stop: m.stopReason, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output });
		if (m?.role === "assistant") this.learn(m);
	}

	/** Regime class, cache survival (persisted) and growth g (this session) from one response's usage. */
	private learn(m: Any) {
		const pend = this.pending, u = m.usage;
		this.pending = null;
		this.justEdited = !!pend?.edited;
		if (!pend || !u || m.stopReason === "error" || m.stopReason === "aborted") return;
		const cr = u.cacheRead ?? 0, cw = u.cacheWrite ?? 0, total = (u.input ?? 0) + cr + cw;
		if (!(total > 0)) return;
		const known = this.entKey === pend.key ? this.ent?.cls : undefined;
		const alive = !pend.censored && pend.gapS >= GAP_EDGES[0] ? sample(pend.expect, cr, total, pend.edited, cw > 0 ? "explicit" : known) : null;
		if (pend.gapS >= GAP_EDGES[0]) this.ledger({ type: "cache_sample", gapS: Math.round(pend.gapS), expect: Math.round(pend.expect), cacheRead: cr, total, edited: pend.edited, censored: pend.censored, alive });
		if (alive !== null || !known || (cw > 0 && known !== "explicit")) { // the file is touched only when there is something to learn
			this.ent = record(pend.key, { explicit: cw > 0, total, gapS: pend.gapS, alive });
			this.entKey = pend.key;
		}
		if (!pend.edited && this.prevKey === pend.key && this.prevTotal > 0 && total >= this.prevTotal) ({ g: this.g, deltas: this.deltas } = grow(this.g, this.deltas, total - this.prevTotal));
		this.prevTotal = total;
		this.prevKey = pend.key;
	}

	onRecall = (handles: string[], chars: number, entryIds: (string | null)[]) => {
		for (const h of handles) this.recalled.add(h);
		this.stats.recalls += handles.length;
		this.stats.recallChars += chars;
		this.ledger({ type: "recall", handles, chars, entryIds });
	};

	// ---- /zip --------------------------------------------------------------------------------------------------
	private persistState() {
		attempt(() => this.pi.appendEntry(STATE_CUSTOM, { off: this.off, quiet: this.quiet }), undefined);
	}
	/** What this session carries: folds and summaries persisted in its file (they survive restarts) and the recalls in its branch. */
	private totals(ctx: Any) {
		const branch = ctx ? this.branch(ctx) : [];
		const byId = new Map(branch.map((e: Any) => [e?.id, e]));
		let folds = 0, summaries = 0, recalls = 0, usd = 0, key = "", failed = 0;
		let last: Any = null, failedLast: Any = null;
		const fileRecalls = new Set<string>(); // tool call ids of built-in reads of recall files (file recall): unzips too
		const byModel = new Map<string, number>(); // chars/4 folded, by the model of the newest response before the fold (the one that planned it)
		for (const e of branch) {
			const ph = String(e?.replacement?.content?.[0]?.text ?? "");
			if (e?.type === "message" && e.message?.role === "assistant" && (e.message.provider || e.message.model)) key = `${e.message.provider ?? ""}/${e.message.model ?? ""}`;
			if (e?.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content))
				for (const c of e.message.content) if (c?.type === "toolCall" && (c.name === "bash" ? commandNamesRecall(c.arguments?.command) : ["read", "grep", "find", "ls"].includes(c.name) && !!parseRecallPath(c.arguments?.path))) fileRecalls.add(c.id);
			if (e?.type === "context_edit" && ph.startsWith(PH_MARK)) {
				folds++;
				byModel.set(key, (byModel.get(key) ?? 0) + Math.max(0, textOf(byId.get(e.targetId)?.message?.content).length - ph.length) / 4);
			} else if (e?.type === "compaction" && e.details?.by === PRODUCT) {
				summaries++;
				usd += Number(e.usage?.cost?.total) || 0;
			} else if (e?.type === "custom" && e.customType === LEGACY_UNUSED_CUSTOM) usd += Number(e.data?.usd) || 0;
			else if (e?.type === "custom" && e.customType === SUMMARY_CUSTOM && (e.data?.cut ? e.data.cut.llmOk === false : e.data?.lost === "failed")) [failed, failedLast] = [failed + 1, e];
			else if (e?.type === "custom" && e.customType === NOTICE_CUSTOM && e.data?.v === 2 && !e.data?.kind) last = e;
			else if (e?.type === "message" && e.message?.role === "toolResult" && (e.message?.toolName === RECALL_TOOL || fileRecalls.has(e.message?.toolCallId))) recalls++;
		}
		// chars/4 of the folded text, on the provider's scale: x c of the model that folded it (folded outputs are content)
		let folded = 0;
		if (folds) {
			const entries = byModel.size > 1 ? ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) : undefined;
			for (const [k, v] of byModel) folded += v * (byModel.size > 1 && k ? this.scaleAt(ctx, entries, k) : this.scaleOf(ctx)).c;
		}
		usd += unusedOf(branch).usd; // background summaries no compaction used, and calls lost or ended before they wrote one
		return { folds, folded, summaries, recalls, usd, last, failed, failedLast };
	}
	/** What this session carries: folds and summaries persisted in its file (they survive restarts) and the recalls in its branch. */
	private sessionTotals(ctx: Any): string {
		const { folds, folded, summaries, recalls, usd } = this.totals(ctx);
		const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
		return `this session: ${folds} zipped (~${fmtK(folded)} tokens), ${n(summaries, "summary", "summaries")}${usd > 0 ? ` (summary calls $${usd.toFixed(4)})` : ""}, ${n(recalls, "unzip", "unzips")}`;
	}
	/** The /zip card (rendered by ui.ts renderCard). */
	card(ctx?: Any): CardData {
		const t = this.totals(ctx);
		const model = ctx?.model ?? this.model;
		const key = modelKey(model), ttlS = ttlFor(model, [], this.tier(model)) / 1000, ent = key ? loadStats().models[key] : undefined;
		let lifeS = 0;
		for (let g = 30; g <= 7200; g += 30) if (pWarm(ent, g, ttlS).p >= 0.5) lifeS = g;
		const life = key ? (lifeS >= 7200 ? "2 h+" : fmtLife(lifeS || ttlS)) : undefined;
		// the chart: every learned bin that still rounds to a return (the weights are decayed), and where the learned curve says
		// "still there" ends (s1) and "gone" starts (s2); never the declared TTL
		const bins: ChartBin[] = Object.entries(ent?.bins ?? {})
			.map(([b, [a, d]]) => ({ lo: GAP_EDGES[Number(b)], hi: GAP_EDGES[Number(b) + 1] ?? 7200, alive: Math.round(a), gone: Math.round(d) }))
			.filter((x) => x.lo !== undefined && x.alive + x.gone > 0)
			.sort((x, y) => x.lo - y.lo);
		const cur = (ent ? curve(ent, ttlS) : []).map((x) => ({ lo: GAP_EDGES[x.bin], hi: GAP_EDGES[x.bin + 1] ?? 7200, p: x.p }));
		let s1 = GAP_EDGES[0];
		for (const x of cur) { if (x.p >= 0.8) s1 = x.hi; else break; }
		const s2 = cur.find((x) => x.lo >= s1 && x.p <= 0.2)?.lo ?? 7200;
		const usually = cur.some((x) => x.hi <= s1 && x.p < 0.95);
		const when = (s?: string, d = s ? new Date(s) : null, p = (x: number) => String(x).padStart(2, "0")) => !d || Number.isNaN(d.getTime()) ? "" : `${d.toDateString() === new Date().toDateString() ? "" : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())} `; // the date only when not today
		const hhmm = when(t.last?.timestamp).replace(/ $/, "  ");
		const last = t.last ? `${hhmm}${t.last.data.desc}${t.last.data.why ? " · " + t.last.data.why : ""}` : undefined;
		const failedWhy = t.failedLast ? `${when(t.failedLast.timestamp)}${String(t.failedLast.data?.cut?.llmError ?? t.failedLast.data?.error ?? "reason not recorded")}` : undefined; // 0.4.0/0.4.1 did not record it
		const file = this.recallMode === "file" && !!this.fileRecall(ctx);
		const state = this.off ? "off" : this.conflict ? "paused" : this.recallMode === "tool" || file ? "on" : "reread-only"; // file recall is a full mode
		const rereadWhy = this.recallMode === "file" ? "a tool allowlist hides zip_recall · no session file, so no recall copies" : "a tool allowlist hides zip_recall · only re-readable outputs fold";
		return {
			state, stateNote: state === "paused" ? `${this.conflict} also manages context` : state === "off" ? "/zip on to resume" : state === "reread-only" ? rereadWhy : undefined,
			model: key || undefined, life, ...(bins.length ? { bins, s1, s2, usually } : {}), folds: t.folds, foldedTokens: fmtK(t.folded), summaries: t.summaries, summaryUsd: t.usd, recalls: t.recalls, last, quiet: this.quiet,
			...(t.failed ? { failed: t.failed, failedWhy } : {}),
			...(file ? { unzip: `from files in ${recallRootShown()} (a tool allowlist hides zip_recall)` } : {}),
		};
	}
	status(ctx?: Any): string {
		const state = this.off ? "off" : this.conflict ? `paused ("${this.conflict}" also manages context; only the request guard is on)` : "on";
		const key = modelKey(this.model), ttl = ttlFor(this.model, [], this.tier()), ent = loadStats().models[key];
		const pr = lawPrices(ent?.cls, ttl >= 3_600_000);
		const cache = !key ? "" : `\ncache ${key}: ${pr.src === "class" ? `${pr.cls} (from usage)` : "class unknown until the first response (explicit ratios meanwhile)"}` +
			`, read ${+pr.r.toFixed(4)} / write ${+pr.w.toFixed(4)} / output ${+pr.out.toFixed(4)} x input (class ratios)` +
			`, ${describe(ent, ttl / 1000)}, growth ${(this.g / 1000).toFixed(1)}K/request`;
		return `${PRODUCT}: ${state}, cache TTL ${Math.round(ttl / 1000)} s, ${this.quiet ? "notices off, " : ""}${this.sessionTotals(ctx)}${cache}`;
	}
	statsLine = (ctx?: Any) => `${PRODUCT} ${this.sessionTotals(ctx)} (tokens on the provider's scale, calibrated from this session's usage)`;
	setOff(off: boolean): string {
		this.off = off;
		if (off) { this.runPlan = null; this.runEdits = false; this.cancelTimer(); this.cancelDoor(); this.discardBg("off"); }
		this.persistState();
		return off ? `${PRODUCT}: off. Nothing is folded or summarised and requests are left untouched; earlier folds stay recallable (/zip on to resume)` : `${PRODUCT}: on`;
	}
	toggleQuiet(): string {
		this.quiet = !this.quiet;
		this.persistState();
		return `${PRODUCT}: per-turn notices ${this.quiet ? "off" : "on"} (folding continues)`;
	}
}
