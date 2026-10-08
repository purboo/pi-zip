// Pure planning: session projection -> which outputs to fold, whether to summarise, where to cut (F5-F10).
import { classifyRecoverability, type Recover } from "./classify.ts";
import { handleFor, makePlaceholderFor, pickKeyLines, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { createHash } from "node:crypto";
import { type Any, PRODUCT, clamp, envInt, textOf, tok4, tokensOf } from "./util.ts";
import { PH_MARK } from "./placeholder.ts";
import { MIN_EXPECT, type Prices } from "./learn.ts";

/** Default: when a COLD plan (P(warm) < 0.5) is still above the cap, also fold REREADABLE outputs of the previous user turn, biggest
 *  first. A warm plan never does: the user comes back to a warm cache and refers to the turn just finished (final model: +4.0 / +5.8
 *  lost items with it); at a cold return the cache is rewritten anyway. false = no relax fold of the previous user turn, but the
 *  in-turn rule (INTURN_AGE) still folds old outputs there; set PI_ZIP_INTURN_AGE=0 as well for a fully protected previous turn. */
export const RELAX_PREV_TURN = true;

/** Default age, in assistant requests, from which ANY foldable output (every recoverability class) inside the protected user turns may
 *  still be folded. A sub-agent session is one user turn with hundreds of tool rounds, so without this its candidate set is empty for
 *  its whole life (offline sim on 295 recorded sessions: 1.37x the billion-context bill). 0 disables the rule (PI_ZIP_INTURN_AGE).
 *  Plans run at turn_end, before the next request, so `age >= 60` here equals the sim's `b <= v - 61`. 60 is the final model's quality
 *  constant (largest saving with lost <= prod in every stratum); the old rereadable-only filter cost 1.026 / 1.018x at -0.6 lost items. */
export const INTURN_AGE = 60;

const PROTECT_USER_TURNS = 2; // the latest user turn and the one before it are never summarised; folded only by relax (cold plan, previous turn, rereadable) or in-turn (old enough)
const SUMMARY_FLOOR = 1000;
const SUMMARY_CAP = 8000;
const SUMMARY_RATIO = 0.1;

export const DEFAULT_RESERVE_TOKENS = 16_384; // Pi's compaction reserve default
export const COMPACT_MARGIN = 8_192; // estimates are chars/4: stay clear of the trigger
const MIN_TARGET = 4_096;

/** Pi's compaction reserve for this model: compaction.modelOverrides["provider/id"], else compaction.reserveTokens, else 16384. */
export function reserveTokensFor(settings: Any, model: Any): number {
	const c = settings?.compaction;
	const key = model ? `${model.provider}/${model.id}` : "";
	for (const v of [c?.modelOverrides?.[key]?.reserveTokens, c?.reserveTokens]) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	return DEFAULT_RESERVE_TOKENS;
}

/** Highest context size that stays clear of Pi's compaction trigger; null when the window is unknown. */
export function compactionRoom(model: Any, reserve = DEFAULT_RESERVE_TOKENS): number | null {
	const w = Number(model?.contextWindow);
	return w > 0 ? Math.max(MIN_TARGET, w - reserve - COMPACT_MARGIN) : null;
}

// Legacy rule, only when nothing at all is known about prices (cache class unknown: no response from this model yet): a warm edit must cut at least half
// of the context, or, inside Pi's compaction danger zone (before >= room), merely reduce it.
export const VALVE_MIN_REDUCTION = 0.5;
export function legacyValve(before: number, after: number, room: number | null): boolean {
	if (!(after < before)) return false;
	if (room !== null && before >= room) return true;
	return after <= (1 - VALVE_MIN_REDUCTION) * before;
}

export const PI_KEEP_RECENT = 20_000; // Pi's compaction keepRecentTokens default
export const G0 = 2_500; // growth per request before the session's own EWMA has data

/** What the law knows at a decision: prices (null = legacy rule), growth per request g (real tokens), P(the cache is warm). */
export interface Law { pr: Prices | null; g: number; pWarm: number }
export interface LawTerms { ok: boolean; B: number; A: number; T: number; P: number; K: number; eta: number; phi: number; Tsuf?: number }

/**
 * The round-5 law (verdict section 8): rewrite the cache only when what the edit saves pays for the rewrite it causes.
 *   Phi = [ r D^2/(2g) + eta D ] / K >= 1,   D = B - A,   K = (w - r) (P T - (1 - P) D) + call
 * B, A = real context before / after the edit. T = the rewrite base; the planner passes T = A (final model: pricing only the suffix after
 * the earliest edit, ~0.42 A, fires warm edits earlier and costs +0.9 / +4.6 lost items for -0.6 / -0.3% $; the suffix is logged as Tsuf,
 * a measurement only). T is clamped to A. P = P(warm) at this gap: 1 = the verdict's warm valve, 0 = known dead (K < 0: always fire). The expected form is
 * linear in P because a warm next request costs (w - r) T - r D more with the edit and a cold one w D less, plus the r D read credit.
 * eta = 0 below Pi's compaction room, else Pi's own price per token of room (window term). Prices per token; no prices = legacy rule.
 */
export function lawTerms(B: number, A: number, P: number, room: number | null, pr: Prices | null, g: number, call = 0, T = A, keep = PI_KEEP_RECENT): LawTerms {
	const t: LawTerms = { ok: false, B, A, T, P, K: NaN, eta: 0, phi: NaN };
	if (!(A < B)) return t;
	if (!pr || !(pr.r > 0)) return { ...t, ok: legacyValve(B, A, room) };
	const { r, w, out } = pr;
	const D = B - A, K = (w - r) * (P * Math.min(T, A) - (1 - P) * D) + call;
	let eta = 0;
	if (room !== null && B >= room) {
		const S = Math.min(8_000, Math.max(1_000, 0.1 * (B - keep))), Api = keep + S;
		eta = (w * (B - keep) + out * S + (w - r) * Api) / Math.max(B - Api, 1);
	}
	const gain = (r * D * D) / (2 * Math.max(g, 1)) + eta * D;
	return { ...t, ok: K <= 0 || gain >= K, K, eta, phi: K > 0 ? gain / K : Infinity };
}

export const editAllowed = (B: number, A: number, P: number, room: number | null, pr: Prices | null, g: number, call = 0, T = A): boolean =>
	lawTerms(B, A, P, room, pr, g, call, T).ok;

// Token scale. Every size in this file is a chars/4 estimate, and chars/4 undercounts real tokens (JSON-heavy tool calls, code,
// identifiers, tool definitions that are not in the text at all). `k` = real tokens per estimated token; every limit (cold cap,
// compaction room, min gain) is compared against k x estimate, so they mean REAL tokens. k is read from the branch itself (the
// usage of the newest assistant message), so it survives a restart and needs no stored state. With no usage to read, DEFAULT_K
// applies: 1.7 is the ratio measured on recorded coding sessions (real first-request context / chars/4 estimate: 1.72 after cold
// returns, 1.71 for previous-prompt peaks), and a too-high k only folds a little deeper, a too-low k leaves the context over the cap.
export const DEFAULT_K = 1.7;
export const K_MIN = 1; // an estimate above the real count is not trusted: never scale down
export const K_MAX = 2.5;

export interface Calibration {
	k: number;
	real: number; // input + cacheRead + cacheWrite of the request that produced the newest usable assistant message (0 = none)
	est: number; // estimate of what that request carried: system prompt + the view blocks before that message
	source: "usage" | "default";
}

/**
 * k from the branch: the newest assistant message with usage says how many real tokens its request carried; the estimate of the
 * view blocks before it (the projection, with the folds and cut as persisted, which are exactly what that request carried, I1)
 * says how many we would have guessed. Only the INPUT side is used: that message's own output is not part of the request it
 * answered, and thinking tokens may or may not be sent back, so including output would add noise to the ratio.
 * Skipped: errored messages, messages without input usage, and messages older than a compaction Pi made (not ours): their
 * request carried text the projection no longer has.
 */
export function calibrate(entries: Any[], sys = 0): Calibration {
	const none: Calibration = { k: DEFAULT_K, real: 0, est: 0, source: "default" };
	const blocks = buildBlocks(entries);
	let foreignCompactionMs = 0;
	for (const pe of entries) {
		const src = pe.sourceEntry;
		if (src?.type === "compaction" && src.details?.by !== PRODUCT) foreignCompactionMs = Math.max(foreignCompactionMs, Date.parse(src.timestamp) || 0);
	}
	const before: number[] = []; // estimate of blocks[0..i)
	let acc = 0;
	for (const b of blocks) { before.push(acc); acc += b.tokens; }
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].kind !== "assistant") continue;
		const m = blocks[i].raw ?? blocks[i].msg;
		const u = m?.usage;
		const real = u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
		if (!(real > 0) || m.stopReason === "error") continue;
		if (foreignCompactionMs && typeof m.timestamp === "number" && m.timestamp < foreignCompactionMs) return none;
		const est = sys + before[i];
		if (!(est > 0)) return none;
		return { k: clamp(real / est, K_MIN, K_MAX), real, est, source: "usage" };
	}
	return none;
}

export const settings = () => ({
	coldCap: envInt("COLD_CAP", 40_000), // cold: fold, then summarise, down to this many tokens
	foldMin: envInt("FOLD_MIN", 500), // outputs below this many tokens are never folded
	keepLines: envInt("KEEP_LINES", 8),
	minGain: envInt("MIN_GAIN", 10_000), // legacy rule only (no prices): a summary must remove at least max(minGain, 15% of the context)
	inturnAge: envInt("INTURN_AGE", INTURN_AGE), // outputs (any class) of the protected turns at least this many assistant requests old may fold; 0 = never
});

/** Legacy summary gate (no prices): a summary only pays when it removes a real share of the context. */
export function summaryGainOk(prefixTokens: number, summaryTokens: number, totalTokens: number, minGain = settings().minGain): boolean {
	return prefixTokens - summaryTokens >= Math.max(minGain, 0.15 * totalTokens);
}

// ---------------------------------------------------------------------------------------------------------------
// blocks: the model-visible context, one block per projected session entry
// ---------------------------------------------------------------------------------------------------------------
export interface Block {
	idx: number;
	entryId: string | null;
	kind: "summary" | "user" | "assistant" | "toolResult" | "other";
	msg: Any; // projected message (after edits)
	raw: Any; // original message (before edits), message entries only
	tokens: number;
	userTurn: number; // user messages so far (inclusive)
	edited: boolean; // some context_edit changed this entry
	ours: boolean; // ... and it is one of our placeholders
	age: number; // toolResult: assistant requests that came after the one that issued the call (0 = answered by the newest request); other kinds 0
}
export type Calls = Map<string, { name: string; args: Any }>;

/** User turns so far: the real prompts. Steering and follow-up messages typed during a run belong to that run's turn. */
export const countUserTurns = (blocks: Block[]): number => blocks.reduce((a, b) => Math.max(a, b.userTurn), 0);

export function buildBlocks(contextEntries: Any[], steerIds?: Set<string>): Block[] {
	const blocks: Block[] = [];
	let userTurn = 0;
	let asst = 0; // assistant messages so far
	const issued = new Map<string, number>(); // tool call id -> ordinal of the latest assistant message that issued it (ids may be reused)
	const asstOf: number[] = []; // block idx -> ordinal of the issuing assistant message (toolResult blocks only)
	for (const pe of contextEntries) {
		const src = pe.sourceEntry;
		const msgs: Any[] = pe.messages ?? [];
		if (!msgs.length) continue;
		let kind: Block["kind"] = "other";
		let msg = msgs[msgs.length - 1];
		let raw: Any;
		let edited = false;
		if (src.type === "compaction") {
			kind = "summary";
			msg = msgs.find((m) => m.role === "compactionSummary") ?? msg;
		} else if (src.type === "message" && msgs.length === 1) {
			raw = src.message;
			msg = msgs[0];
			const r = msg.role;
			kind = r === "user" ? "user" : r === "assistant" ? "assistant" : r === "toolResult" ? "toolResult" : "other";
			edited = msg !== raw && msg.content !== raw.content;
		}
		if (kind === "user" && !(src.id && steerIds?.has(src.id))) userTurn++;
		const ours = edited && kind === "toolResult" && textOf(msg.content).startsWith(PH_MARK);
		if (kind === "assistant") {
			// aborted / final-error messages stay in the projection but pi-ai drops them before sending: they add no age (their calls still count as issued)
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") asst++;
			for (const c of msg.content ?? []) if (c?.type === "toolCall") issued.set(c.id, asst);
		}
		asstOf[blocks.length] = kind === "toolResult" ? (issued.get(msg.toolCallId) ?? asst) : asst;
		blocks.push({ idx: blocks.length, entryId: src.id ?? null, kind, msg, raw, tokens: msgs.reduce((a, m) => a + tokensOf(m), 0), userTurn, edited, ours, age: 0 });
	}
	for (const b of blocks) if (b.kind === "toolResult") b.age = asst - asstOf[b.idx];
	return blocks;
}

export function toolCallIndex(blocks: Block[]): Calls {
	const m: Calls = new Map();
	for (const b of blocks) if (b.kind === "assistant") for (const c of b.msg.content ?? []) if (c?.type === "toolCall") m.set(c.id, { name: c.name, args: c.arguments });
	return m;
}

// ---------------------------------------------------------------------------------------------------------------
// plan types
// ---------------------------------------------------------------------------------------------------------------
export interface FoldTarget {
	entryId: string;
	toolCallId: string;
	visIdx: number; // index among the non-system projected messages when planned (-1 = unknown)
	contentKey: string; // hash + length of the original text: some servers reuse tool call ids, so the id alone does not identify a result
	tool: string;
	args: string;
	entryTokens: number;
	phTokens: number;
	ph: string; // placeholder text: byte-identical in the request-local view and the persisted context_edit
	trig: string;
	recover?: Recover;
}

export interface Cut {
	firstKeptEntryId: string;
	text: string; // summary text: byte-identical in the request-local view and the persisted compaction
	trigger: "cold" | "valve";
	count: number; // user requests carried verbatim in the summary
	prefixTokens: number;
	summaryTokens: number;
	llmOk: boolean;
	llmError: string | null;
	costUsd: number; // what the narrative model call cost (0 when unknown)
	usage?: Any;
	ms: number; // total production time (the narrative model call included)
}

/** What a run sends from its first request on and persists verbatim at turn_end (F8). */
export interface RunPlan {
	source: "settle" | "runstart" | "valve";
	folds: FoldTarget[];
	cut: Cut | null;
	ctxBefore: number;
	ctxAfter: number;
	ms: number;
	k: number; // the token scale the plan was made with (stats and notices of this run use the same one)
	persisted: boolean;
	cutVisibleIdx?: number; // where the kept part starts among the projected non-system messages
	cutKeptFirstMsg?: Any; // ... and that message itself (a disagreeing request view drops the cut)
	sent?: boolean; // a request view carrying this plan has gone out
	applied?: Set<string>; // entry ids whose fold the latest request view actually carried (what turn_end must persist, no more)
	cutTs?: number; // timestamp of the request-local summary message: one value per run, so every request of the run is identical
	untouched?: number; // real tokens before the earliest edited block: what the first request carrying the plan can still read from the cache
}

export interface PlanOpts {
	mode?: "cold" | "warm"; // cold: cache believed gone (default). warm: only when the context is above the cold cap and the law fires; then the cold plan without the previous-turn relax.
	law?: Law; // prices, g and P(warm); default: no prices (legacy rule), P = 0 cold / 1 warm
	trace?: (LawTerms & { where: "summary" | "plan" })[]; // every law evaluation is pushed here (ledger)
	reserve?: number; // Pi's compaction reserveTokens (default 16384)
	steerIds?: Set<string>; // user entries that are mid-run steering or follow-up messages, not new user turns
	sys: number; // estimated tokens of the system prompt (same chars/4 scale as the blocks; tool definitions are covered by k)
	k?: number; // real tokens per estimated token (calibrate); default 1 = the estimates are taken as real
	cwd: string;
	coldCap?: number;
	foldMin?: number;
	keepLines?: number;
	recalled?: Set<string>;
	model?: Any;
	promptPending?: boolean; // true at settle: the upcoming prompt is NOT in `entries` yet but counts as a new user turn
	relax?: boolean; // default RELAX_PREV_TURN
	minGain?: number;
	inturnAge?: number; // default settings().inturnAge (PI_ZIP_INTURN_AGE, 60); 0 = outputs of the protected turns never fold on age
}

export interface PlanResult {
	blocks: Block[];
	calls: Calls;
	folds: FoldTarget[];
	cutIdx: number | null;
	firstKeptEntryId: string | null;
	prefixTokens: number; // estimate units (x k = real), like summaryTokensPlanned
	summaryTokensPlanned: number;
	sumTrigger: "cold" | "valve" | null;
	k: number;
	ctxTokens: number; // calibrated: k x (sys + blocks)
	ctxAfterFolds: number; // calibrated
	userTurns: number;
	cutVisibleIdx: number;
	cutKeptFirstMsg: Any;
}

/** Estimated tokens before the earliest edited block (system prompt included): what stays cached through the edit. A cut edits from the start. */
export function untouchedEst(blocks: Block[], folds: FoldTarget[], cut: boolean, sys: number): number {
	const ids = new Set(folds.map((t) => t.entryId));
	let est = sys;
	if (!cut) for (const b of blocks) { if (b.entryId && ids.has(b.entryId)) break; est += b.tokens; }
	return est;
}

/** Identity of a tool result's text, independent of its tool call id. */
export const contentKeyOf = (content: Any): string => {
	const t = textOf(content);
	return `${createHash("sha1").update(t).digest("hex")}:${t.length}`;
};

/** The planner. Cold: fold everything outside the protected window, relax into the previous turn if still above the cap,
 *  summarise only if folds cannot reach the cap and the law prices the summary call in. Warm: null unless the context is above the
 *  cold cap and the law fires for the plan (the summary call is sunk there); then the cold plan minus the previous-turn relax (a warm plan
 *  never folds the previous user turn by relax). A cold plan with P(warm) > 0
 *  passes the same law (expected cost). The cap never exceeds Pi's compaction room. Returns null when there is nothing to plan on
 *  or the law says no. */
export function planContext(entries: Any[], o: PlanOpts): PlanResult | null {
	const s = settings();
	const mode = o.mode ?? "cold";
	// limits are in real tokens; the plan works in estimate units, so they are divided by k once, here
	const k = o.k ?? 1;
	const room = compactionRoom(o.model, o.reserve);
	const coldCap = Math.min(o.coldCap ?? s.coldCap, room ?? Infinity) / k;
	const law: Law = o.law ?? { pr: null, g: G0, pWarm: mode === "cold" ? 0 : 1 };
	const gate = (where: "summary" | "plan", B: number, A: number, r: number | null, call: number, T: number, Tsuf?: number): boolean => {
		const t = lawTerms(B, A, law.pWarm, r, law.pr, law.g, call, T);
		o.trace?.push({ where, ...t, ...(Tsuf !== undefined ? { Tsuf } : {}) });
		return t.ok;
	};
	const minGain = (o.minGain ?? s.minGain) / k;
	const foldMin = o.foldMin ?? s.foldMin;
	const keepLines = o.keepLines ?? s.keepLines;
	const relax = o.relax ?? RELAX_PREV_TURN;
	const inturnAge = o.inturnAge ?? s.inturnAge;
	const blocks = buildBlocks(entries, o.steerIds);
	if (!blocks.length) return null;
	const userTurns = countUserTurns(blocks) + (o.promptPending ? 1 : 0); // the upcoming prompt is a new user turn
	const calls = toolCallIndex(blocks);
	const recalled = o.recalled ?? new Set<string>();
	const ctxEst = o.sys + blocks.reduce((a, b) => a + b.tokens, 0);
	if (mode === "warm" && !(ctxEst > coldCap)) return null; // I6: warm cache below the cold cap -> never edit
	const trig = mode === "warm" ? "valve" : "cold";
	const tokOverride = new Map<number, number>();
	const folds: FoldTarget[] = [];
	const visOfBlock: number[] = []; // block idx -> index among the non-system projected messages (the numbering a request view uses)
	{
		let vis = 0;
		for (const pe of entries) {
			const msgs: Any[] = pe.messages ?? [];
			if (!msgs.length) continue;
			visOfBlock.push(vis);
			for (const m of msgs) if (String(m?.role ?? "") !== "system") vis++;
		}
	}
	const classify = (b: Block): Recover => {
		const call = calls.get(b.msg.toolCallId);
		return classifyRecoverability(call?.name ?? b.msg.toolName ?? "", call?.args, textOf((b.raw ?? b.msg).content), o.cwd);
	};
	const addFold = (b: Block, trig: string): boolean => {
		if (tokOverride.has(b.idx) || recalled.has(handleFor(b.entryId!))) return false; // F4: never refold what the model recalled
		const ph = makePlaceholderFor(b, calls, keepLines);
		if (ph === null) return false;
		const phTok = tok4(ph);
		if (!(phTok < 0.9 * b.tokens)) return false;
		tokOverride.set(b.idx, phTok);
		const call = calls.get(b.msg.toolCallId);
		folds.push({ entryId: b.entryId!, toolCallId: b.msg.toolCallId, visIdx: visOfBlock[b.idx] ?? -1, contentKey: contentKeyOf(b.msg.content), tool: call?.name ?? b.msg.toolName ?? "tool", args: call ? shortArgs(call.args) : "", entryTokens: b.tokens, phTokens: phTok, ph, trig, recover: classify(b) });
		return true;
	};
	// a zip_recall result IS content the model just asked for: folding it would undo the recall (and loop); never
	const isRecall = (b: Block) => (calls.get(b.msg.toolCallId)?.name ?? b.msg.toolName) === RECALL_TOOL;
	// Observability: on an automatic (prefix) cache no fold starts inside the first MIN_EXPECT real tokens, so the next response's cacheRead
	// is an uncensored survival sample (learn.ts sample). Without it every idle return folded into the first 1-7K tokens and its sample was
	// censored, so the learned curve never saw a return (live GLM bench). Explicit caches are exempt: the provider looks back only ~20
	// blocks from the last breakpoint, a far head is not read either way. A cut replaces the prefix from the first message: exempt too.
	const head = law.pr?.cls === "automatic" ? MIN_EXPECT / k : 0;
	const start: number[] = [];
	blocks.reduce((acc, b) => ((start[b.idx] = acc), acc + b.tokens), o.sys);
	const foldable = (b: Block) => b.kind === "toolResult" && !b.edited && !!b.entryId && b.tokens > foldMin && !isRecall(b) && start[b.idx] >= head;
	const protectedTurn = (b: Block) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1;
	const savings = () => folds.reduce((a, t) => a + t.entryTokens - t.phTokens, 0);
	const cands = blocks.filter((b) => foldable(b) && !protectedTurn(b));
	for (const b of cands) addFold(b, trig);
	if (relax && mode === "cold") {
		// the protected window = the new prompt + the previous user turn; that turn's big reads are what makes a cold return
		// expensive. Rereadable ones can be recalled exactly: fold them biggest-first until the cap; never the latest turn's own.
		// Cold plans only: a warm plan keeps the previous user turn visible.
		let est = ctxEst - savings();
		if (est > coldCap) {
			const prev = blocks.filter((b) => foldable(b) && protectedTurn(b) && b.userTurn < userTurns && classify(b) === "rereadable");
			for (const b of prev.sort((x, y) => y.tokens - x.tokens)) {
				if (est <= coldCap) break;
				if (addFold(b, `${trig}(relax)`)) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
			}
		}
	}
	if (inturnAge > 0) {
		// in-turn: a protected turn (the new prompt's, the previous one, or the one a mid-run cold return / valve is inside) still holds
		// outputs that are many requests old; they fold biggest-first until the cap, whatever their recoverability class (every fold
		// stays recallable). Age = assistant requests since the call was issued (the newest outputs, age < inturnAge, always stay).
		let est = ctxEst - savings();
		if (est > coldCap) {
			const aged = blocks.filter((b) => foldable(b) && protectedTurn(b) && b.age >= inturnAge);
			for (const b of aged.sort((x, y) => y.tokens - x.tokens)) {
				if (est <= coldCap) break;
				if (addFold(b, `${trig}(inturn)`)) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
			}
		}
	}
	let ctxAfterFolds = ctxEst - savings();
	const sumTrigger: "cold" | "valve" | null = ctxAfterFolds > coldCap ? trig : null;
	let cutIdx: number | null = null;
	let prefixTokens = 0;
	let summaryTokensPlanned = 0;
	if (sumTrigger) {
		const limit = blocks.findIndex((b) => protectedTurn(b));
		const cuts: number[] = [];
		const minCut = blocks[0].kind === "summary" ? 2 : 1; // never re-summarise a prefix that is only the previous summary
		for (let i = minCut; i < blocks.length; i++) {
			if (limit >= 0 && i > limit) break;
			if (blocks[i].entryId && (blocks[i].kind === "user" || blocks[i].kind === "assistant")) cuts.push(i);
		}
		const pre: number[] = [];
		let acc = 0;
		for (let i = 0; i < blocks.length; i++) {
			pre[i] = acc;
			acc += tokOverride.get(i) ?? blocks[i].tokens;
		}
		const total = o.sys + acc;
		const S = (x: number) => clamp(SUMMARY_RATIO * x, SUMMARY_FLOOR, SUMMARY_CAP);
		if (cuts.length) {
			let pick = cuts[cuts.length - 1];
			for (const c of cuts) if (total - pre[c] + S(pre[c]) <= coldCap) { pick = c; break; }
			// cold: the summary call must pay for itself (verdict: call = w X + out S for an uncached call); warm: it is sunk in the plan's law
			const X = k * pre[pick], Sr = k * S(pre[pick]);
			const gain = !law.pr ? summaryGainOk(pre[pick], S(pre[pick]), total, minGain) : mode === "warm" || gate("summary", X, Sr, null, law.pr.w * X + law.pr.out * Sr, Sr);
			if (pre[pick] >= 2 * S(pre[pick]) && gain) {
				cutIdx = pick;
				prefixTokens = pre[pick];
				summaryTokensPlanned = S(pre[pick]);
				for (let i = folds.length - 1; i >= 0; i--) {
					const bi = blocks.findIndex((b) => b.entryId === folds[i].entryId);
					if (bi < pick) { tokOverride.delete(bi); folds.splice(i, 1); } // the prefix is replaced: its folds are void
				}
				ctxAfterFolds = ctxEst - savings();
			}
		}
	}
	// where the kept part starts among the projected non-system messages (the request-local view drops everything before it)
	let cutVisibleIdx = -1;
	let cutKeptFirstMsg: Any;
	if (cutIdx !== null) {
		let vis = 0;
		let bi = 0;
		for (const pe of entries) {
			const msgs: Any[] = pe.messages ?? [];
			if (!msgs.length) continue;
			for (const m of msgs) {
				if (String(m?.role ?? "") === "system") continue;
				if (bi === cutIdx && cutVisibleIdx < 0) { cutVisibleIdx = vis; cutKeptFirstMsg = m; }
				vis++;
			}
			bi++;
		}
	}
	// the untouched prefix: everything before the earliest edited block (a cut edits from the first block on)
	const untouched = untouchedEst(blocks, folds, cutIdx !== null, o.sys);
	const after = ctxAfterFolds - (cutIdx !== null ? prefixTokens - summaryTokensPlanned : 0);
	const planned = folds.length > 0 || cutIdx !== null;
	// F10: a warm rewrite must pay back; a cold plan with some chance of a warm cache is priced by expectation (no prices: cold always fires).
	// T = A (the whole post-edit context); the suffix after the earliest edit goes to the ledger only.
	if ((mode === "warm" || (planned && law.pr)) && !gate("plan", k * ctxEst, k * after, room, 0, k * after, k * (after - untouched))) return null;
	return { blocks, calls, folds, cutIdx, firstKeptEntryId: cutIdx !== null ? blocks[cutIdx].entryId : null, prefixTokens, summaryTokensPlanned, sumTrigger, k, ctxTokens: k * ctxEst, ctxAfterFolds: k * ctxAfterFolds, userTurns, cutVisibleIdx, cutKeptFirstMsg };
}

const sameMsg = (a: Any, b: Any): boolean =>
	!!a && !!b && String(a?.role ?? "") === String(b?.role ?? "") && JSON.stringify(a?.content ?? "") === JSON.stringify(b?.content ?? "");

const isSystem = (m: Any) => String(m?.role ?? "") === "system";

/**
 * Replay every system message into the one leading message Pi puts at the head of a compacted projection
 * (same rules as pi-ai getCurrentSystemMessage; the integration test checks the two agree).
 */
export function collapseSystem(messages: Any[]): Any | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, Any>();
	let timestamp: number | undefined;
	for (const m of messages) {
		if (!isSystem(m)) continue;
		timestamp ??= m.timestamp;
		const text = textOf(m.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(m.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value as string);
		}
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
	}
	if (timestamp === undefined && tools.size === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.size > 0 ? { toolsAdded: [...tools.values()] } : {}),
		timestamp: timestamp ?? 0,
	};
}

/**
 * Request-local view of a plan over the COMPLETE transcript (the `context_with_system` form): fold targets are replaced
 * in place, system messages stay exactly where they are (so the request is byte-identical before and after turn_end
 * persists the same edits, I1). With a cut, the view is what Pi projects after the compaction: the replayed system
 * message, the summary, then the kept non-system messages. null = nothing to apply. A cut whose kept boundary cannot be
 * located is dropped (folds still apply); an inconsistent split is never sent.
 */
export function applyPlanToMessages(messages: Any[], plan: RunPlan | null): { messages: Any[]; droppedCut: boolean; applied: Set<string> } | null {
	if (!plan || plan.persisted || (!plan.folds.length && !plan.cut)) return null;
	const vis: number[] = []; // indices of the non-system messages
	messages.forEach((m, i) => { if (!isSystem(m)) vis.push(i); });
	let cutAt = -1; // index into `messages`
	let droppedCut = false;
	if (plan.cut) {
		const v = plan.cutVisibleIdx ?? -1;
		cutAt = v >= 0 && v < vis.length ? vis[v] : -1;
		if (cutAt < 0 || !sameMsg(messages[cutAt], plan.cutKeptFirstMsg)) {
			plan.cut = null;
			cutAt = -1;
			droppedCut = true;
		}
	}
	// match each result to its target: by position when the position still holds the same result, else by (call id, content) when that is unique
	const used = new Set<FoldTarget>();
	const applied = new Set<string>();
	const byKey = new Map<string, FoldTarget[]>();
	const key = (id: string, ck: string) => `${id}|${ck}`;
	for (const t of plan.folds) {
		const k = key(t.toolCallId, t.contentKey);
		byKey.set(k, [...(byKey.get(k) ?? []), t]);
	}
	const seenKey = new Map<string, number>(); // how many results in THIS request carry each (id, content): more than one = ambiguous
	for (const m of messages) {
		if (m?.role !== "toolResult" || !byKey.has(key(m.toolCallId, contentKeyOf(m.content)))) continue;
		const k = key(m.toolCallId, contentKeyOf(m.content));
		seenKey.set(k, (seenKey.get(k) ?? 0) + 1);
	}
	const byPos = new Map<number, FoldTarget>();
	for (const t of plan.folds) if (t.visIdx >= 0) byPos.set(t.visIdx, t);
	let changed = false;
	let v = -1;
	const folded = messages.map((m: Any, i: number) => {
		if (isSystem(m)) return m;
		v++;
		if (cutAt >= 0 && i < cutAt) return m; // replaced by the compaction message below
		if (m?.role !== "toolResult" || textOf(m.content).startsWith(PH_MARK)) return m; // not ours, or the persisted edit already folded it
		const ck = contentKeyOf(m.content);
		let t = byPos.get(v);
		if (!t || used.has(t) || t.toolCallId !== m.toolCallId || t.contentKey !== ck) {
			const k = key(m.toolCallId, ck);
			const c = byKey.get(k);
			t = c && c.length === 1 && seenKey.get(k) === 1 && !used.has(c[0]) ? c[0] : undefined;
		}
		if (!t) return m;
		used.add(t);
		applied.add(t.entryId);
		changed = true;
		return { ...m, content: [{ type: "text", text: t.ph }] };
	});
	if (cutAt >= 0) {
		const c = plan.cut!;
		const head = collapseSystem(messages);
		const kept = folded.slice(cutAt).filter((m: Any) => !isSystem(m));
		return { messages: [...(head ? [head] : []), { role: "compactionSummary", summary: c.text, tokensBefore: c.prefixTokens, timestamp: plan.cutTs ??= Date.now() }, ...kept], droppedCut, applied };
	}
	return changed || droppedCut ? { messages: folded, droppedCut, applied } : null;
}

export { pickKeyLines };
