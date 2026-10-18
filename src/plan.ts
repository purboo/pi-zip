// Pure planning: session projection -> which outputs to fold, whether to summarise, where to cut (F5-F10).
import { classifyRecoverability, type Recover } from "./classify.ts";
import { handleFor, makePlaceholderFor, pickKeyLines, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { createHash } from "node:crypto";
import { type Any, COMMIT_CUSTOM, PRODUCT, clamp, envInt, piTokensOf, textOf, tok4, tokensOf } from "./util.ts";
import { PH_MARK } from "./placeholder.ts";
import { lawPrices, MIN_EXPECT, type Prices } from "./learn.ts";
import { commandNamesRecall, parseRecallPath, type FileRecall } from "./recallfile.ts";
import { parseSummary } from "./summary.ts";
import { mandatoryUserTokens, userTextBefore } from "./user-text.ts";

/** Default age, in assistant requests, from which ANY foldable output (every recoverability class) inside the protected user turns may
 *  still be folded. A sub-agent session is one user turn with hundreds of tool rounds, so without this its candidate set is empty for
 *  its whole life (offline sim on 295 recorded sessions: 1.37x the billion-context bill). 0 disables the rule (PI_ZIP_INTURN_AGE).
 *  Plans run at turn_end, before the next request, so `age >= 60` here equals the sim's `b <= v - 61`. 60 is the final model's quality
 *  constant (largest saving with lost <= prod in every stratum); the old rereadable-only filter cost 1.026 / 1.018x at -0.6 lost items. */
export const INTURN_AGE = 60;

const PROTECT_USER_TURNS = 2; // the latest user turn and the one before it are never summarised; their outputs fold only after a pause (previous turn, re-readable) or when old enough (INTURN_AGE)

/** A summary call is priced as the call summary.ts makes (its narrative): uncached input of the prefix the narrative reads plus the
 *  previous summary's narrative it merges (an upper bound: summary.ts PREV_NARRATIVE_CHARS; the previous summary's lists are not sent,
 *  code carries them forward), plus output of at most the narrative budget. */
/** The narrative's token budget (chars/4), summary.ts buildCut: clamp(planned - skeleton, 300, NARRATIVE_MAX). */
export const NARRATIVE_MAX = 4000;
/** The narrative call's output cap (summary.ts narrative): room above the budget, which is what the prompt asks for and the law
 *  prices. Real replies overshoot the budget (a merge writes ~1.55x its words, CJK text runs ~2 tokens per chars/4 token, reasoning
 *  counts against the cap): capped at the budget, every call of a real CJK session hit the cap (0.4.0, 0.4.1). Never above the
 *  model's own output limit. */
export const NARRATIVE_CALL_MAX = 16_000;
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

export const PI_KEEP_RECENT = 20_000; // Pi's compaction keepRecentTokens default

/** Pi's compaction keepRecentTokens for this model: compaction.modelOverrides["provider/id"], else compaction.keepRecentTokens, else 20000. */
export function keepRecentTokensFor(settings: Any, model: Any): number {
	const c = settings?.compaction;
	const key = model ? `${model.provider}/${model.id}` : "";
	for (const v of [c?.modelOverrides?.[key]?.keepRecentTokens, c?.keepRecentTokens]) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	return PI_KEEP_RECENT;
}

/** Pi's boundary compaction meter: newest valid usage plus trailing messages, else the projected chars/4 estimate.
 *  Like Pi's estimateProjectedContextTokens, a later fold or compaction invalidates that usage. */
export function piContextTokens(entries: Any[], branch: Any[], drafts: Any[] = []): number {
	const messages = entries.flatMap((e) => e.messages ?? []);
	const usage = (m: Any) => {
		const u = m?.role === "assistant" && !dropped(m) ? m.usage : null;
		return u ? Number(u.totalTokens) || (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
	};
	const staged = [...branch, ...drafts];
	const invalid = staged.reduce((at, e, i) => e.type === "context_edit" || e.type === "compaction" ? i : at, -1);
	let n = 0, usageAt = -1, usageId = "";
	for (const e of entries) for (const m of e.messages ?? []) {
		if (usage(m) > 0) { usageAt = n; usageId = e.sourceEntry?.id; }
		n++;
	}
	if (usageAt >= 0 && staged.findIndex((e) => e.id === usageId) > invalid) {
		return usage(messages[usageAt]) + messages.slice(usageAt + 1).reduce((t, m) => t + piTokensOf(m), 0);
	}
	const system = collapseSystem(messages);
	return (system ? piTokensOf(system) : 0) + messages.filter((m) => m.role !== "system").reduce((t, m) => t + piTokensOf(m), 0);
}

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

/**
 * Would Pi's compact() find something to compact in this projection (the branch as it is now), or throw "Nothing to compact (session
 * too small)"? A replica of the emptiness test of Pi's prepareCompaction (core/compaction/compaction.js, not exported): Pi cuts where
 * keepRecent of its chars/4 tokens, counted from the end, begin, at the next cut point; the conversation before that cut (or before the
 * turn it splits) must not be empty. Pi's own extra moves of the cut (over entries without messages, past recovery omissions) never
 * empty it. The caller checks "Already compacted" (the newest branch entry is a compaction) itself.
 */
export function piCanCompact(entries: Any[], keepRecent: number): boolean {
	const msgs = (e: Any): Any[] => (Array.isArray(e?.messages) ? e.messages : []);
	const isComp = (e: Any) => e?.sourceEntry?.type === "compaction";
	const prev = entries.findIndex((e) => isComp(e) && msgs(e).length > 0);
	const start = prev >= 0 ? prev + 1 : 0, end = entries.length;
	const cuts: number[] = [];
	for (let i = start; i < end; i++) if (!isComp(entries[i]) && msgs(entries[i]).some((m) => CUT_POINT_ROLES.has(m?.role))) cuts.push(i);
	if (!cuts.length) return false;
	let cut = cuts[0], acc = 0;
	for (let i = end - 1; i >= start; i--) {
		const t = msgs(entries[i]).reduce((a, m) => a + piTokensOf(m), 0);
		if (!t) continue;
		acc += t;
		if (acc >= keepRecent) { cut = cuts.find((c) => c >= i) ?? cuts[cuts.length - 1]; break; }
	}
	while (cut > start && !isComp(entries[cut - 1]) && !msgs(entries[cut - 1]).length) cut--;
	if (!entries[cut]?.sourceEntry?.id) return false;
	const startsTurn = (e: Any) => !isComp(e) && msgs(e).some((m) => TURN_START_ROLES.has(m?.role));
	let turn = -1;
	if (!startsTurn(entries[cut])) for (let i = cut; i >= start; i--) if (startsTurn(entries[i])) { turn = i; break; }
	const conversation = (from: number, to: number) => entries.slice(from, to).some((e) => !isComp(e) && msgs(e).some((m) => m?.role !== "system"));
	return turn >= 0 ? conversation(start, turn) || conversation(turn, cut) : conversation(start, cut);
}

export const G0 = 2_500; // growth per request before the session's own EWMA has data

/** What the law knows at a decision: prices (the class ratios; the explicit ones while the class is not learned yet), growth per
 *  request g (real tokens), P(the cache is warm). P enters the planner here and nowhere else. */
export interface Law { pr: Prices; g: number; pWarm: number }
export interface LawTerms { ok: boolean; B: number; A: number; T: number; P: number; K: number; eta: number; phi: number; Tsuf?: number; rent?: number; keep?: number }

/**
 * The round-5 law (verdict section 8): rewrite the cache only when what the edit saves pays for the rewrite it causes.
 *   Phi = [ r D^2/(2g) + eta D ] / K >= 1,   D = B - A,   K = (w - r) (P T - (1 - P) D) + call
 * B, A = real context before / after the edit. T = the rewrite base; the planner passes T = A (final model: pricing only the suffix after
 * the earliest edit, ~0.42 A, fires warm edits earlier and costs +0.9 / +4.6 lost items for -0.6 / -0.3% $; the suffix is logged as Tsuf,
 * a measurement only). T is clamped to A. P = P(warm) at this gap: 1 = the verdict's warm valve, 0 = known dead (K < 0: always fire). The expected form is
 * linear in P because a warm next request costs (w - r) T - r D more with the edit and a cold one w D less, plus the r D read credit.
 * eta = 0 below Pi's compaction room, else Pi's own price per token of room (window term). Prices per token; without prices nothing
 * is allowed (the planner always has the class ratios).
 */
export function lawTerms(B: number, A: number, P: number, room: number | null, pr: Prices | null, g: number, call = 0, T = A, keep = PI_KEEP_RECENT): LawTerms {
	const t: LawTerms = { ok: false, B, A, T, P, K: NaN, eta: 0, phi: NaN };
	if (!(A < B) || !pr || !(pr.r > 0)) return t;
	const { r, w, out } = pr;
	const D = B - A, K = (w - r) * (P * Math.min(T, A) - (1 - P) * D) + call;
	let eta = 0;
	if (room !== null && B >= room) {
		const X = Math.max(0, B - keep), S = clamp(0.1 * X, 1_000, 8_000);
		eta = X > S ? (w * X + out * S + (w - r) * (B - X + S)) / (X - S) : 0;
	}
	const gain = (r * D * D) / (2 * Math.max(g, 1)) + eta * D;
	return { ...t, ok: K <= 0 || gain >= K, K, eta, phi: K > 0 ? gain / K : Infinity };
}

/** G_{1/10}: accumulated rent buys the rewrite, or the plain law buys it once a tenth is paid.
 * Prices are input units here; rent and D are tokens, so multiplying by r converts their rent to the same units. */
export function guardTerms(B: number, A: number, P: number, room: number | null, pr: Prices, g: number, rent: number, keep = PI_KEEP_RECENT): LawTerms {
	const t = lawTerms(B, A, P, room, pr, g, 0, A, keep), D = B - A;
	const effective = t.K - t.eta * D, paid = pr.r * (rent + D);
	return { ...t, ok: D > 0 && (effective <= 0 || paid >= effective || (t.ok && paid >= effective / 10)) };
}

export const editAllowed = (B: number, A: number, P: number, room: number | null, pr: Prices | null, g: number, call = 0, T = A): boolean =>
	lawTerms(B, A, P, room, pr, g, call, T).ok;

// Token scale. Every size in this file is a chars/4 estimate of the CONTENT (Pi's own rule); the provider counts real tokens, and the
// two are not proportional:   real = O + c x content.
//   O  what every request carries and no edit can shrink: system prompt, tool schemas, the provider's own framing (2-4K on a bare Pi,
//      29-55K with a large tool set);
//   c  real tokens per estimated content token (0.7-1.1 GLM / GPT, 1.5-2.2 Claude; more on CJK-heavy content).
// pi-zip <= 0.2.9 used ONE ratio, k = real / (system prompt + content) clamped to [1, 2.5]: with O a third of the context k sat on its
// clamp, and every size after an edit came out 10-15K too small (research round5/affine.md). Both are read from the branch on every
// decision, so a restart or `pi -p` calibrates exactly like a long-lived process, and nothing is stored:
//   O  1. the cacheRead of the request that first carried the newest summary: everything after the system prompt and tools changed
//         there, so what the provider still read from its cache is exactly O (when the cache was warm at all);
//      2. else the session's first request minus C0 x its content (an opening prompt is small next to O);
//      3. else R0 x the chars/4 of the system prompt and the JSON of the declared tools.
//      An O measured under another system prompt or tool set moves by R0 x the change of that chars/4 size (MCP tools come and go).
//   c  (real - O) / content of the newest response, clamped to [C_MIN, C_MAX] (a guard for a tiny content estimate; recorded sessions
//      span 0.7-3.9); C0 before the first response. A response followed by edits it did not carry (a warm-valve edit is persisted at
//      turn_end and first sent with the next request: that response's prompt did not shrink) is counted with the originals.
//   Both are per model: only responses of the model the next request goes to count. After a switch, before its first response,
//   O = R0 x the system state and c = C0; after it, with no O evidence of its own, O = c x X, X = O / c of the previous model.
export const C0 = 1.5;
export const C_MIN = 0.5;
export const C_MAX = 4;
export const R0 = 2;

/** The system prompt and the declared tools (Pi API fallback for a transcript that records no system message). */
export interface SysInfo { text: string; tools: Any[] }
/** chars/4 of the system prompt plus the JSON of the declared tool definitions (name, description, parameters). */
export const sysEst = (s: SysInfo): number =>
	tok4(s.text) + (s.tools.length ? tok4(JSON.stringify(s.tools.map((t: Any) => ({ name: t?.name, description: t?.description, parameters: t?.parameters })))) : 0);

export interface Scale {
	O: number; // real tokens every request carries before the content (system prompt, tools, framing)
	c: number; // real tokens per estimated (chars/4) content token
	real: number; // input + cacheRead + cacheWrite of the newest usable response (0 = none)
	est: number; // estimated content that request carried
	source: "usage" | "default"; // where c comes from
	oSource: "summary" | "first" | "model" | "default"; // where O comes from ("model": another model's O in content units, X = O' / c')
}
/** Sizes taken as real (tests, and the ledger of a plan made without calibration). */
export const UNIT: Scale = { O: 0, c: 1, real: 0, est: 0, source: "default", oSource: "default" };
/** Real tokens of a context whose content is estimated at `content`. */
export const sizeOf = (s: Pick<Scale, "O" | "c">, content: number): number => s.O + s.c * content;

/** A response pi-ai drops before sending (an error or an abort): it carries no usable usage and adds nothing to later requests. */
const dropped = (m: Any): boolean => m?.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted");
/** chars/4 a message adds to every later request: tokensOf, except 0 for an assistant message pi-ai drops before sending. */
export const wireTokensOf = (m: Any): number => (dropped(m) ? 0 : tokensOf(m));
/** Prompt size the provider reported for a response that really ran (0 = none, an error or an abort). */
const promptOf = (m: Any): number => {
	const u = m?.role === "assistant" && !dropped(m) ? m.usage : null;
	return u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
};
/** "provider/model" of a response ("" = not recorded: such a response counts for any model). */
const respKey = (m: Any): string => (m?.provider || m?.model ? `${m.provider ?? ""}/${m.model ?? ""}` : "");
/** chars/4 of the system state the transcript records in `msgs` (-1: none recorded). */
function sysOf(msgs: Any[]): number {
	const s = collapseSystem(msgs);
	return s ? sysEst({ text: [textOf(s.content), ...Object.values<string>(s.sections ?? {})].filter((x) => x).join("\n\n"), tools: s.toolsAdded ?? [] }) : -1;
}
/** The session's first response from model `key` on the branch: its prompt, the content before it and the system state it was sent with. */
function firstRequest(branch: Any[], key: string): { real: number; est: number; S: number } | null {
	const sys: Any[] = [];
	let est = 0;
	for (const e of branch) {
		const m = e?.type === "message" ? e.message : e?.type === "custom_message" ? { role: "custom", content: e.content } : null;
		if (!m) continue;
		if (m.role === "system") { sys.push(m); continue; }
		const real = promptOf(m), k = respKey(m);
		if (real > 0 && (!key || !k || k === key)) return { real, est, S: sysOf(sys) };
		est += wireTokensOf(m);
	}
	return null;
}

/** chars/4 of the context the request behind the response `id` carried, rebuilt from the branch the way Pi projects it: the newest
 *  compaction before the response, the entries it keeps, everything after it, and the edits persisted before the response, plus the
 *  edits of a run plan persisted right after it (their commit entry says the response itself carried them). null: `id` is not on the
 *  branch. Used when a compaction written after the response (Pi's own, another extension's) removed that request's content from the
 *  projection, so the projection cannot say what the response measured. */
function requestEst(branch: Any[], id: string): number | null {
	const at = branch.findIndex((e) => e?.id === id);
	if (at < 0) return null;
	const pre = branch.slice(0, at);
	const edit = new Map<string, Any>();
	for (const e of pre) if (e?.type === "context_edit") edit.set(e.targetId, e.replacement);
	for (let i = at + 1; i < branch.length; i++) {
		const e = branch[i];
		if ((e?.type === "message" && e.message?.role !== "toolResult")) break;
		if (e?.type === "custom" && e.customType === COMMIT_CUSTOM) {
			if (e.data?.carried) for (let j = at + 1; j < i; j++) if (branch[j]?.type === "context_edit" && (!e.data.carriedIds || e.data.carriedIds.includes(branch[j].targetId))) edit.set(branch[j].targetId, branch[j].replacement);
			break;
		}
	}
	let ci = -1;
	pre.forEach((e, i) => { if (e?.type === "compaction") ci = i; });
	const kept = ci < 0 ? pre : [pre[ci], ...pre.slice(0, ci).slice(Math.max(0, pre.findIndex((e) => e?.id === pre[ci].firstKeptEntryId))).filter((e) => !(e?.type === "message" && e.message?.role === "system")), ...pre.slice(ci + 1)];
	let est = 0;
	for (const e of kept) {
		if (e?.type === "compaction" || e?.type === "branch_summary") est += tokensOf({ role: "compactionSummary", summary: e.summary });
		else if (e?.type === "custom_message") est += tokensOf({ role: "custom", content: edit.has(e.id) ? edit.get(e.id)?.content : e.content });
		else if (e?.type === "message" && e.message) {
			const rep = edit.get(e.id);
			if (rep === null) continue;
			const m = rep && e.message.role !== "system" ? { ...e.message, content: typeof rep.content === "string" && e.message.role !== "user" ? [{ type: "text", text: rep.content }] : rep.content } : e.message;
			est += wireTokensOf(m);
		}
	}
	return est;
}

/** O and c from the projection (`entries`) and, for the session's first request, the branch; `sys` stands in for a transcript without
 *  system messages. `model` = "provider/id" of the model the next request goes to (default: the newest response's): O and c are
 *  properties of the provider's tokenizer, so only that model's responses are evidence. With none, O = R0 x the system state and
 *  c = C0; with responses but no O evidence of its own (a model switch mid-session), O keeps the size another model measured in
 *  content units, X = O' / c' (the system prompt and tools tokenize like the content around them): real = c (X + E). */
export function calibrate(entries: Any[], sys?: SysInfo, branch: Any[] = [], model?: string): Scale {
	type Resp = { at: number; est: number; real: number; read: number; nSys: number; ts: number; key: string; id: string };
	const resp: Resp[] = [];
	const sysMsgs: Any[] = [];
	const edits: { at: number; target: string; foreign: boolean }[] = [];
	const marks: { at: number; carried: boolean; carriedIds?: string[] }[] = []; // pi-zip's commit entries: who first carried the edits right before them (run.ts commit)
	const orig = new Map<string, { at: number; d: number }>(); // edited entries: tokens their originals add back
	const withMsgs: number[] = [0]; // withMsgs[k]: entries before k that carry messages (a commit group has none inside it)
	let est = 0, sysAt = 0; // sysAt: responses before the newest system message
	entries.forEach((pe, at) => {
		const src = pe.sourceEntry, msgs: Any[] = pe.messages ?? [];
		withMsgs.push(withMsgs[at] + (msgs.length ? 1 : 0));
		// an edit with a replacement that is not our placeholder is another extension's (never carried by a request of ours); one without
		// (a bare entry) is judged by the size heuristics below
		if (src?.type === "context_edit") edits.push({ at, target: src.targetId, foreign: "replacement" in src && !textOf(src.replacement?.content).startsWith(PH_MARK) });
		if (src?.type === "custom" && src.customType === COMMIT_CUSTOM) marks.push({ at, carried: !!src.data?.carried, carriedIds: src.data?.carriedIds });
		if (src?.type === "message" && msgs.length === 1 && msgs[0] !== src.message) orig.set(src.id, { at, d: wireTokensOf(src.message) - wireTokensOf(msgs[0]) });
		for (const m of msgs) {
			if (m?.role === "system") { sysMsgs.push(m); sysAt = resp.length; continue; }
			const real = promptOf(m);
			if (real > 0) resp.push({ at, est, real, read: Number(m.usage.cacheRead) || 0, nSys: sysMsgs.length, ts: Number(m.timestamp) || 0, key: respKey(m), id: src?.id ?? "" });
			est += wireTokensOf(m);
		}
	});
	const sAt = (n: number) => sysOf(sysMsgs.slice(0, n)); // the system state after the first n system messages (computed only where needed)
	const S = sAt(sysMsgs.length);
	const Snow = S >= 0 ? S : sys ? sysEst(sys) : 0;
	const head = entries[0]?.sourceEntry?.type === "compaction" ? entries[0].sourceEntry : null;
	const headMs = head ? Date.parse(head.timestamp) || 0 : 0;
	// Was the request behind this response sent after the head compaction entry was written? The branch's order says (timestamps tie when
	// a compaction follows a response in the same millisecond); without the branch the timestamps do.
	const pos = new Map<string, number>();
	if (head) branch.forEach((e, i) => { if (typeof e?.id === "string") pos.set(e.id, i); });
	const afterHead = (r: Resp): boolean => {
		const h = pos.get(head?.id), i = pos.get(r.id);
		return h !== undefined && i !== undefined ? i > h : r.ts > headMs;
	};
	const opening = (r: { real: number; est: number } | null | undefined) => !!r && C0 * r.est <= 0.1 * r.real; // content small next to O

	/** The first commit entry of the group of pi-zip edits that starts at entry `at` (none when a message comes first). */
	const markOf = (at: number) => marks.find((m) => m.at > at && withMsgs[m.at] - withMsgs[at + 1] === 0);
	/** Index of the newest response in `resp` before entry `at`. */
	const respBefore = (at: number) => resp.reduce((k, r, i) => (r.at < at ? i : k), -1);
	/** Tokens the originals add back for response i: edits persisted after it that its own request did not carry (the projection counts
	 *  their placeholders). A commit entry says who carried them (a run plan: the response before the entry; a valve plan: the next one);
	 *  with none (a session of an older version) the sizes decide, for the newest response only (`legacy`). */
	const addBack = (i: number, legacy: boolean): number => {
		let d = 0;
		for (const x of edits) {
			const t = orig.get(x.target);
			if (x.at <= resp[i].at || !t || t.at >= resp[i].at) continue;
			const m = x.foreign ? undefined : markOf(x.at);
			if (m ? m.carried && (!m.carriedIds || m.carriedIds.includes(x.target)) && respBefore(m.at) === i : !x.foreign && legacy) continue;
			d += t.d;
		}
		return d;
	};

	const fit = (want: string, transfer: boolean): Scale => {
		const mine = (r: Resp | undefined): r is Resp => !!r && (!want || !r.key || r.key === want);
		// evidence for O, the newest wins (it needs the smallest correction for system changes since)
		const ev: { at: number; O: number; S: number; src: Scale["oSource"] }[] = [];
		const f = branch.length ? firstRequest(branch, want) : head ? null : resp.find(mine); // the session's first request
		if (f && opening(f)) ev.push({ at: -1, O: f.real - C0 * f.est, S: "S" in f ? f.S : sAt(f.nSys), src: "first" });
		const ci = resp.findIndex((r, i) => i >= sysAt && mine(r)), cur = resp[ci]; // the first response sent with the current system prompt and tools
		// its content as its request carried it: edits persisted after it (a model switch, say, then a run plan's folds) are in `est`
		const curEst = cur ? cur.est + addBack(ci, false) : 0;
		if (cur && (!head || afterHead(cur)) && opening({ real: cur.real, est: curEst })) ev.push({ at: ci, O: cur.real - C0 * curEst, S, src: "first" });
		if (head) {
			// Only the first response after a compaction can measure its rewritten prefix.
			const i = resp.findIndex((r) => afterHead(r)), r = resp[i], prev = resp[i - 1];
			if (mine(r) && r.read > 0 && r.read < 0.8 * r.real && (!prev || r.read < 0.8 * prev.real)) ev.push({ at: i, O: r.read, S: sAt(r.nSys), src: "summary" });
		}
		const best = ev.sort((a, b) => b.at - a.at)[0];
		let O = best ? Math.max(0, best.O + (best.S >= 0 && S >= 0 ? R0 * (Snow - best.S) : 0)) : R0 * Snow, oSource: Scale["oSource"] = best?.src ?? "default";
		// the scale of the newest other model of the same provider AND the same model family (a model switch before the new model's first
		// response): a multi-vendor provider (github-copilot, openrouter, opencode, bedrock, ...) serves several tokenizers
		const sameProviderScale = (key: string): Scale | null => {
			const prov = key.split("/")[0];
			if (!key || !prov) return null;
			const kin = (k: string) => !!k && k !== key && sameTokenizer(k, key);
			const other = [...resp].reverse().find((r) => kin(r.key))?.key
				?? [...branch].reverse().map((e) => (e?.type === "message" && promptOf(e.message) > 0 ? respKey(e.message) : "")).find(kin);
			const o = other ? fit(other, false) : null;
			return o && o.source === "usage" && o.oSource !== "default" ? o : null;
		};
		// c from the newest response of this model
		let n = resp.length - 1;
		while (n >= 0 && !mine(resp[n])) n--;
		if (n < 0) {
			// no response of this model yet (a model switch): its tokenizer is unknown, but a model of the same provider counts like the one
			// the session ran on; carrying that model's O and c over keeps the sizes of the first cold return near the real ones. Another
			// provider keeps the defaults (R0 x the system state, C0).
			const o = transfer && !best ? sameProviderScale(want) : null;
			if (o) return { O: o.O, c: o.c, real: 0, est: 0, source: "default", oSource: "model" };
			return { O, c: C0, real: 0, est: 0, source: "default", oSource };
		}
		const N = resp[n];
		let estN = N.est;
		const cutLater = !!head && !afterHead(N);
		const later = edits.filter((x) => x.at > N.at);
		const rebuilt = cutLater && !!N.id ? requestEst(branch, N.id) : null; // what its request carried: the compaction after it removed that from the projection
		if (rebuilt !== null && rebuilt > 0) estN = rebuilt;
		else if (later.length || cutLater) {
			// carried (a run plan): the prompt shrank, or a read stopped early; a cache miss alone (no read at all) proves nothing. The
			// commit entries of pi-zip's edits say it outright; the sizes decide only for edits without one (older sessions).
			// Pi's own compaction is never request-local.
			let p = n - 1;
			while (p >= 0 && !mine(resp[p])) p--;
			const P = resp[p];
			const heur = !P || N.real < P.real || (N.read > 0 && N.read < 0.8 * P.real);
			const carried = !cutLater && heur;
			if (!carried && cutLater) return { O, c: C0, real: N.real, est: 0, source: "default", oSource }; // what it carried is summarised away
			estN += addBack(n, heur && carried);
		}
		if (!best && transfer && estN > 0) {
			// no O of its own: the newest other model's O in content units
			// (a compaction may have taken the other model's responses out of the projection: the branch still has them)
			const other = [...resp].reverse().find((r) => r.key && r.key !== want)?.key
				?? [...branch].reverse().map((e) => (e?.type === "message" && promptOf(e.message) > 0 ? respKey(e.message) : "")).find((k) => k && k !== want);
			const o = other ? fit(other, false) : null;
			if (o && o.oSource !== "default" && o.c > 0) {
				const X = o.O / o.c, c = clamp(N.real / (X + estN), C_MIN, C_MAX);
				return { O: c * X, c, real: N.real, est: estN, source: "usage", oSource: "model" };
			}
		}
		return { O, c: estN > 0 ? clamp((N.real - O) / estN, C_MIN, C_MAX) : C0, real: N.real, est: estN, source: estN > 0 ? "usage" : "default", oSource };
	};
	return fit(model || [...resp].reverse().find((r) => r.key)?.key || "", true);
}

/** The model family a model id belongs to, by the vendor names model ids carry (null: not recognised). */
const FAMILIES: [RegExp, string][] = [
	[/claude|anthropic|opus|sonnet|haiku/, "anthropic"], [/gpt|codex|openai|(^|[/.~])o[1-9]([-.]|$)/, "openai"], [/gemini|gemma|google/, "google"], [/grok|x-ai|xai/, "xai"],
	[/glm|z-ai|zai/, "zai"], [/kimi|moonshot/, "moonshot"], [/deepseek/, "deepseek"], [/qwen|alibaba/, "qwen"], [/minimax/, "minimax"],
	[/mistral|codestral|devstral|magistral|ministral|pixtral/, "mistral"], [/llama|meta/, "meta"], [/mimo|xiaomi/, "xiaomi"],
];
export function modelFamily(id: string): string | null {
	const s = id.toLowerCase();
	const hits = new Set(FAMILIES.filter(([re]) => re.test(s)).map(([, f]) => f));
	return hits.size === 1 ? [...hits][0] : null; // none, or ambiguous ("anthropic/claude" is one; "glm-on-mistral" style ids are not guessed)
}
/** Providers that serve only their vendor's models (Pi's catalog; mistral is not one: it lists GLM models too). */
const FIRST_PARTY = new Set(["anthropic", "openai", "openai-codex", "google", "google-vertex", "xai", "zai", "zai-coding-cn", "deepseek", "moonshotai", "moonshotai-cn", "kimi-coding", "minimax", "minimax-cn", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"]);
/** Do two models ("provider/id") count tokens alike? The same provider, and either a vendor's own API or the same recognised model
 *  family: a multi-vendor provider (github-copilot: GPT, Claude, Gemini, Grok; openrouter) is not one tokenizer. Unrecognised ids of a
 *  multi-vendor provider never match (the defaults stand). */
export function sameTokenizer(a: string, b: string): boolean {
	const ia = a.indexOf("/"), ib = b.indexOf("/");
	if (ia <= 0 || ib <= 0 || a.slice(0, ia) !== b.slice(0, ib)) return false;
	if (FIRST_PARTY.has(a.slice(0, ia))) return true; // a vendor's own API serves its own models
	const fa = modelFamily(a.slice(ia + 1)), fb = modelFamily(b.slice(ib + 1));
	return fa !== null && fa === fb;
}

/** The cold cap's target in real tokens of the WHOLE context (system prompt and tools included, as the cap was tuned): max(cap, O + cap/2),
 *  never above Pi's compaction room. While O is under half the cap this is the plain whole-context cap. Above that the target is O plus
 *  half the cap of conversation: never at or below O, where no edit reaches it (0.2.9's 40K with O = 29-55K summarised at every cold
 *  return), and not 40K of conversation on top of O either (the cap on content alone cost +13% live on a 36K prefix, with no quality
 *  difference measured). Offline it never loses more items than the whole-context cap (research round5/affine.md section 11). */
export const CAP_CONTENT_MIN = 0.5;
export const coldTarget = (cap: number, O: number, room: number | null): number => Math.min(Math.max(cap, O + CAP_CONTENT_MIN * cap), room ?? Infinity);

export const settings = () => ({
	coldCap: envInt("COLD_CAP", 40_000), // cold: fold, then summarise, down to this many real tokens of the whole context, but never below O + half of it (coldTarget)
	foldMin: envInt("FOLD_MIN", 500), // outputs below this many tokens are never folded
	keepLines: envInt("KEEP_LINES", 8),
	inturnAge: envInt("INTURN_AGE", INTURN_AGE), // outputs (any class) of the protected turns at least this many assistant requests old may fold; 0 = never
});

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

/** The newest turn was opened by an extension's custom message that nothing has answered or joined yet (no user, assistant or tool
 *  result since): a prompt typed now joins that turn (buildBlocks: a prompt right after its starter is the same turn), so a plan made
 *  before that prompt (promptPending) must not count it as one more. A display-only note posted at session start (durable-subagents'
 *  "1 workflow was paused") opens such a turn; a message that does start a run is answered before any prompt is planned for. */
export const openStarter = (blocks: Block[]): boolean => {
	const n = countUserTurns(blocks);
	if (n === 0) return false;
	const turn = blocks.filter((b) => b.userTurn === n);
	return turn[0]?.kind === "other" && turn[0].msg?.role === "custom" && !turn.some((b) => b.kind === "user" || b.kind === "assistant" || b.kind === "toolResult");
};

export function buildBlocks(contextEntries: Any[], steerIds?: Set<string>): Block[] {
	const blocks: Block[] = [];
	let userTurn = 0;
	let afterAnswer = false; // the newest block is an assistant message that ended a run (a final answer, a failed or aborted request)
	let starter = false; // a custom message started the turn that is open (no assistant message since)
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
		// A turn starts at a real user prompt, or at a custom message that starts a run (an extension's `sendMessage(..., { triggerTurn })`:
		// pi-runway's owed-drive, durable-subagents' attention; Pi starts a run from it with no user prompt, before_agent_start only on Pi
		// 1.2.0, and nothing else in the session says "the user is here"). Such a message follows the previous run's final answer; one that
		// arrives mid-run follows a tool result and belongs to that run. A prompt that directly follows its own starter (a nextTurn message is
		// stored before the prompt it rides with) is the same turn: one start, however many entries it took. Pi 1.1.0 stores a prompt FIRST and
		// then the nextTurn and before_agent_start messages that ride with it (agent-session.js prompt): those follow a user message, not an
		// answer, so they never start a turn of their own (every start clears afterAnswer).
		if (kind === "user") {
			if (!(src.id && steerIds?.has(src.id)) && !starter) userTurn++;
			starter = false;
			afterAnswer = false;
		} else if (msgs.some((m) => m?.role === "custom")) {
			if (afterAnswer) { userTurn++; starter = true; afterAnswer = false; }
		} else if (kind === "assistant" || kind === "toolResult") starter = false;
		// a run ends at its final answer, and also at a request that failed or was aborted (Esc): a custom message after either starts
		// the next run (formal TR, round 4: a driven run after a refused request was counted into the failed run's turn)
		if (kind === "assistant") afterAnswer = msg.stopReason !== "toolUse";
		else if (kind === "toolResult") afterAnswer = false;
		const ours = edited && kind === "toolResult" && textOf(msg.content).startsWith(PH_MARK);
		if (kind === "assistant") {
			// aborted / final-error messages stay in the projection but pi-ai drops them before sending: they add no age (their calls still count as issued)
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") asst++;
			for (const c of msg.content ?? []) if (c?.type === "toolCall") issued.set(c.id, asst);
		}
		asstOf[blocks.length] = kind === "toolResult" ? (issued.get(msg.toolCallId) ?? asst) : asst;
		blocks.push({ idx: blocks.length, entryId: src.id ?? null, kind, msg, raw, tokens: msgs.reduce((a, m) => a + wireTokensOf(m), 0), userTurn, edited, ours, age: 0 });
	}
	for (const b of blocks) if (b.kind === "toolResult") b.age = asst - asstOf[b.idx];
	return blocks;
}

/** Where a summary may cut (the first kept block): a user or assistant message, or an extension's custom message (Pi's own cut points
 *  include it: compaction.js isCutPointMessage). Without the custom message, the turn a run an extension started could only be kept
 *  from the previous turn's final answer on (formal TR, round 4: 50K of answer kept in front of a driven run). */
export const isCutBlock = (b: Block): boolean => !!b.entryId && (b.kind === "user" || b.kind === "assistant" || (b.kind === "other" && b.msg?.role === "custom"));

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
	prepared?: boolean; // written in the background (a pi-zip/summary entry): its cost was counted when it was produced
}

/** What a run sends from its first request on and persists verbatim at turn_end (F8). */
export interface RunPlan {
	source: "settle" | "runstart" | "valve";
	folds: FoldTarget[];
	cut: Cut | null;
	ctxBefore: number;
	ctxAfter: number;
	ms: number;
	scale: Scale; // the token scale the plan was made with (stats and notices of this run use the same one)
	persisted: boolean;
	carriedIds?: Set<string>; // a mixed boundary plan: folds already carried by the request
	sent?: boolean; // a request view carrying this plan's folds has gone out
	noticeTs?: number; // the first request carrying the folds (their notice may wait for the boundary)
	applied?: Set<string>; // entry ids whose fold the latest request view actually carried (what turn_end must persist, no more)
	untouched?: number; // real tokens before the earliest edited block: what the first request carrying the plan can still read from the cache
	waitMs?: number; // how long the turn waited for this plan's summary (only at Pi's compaction room; 0: it was ready)
	noticed?: boolean; // its notice is already in the transcript (shown when the first request carrying it went out)
	native?: Cut; // this run's summary went in through Pi's own compaction before the run: no request-local cut, no compaction draft
	ready?: "away" | "background"; // its summary was written in the background: before this warm return ("away"), or while the run went on
}

export interface PlanOpts {
	keep?: number; // real tokens in Pi's kept tail, measured on the unedited view
	rent?: number; // removable tokens rented since the last applied edit or cold decision
	justEdited?: boolean; // the immediately preceding request carried a rewrite
	application?: boolean; // application uses the guard; production keeps the plain law
	deferSummary?: boolean; // first requests of driven runs take folds only
	carriedFolds?: readonly FoldTarget[]; // reconciled sent folds: retain their exact placeholders when pricing the boundary edit
	law?: Law; // prices, g and P(warm): the only input that depends on P; default: the explicit class ratios at P = 0
	pause?: boolean; // a return after a pause (the absence outlived the requested cache lifetime) or a model switch: the previous user turn's re-readable outputs may fold
	trace?: (LawTerms & { where: "summary" | "plan" | "guard"; cut?: boolean; ready?: boolean; key?: string })[]; // every law evaluation is pushed here (ledger)
	reserve?: number; // Pi's compaction reserveTokens (default 16384)
	steerIds?: Set<string>; // user entries that are mid-run steering or follow-up messages, not new user turns
	scale?: Scale; // real = O + c x content estimate (calibrate); default UNIT = the estimates are taken as real
	cwd: string;
	coldCap?: number;
	foldMin?: number;
	keepLines?: number;
	recalled?: Set<string>;
	model?: Any;
	promptPending?: boolean; // true at settle: the upcoming prompt is NOT in `entries` yet but counts as a new user turn
	inturnAge?: number; // default settings().inturnAge (PI_ZIP_INTURN_AGE, 60); 0 = outputs of the protected turns never fold on age
	rereadOnly?: boolean; // zip_recall is not available to the model: fold only outputs that can be re-read (classify "rereadable")
	fileRecall?: FileRecall; // zip_recall is hidden but read, grep or bash is active: fold as in full mode, placeholders name the recall file
	branch?: Any[];
	cutAt?: string; // cut at this entry or not at all (a summary for that cut is produced or being produced: core.ts adopt)
	foldsOnly?: boolean; // no cut: the plan of the folds alone (its summary is not ready: core.ts unready)
	ready?: readonly string[];
	readySizes?: Readonly<Record<string, number>>; // cuts whose summary is produced and ready: its call is spent, so the law prices it at 0 (theory 1.4)
}

export interface PlanResult {
	blocks: Block[];
	calls: Calls;
	folds: FoldTarget[];
	cutIdx: number | null;
	firstKeptEntryId: string | null;
	prefixTokens: number; // content estimate units (x c = real), like summaryTokensPlanned
	summaryTokensPlanned: number;
	sumTrigger: "cold" | "valve" | null;
	scale: Scale;
	ctxTokens: number; // real: O + c x content
	ctxAfterFolds: number; // real
	userTurns: number;
	fileRecall?: FileRecall; // the summary of this plan names recall files instead of zip_recall (PlanOpts.fileRecall)
	atRoom?: boolean; // the context after the plan's folds is at Pi's compaction room: Pi would compact (lossy) if nothing is done now
	atRoomUnedited?: boolean; // the context as it is (no fold, no cut applied) is at Pi's compaction room: a request sent unchanged would trigger it
}

/** Estimated content before the earliest edited block: what stays cached through the edit with O (real: O + c x it). A cut edits from the start. */
export function untouchedEst(blocks: Block[], folds: FoldTarget[], cut: boolean): number {
	const ids = new Set(folds.map((t) => t.entryId));
	let est = 0;
	if (!cut) for (const b of blocks) { if (b.entryId && ids.has(b.entryId)) break; est += b.tokens; }
	return est;
}

/** Identity of a tool result's text, independent of its tool call id. */
export const contentKeyOf = (content: Any): string => {
	const t = textOf(content);
	return `${createHash("sha1").update(t).digest("hex")}:${t.length}`;
};

/** The planner: one plan, whatever the cache is believed to be. Below the working view W (the cold target) it plans nothing. Above
 *  it, eligible outputs fold biggest first, class by class, until the view is at W: those of user turns older than the previous one;
 *  after a pause (PlanOpts.pause), the previous turn's re-readable outputs; those of the protected turns at least INTURN_AGE requests
 *  old. If the folds cannot reach W, one summary: the first cut from the one reaching W whose summary pays with its call, and with
 *  which the whole plan pays (folds inside the prefix are void). Then the whole plan must pay. P(warm) enters only the law (o.law), so
 *  a lower P never plans less. The target never exceeds Pi's compaction room. null: nothing to plan, or the law refuses. */
export function plan(entries: Any[], o: PlanOpts): { f: PlanResult; c: PlanResult | null; a: PlanResult | null } | null {
	const s = settings();
	// limits are in real tokens; the plan works in content estimate units (real = O + c x estimate), so they are converted once, here.
	// The cold cap is on the whole context, but leaves at least half of itself for the conversation above O (coldTarget): a cap the
	// fixed prefix alone fills is out of reach, and every return then folds all it may and summarises. The compaction room is Pi's
	// trigger on the whole context.
	const { O, c } = o.scale ?? UNIT;
	const real = (est: number) => O + c * est;
	const room = compactionRoom(o.model, o.reserve);
	const coldCap = (coldTarget(o.coldCap ?? s.coldCap, O, room) - O) / c;
	const law: Law = o.law ?? { pr: lawPrices(undefined, false), g: G0, pWarm: 0 };
	// `cut`: a whole-plan step records whether the plan it judges has a cut (and so carries its summary call); the formal checker pins the
	// call to 0 for a folds-only plan and to the summary step's call for a cut; `ready`: the cut's summary is ready (its call is 0);
	// `key`: a summary step's cut (its first kept entry)
	const gate = (where: "summary" | "plan" | "guard", B: number, A: number, r: number | null, call: number, T: number, Tsuf?: number, cut?: boolean, isReady?: boolean, key?: string): boolean => {
		const t = lawTerms(B, A, law.pWarm, r, law.pr, law.g, call, T, o.keep);
		o.trace?.push({ where, ...t, ...(r !== null ? { keep: o.keep } : {}), ...(Tsuf !== undefined ? { Tsuf } : {}), ...(cut !== undefined ? { cut } : {}), ...(isReady ? { ready: true } : {}), ...(key !== undefined ? { key } : {}) });
		return t.ok;
	};
	const foldMin = o.foldMin ?? s.foldMin;
	const keepLines = o.keepLines ?? s.keepLines;
	const inturnAge = o.inturnAge ?? s.inturnAge;
	const blocks = buildBlocks(entries, o.steerIds);
	if (!blocks.length) return null;
	const userTurns = countUserTurns(blocks) + (o.promptPending && !openStarter(blocks) ? 1 : 0); // the upcoming prompt is a new user turn (unless it joins an open starter)
	const calls = toolCallIndex(blocks);
	const recalled = o.recalled ?? new Set<string>();
	const ctxEst = blocks.reduce((a, b) => a + b.tokens, 0); // content
	let tail = 0;
	for (let i = blocks.length - 1; i >= 0 && tail < PI_KEEP_RECENT; i--) tail += c * blocks[i].tokens;
	o.keep = tail;
	if (!(ctxEst > coldCap)) return null; // below the working view nothing is planned (I6)
	const trig = law.pWarm < 0.5 ? "cold" : "valve"; // a label for the ledger and the summary's trigger only
	const tokOverride = new Map<number, number>();
	const folds: FoldTarget[] = [...(o.carriedFolds ?? [])];
	for (const t of folds) tokOverride.set(blocks.findIndex((b) => b.entryId === t.entryId), t.phTokens);
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
		return classifyRecoverability(call?.name ?? b.msg.toolName ?? "", call?.args, textOf((b.raw ?? b.msg).content), o.cwd, { exactRecall: !o.rereadOnly || !!o.fileRecall });
	};
	const addFold = (b: Block, trig: string): boolean => {
		if (tokOverride.has(b.idx) || recalled.has(handleFor(b.entryId!))) return false; // F4: never refold what the model recalled
		const ph = makePlaceholderFor(b, calls, keepLines, !!o.rereadOnly, o.fileRecall);
		if (ph === null) return false;
		const phTok = tokensOf({ ...b.msg, content: [{ type: "text", text: ph }] }); // the folded message: its id and framing stay
		if (!(phTok < 0.9 * b.tokens)) return false;
		tokOverride.set(b.idx, phTok);
		const call = calls.get(b.msg.toolCallId);
		folds.push({ entryId: b.entryId!, toolCallId: b.msg.toolCallId, visIdx: visOfBlock[b.idx] ?? -1, contentKey: contentKeyOf(b.msg.content), tool: call?.name ?? b.msg.toolName ?? "tool", args: call ? shortArgs(call.args) : "", entryTokens: b.tokens, phTokens: phTok, ph, trig, recover: classify(b) });
		return true;
	};
	// a zip_recall result IS content the model just asked for: folding it would undo the recall (and loop); never
	// ... and so is a built-in read, grep, find, ls or bash call on a recall file (file recall, when an allowlist hides zip_recall)
	const isRecall = (b: Block) => {
		const call = calls.get(b.msg.toolCallId), name = call?.name ?? b.msg.toolName;
		if (name === RECALL_TOOL) return true;
		if (name === "bash") return commandNamesRecall(call?.args?.command);
		return (name === "read" || name === "grep" || name === "find" || name === "ls") && !!parseRecallPath(call?.args?.path);
	};
	// Observability: on an automatic (prefix) cache no fold starts inside the first MIN_EXPECT real tokens, so the next response's cacheRead
	// is an uncensored survival sample (learn.ts sample). Without it every idle return folded into the first 1-7K tokens and its sample was
	// censored, so the learned curve never saw a return (live GLM bench). Explicit caches are exempt: the provider looks back only ~20
	// blocks from the last breakpoint, a far head is not read either way. A cut replaces the prefix from the first message: exempt too.
	const head = law.pr.cls === "automatic" ? (MIN_EXPECT - O) / c : 0; // MIN_EXPECT counts from the first token, O included
	const start: number[] = [];
	blocks.reduce((acc, b) => ((start[b.idx] = acc), acc + b.tokens), 0);
	const foldable = (b: Block) => b.kind === "toolResult" && !b.edited && !!b.entryId && tok4(textOf((b.raw ?? b.msg).content)) > foldMin && !isRecall(b) && start[b.idx] >= head && (!o.rereadOnly || classify(b) === "rereadable");
	const protectedTurn = (b: Block) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1;
	const savings = () => folds.reduce((a, t) => a + t.entryTokens - t.phTokens, 0);
	// the eligible outputs, class by class, each biggest first, until the view is at the working size: inside one rewrite a fold beyond
	// it would hide work for no saving the law asked for
	let est = ctxEst - savings();
	const take = (list: Block[], tag: string) => {
		for (const b of list.sort((x, y) => y.tokens - x.tokens)) {
			if (est <= coldCap) return;
			if (addFold(b, tag)) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
		}
	};
	// outputs of the user turns before the previous one
	take(blocks.filter((b) => foldable(b) && !protectedTurn(b)), trig);
	// the protected window = the new prompt + the previous user turn; after a pause (or a model switch) the user comes back to a cache
	// that is gone, and that turn's big re-readable reads are what makes the return expensive: they come back exactly
	if (o.pause) take(blocks.filter((b) => foldable(b) && protectedTurn(b) && b.userTurn < userTurns && classify(b) === "rereadable"), `${trig}(relax)`);
	// in-turn: outputs of the protected turns that are many requests old, whatever their recoverability class (every fold stays
	// recallable). Age = assistant requests since the call was issued (the newest outputs, age < inturnAge, always stay).
	if (inturnAge > 0) take(blocks.filter((b) => foldable(b) && protectedTurn(b) && b.age >= inturnAge), `${trig}(inturn)`);
	const ctxAfterFolds = ctxEst - savings();
	// what no summary can remove (besides O): the protected turns (after their folds) and the previous summary, which the next one
	// carries forward; the cap is never chased below it (a context that is mostly this floor would be re-summarised for nothing)
	const prevSum = blocks[0]?.kind === "summary" ? blocks[0].tokens : 0;
	const atRoom = room !== null && real(ctxAfterFolds) >= room;
	const atRoomUnedited = room !== null && real(ctxEst) >= room;
	const sumTrigger: "cold" | "valve" | null = !o.foldsOnly && ctxAfterFolds > coldCap ? trig : null;
	const minCut = blocks[0].kind === "summary" ? 2 : 1; // never re-summarise a prefix that is only the previous summary
	const pre: number[] = [];
	const previousUsers = parseSummary(blocks[0]?.kind === "summary" ? String(blocks[0].msg.summary ?? "") : null).users;
	const previousBoundary = o.branch?.find((e) => e?.id === blocks[0]?.entryId)?.firstKeptEntryId;
	const recoveredUsers = previousBoundary ? userTextBefore(o.branch, previousBoundary, previousUsers) : null;
	const userFloor = (k: number) => mandatoryUserTokens(
		{ items: recoveredUsers ?? previousUsers.items, omitted: recoveredUsers ? 0 : previousUsers.omitted },
		blocks.slice(blocks[0]?.kind === "summary" ? 1 : 0, k).filter((b) => b.kind === "user").map((b) => textOf((b.raw ?? b.msg).content)),
	);
	const S = (k: number) => Math.max(clamp(SUMMARY_RATIO * c * pre[k], SUMMARY_FLOOR, SUMMARY_CAP), c * prevSum, c * (userFloor(k) + 300)) / c; // mandatory user text can exceed the nominal summary cap
	const result = (pick: number | null, summary = pick === null ? 0 : S(pick)): PlanResult => ({
		blocks, calls, folds: pick === null ? [...folds] : folds.filter((t) => blocks.findIndex((b) => b.entryId === t.entryId) >= pick || o.carriedFolds?.some((u) => u.entryId === t.entryId)),
		cutIdx: pick, firstKeptEntryId: pick === null ? null : blocks[pick].entryId, prefixTokens: pick === null ? 0 : pre[pick],
		summaryTokensPlanned: summary, sumTrigger, scale: o.scale ?? UNIT,
		ctxTokens: real(ctxEst), ctxAfterFolds: real(ctxAfterFolds), userTurns, ...(o.fileRecall ? { fileRecall: o.fileRecall } : {}),
		...(atRoom ? { atRoom } : {}), ...(atRoomUnedited ? { atRoomUnedited } : {}),
	});
	const f = result(null);
	if (!sumTrigger) return { f, c: null, a: null };
	let acc = 0;
	for (const b of blocks) { pre[b.idx] = acc; acc += tokOverride.get(b.idx) ?? b.tokens; }
	const limit = blocks.findIndex(protectedTurn), cuts: number[] = [];
	for (let i = minCut; i < blocks.length && (limit < 0 || i <= limit); i++) if (isCutBlock(blocks[i])) cuts.push(i);
	if (!cuts.length) return { f, c: null, a: null };
	const cw = cuts.findIndex((k) => ctxAfterFolds - pre[k] + S(k) <= coldCap);
	const first = cw < 0 ? cuts.length - 1 : cw;
	const paying = cuts.slice(first).find((k) => {
		const X = c * pre[k], Sr = c * S(k);
		if (X < 2 * Sr) return false;
		const call = law.pr.w * c * Math.max(0, pre[k] - prevSum) + law.pr.out * Math.min(c * S(k), NARRATIVE_MAX);
		return gate("summary", X, Sr, null, call, Sr, undefined, undefined, false, blocks[k].entryId ?? undefined)
			&& gate("plan", real(ctxEst), real(ctxAfterFolds - pre[k] + S(k)), room, call, real(ctxAfterFolds - pre[k] + S(k)), undefined, true);
	});
	const bound = paying ?? cuts[first], ready = new Set(o.ready ?? []);
	const readySize = (k: number) => o.readySizes?.[blocks[k].entryId!] ?? S(k);
	const have = cuts.filter((k) => k <= bound && ready.has(blocks[k].entryId!) && pre[k] >= 2 * readySize(k)).pop();
	return { f, c: paying === undefined ? null : result(paying), a: have === undefined ? null : result(have, readySize(have)) };
}

/** Select from the planner's tuple: production uses the plain law; application uses G_{1/10} and takes only READY summaries. */
export function selectPlan(q: ReturnType<typeof plan>, o: PlanOpts): PlanResult | null {
	if (!q) return null;
	const law = o.law ?? { pr: lawPrices(undefined, false), g: G0, pWarm: 0 };
	const test = (p: PlanResult, ready = false) => {
		const A = p.ctxAfterFolds - p.scale.c * (p.prefixTokens - p.summaryTokensPlanned), room = compactionRoom(o.model, o.reserve);
		const t = o.application ? guardTerms(p.ctxTokens, A, law.pWarm, room, law.pr, law.g, o.rent ?? 0, o.keep)
			: lawTerms(p.ctxTokens, A, law.pWarm, room, law.pr, law.g, 0, A, o.keep);
		o.trace?.push({ ...t, keep: o.keep, Tsuf: A - sizeOf(p.scale, untouchedEst(p.blocks, p.folds, p.cutIdx !== null)), where: o.application ? "guard" : "plan", ...(o.application ? { rent: o.rent ?? 0 } : {}), cut: p.cutIdx !== null, ...(ready ? { ready: true } : {}) });
		return t.ok && (p.cutIdx !== null || p.folds.length > 0);
	};
	const a = o.cutAt === undefined ? q.a : q.a?.firstKeptEntryId === o.cutAt ? q.a : null;
	if (a && !o.deferSummary && test(a, true)) return a;
	if (!o.application && !o.foldsOnly && o.cutAt === undefined && q.c) return q.c;
	return test(q.f) ? q.f : null;
}

/** Compatibility projection for planner callers; the decision core also reads the unfiltered tuple for rent and production. */
export function planContext(entries: Any[], o: PlanOpts): PlanResult | null {
	return selectPlan(plan(entries, o), o);
}

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

/** Apply only folds to a request; summaries enter through Pi's native or boundary compaction. */
export function applyPlanToMessages(messages: Any[], plan: RunPlan | null): { messages: Any[]; applied: Set<string> } | null {
	if (!plan || plan.persisted || !plan.folds.length) return null;
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
	return changed ? { messages: folded, applied } : null;
}

export { pickKeyLines };
