// Pure planning: session projection -> which outputs to fold, whether to summarise, where to cut (F5-F10).
import { classifyRecoverability, type Recover } from "./classify.ts";
import { handleFor, makePlaceholderFor, pickKeyLines, shortArgs } from "./placeholder.ts";
import { type Any, clamp, envInt, textOf, tok4, tokensOf } from "./util.ts";
import { PH_MARK } from "./placeholder.ts";

/** Default: when a cold return is still above the cap, also fold REREADABLE outputs of the previous user turn, biggest first.
 *  false = the previous user turn stays fully protected. The only knob that is meant to be flipped. */
export const RELAX_PREV_TURN = true;

const PROTECT_USER_TURNS = 2; // the latest user turn and the one before it are never folded or summarised
const SUMMARY_FLOOR = 1000;
const SUMMARY_CAP = 8000;
const SUMMARY_RATIO = 0.1;
export const FOLD_AT = 0.8; // hot: fold only above this share of the context window
export const SUMMARY_AT = 0.85; // hot: summarise only above this share of the context window

export const settings = () => ({
	coldCap: envInt("COLD_CAP", 60_000), // cold: fold, then summarise, down to this many tokens
	foldMin: envInt("FOLD_MIN", 500), // outputs below this many tokens are never folded
	keepLines: envInt("KEEP_LINES", 8),
	minGain: envInt("MIN_GAIN", 10_000), // a summary must remove at least max(minGain, 15% of the context)
});

/** A summary only pays when it removes a real share of the context. */
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
}
export type Calls = Map<string, { name: string; args: Any }>;

export function buildBlocks(contextEntries: Any[]): Block[] {
	const blocks: Block[] = [];
	let userTurn = 0;
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
		if (kind === "user") userTurn++;
		const ours = edited && kind === "toolResult" && textOf(msg.content).startsWith(PH_MARK);
		blocks.push({ idx: blocks.length, entryId: src.id ?? null, kind, msg, raw, tokens: msgs.reduce((a, m) => a + tokensOf(m), 0), userTurn, edited, ours });
	}
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
	trigger: "cold" | "hard";
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
	source: "settle" | "runstart" | "pressure";
	folds: FoldTarget[];
	cut: Cut | null;
	ctxBefore: number;
	ctxAfter: number;
	ms: number;
	persisted: boolean;
	cutVisibleIdx?: number; // where the kept part starts among the projected non-system messages
	cutKeptFirstMsg?: Any; // ... and that message itself (a disagreeing request view drops the cut)
}

export interface PlanOpts {
	mode?: "cold" | "hot"; // cold: cache already gone (default). hot: window pressure only.
	base: number; // system prompt + tools + estimation error, in tokens
	cwd: string;
	coldCap?: number;
	foldMin?: number;
	keepLines?: number;
	recalled?: Set<string>;
	model?: Any;
	promptPending?: boolean; // true at settle: the upcoming prompt is NOT in `entries` yet but counts as a new user turn
	relax?: boolean; // default RELAX_PREV_TURN
	minGain?: number;
}

export interface PlanResult {
	blocks: Block[];
	calls: Calls;
	folds: FoldTarget[];
	cutIdx: number | null;
	firstKeptEntryId: string | null;
	prefixTokens: number;
	summaryTokensPlanned: number;
	sumTrigger: "cold" | "hard" | null;
	ctxTokens: number;
	ctxAfterFolds: number;
	userTurns: number;
	cutVisibleIdx: number;
	cutKeptFirstMsg: Any;
}

export const foldThreshold = (model: Any): number | null => (Number(model?.contextWindow) > 0 ? FOLD_AT * Number(model.contextWindow) : null);
export const summaryThreshold = (model: Any): number | null => (Number(model?.contextWindow) > 0 ? SUMMARY_AT * Number(model.contextWindow) : null);

/** The planner. Cold: fold everything outside the protected window, relax into the previous turn if still above the cap,
 *  summarise only if folds cannot reach the cap and the gain gate passes. Hot: nothing below 80% of the window; above it
 *  fold newest-first down to 80%, summarise only above 85%. Returns null when there is nothing to plan on. */
export function planContext(entries: Any[], o: PlanOpts): PlanResult | null {
	const s = settings();
	const mode = o.mode ?? "cold";
	const coldCap = o.coldCap ?? s.coldCap;
	const foldMin = o.foldMin ?? s.foldMin;
	const keepLines = o.keepLines ?? s.keepLines;
	const relax = o.relax ?? RELAX_PREV_TURN;
	const blocks = buildBlocks(entries);
	if (!blocks.length) return null;
	const userTurns = blocks.filter((b) => b.kind === "user").length + (o.promptPending ? 1 : 0); // the upcoming prompt is a new user turn
	const calls = toolCallIndex(blocks);
	const recalled = o.recalled ?? new Set<string>();
	const ctxTokens = o.base + blocks.reduce((a, b) => a + b.tokens, 0);
	const foldAt = foldThreshold(o.model);
	const hardAt = summaryThreshold(o.model);
	if (mode === "hot" && !(foldAt !== null && ctxTokens > foldAt)) return null; // I6: warm cache below the pressure line -> never edit
	const tokOverride = new Map<number, number>();
	const folds: FoldTarget[] = [];
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
		folds.push({ entryId: b.entryId!, toolCallId: b.msg.toolCallId, tool: call?.name ?? b.msg.toolName ?? "tool", args: call ? shortArgs(call.args) : "", entryTokens: b.tokens, phTokens: phTok, ph, trig, recover: classify(b) });
		return true;
	};
	const foldable = (b: Block) => b.kind === "toolResult" && !b.edited && !!b.entryId && b.tokens > foldMin;
	const protectedTurn = (b: Block) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1;
	const savings = () => folds.reduce((a, t) => a + t.entryTokens - t.phTokens, 0);
	const cands = blocks.filter((b) => foldable(b) && !protectedTurn(b));
	if (mode === "cold") {
		for (const b of cands) addFold(b, "cold");
		if (relax) {
			// the protected window = the new prompt + the previous user turn; that turn's big reads are what makes a cold return
			// expensive. Rereadable ones can be recalled exactly: fold them biggest-first until the cap; never the latest turn's own.
			let est = ctxTokens - savings();
			if (est > coldCap) {
				const prev = blocks.filter((b) => foldable(b) && protectedTurn(b) && b.userTurn < userTurns && classify(b) === "rereadable");
				for (const b of prev.sort((x, y) => y.tokens - x.tokens)) {
					if (est <= coldCap) break;
					if (addFold(b, "cold(relax)")) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
				}
			}
		}
	} else {
		let est = ctxTokens; // newest first: the cache boundary that snaps back stays close to the tail
		for (const b of [...cands].reverse()) {
			if (est <= foldAt!) break;
			if (addFold(b, "pressure")) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
		}
	}
	let ctxAfterFolds = ctxTokens - savings();
	let sumTrigger: "cold" | "hard" | null = mode === "cold" && ctxAfterFolds > coldCap ? "cold" : null;
	if (!sumTrigger && hardAt !== null && ctxAfterFolds > hardAt) sumTrigger = "hard";
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
		const total = o.base + acc;
		const S = (x: number) => clamp(SUMMARY_RATIO * x, SUMMARY_FLOOR, SUMMARY_CAP);
		if (cuts.length) {
			let pick = cuts[cuts.length - 1];
			for (const c of cuts) if (total - pre[c] + S(pre[c]) <= coldCap) { pick = c; break; }
			if (pre[pick] >= 2 * S(pre[pick]) && summaryGainOk(pre[pick], S(pre[pick]), total, o.minGain)) {
				cutIdx = pick;
				prefixTokens = pre[pick];
				summaryTokensPlanned = S(pre[pick]);
				for (let i = folds.length - 1; i >= 0; i--) {
					const bi = blocks.findIndex((b) => b.entryId === folds[i].entryId);
					if (bi < pick) { tokOverride.delete(bi); folds.splice(i, 1); } // the prefix is replaced: its folds are void
				}
				ctxAfterFolds = ctxTokens - savings();
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
	return { blocks, calls, folds, cutIdx, firstKeptEntryId: cutIdx !== null ? blocks[cutIdx].entryId : null, prefixTokens, summaryTokensPlanned, sumTrigger, ctxTokens, ctxAfterFolds, userTurns, cutVisibleIdx, cutKeptFirstMsg };
}

const sameMsg = (a: Any, b: Any): boolean =>
	!!a && !!b && String(a?.role ?? "") === String(b?.role ?? "") && JSON.stringify(a?.content ?? "") === JSON.stringify(b?.content ?? "");

/**
 * Request-local view of a plan: fold its targets and (when planned) replace the summarised prefix with the compaction
 * message, which is exactly what the persisted edits project after turn_end (I1). null = nothing to apply. A cut whose
 * kept boundary cannot be located in the given messages is dropped (folds still apply); an inconsistent split is never sent.
 */
export function applyPlanToMessages(messages: Any[], plan: RunPlan | null): { messages: Any[]; droppedCut: boolean } | null {
	if (!plan || plan.persisted || (!plan.folds.length && !plan.cut)) return null;
	let cutIdx = -1;
	let droppedCut = false;
	if (plan.cut) {
		cutIdx = plan.cutVisibleIdx ?? -1;
		if (cutIdx < 0 || cutIdx >= messages.length || !sameMsg(messages[cutIdx], plan.cutKeptFirstMsg)) {
			plan.cut = null;
			cutIdx = -1;
			droppedCut = true;
		}
	}
	const byCall = new Map(plan.folds.map((t) => [t.toolCallId, t]));
	let changed = false;
	const folded = messages.map((m: Any, i: number) => {
		if (cutIdx >= 0 && i < cutIdx) return m; // replaced by the compaction message below
		const t = m?.role === "toolResult" ? byCall.get(m.toolCallId) : undefined;
		if (!t || textOf(m.content).startsWith(PH_MARK)) return m; // not ours, or the persisted edit already folded it
		changed = true;
		return { ...m, content: [{ type: "text", text: t.ph }] };
	});
	if (cutIdx >= 0) {
		const c = plan.cut!;
		return { messages: [{ role: "compactionSummary", summary: c.text, tokensBefore: c.prefixTokens, timestamp: Date.now() }, ...folded.slice(cutIdx)], droppedCut };
	}
	return changed || droppedCut ? { messages: folded, droppedCut } : null;
}

export { pickKeyLines };
