import type { SpeedStamp } from "./speed.ts";
// The decision core: view, clock, law, plan and decide as pure functions of the session branch, what pi-zip has learned (Λ) and
// the time. Nothing here reads a file, Pi or the clock, and nothing here has an effect: run.ts (the shell) gathers the inputs at Pi's
// events, keeps what only the process holds (the summary call in the background, the timers) and carries out what these return.
import { detectCold, modelKey, resolveTtl, type ColdInfo } from "./cache.ts";
import { validateEdits } from "./guard.ts";
import { GAP_EDGES, lawPrices, pWarm, type Entry } from "./learn.ts";
import { buildBlocks, calibrate, compactionRoom, plan, selectPlan, sizeOf, untouchedEst, UNIT, type Block, type Cut, type FoldTarget, type Law, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
import type { FileRecall } from "./recallfile.ts";
import { PRODUCT, type Any } from "./util.ts";

export const SUMMARY_CUSTOM = "pi-zip/summary"; // a summary call pi-zip made in the background: what it produced (or that it was lost) and its cost

/** A `pi-zip/summary` entry: the summary written for the cut at entry `key` of the projection whose head is `head` (the id of the
 *  branch's newest compaction, "" before any), and what the call cost. Without `cut`, a call that ended without a summary it could
 *  hand over (aborted when it was replaced or pi-zip was switched off, or still running when the process exited): unused, its cost
 *  `estimated` from the input it is billed for, or a call that threw (`error`). A failed narrative is not a lost call: its `cut` is the
 *  fallback summary (cut.llmOk false, cut.llmError why), READY like any other. A summary is READY while its head is the branch's head;
 *  using it (a compaction with its text) or any other compaction moves the head, so it is never taken twice. */
export interface Artifact {
	speed?: SpeedStamp;
	head: string;
	key: string;
	cut?: Cut;
	usd: number;
	estimated?: boolean;
	lost?: string;
	error?: string;
}

/** Λ for the model a decision is about: its learned class and survival (learn.ts), the cache tier its requests ask for (when known),
 *  growth per request, and the facts of the session state.ts rebuilds from the branch. */
export interface Learned {
	model: Any;
	ent?: Entry;
	tier?: "short" | "long";
	g: number;
	justEdited: boolean; // the newest response answered a request that first carried an edit (no back-to-back warm rewrites)
}

/** What the planner reads besides the branch: the model, the working directory, the system prompt and tools, Pi's compaction reserve,
 *  the recalled handles, the steering marks and how a folded output comes back (run.ts recallMode). */
export interface Env {
	model: Any;
	cwd: string;
	sys: SysInfo;
	reserve: number;
	recalled: Set<string>;
	steerIds: Set<string>;
	scale?: Scale; // the token scale of these entries, already read by the shell (one want() prices ~30 plans of one view)
	rereadOnly: boolean;
	fileRecall?: FileRecall;
}

/** A record for the ledger, returned by a decision for the shell to write (in order). */
export type Note = Record<string, unknown>;

// ---- view ---------------------------------------------------------------------------------------------------------------------

/** The token scale (O, c) of model `key` read from the branch (UNIT when it cannot be read). */
export function scaleOf(entries: Any[], branch: Any[], sys: SysInfo, key?: string): Scale {
	try {
		return calibrate(entries, sys, branch, key);
	} catch {
		return UNIT;
	}
}

/** The guard's view of a candidate edit set; folds whose entry left the projection are ignored. */
export function checkEdits(blocks: Block[], userTurns: number, folds: FoldTarget[], cut: Cut | null): string | null {
	const byId = new Map(blocks.map((b) => [b.entryId, b]));
	const live = folds.filter((t) => byId.has(t.entryId));
	const cutBlock = cut ? byId.get(cut.firstKeptEntryId) : undefined;
	if (cut && !cutBlock) return `cut target ${cut.firstKeptEntryId} is not in the projection`;
	return validateEdits(blocks, { folds: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.ph])), recover: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.recover])), cut: cutBlock ? cutBlock.idx : null }, userTurns);
}

// ---- clock --------------------------------------------------------------------------------------------------------------------

/** The return a request sent at `nowMs` would be: P(warm) (cold = P < 0.5), the gap and whether the absence was a pause.
 *  `last`: the shell's own clock of the newest request and its model (0 and "" read both from the branch). */
export const clock = (branch: Any[], lam: Pick<Learned, "model" | "ent" | "tier">, nowMs: number, last: { reqMs: number; modelKey: string } = { reqMs: 0, modelKey: "" }): ColdInfo =>
	detectCold(lam.model, last.reqMs, branch, nowMs, last.modelKey, (g, prior) => pWarm(lam.ent, g, prior), lam.tier);

/** Requests appended after the newest assistant have not reached the cache; usage entries may have refreshed it. */
export function requestBranch(branch: Any[]): Any[] {
	let n = branch.length;
	while (n > 0 && !(branch[n - 1]?.type === "message" && branch[n - 1].message?.role === "assistant")) n--;
	return branch.filter((e, i) => i < n || e?.type !== "message");
}
/** P(warm) inside a run: trailing tool/user messages touch nothing; usage entries can refresh the cache. Never a pause. */
export const inRunClock = (branch: Any[], lam: Pick<Learned, "model" | "ent" | "tier">, nowMs: number, last: { reqMs: number; modelKey: string }): ColdInfo =>
	({ ...clock(requestBranch(branch), lam, nowMs, last), pause: false });

/** The head of the projection the branch builds: the id of its newest compaction, "" before any. */
export function headOf(branch: Any[]): string {
	for (let i = branch.length - 1; i >= 0; i--) if (branch[i]?.type === "compaction") return String(branch[i].id ?? "");
	return "";
}

/** The `pi-zip/summary` entries of the branch, oldest first. */
export const artifactsOf = (branch: Any[]): Artifact[] =>
	branch.filter((e) => e?.type === "custom" && e.customType === SUMMARY_CUSTOM && typeof e.data?.key === "string").map((e) => e.data as Artifact);

/** The READY summaries: produced for the projection the branch builds now (its head), from the branch's entries and `extra` (those
 *  this process produced, written or not yet), one per cut (the newest). */
export function readyOf(branch: Any[], extra: readonly Artifact[] = []): Artifact[] {
	const head = headOf(branch);
	const byKey = new Map<string, Artifact>();
	for (const a of [...artifactsOf(branch), ...extra]) if (a.cut && a.head === head) byKey.set(a.key, a);
	return [...byKey.values()];
}

/** The summary calls of the branch that no compaction used (a summary nobody took, or a call that ended without one), and their cost:
 *  what keeps the session totals honest. Each compaction consumes one matching artifact of its incoming head, at the charge it carries.
 *  Artifacts can follow their compaction because Pi requires the compaction draft first. A fallback whose provider reported no cost is
 *  booked at its estimate (`estimated`) and its compaction carries cost 0: the two do not pair, so it stays here, which is what keeps
 *  its estimated charge in the totals. */
export function unusedOf(branch: Any[]): { n: number; usd: number } {
	const used = new Map<string, number>(), keyOf = (head: string, key: string, text: string, usd: unknown) => JSON.stringify([head, key, text, Number(usd) || 0]);
	let head = "", n = 0, usd = 0;
	for (const e of branch) if (e?.type === "compaction") {
		if (e.details?.by === PRODUCT) {
			const key = keyOf(head, e.firstKeptEntryId, e.summary, e.usage?.cost?.total);
			used.set(key, (used.get(key) ?? 0) + 1);
		}
		head = String(e.id ?? "");
	}
	for (const a of artifactsOf(branch).reverse()) {
		const key = a.cut ? keyOf(a.head, a.key, a.cut.text, a.usd) : "", remaining = used.get(key) ?? 0;
		if (remaining) { used.set(key, remaining - 1); continue; }
		n++;
		usd += Number(a.usd) || 0;
	}
	return { n, usd };
}

/** One step of the growth estimate g: EWMA(0.1) of the prompt growth `d` between consecutive unedited responses of one model, each
 *  capped at the p90 of the last 20 deltas (run.ts learn and state.ts replayGrowth share it). */
export function grow(g: number, deltas: number[], d: number): { g: number; deltas: number[] } {
	const next = [...deltas.slice(-19), d];
	const sorted = [...next].sort((a, b) => a - b);
	return { g: 0.9 * g + 0.1 * Math.min(d, sorted[Math.ceil(0.9 * sorted.length) - 1]), deltas: next };
}

// ---- law ----------------------------------------------------------------------------------------------------------------------

/** The law's inputs at P(warm) `pWarm`: the class prices of Λ's model (its tier decides the 1-hour premium), growth g, P. */
export const lawOf = (branch: Any[], lam: Learned, pWarm: number): Law => ({ pr: lawPrices(lam.ent?.cls, resolveTtl(lam.model, branch, lam.tier).ms >= 3_600_000), g: lam.g, pWarm });

// ---- plan ---------------------------------------------------------------------------------------------------------------------

/** Plan options for `entries` (`pending`: the next prompt is not in them yet) at P(warm) `pWarm`, after a pause or not, with the token
 *  scale read from the branch. P goes into the law only. */
export function planOpts(entries: Any[], branch: Any[], env: Env, lam: Learned, pending: boolean, pWarm: number, pause: boolean, cutAt?: string, foldsOnly = false, ready?: readonly string[]): { o: PlanOpts; cal: Scale } {
	const cal = env.scale ?? scaleOf(entries, branch, env.sys, env.model ? modelKey(env.model) : undefined);
	return { cal, o: { pause, scale: cal, cwd: env.cwd, recalled: env.recalled, model: env.model, promptPending: pending, rereadOnly: env.rereadOnly, ...(env.fileRecall ? { fileRecall: env.fileRecall } : {}), reserve: env.reserve, steerIds: env.steerIds, law: lawOf(branch, lam, pWarm), trace: [], ...(cutAt !== undefined ? { cutAt } : {}), ...(foldsOnly ? { foldsOnly } : {}), ...(ready?.length ? { ready } : {}) } };
}

/** The branch owns rent; every compaction is a rewrite, including one supplied by Pi or another extension. */
export function rentOf(branch: Any[]): number {
	const latest = [...branch].reverse().find((e) => e?.customType === "pi-zip/rent" || e?.type === "compaction");
	return latest?.type === "custom" ? latest.data?.rent ?? 0 : 0;
}

/** A summary a plan may take: produced and ready (`running` false), or still being written. */
export interface Avail { key: string; running: boolean; summaryTokens?: number }

/** Production reads the same tuple, including structurally eligible ready/running summaries. No application test suppresses Y. */
export function candidateOf(entries: Any[], opts: (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts; cal?: Scale }, avail: readonly Avail[], _where: string, foldsOnly = false) {
	const { o, cal } = opts(undefined, foldsOnly, avail.map((a) => a.key));
	o.readySizes = Object.fromEntries(avail.filter((a) => a.summaryTokens !== undefined).map((a) => [a.key, a.summaryTokens!]));
	const q = plan(entries, o);
	return { r: { o, cal: o.scale ?? cal ?? UNIT, p: q?.a ?? q?.c ?? null } };
}

// ---- decide -------------------------------------------------------------------------------------------------------------------

/** The application rules have one implementation for prompts, first requests and boundaries. First requests defer summaries;
 *  native first requests retain the prompt's already priced decision. b2b blocks application only, never production or the room. */
export function decideEdits(x: { at: "native" | "run" | "turn_end"; justEdited: boolean; pWarm: number; entries: Any[]; ready: readonly Avail[];
	opts: (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts; cal?: Scale } }) {
	const r = x.opts(undefined, false, x.ready.filter((a) => !a.running).map((a) => a.key));
	const { o } = r, cal = o.scale ?? r.cal ?? UNIT;
	o.readySizes = Object.fromEntries(x.ready.filter((a) => !a.running && a.summaryTokens !== undefined).map((a) => [a.key, a.summaryTokens!]));
	o.application = true;
	o.justEdited = x.justEdited;
	o.deferSummary = x.at === "run";
	const q = plan(x.entries, o), produce = q?.c && !x.ready.some((a) => a.key === q.c!.firstKeptEntryId) ? q.c : null;
	const carriedSavings = cal.c * (o.carriedFolds ?? []).reduce((n, t) => n + t.entryTokens - t.phTokens, 0);
	const saved = q ? q.f.ctxTokens - (q.a ?? q.f).ctxAfterFolds + (q.a ? q.a.scale.c * (q.a.prefixTokens - q.a.summaryTokensPlanned) : 0) : 0;
	const b2b = x.justEdited && x.pWarm >= 0.5;
	const p = b2b ? null : selectPlan(q, o);
	const rentNext = p || x.pWarm < 0.5 ? 0 : (o.rent ?? 0) + Math.max(0, saved - carriedSavings);
	const notes: Note[] = q?.a && x.at === "run" ? [{ type: "defer", key: q.a.firstKeptEntryId }] : [];
	if (p?.cutIdx != null && q?.c && p.firstKeptEntryId !== q.c.firstKeptEntryId) notes.push({ type: "pin", where: x.at, from: q.c.firstKeptEntryId, to: p.firstKeptEntryId, ok: true });
	return { kind: b2b ? "b2b" as const : "plan" as const, o, cal, p, notes, produce: p?.cutIdx != null ? null : produce, rentNext };

}

/** A native prompt carries its jointly priced folds; other first requests defer summaries to turn_end. */
export function decideRun(x: { cold: boolean; justEdited: boolean; nat: { o: PlanOpts; cal: Scale; p: PlanResult } | null; foreign: boolean; now: Any[]; ready: readonly Avail[]; opts: (entries: Any[], cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts; cal: Scale } }) {
	if (x.nat) return { kind: "plan" as const, ...x.nat, notes: [], produce: null, rentNext: 0 };
	return decideEdits({ at: "run", justEdited: x.justEdited, pWarm: x.cold ? 0 : 1, entries: x.now, ready: x.ready,
		opts: (cutAt, foldsOnly, ready) => {
			const r = x.opts(x.now, cutAt, foldsOnly, ready);
			if (x.foreign) r.o.foldsOnly = true;
			return r;
		} });
}

/** Native folds retain the prompt decision and use entry IDs to find their positions; other folds are guarded before sending. */
export function runPlanOf(x: { p: PlanResult | null; cal: Scale; cold: boolean; native: Cut | null; nat: { before: number; after: number } | null; folds: FoldTarget[]; settleIds: string[]; ms: number; now?: Any[] }): { plan: RunPlan; folds: FoldTarget[]; drop?: Note } {
	const { p, cal, cold, native, nat } = x;
	let folds = x.folds, drop: Note | undefined;
	const sameSet = x.settleIds.length === folds.length && x.settleIds.every((id) => folds.some((u) => u.entryId === id));
	const source: RunPlan["source"] = !cold ? "valve" : native || (x.settleIds.length > 0 && sameSet) ? "settle" : "runstart";
	if (native && p) {
		const positions = new Map((x.now ?? []).flatMap((e) => (e.messages ?? []).filter((m: Any) => m.role !== "system").map(() => e.sourceEntry?.id)).map((id, visIdx) => [id, visIdx]));
		folds = folds.map((t) => {
			const visIdx = positions.get(t.entryId);
			if (visIdx === undefined) throw new Error("native fold target must be kept after the cut");
			return { ...t, visIdx };
		});
	} else if (p) {
		const invalid = checkEdits(p.blocks, p.userTurns, folds, null);
		if (invalid) {
			drop = { type: "guard_drop", where: "run_plan", reason: invalid, folds: folds.length, summary: false };
			folds = [];
		}
	}
	const plan: RunPlan = {
		source, folds, cut: null, native: native ?? undefined, ctxBefore: nat?.before ?? p?.ctxTokens ?? 0,
		ctxAfter: nat?.after ?? p?.ctxAfterFolds ?? 0, ms: x.ms, scale: cal, persisted: false,
		...(!cold && native ? { ready: "away" as const } : {}), waitMs: 0,
		untouched: p ? sizeOf(cal, untouchedEst(p.blocks, folds, !!native)) : sizeOf(cal, 0),
	};
	return { plan, folds, ...(drop ? { drop } : {}) };
}

/** Reconcile carried folds before selection: the planner keeps their exact placeholders and prices the resulting union.
 *  The same selected edit supplies the single post-edit room judgement and the boundary commit. */
export function decideTurnEnd(x: { failed: boolean; justEdited: boolean; pWarm: number; ready: readonly Avail[]; opts: (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts }; entries: Any[]; runPlan?: RunPlan | null }) {
	const blocks = buildBlocks(x.entries), live = new Set(blocks.filter((b) => !b.edited).map((b) => b.entryId));
	const carried = x.runPlan ? { ...x.runPlan, folds: x.runPlan.folds.filter((t) => live.has(t.entryId) && (!x.runPlan!.applied || x.runPlan!.applied.has(t.entryId))) } : null;
	if (x.failed) return { kind: "none" as const, runPlan: carried };
	const opts = (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => {
		const r = x.opts(cutAt, foldsOnly, ready);
		if (carried) { r.o.scale = carried.scale; r.o.carriedFolds = carried.folds; }
		return r;
	};
	const d = decideEdits({ ...x, at: "turn_end", opts });
	const before = sizeOf(d.cal, blocks.reduce((n, b) => n + b.tokens, 0));
	const after = d.p ? d.p.ctxAfterFolds - d.p.scale.c * (d.p.prefixTokens - d.p.summaryTokensPlanned)
		: before - d.cal.c * (d.o.carriedFolds ?? []).reduce((n, t) => n + t.entryTokens - t.phTokens, 0);
	const room = roomOf(after, d.o, () => { const r = opts(undefined, false, []); r.o.application = false; r.o.pause = false; return candidateOf(x.entries, () => r, [], "room").r.p; });
	return { ...d, produce: room ? null : d.produce, room, runPlan: carried };
}

/** The one wait (theory 1.4 R9): when the view after a turn_end's edit (`after`) is still at Pi's compaction room, the plan at the
 *  in-run p with no pause and no ready summaries (`plan`: every call priced), if it has a cut c′ (which then passed the law with its
 *  call); else null. A ready summary of that same cut may still leave the view at the room. `o`: model and reserve. */
export function roomOf(after: number, o: PlanOpts, plan: () => PlanResult | null): PlanResult | null {
	const room = compactionRoom(o.model, o.reserve);
	if (room === null || after < room) return null;
	const c = plan();
	return c && c.cutIdx !== null ? c : null;
}

/** The valve plan of a turn_end (persisted at once; `cut`: its summary, ready, or the room wait's; `waitMs`: the room wait). */
export const valvePlanOf = (p: PlanResult, cut: Cut | null, ready: boolean, waitMs: number, ms: number): RunPlan => ({
	source: "valve", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds - (cut ? p.scale.c * (cut.prefixTokens - cut.summaryTokens) : 0), ms, scale: p.scale, persisted: false,
	untouched: sizeOf(p.scale, untouchedEst(p.blocks, p.folds, !!cut)), ...(cut ? { waitMs } : {}), ...(cut && ready ? { ready: "background" as const } : {}),
});

/** One producer rule, triggered by a decision, settle, or the timer. Decisions supply the cut their call-priced plan wants.
 *  Settle also asks about a return at 30 s; the timer asks only about the first paying pause. Produced/running cuts are never
 *  produced again. The timer's deadline remains relative to the last touch, so re-planning cannot slide it into the future. */
export function want(x: { at: "decision" | "settle" | "timer"; now: number; lastTouch: number; ttlMs: number; survival: (gapS: number) => number;
	avail: readonly Avail[]; candidate?: PlanResult | null; plan: (p: number, pause: boolean, avail: readonly Avail[]) => PlanResult | null;
	latency: (p: PlanResult) => number }): { p: PlanResult; start: number; gapS?: number } | null {
	const fresh = (p: PlanResult | null | undefined) => p && p.cutIdx !== null && !x.avail.some((a) => a.key === p.firstKeptEntryId) ? p : null;
	if (x.at === "decision") {
		const p = fresh(x.candidate);
		return p ? { p, start: x.now } : null;
	}
	if (!x.lastTouch) return null;
	if (x.at === "settle") {
		const p = fresh(x.plan(x.survival(30), false, x.avail));
		if (p && !x.avail.some((a) => a.running)) return { p, start: x.now };
	}
	// A summary already produced (or running) that the cold return can take covers that return.
	const cold = x.plan(0, true, x.avail);
	if (cold?.cutIdx !== null && cold && x.avail.some((a) => a.key === cold.firstKeptEntryId)) return null;
	const tau = x.ttlMs / 1000;
	const gaps = [...new Set([tau, tau + 1, ...GAP_EDGES.filter((g) => g >= tau).flatMap((g) => [g, g + 1]), 7200])].sort((a, b) => a - b);
	for (const gapS of gaps) {
		const p = x.plan(x.survival(gapS), true, []);
		if (!p || p.cutIdx === null) continue;
		if (!fresh(p)) return null;
		return { p, start: x.lastTouch + gapS * 1000 - 1.5 * x.latency(p), gapS };
	}
	return null;
}
