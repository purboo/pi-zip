// The per-session state machine behind index.ts: cold detection, the run plan (F8), the warm valve (F10), persistence at turn_end,
// settle preparation and the away-timer for the summary (F12).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectCold, lastMessageMs, lastPrompt, modelKey, resolveTtl, ttlFor } from "./cache.ts";
import { describe, lawPrices, loadStats, pWarm, record, sample, GAP_EDGES, type Entry } from "./learn.ts";
import { validateEdits, repairPayload } from "./guard.ts";
import { Stats, noticeText, statsText, type NoticeAction, type ZipControl } from "./notice.ts";
import { applyPlanToMessages, buildBlocks, calibrate, countUserTurns, G0, planContext, reserveTokensFor, untouchedEst, type Block, type Calibration, type Cut, type FoldTarget, type Law, type PlanOpts, type PlanResult, type RunPlan } from "./plan.ts";
import { handleFor } from "./placeholder.ts";
import { recalledHandlesFromBranch } from "./recall.ts";
import { buildCut } from "./summary.ts";
import { type Any, PRODUCT, tok4 } from "./util.ts";

export const PLAN_CUSTOM = "pi-zip/plan";
export const STATE_CUSTOM = "pi-zip/state";
export const STEER_CUSTOM = "pi-zip/steer";
export const AWAY_FRACTION = 0.8; // the away-timer fires this far into the cache lifetime
// Other context managers rewrite the view too (F14); two writers give unpredictable results, so we pause and keep only the Guard.
const CONFLICT_RE = /billion-context|bc-pi|magic-context|smart-compact|hot-compact|context-prune|pi-vcc|context-mode|prefix-cache/i;

/** The guard's view of a candidate edit set; folds whose entry left the projection are ignored. */
export function checkEdits(blocks: Block[], userTurns: number, folds: FoldTarget[], cut: Cut | null): string | null {
	const byId = new Map(blocks.map((b) => [b.entryId, b]));
	const live = folds.filter((t) => byId.has(t.entryId));
	const cutBlock = cut ? byId.get(cut.firstKeptEntryId) : undefined;
	if (cut && !cutBlock) return `cut target ${cut.firstKeptEntryId} is not in the projection`;
	return validateEdits(blocks, { folds: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.ph])), recover: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.recover])), cut: cutBlock ? cutBlock.idx : null }, userTurns);
}

/** A summary being prepared (or finished) while the user is away. It has its own AbortController: no run owns it. */
interface Bg {
	key: string | null; // firstKeptEntryId of the cut it was written for
	done: Cut | null;
	promise: Promise<Cut | null>;
	controller: AbortController;
}

/** Resolves with the promise's value, or null as soon as the signal aborts (Esc cancels the waiting, not the work). */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(null);
		const onAbort = () => resolve(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, () => resolve(null)).finally(() => signal?.removeEventListener("abort", onAbort));
	});
}

const errText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

export class Zip implements ZipControl {
	off = false;
	quiet = false;
	conflict: string | null = null;
	readonly stats = new Stats();
	readonly recalled = new Set<string>();
	private cold = false;
	private coldReason = "";
	private runChecked = true; // the first request of the run has been looked at
	private runEdits = false; // this run carries an edit plan that turn_end has yet to persist
	private runPlan: RunPlan | null = null;
	private lastReqMs = 0; // the real-time cache clock: newest request start or end
	private lastModelKey = ""; // provider/model of the newest request: a cache entry belongs to one model
	private settleIds: string[] = []; // entries the settle plan folded: only used to label a plan as prepared
	private bg: Bg | null = null;
	private bgWaitMs = 0;
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
	private pastTtl = false; // this run is a user return after the declared TTL (the previous user turn is eligible: plan.ts PlanOpts.pastTtl)
	private survSrc = "no prior request";
	private ent: Entry | undefined; // learned class + survival of the current model (learn.ts)
	private g = G0; // EWMA(0.1) of real-token growth between consecutive responses, capped at the p90 of the last 20 deltas
	private deltas: number[] = [];
	private prevTotal = 0; // prompt size (input + cacheRead + cacheWrite) of the newest response, and its model
	private prevKey = "";
	private branchLastMs = 0; // the branch clock at run start (a fresh process knows the gap from the session)
	private nextEdit: number | null = null; // the next request is the first to carry a new edit: its untouched prefix (real tokens)
	private pending: { gapS: number; expect: number; edited: boolean; key: string } | null = null;
	private justEdited = false; // the newest response answered a request that first carried an edit: the next request gets no warm edit

	constructor(private pi: ExtensionAPI) {}

	active = () => !this.off && !this.conflict;

	/** zip_recall declared to the model? Checked at session start and before every run (index.ts); a `--tools` allowlist hides it. */
	recallOk = true;
	setRecallOk(ok: boolean) {
		if (ok !== this.recallOk) this.ledger({ type: "recall_available", ok });
		this.recallOk = ok;
	}

	ledger(rec: Record<string, unknown>) {
		const path = process.env.PI_ZIP_LEDGER; // test only
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...rec }) + "\n");
		} catch {}
	}

	private notify(ctx: Any, text: string) {
		this.stats.notices++;
		this.ledger({ type: "notice", text });
		if (ctx?.ui?.notify && (ctx.mode === "tui" || ctx.mode === "rpc")) {
			try {
				ctx.ui.notify(text, "info");
			} catch {}
		}
	}

	private branch(ctx: Any): Any[] {
		try {
			return ctx.sessionManager.getBranch() as Any[];
		} catch {
			return [];
		}
	}

	private reserve(ctx: Any): number {
		try {
			return reserveTokensFor(this.pi.getSettings?.(), ctx?.model);
		} catch {
			return reserveTokensFor(undefined, ctx?.model);
		}
	}

	private sysTokens(ctx: Any): number {
		try {
			return tok4(ctx.getSystemPrompt?.() ?? "");
		} catch {
			return 0;
		}
	}

	/** Plan options with the token scale read from the branch (stateless: a fresh process calibrates exactly like a long-lived one). */
	private opts(ctx: Any, pending: boolean, mode: "cold" | "warm", entries: Any[], pWarm = mode === "cold" ? 0 : 1): { o: PlanOpts; cal: Calibration } {
		const sys = this.sysTokens(ctx);
		const cal = calibrate(entries, sys);
		return { cal, o: { mode, sys, k: cal.k, cwd: (ctx?.cwd as string) ?? process.cwd(), recalled: this.recalled, model: ctx?.model, promptPending: pending, rereadOnly: !this.recallOk, reserve: this.reserve(ctx), steerIds: this.steerIds, law: this.law(ctx, pWarm), trace: [] } };
	}

	private law(ctx: Any, pWarm: number): Law {
		const m = ctx?.model ?? this.model;
		const ent = this.entKey === modelKey(m) ? this.ent : undefined;
		return { pr: lawPrices(ent?.cls, resolveTtl(m, this.branch(ctx)).ms >= 3_600_000), g: this.g, pWarm };
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
			type: "law", where, g: Math.round(l.g), pWarm: rd(l.pWarm), survSrc: where === "run" ? this.survSrc : "in-run", cls: pr?.cls ?? null, wr: pr ? rd(pr.w / pr.r) : null, prSrc: pr?.src ?? "legacy",
			steps: (o.trace ?? []).map((t) => ({ at: t.where, ok: t.ok, B: Math.round(t.B), A: Math.round(t.A), T: Math.round(t.T), ...(t.Tsuf !== undefined ? { Tsuf: Math.round(t.Tsuf) } : {}), phi: rd(t.phi), K: rd(t.K), eta: rd(t.eta) })),
		});
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
			this.notify(ctx, `${PRODUCT} · "${found}" also manages context, so folding is paused (only the request guard stays on)`);
		}
	}

	// ---- events ----------------------------------------------------------------------------------------------
	sessionStart(ctx: Any) {
		const branch = this.branch(ctx);
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
		this.detectConflict(ctx);
		this.ledger({ type: "session_start", off: this.off, quiet: this.quiet, conflict: this.conflict });
	}

	shutdown() {
		this.cancelTimer();
		this.bg?.controller.abort();
		this.bg = null;
	}

	beforeAgentStart(ctx: Any) {
		this.cancelTimer(); // the user is back: nothing is started behind their back any more
		this.model = ctx?.model;
		this.cold = false;
		this.pastTtl = false;
		this.runChecked = true;
		this.runEdits = false;
		this.runPlan = null;
		this.settleIds = [];
		this.bgWaitMs = 0;
		this.wireLedgered = false;
		this.runUserSeen = 0;
		if (!this.active()) return;
		this.detectConflict(ctx);
		if (!this.active()) return;
		const branch = this.branch(ctx);
		const key = modelKey(ctx.model);
		this.loadEnt(key);
		this.branchLastMs = lastMessageMs(branch);
		if (!this.prevKey) ({ key: this.prevKey, total: this.prevTotal } = lastPrompt(branch)); // fresh process: the session's newest response
		const { cold, reason, ttl, pWarm: p, src, gapS, pastTtl } = detectCold(ctx.model, this.lastReqMs, branch, Date.now(), this.lastModelKey, (g, prior) => pWarm(this.ent, g, prior));
		this.cold = cold;
		this.pastTtl = pastTtl;
		this.pWarm = p;
		this.survSrc = src;
		this.runChecked = false; // the first request decides (cold: the cold plan; warm: only above the cap, if the law fires)
		this.coldReason = reason;
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		for (let i = branch.length - 1; i >= 0; i--) {
			const en = branch[i];
			if (en?.type !== "custom" || en.customType !== PLAN_CUSTOM) continue;
			if (en.data?.policy === PRODUCT) {
				if (cold && Array.isArray(en.data.targets)) this.settleIds = en.data.targets.map((t: Any) => (typeof t === "string" ? t : t?.entryId)).filter((x: Any) => typeof x === "string");
			}
			break;
		}
		this.ledger({ type: "prompt", cold, reason, ttlMs: ttl.ms, ttlSource: ttl.source, settleTargets: this.settleIds.length, gapS: gapS === null ? null : Math.round(gapS), pWarm: Math.round(p * 1000) / 1000, survSrc: src, cls: this.ent?.cls ?? null });
		if (ttl.note && !this.ttlNoticed) {
			this.ttlNoticed = true; // once per session
			if (!this.quiet) this.notify(ctx, ttl.note);
		}
	}

	private cancelTimer() {
		this.timerGen++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** A summary nobody adopted still cost money: abort it if it is still running, book it if it finished. */
	private discardBg() {
		const b = this.bg;
		this.bg = null;
		if (!b) return;
		if (!b.done) b.controller.abort();
		b.promise.then((c) => { if (c) this.stats.summaryUsd += c.costUsd; });
	}

	async context(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		if (!this.runChecked) {
			this.runChecked = true;
			try {
				await this.computeRunPlan(ctx);
			} catch (err) {
				// no plan was sent, so none may be persisted: end the edit run here
				this.runPlan = null;
				this.runEdits = false;
				this.ledger({ type: "error", where: "context/run_plan", error: errText(err) });
			}
		}
		if (this.runPlan && !this.runPlan.persisted) {
			const out = applyPlanToMessages(e.messages, this.runPlan);
			if (out) {
				if (!this.runPlan.sent) this.nextEdit = this.runPlan.untouched ?? 0;
				this.runPlan.sent = true;
				this.runPlan.applied = out.applied;
				return { messages: out.messages };
			}
		}
		return undefined;
	}

	/** A prepared summary for this cut, or null. A summary still being written is waited for (only the remainder); Esc stops the waiting, not the work. */
	private async takeBg(key: string | null, signal?: AbortSignal): Promise<{ cut: Cut | null; adopted: boolean }> {
		const b = this.bg;
		if (!b || key === null || b.key !== key) {
			this.discardBg();
			return { cut: null, adopted: false };
		}
		const w0 = performance.now();
		const cut = b.done ?? (await waitFor(b.promise, signal));
		this.bgWaitMs = performance.now() - w0;
		if (cut) {
			this.bg = null;
			return { cut, adopted: true };
		}
		if (signal?.aborted) return { cut: null, adopted: false }; // keep it running: a retry of the prompt can still use it
		this.discardBg();
		return { cut: null, adopted: false };
	}

	/** ONE plan per edit run: computed at the first request (the new prompt is in the session), applied to every request until turn_end persists the same set. */
	private async computeRunPlan(ctx: Any) {
		const t0 = performance.now();
		const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		if (!this.cold && this.justEdited) { // no warm edit on the request right after an edited one (no back-to-back warm rewrites)
			this.ledger({ type: "b2b_skip", where: "run" });
			this.discardBg();
			return;
		}
		const { o, cal } = this.opts(ctx, false, this.cold ? "cold" : "warm", entries, this.pWarm);
		o.pastTtl = this.pastTtl;
		const p = planContext(entries, o);
		this.lawLedger("run", o);
		if (!p) {
			this.discardBg(); // the law does not fire (warm below the cap or a rewrite that does not pay back; a likely-warm cold return): a prepared summary does not pay back
			return;
		}
		this.runEdits = true;
		const trigger = this.cold ? "cold" : "valve";
		let folds: FoldTarget[] = p?.folds ?? [];
		let cut: Cut | null = null;
		let adopted = false;
		if (p && p.cutIdx !== null) {
			const got = await this.takeBg(p.firstKeptEntryId, ctx.signal);
			cut = got.cut;
			adopted = got.adopted;
		} else {
			this.discardBg();
		}
		const sameSet = this.settleIds.length === folds.length && this.settleIds.every((id) => folds.some((u) => u.entryId === id));
		const source: RunPlan["source"] = !this.cold ? "valve" : adopted || (this.settleIds.length > 0 && sameSet) ? "settle" : "runstart";
		const foldMs = performance.now() - t0;
		if (!cut && p && p.cutIdx !== null && !ctx.signal?.aborted) cut = await buildCut(p, ctx); // produced now, before the first request: the user waits
		// a plan that cannot be persisted must never be sent: the request view would differ from what turn_end can write (I1)
		if (p) {
			const invalid = checkEdits(p.blocks, p.userTurns, folds, cut);
			if (invalid) {
				this.ledger({ type: "guard_drop", where: "run_plan", reason: invalid, folds: folds.length, summary: !!cut });
				if (cut && checkEdits(p.blocks, p.userTurns, folds, null) === null) cut = null;
				else { folds = []; cut = null; }
			}
		}
		const ctxAfter = cut ? (p?.ctxAfterFolds ?? 0) - cal.k * (cut.prefixTokens - cut.summaryTokens) : (p?.ctxAfterFolds ?? 0);
		this.runPlan = { source, folds, cut, ctxBefore: p?.ctxTokens ?? 0, ctxAfter, ms: foldMs, k: cal.k, persisted: false, cutVisibleIdx: p?.cutVisibleIdx ?? -1, cutKeptFirstMsg: p?.cutKeptFirstMsg, untouched: p ? p.k * untouchedEst(p.blocks, folds, !!cut, o.sys) : 0 };
		this.ledger({ type: "cold_plan", trigger, source, folds: folds.length, summary: !!cut, ...this.calOf(cal), ctxBefore: Math.round(this.runPlan.ctxBefore), ctxAfter: Math.round(ctxAfter), ms: Math.round(foldMs), ...(cut ? { summaryMs: cut.ms, llmOk: cut.llmOk, waitedMs: Math.round(adopted ? this.bgWaitMs : cut.ms), ...this.usageOf(cut) } : {}) });
	}

	/** Ledger form of a calibration; ctxBefore/ctxAfter next to it are already scaled (k x estimate). */
	private calOf(cal: Calibration) {
		return { k: Math.round(cal.k * 1000) / 1000, calReal: cal.real, calEst: Math.round(cal.est), calSource: cal.source };
	}

	private usageOf(cut: Cut) {
		const u = cut.usage;
		return u ? { summaryUsage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } } : {};
	}

	/**
	 * Prepare the next cold return while the user is away (interactive only; print and json mode exit right after settle, so there is
	 * nothing to prepare and nothing is ever started in the background). The plan itself is local and free; only a summary needs
	 * a model call, and that is started by a timer 0.8 x TTL after the last request, if the user has not come back by then.
	 */
	async settle(e: Any, ctx: Any): Promise<Any> {
		if (!this.active() || !ctx.hasUI) return undefined;
		try {
			const t0 = performance.now();
			const { o, cal } = this.opts(ctx, true, "cold", e.context.contextEntries);
			const p = planContext(e.context.contextEntries, o);
			if (!p) return undefined;
			this.cancelTimer();
			let scheduledMs: number | null = null;
			if (p.cutIdx !== null) {
				if (this.bg && this.bg.key === p.firstKeptEntryId) {
					// the summary for this very cut is already in flight or done: keep it
				} else {
					this.discardBg();
					scheduledMs = this.scheduleSummary(p, ctx);
				}
			} else {
				this.discardBg();
			}
			this.ledger({ type: "settle_plan", folds: p.folds.length, summary: p.cutIdx !== null, timerMs: scheduledMs, ...this.calOf(cal), ctxBefore: Math.round(p.ctxTokens), ms: Math.round(performance.now() - t0) });
			if (!p.folds.length && p.cutIdx === null) return undefined;
			// ids only: placeholders and summary text are recomputed (they are pure functions of the session), never stored a second time
			const data = { policy: PRODUCT, ts: Date.now(), targets: p.folds.map((t) => t.entryId), cutKey: p.firstKeptEntryId };
			return { entries: [...e.entries, { type: "custom", customType: PLAN_CUSTOM, data }] };
		} catch (err) {
			this.ledger({ type: "error", where: "settle", error: errText(err) });
			return undefined; // never break the session
		}
	}

	/** Start the away-timer for a summary; returns the delay in ms. unref'd: it never keeps the process alive. */
	private scheduleSummary(p: PlanResult, ctx: Any): number {
		const ttl = ttlFor(ctx.model, this.branch(ctx));
		const delay = Math.max(0, (this.lastReqMs || Date.now()) + AWAY_FRACTION * ttl - Date.now());
		const gen = ++this.timerGen;
		this.timer = setTimeout(() => void this.runAway(p, ctx, gen), delay);
		this.timer.unref?.();
		return Math.round(delay);
	}

	private async runAway(p: PlanResult, ctx: Any, gen: number) {
		this.timer = null;
		if (gen !== this.timerGen || !this.active()) return; // the user came back, or we were switched off
		const controller = new AbortController();
		const bg: Bg = { key: p.firstKeptEntryId, done: null, promise: Promise.resolve(null), controller };
		bg.promise = buildCut(p, ctx, controller.signal)
			.then((c) => ((bg.done = c), this.ledger({ type: "away_summary", ms: c.ms, llmOk: c.llmOk, costUsd: c.costUsd, ...this.usageOf(c) }), c))
			.catch((err) => {
				this.ledger({ type: "error", where: "away_summary", error: err instanceof Error ? err.message : String(err) });
				return null;
			});
		this.bg = bg;
		this.ledger({ type: "away_summary_start" });
	}

	async turnEnd(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		try {
			const fresh = this.collectSteer(e); // marked before anything is validated: a steering message is part of its turn
			const out = await this.onTurnEnd(e, ctx);
			if (!fresh.length) return out;
			this.ledger({ type: "steer", ids: fresh });
			return { entries: [...(out?.entries ?? e.entries), { type: "custom", customType: STEER_CUSTOM, data: { ids: fresh } }] };
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
		const o = { t0, blocks, userTurns, sys: this.sysTokens(ctx), usageTotal };
		if (this.runEdits) {
			this.runEdits = false;
			if (!this.runPlan?.sent && this.runPlan && (this.runPlan.folds.length || this.runPlan.cut)) {
				this.runPlan = null; // never sent (the request failed before the context hook, or nothing matched): persisting it would change a prefix nobody saw
				return undefined;
			}
			if (!this.runPlan) return undefined;
			// the run has carried its plan since the first request: persist EXACTLY it, even when this turn failed (the prefix was sent and cached)
			return this.commit(e, ctx, this.runPlan, o);
		}
		if (failed) return undefined;
		if (this.justEdited) { // the request that just ended carried a fresh edit: no warm edit on the very next one (no back-to-back warm rewrites)
			this.ledger({ type: "b2b_skip", where: "turn_end" });
			return undefined;
		}
		// warm cache (in-run, P = 1): nothing, unless the context is above the cold cap and the law fires (I6, F10): then the warm plan, from the next request on
		const { o: popts } = this.opts(ctx, false, "warm", e.context.contextEntries); // the message that just ended carries the newest usage
		const p = planContext(e.context.contextEntries, popts);
		if (popts.trace?.length) this.lawLedger("turn_end", popts);
		if (!p || (!p.folds.length && p.cutIdx === null)) return undefined;
		let cut: Cut | null = null;
		if (p.cutIdx !== null) {
			const got = await this.takeBg(p.firstKeptEntryId, ctx.signal);
			cut = got.cut ?? (await buildCut(p, ctx)); // the user is here and the cache is warm; the alternative is Pi's lossy compaction
		} else this.discardBg();
		const plan: RunPlan = { source: "valve", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds, ms: performance.now() - t0, k: p.k, persisted: false, untouched: p.k * untouchedEst(p.blocks, p.folds, !!cut, popts.sys) };
		return this.commit(e, ctx, plan, o);
	}

	private commit(e: Any, ctx: Any, plan: RunPlan, o: { t0: number; blocks: Block[]; userTurns: number; sys: number; usageTotal: number }) {
		plan.persisted = true;
		const k = plan.k; // one scale for the whole run: stats, notices and the ledger agree with what the plan compared against the limits
		const ctxTokens = k * (o.sys + o.blocks.reduce((a, b) => a + b.tokens, 0));
		const byId = new Map(o.blocks.map((b) => [b.entryId, b]));
		const wasApplied = (t: FoldTarget) => !plan.applied || plan.applied.has(t.entryId); // persist what the requests actually carried
		const live = plan.folds.filter((t) => byId.has(t.entryId) && wasApplied(t));
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
		if (!plan.sent) this.nextEdit = plan.untouched ?? 0; // persisted now, first sent with the next request
		const ours: Any[] = live.map((t) => ({ type: "context_edit", targetId: t.entryId, replacement: { content: [{ type: "text", text: t.ph }] } }));
		if (cut) ours.push({ type: "compaction", summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, details: { by: PRODUCT, trigger: cut.trigger }, usage: cut.usage });
		const before = Math.round(k * live.reduce((a, t) => a + t.entryTokens, 0));
		const after = Math.round(k * live.reduce((a, t) => a + t.phTokens, 0));
		const cutSaved = cut ? Math.round(k * (cut.prefixTokens - cut.summaryTokens)) : 0;
		const waitMs = cut ? (plan.source === "settle" ? this.bgWaitMs : cut.ms) : 0;
		const s = this.stats;
		s.folds += live.length;
		s.foldedTokens += before - after;
		s.activeSaved += before - after + cutSaved;
		if (plan.source === "valve") {
			s.pressureEdits++;
			s.pressureRewriteTokens += ctxTokens;
		} else {
			s.writeSavedTokens += before - after + cutSaved;
		}
		if (cut) {
			s.summaries++;
			s.summarizedTokens += cutSaved;
			s.summaryMs += waitMs;
			s.summaryUsd += cut.costUsd;
		}
		if (live.length) this.ledger({
			type: "fold", trigger: plan.source, turnIndex: e.turnIndex, count: live.length, entries: live.map((t) => t.entryId), tools: live.map((t) => t.tool),
			recoverability: live.map((t) => t.recover ?? "?"), trigs: live.map((t) => t.trig), handles: live.map((t) => handleFor(t.entryId)),
			entryTokensBefore: before, entryTokensAfter: after, ctxBefore: Math.round(ctxTokens), ctxAfter: Math.round(ctxTokens - (before - after) - cutSaved), k: Math.round(k * 1000) / 1000, usageTotal: o.usageTotal,
			coldReason: this.coldReason, prepared: plan.source === "settle", ...(stale ? { staleTargets: stale } : {}),
		});
		if (cut) this.ledger({ type: "summary", trigger: cut.trigger, source: plan.source, count: cut.count, prefixTokens: cut.prefixTokens, summaryTokens: cut.summaryTokens, ms: cut.ms, waitedMs: Math.round(waitMs), llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
		const valve = plan.source === "valve";
		const notices: NoticeAction[] = [];
		if (live.length) notices.push({ kind: "fold", count: live.length, tokensBefore: ctxTokens, tokensAfter: ctxTokens - (before - after), ms: plan.ms + (performance.now() - o.t0), pressure: valve });
		if (cut) {
			const prepared = plan.source === "settle" && waitMs < 500; // finished while the user was away: report the real production time, not the zero wait
			notices.push({ kind: "summary", count: cut.count, tokensBefore: ctxTokens - (before - after), tokensAfter: ctxTokens - (before - after) - cutSaved, ms: prepared ? cut.ms : waitMs, prepared, pressure: valve });
		}
		if (notices.length && !this.quiet) this.notify(ctx, noticeText(notices));
		return { entries: [...e.entries, ...ours] }; // append, never overwrite other extensions' drafts
	}

	providerRequest(e: Any): Any {
		const now = Date.now(), key = modelKey(this.model), last = Math.max(this.lastReqMs, this.branchLastMs);
		const edited = this.nextEdit !== null;
		// the free cache signal: this response's cacheRead against what this request re-sent unchanged, after this gap (same model only)
		this.pending = { gapS: last && (this.lastModelKey || this.prevKey) === key ? (now - last) / 1000 : -1, expect: edited ? this.nextEdit! : this.prevTotal, edited, key };
		this.nextEdit = null;
		this.lastReqMs = now;
		this.lastModelKey = key;
		this.stats.readSavedTokens += this.stats.activeSaved;
		const p: Any = e.payload;
		if (process.env.PI_ZIP_LEDGER && this.cold && !this.wireLedgered && p && Array.isArray(p.messages)) {
			this.wireLedgered = true; // proof that the FIRST request after a cold return is already small
			let tok = 0;
			for (const m of p.messages) tok += tok4(JSON.stringify(m?.content ?? "")) + 8;
			const sys = p.system;
			tok += typeof sys === "string" ? tok4(sys) : Array.isArray(sys) ? tok4(sys.map((x: Any) => x?.text ?? "").join("\n")) : 0;
			this.ledger({ type: "cold_wire", tokens: Math.round(tok), messages: p.messages.length, folds: this.runPlan && !this.runPlan.persisted ? this.runPlan.folds.length : 0, summary: !!this.runPlan?.cut, source: this.runPlan?.source ?? null });
		}
		if (this.off) return undefined; // strict no-op
		const r = repairPayload(p);
		if (!r) return undefined;
		this.ledger({ type: "guard_repair", repaired: r.repaired });
		return r.payload;
	}

	messageEnd(m: Any) {
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") this.lastReqMs = Date.now(); // the response is complete: the entry was refreshed when it finished
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
		const alive = pend.gapS >= GAP_EDGES[0] ? sample(pend.expect, cr, total, pend.edited, cw > 0 ? "explicit" : known) : null;
		if (pend.gapS >= GAP_EDGES[0]) this.ledger({ type: "cache_sample", gapS: Math.round(pend.gapS), expect: Math.round(pend.expect), cacheRead: cr, total, edited: pend.edited, alive });
		if (alive !== null || !known || (cw > 0 && known !== "explicit")) { // the file is touched only when there is something to learn
			this.ent = record(pend.key, { explicit: cw > 0, total, gapS: pend.gapS, alive });
			this.entKey = pend.key;
		}
		if (!pend.edited && this.prevKey === pend.key && this.prevTotal > 0 && total >= this.prevTotal) {
			const d = total - this.prevTotal;
			this.deltas = [...this.deltas.slice(-19), d];
			const sorted = [...this.deltas].sort((a, b) => a - b);
			this.g = 0.9 * this.g + 0.1 * Math.min(d, sorted[Math.ceil(0.9 * sorted.length) - 1]);
		}
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
		try {
			this.pi.appendEntry(STATE_CUSTOM, { off: this.off, quiet: this.quiet });
		} catch {}
	}
	status(): string {
		const state = this.off ? "off" : this.conflict ? `paused ("${this.conflict}" also manages context; only the request guard is on)` : "on";
		const key = modelKey(this.model), ttl = ttlFor(this.model), ent = loadStats().models[key];
		const pr = lawPrices(ent?.cls, ttl >= 3_600_000);
		const cache = !key ? "" : `\ncache ${key}: ${pr ? `${pr.cls} (from usage)` : "class unknown until the first response"}` +
			`, ${pr ? `read ${+pr.r.toFixed(4)} / write ${+pr.w.toFixed(4)} / output ${+pr.out.toFixed(4)} x input (class ratios)` : "no prices (legacy rule)"}` +
			`, ${describe(ent, ttl / 1000)}, growth ${(this.g / 1000).toFixed(1)}K/request`;
		return `${PRODUCT}: ${state}, cache TTL ${Math.round(ttl / 1000)} s, ${this.quiet ? "notices off, " : ""}folded ${this.stats.folds} output${this.stats.folds === 1 ? "" : "s"}, ${this.stats.summaries} summar${this.stats.summaries === 1 ? "y" : "ies"} (/zip stats for details)${cache}`;
	}
	statsLine = () => statsText(this.stats, this.model);
	setOff(off: boolean): string {
		this.off = off;
		if (off) { this.runPlan = null; this.runEdits = false; this.cancelTimer(); this.discardBg(); }
		this.persistState();
		return off ? `${PRODUCT}: off. Nothing is folded or summarised and requests are left untouched; earlier folds stay recallable (/zip on to resume)` : `${PRODUCT}: on`;
	}
	toggleQuiet(): string {
		this.quiet = !this.quiet;
		this.persistState();
		return `${PRODUCT}: per-turn notices ${this.quiet ? "off" : "on"} (folding continues)`;
	}
}
