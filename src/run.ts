// The per-session state machine behind index.ts: cold detection, the run plan (F8), persistence at turn_end, settle preparation (F12).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectCold, ttlFor } from "./cache.ts";
import { validateEdits, repairPayload } from "./guard.ts";
import { Stats, noticeText, statsText, type NoticeAction, type ZipControl } from "./notice.ts";
import { applyPlanToMessages, buildBlocks, planContext, type Block, type Cut, type FoldTarget, type PlanOpts, type RunPlan } from "./plan.ts";
import { handleFor } from "./placeholder.ts";
import { recalledHandlesFromBranch } from "./recall.ts";
import { buildCut } from "./summary.ts";
import { type Any, PRODUCT, clamp, tok4 } from "./util.ts";

export const PLAN_CUSTOM = "pi-zip/plan";
export const STATE_CUSTOM = "pi-zip/state";
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

interface Bg {
	key: string | null;
	done: Cut | null;
	promise: Promise<Cut | null>;
}

export class Zip implements ZipControl {
	off = false;
	quiet = false;
	conflict: string | null = null;
	readonly stats = new Stats();
	readonly recalled = new Set<string>();
	private cold = false;
	private coldDone = true;
	private coldReason = "";
	private base = 0;
	private lastReqMs = 0;
	private settlePlan: Any = null;
	private runPlan: RunPlan | null = null;
	private runPlanned = false;
	private bg: Bg | null = null;
	private bgWaitMs = 0;
	private wireLedgered = false;
	private model: Any;
	private conflictNoticed = false;

	constructor(private pi: ExtensionAPI) {}

	active = () => !this.off && !this.conflict;

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

	private opts(ctx: Any, pending: boolean, mode: "cold" | "hot"): PlanOpts {
		return { mode, base: this.base || tok4(ctx.getSystemPrompt?.() ?? "") + 1500, cwd: (ctx?.cwd as string) ?? process.cwd(), recalled: this.recalled, model: ctx?.model, promptPending: pending };
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
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		this.model = ctx?.model;
		this.detectConflict(ctx);
		this.ledger({ type: "session_start", off: this.off, quiet: this.quiet, conflict: this.conflict });
	}

	beforeAgentStart(ctx: Any) {
		this.model = ctx?.model;
		this.cold = false;
		this.coldDone = true;
		this.runPlan = null;
		this.runPlanned = false;
		this.settlePlan = null;
		this.bgWaitMs = 0;
		this.wireLedgered = false;
		if (!this.active()) return;
		this.detectConflict(ctx);
		if (!this.active()) return;
		const branch = this.branch(ctx);
		const { cold, reason } = detectCold(ctx.model, this.lastReqMs, branch);
		this.cold = cold;
		this.coldDone = !cold;
		this.coldReason = reason;
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		if (!cold) this.discardBg();
		if (cold) {
			for (let i = branch.length - 1; i >= 0; i--) {
				const en = branch[i];
				if (en?.type !== "custom" || en.customType !== PLAN_CUSTOM) continue;
				if (en.data?.policy === PRODUCT) this.settlePlan = en.data;
				break;
			}
			if (this.settlePlan?.baseTokens && !this.base) this.base = this.settlePlan.baseTokens; // same ctx math at settle and at return
		}
		this.ledger({ type: "prompt", cold, reason, settleTargets: this.settlePlan?.targets?.length ?? 0 });
	}

	/** A background summary nobody adopted still cost money: book it. */
	private discardBg() {
		const b = this.bg;
		this.bg = null;
		b?.promise.then((c) => { if (c) this.stats.summaryUsd += c.costUsd; });
	}

	async context(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		if (!this.runPlanned && this.cold && !this.coldDone) {
			this.runPlanned = true;
			try {
				await this.computeRunPlan(ctx);
			} catch (err) {
				this.ledger({ type: "error", where: "context/run_plan", error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
			}
		}
		if (this.runPlan && !this.runPlan.persisted) {
			const out = applyPlanToMessages(e.messages, this.runPlan);
			if (out) return { messages: out.messages };
		}
		return undefined;
	}

	/** ONE plan per cold run: computed at the first request (the new prompt is in the session), applied to every request until turn_end persists the same set. */
	private async computeRunPlan(ctx: Any) {
		const t0 = performance.now();
		const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		const p = planContext(entries, this.opts(ctx, false, "cold"));
		let folds: FoldTarget[] = p?.folds ?? [];
		let cut: Cut | null = null;
		let source: RunPlan["source"] = "runstart";
		const settleFolds: FoldTarget[] = Array.isArray(this.settlePlan?.targets) ? this.settlePlan.targets : [];
		const sameSet = settleFolds.length === folds.length && settleFolds.every((t) => folds.some((u) => u.entryId === t.entryId));
		let adopted = false;
		if (this.settlePlan && sameSet) {
			let settleCut: Cut | null = this.settlePlan.summary ?? null;
			if (!settleCut && this.bg && p && p.cutIdx !== null && this.bg.key === p.firstKeptEntryId) {
				const w0 = performance.now();
				settleCut = this.bg.done ?? (await this.bg.promise); // usually ready; else wait only for the remainder
				this.bgWaitMs = performance.now() - w0;
				adopted = !!settleCut;
			}
			if (settleCut && p && p.cutIdx !== null && settleCut.firstKeptEntryId === p.firstKeptEntryId) {
				source = "settle"; // adopt the prepared summary and the settle view's byte-identical placeholders
				folds = settleFolds;
				cut = settleCut;
			} else if (!settleCut && p?.cutIdx === null) {
				source = "settle";
				folds = settleFolds;
			}
		}
		if (this.bg && !adopted) this.discardBg();
		const foldMs = performance.now() - t0;
		if (!cut && p && p.cutIdx !== null) cut = await buildCut(p, ctx); // produced now, before the first request: the user waits
		// a plan that cannot be persisted must never be sent: the request view would differ from what turn_end can write (I1)
		let invalid: string | null = null;
		if (p) {
			invalid = checkEdits(p.blocks, p.userTurns, folds, cut);
			if (invalid && cut) {
				cut = null;
				const again = checkEdits(p.blocks, p.userTurns, folds, null);
				if (again) { folds = []; cut = null; }
			}
			if (invalid) this.ledger({ type: "guard_drop", where: "run_plan", reason: invalid, folds: folds.length });
		}
		const ctxAfter = cut ? (p?.ctxAfterFolds ?? 0) - (cut.prefixTokens - cut.summaryTokens) : (p?.ctxAfterFolds ?? 0);
		this.runPlan = { source, folds, cut, ctxBefore: p?.ctxTokens ?? 0, ctxAfter, ms: foldMs, persisted: false, cutVisibleIdx: p?.cutVisibleIdx ?? -1, cutKeptFirstMsg: p?.cutKeptFirstMsg };
		this.ledger({ type: "cold_plan", source, folds: folds.length, summary: !!cut, ctxBefore: Math.round(this.runPlan.ctxBefore), ctxAfter: Math.round(ctxAfter), ms: Math.round(foldMs), ...(cut ? { summaryMs: cut.ms, llmOk: cut.llmOk, waitedMs: Math.round(source === "settle" ? this.bgWaitMs : cut.ms) } : {}) });
	}

	/** Prepare the next cold return while the user is away: pure computation, and (interactive) the summary in the background. */
	async settle(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		try {
			const t0 = performance.now();
			const p = planContext(e.context.contextEntries, this.opts(ctx, true, "cold"));
			if (!p) return undefined;
			this.discardBg();
			let summary: Cut | null = null;
			if (p.cutIdx !== null) {
				if (ctx.hasUI) {
					// never hold the turn open for a model call: build in the background; the next cold run adopts it, a warm return discards it
					const bg: Bg = { key: p.firstKeptEntryId, done: null, promise: Promise.resolve(null) };
					bg.promise = buildCut(p, ctx).then((c) => ((bg.done = c), c)).catch((err) => {
						this.ledger({ type: "error", where: "settle/bg_summary", error: err instanceof Error ? err.message : String(err) });
						return null;
					});
					this.bg = bg;
				} else {
					summary = await buildCut(p, ctx); // print/json mode exits right after settle: a background call would be lost
				}
			}
			this.ledger({ type: "settle_plan", folds: p.folds.length, summary: !!summary, background: !!this.bg, ctxBefore: Math.round(p.ctxTokens), ms: Math.round(performance.now() - t0) });
			if (!p.folds.length && !summary && !this.bg) return undefined;
			const data = { policy: PRODUCT, ts: Date.now(), baseTokens: Math.round(this.base || p.ctxTokens - p.blocks.reduce((a, b) => a + b.tokens, 0)), targets: p.folds, summary };
			return { entries: [...e.entries, { type: "custom", customType: PLAN_CUSTOM, data }] };
		} catch (err) {
			this.ledger({ type: "error", where: "settle", error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
			return undefined; // never break the session
		}
	}

	async turnEnd(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		try {
			return await this.onTurnEnd(e, ctx);
		} catch (err) {
			this.ledger({ type: "error", where: "turn_end", error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
			return undefined;
		}
	}

	private async onTurnEnd(e: Any, ctx: Any) {
		const msg: Any = e.message;
		if (msg?.stopReason === "error" || msg?.stopReason === "aborted") return undefined;
		const t0 = performance.now();
		const blocks = buildBlocks(e.context.contextEntries);
		if (!blocks.length) return undefined;
		const userTurns = blocks.filter((b) => b.kind === "user").length;
		// calibrate the base overhead from the real usage of the request that produced this assistant message
		const ai = blocks.findIndex((b) => b.entryId === e.messageEntryId);
		const u = msg?.usage;
		const usageTotal = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
		if (ai >= 0 && usageTotal > 0) this.base = clamp(usageTotal - blocks.slice(0, ai).reduce((a, b) => a + b.tokens, 0), 0, 40_000);
		else if (!this.base) this.base = tok4(ctx.getSystemPrompt?.() ?? "") + 1500;
		const ctxTokens = this.base + blocks.reduce((a, b) => a + b.tokens, 0);
		const o = { t0, blocks, userTurns, ctxTokens, usageTotal };
		if (this.cold && !this.coldDone) {
			// the run has carried its plan since the first request: persist EXACTLY it, so request N+1's prefix equals this run's
			if (!this.runPlan) {
				const p = planContext(e.context.contextEntries, this.opts(ctx, false, "cold")); // defensive: a continuation path skipped the context event
				this.runPlan = { source: "runstart", folds: p?.folds ?? [], cut: null, ctxBefore: p?.ctxTokens ?? ctxTokens, ctxAfter: p?.ctxAfterFolds ?? ctxTokens, ms: 0, persisted: false };
			}
			this.coldDone = true;
			return this.commit(e, ctx, this.runPlan, o);
		}
		// warm cache: nothing, unless the window is nearly full (I6)
		const p = planContext(e.context.contextEntries, this.opts(ctx, false, "hot"));
		if (!p || (!p.folds.length && p.cutIdx === null)) return undefined;
		const cut = p.cutIdx !== null ? await buildCut(p, ctx) : null; // emergency only: the alternative is Pi's lossy compaction
		const plan: RunPlan = { source: "pressure", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds, ms: performance.now() - t0, persisted: false };
		return this.commit(e, ctx, plan, o);
	}

	private commit(e: Any, ctx: Any, plan: RunPlan, o: { t0: number; blocks: Block[]; userTurns: number; ctxTokens: number; usageTotal: number }) {
		plan.persisted = true;
		const byId = new Map(o.blocks.map((b) => [b.entryId, b]));
		const live = plan.folds.filter((t) => byId.has(t.entryId));
		const stale = plan.folds.length - live.length; // e.g. Pi auto-compaction removed them from the projection
		const cut = plan.cut && byId.has(plan.cut.firstKeptEntryId) ? plan.cut : null;
		if (!live.length && !cut) {
			this.ledger({ type: "cold_noop", turnIndex: e.turnIndex, ctx: o.ctxTokens, ...(stale ? { staleTargets: stale } : {}) });
			return undefined;
		}
		const bad = checkEdits(o.blocks, o.userTurns, live, cut);
		if (bad) {
			this.ledger({ type: "guard_drop", turnIndex: e.turnIndex, reason: bad, folds: live.length, source: plan.source });
			plan.persisted = false; // keep the request-local view: never switch the fold set mid-run
			return undefined;
		}
		const ours: Any[] = live.map((t) => ({ type: "context_edit", targetId: t.entryId, replacement: { content: [{ type: "text", text: t.ph }] } }));
		if (cut) ours.push({ type: "compaction", summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, details: { by: PRODUCT, trigger: cut.trigger }, usage: cut.usage });
		const before = live.reduce((a, t) => a + t.entryTokens, 0);
		const after = live.reduce((a, t) => a + t.phTokens, 0);
		const cutSaved = cut ? cut.prefixTokens - cut.summaryTokens : 0;
		const waitMs = cut ? (plan.source === "settle" ? this.bgWaitMs : cut.ms) : 0;
		const s = this.stats;
		s.folds += live.length;
		s.foldedTokens += before - after;
		s.activeSaved += before - after + cutSaved;
		if (plan.source === "pressure") {
			s.pressureEdits++;
			s.pressureRewriteTokens += o.ctxTokens;
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
			entryTokensBefore: before, entryTokensAfter: after, ctxBefore: o.ctxTokens, ctxAfter: o.ctxTokens - (before - after) - cutSaved, usageTotal: o.usageTotal,
			coldReason: this.coldReason, prepared: plan.source === "settle", ...(stale ? { staleTargets: stale } : {}),
		});
		if (cut) this.ledger({ type: "summary", trigger: cut.trigger, source: plan.source, count: cut.count, prefixTokens: cut.prefixTokens, summaryTokens: cut.summaryTokens, ms: cut.ms, waitedMs: Math.round(waitMs), llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd });
		const pressure = plan.source === "pressure";
		const notices: NoticeAction[] = [];
		if (live.length) notices.push({ kind: "fold", count: live.length, tokensBefore: o.ctxTokens, tokensAfter: o.ctxTokens - (before - after), ms: plan.ms + (performance.now() - o.t0), pressure });
		if (cut) {
			const prepared = plan.source === "settle" && waitMs < 500; // finished while the user was away: report the real production time, not the zero wait
			notices.push({ kind: "summary", count: cut.count, tokensBefore: o.ctxTokens - (before - after), tokensAfter: o.ctxTokens - (before - after) - cutSaved, ms: prepared ? cut.ms : waitMs, prepared, pressure });
		}
		if (notices.length && !this.quiet) this.notify(ctx, noticeText(notices));
		return { entries: [...e.entries, ...ours] }; // append, never overwrite other extensions' drafts
	}

	providerRequest(e: Any): Any {
		this.lastReqMs = Date.now(); // the real-time cache clock
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
		const u = m?.usage;
		if (m?.role === "assistant" && u) this.ledger({ type: "usage", stop: m.stopReason, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output });
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
		return `${PRODUCT}: ${state}, cache TTL ${Math.round(ttlFor(this.model) / 1000)} s, ${this.quiet ? "notices off, " : ""}folded ${this.stats.folds} output${this.stats.folds === 1 ? "" : "s"}, ${this.stats.summaries} summar${this.stats.summaries === 1 ? "y" : "ies"} (/zip stats for details)`;
	}
	statsLine = () => statsText(this.stats, this.model);
	setOff(off: boolean): string {
		this.off = off;
		if (off) { this.runPlan = null; this.discardBg(); }
		this.persistState();
		return off ? `${PRODUCT}: off. Nothing is folded or summarised and requests are left untouched; earlier folds stay recallable (/zip on to resume)` : `${PRODUCT}: on`;
	}
	toggleQuiet(): string {
		this.quiet = !this.quiet;
		this.persistState();
		return `${PRODUCT}: per-turn notices ${this.quiet ? "off" : "on"} (folding continues)`;
	}
}

