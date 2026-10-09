import { afterEach, describe, expect, test } from "bun:test";
import { applyPlanToMessages, buildBlocks, compactionRoom, planContext, RELAX_PREV_TURN, settings, summaryGainOk, legacyValve, VALVE_MIN_REDUCTION, type Cut, type PlanOpts, type RunPlan } from "../src/plan.ts";
import { A, AX, flat, longTurn, R, U, type Any } from "./helpers.ts";

const opts = (over: Partial<PlanOpts> = {}): PlanOpts => ({ coldCap: 60_000, sys: 0, cwd: process.cwd(), promptPending: true, ...over });

// settle view of a finished run: 2 user turns, big outputs in both
const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];

describe("cold plan", () => {
	test("RELAX_PREV_TURN defaults to true", () => expect(RELAX_PREV_TURN).toBe(true));

	test("settle plan is non-empty once an older turn has big outputs; the newest turn's outputs stay protected", () => {
		const p = planContext(prevRun, opts());
		expect(p!.folds.map((t) => t.entryId)).toEqual(["r1"]);
	});

	test("a one-user-turn session plans nothing (that turn is protected once the prompt arrives)", () => {
		const one = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2")];
		expect(planContext(one, opts())!.folds).toHaveLength(0);
		expect(planContext(one, opts({ promptPending: false }))!.folds).toHaveLength(0);
	});

	test("run-start view (prompt in context) selects the identical set with byte-identical placeholders (F8)", () => {
		const settle = planContext(prevRun, opts())!;
		const run = planContext([...prevRun, U("u3", "back")], opts({ promptPending: false }))!;
		expect(run.folds.map((t) => t.entryId)).toEqual(settle.folds.map((t) => t.entryId));
		expect(run.folds[0].ph).toBe(settle.folds[0].ph);
		expect(run.folds[0].ph.length).toBeGreaterThan(100);
	});

	test("nothing below foldMin tokens and nothing recalled is folded (F4)", () => {
		const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 9000), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2", 300), A("a4"), U("u3", "three"), A("a5")];
		expect(planContext(ctx, opts({ promptPending: false }))!.folds.map((t) => t.entryId)).toEqual(["r1"]);
		const h = planContext(ctx, opts({ promptPending: false }))!.folds[0];
		const { handleFor } = require("../src/placeholder.ts");
		expect(planContext(ctx, opts({ promptPending: false, recalled: new Set([handleFor("r1")]) }))!.folds).toHaveLength(0);
		expect(h.recover).toBe("rereadable");
	});

	test("images are never folded", () => {
		const img = R("r1", "c1");
		(img.messages[0] as any).content = [{ type: "text", text: "y".repeat(9000) }, { type: "image", data: "x", mimeType: "image/png" }];
		const ctx = [U("u1", "one"), A("a1", ["c1"]), img, A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		expect(planContext(ctx, opts({ promptPending: false }))!.folds).toHaveLength(0);
	});
});

describe("relax (previous user turn)", () => {
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "back")];
	test("relax off: the previous turn is protected ", () => {
		expect(planContext(ctx, opts({ coldCap: 1000, promptPending: false, relax: false }))!.folds).toHaveLength(0);
	});
	test("relax on: a rereadable previous-turn output folds while above the cap", () => {
		const p = planContext(ctx, opts({ coldCap: 1000, promptPending: false, relax: true }))!;
		expect(p.folds.map((f) => f.trig)).toEqual(["cold(relax)"]);
	});
	test("relax is the default", () => {
		expect(planContext(ctx, opts({ coldCap: 1000, promptPending: false }))!.folds).toHaveLength(1);
	});
	test("relax on but under the cap: nothing folds", () => {
		expect(planContext(ctx, opts({ coldCap: 60_000, promptPending: false, relax: true }))!.folds).toHaveLength(0);
	});
	test("relax never takes the latest user turn's own outputs, nor non-rereadable ones", () => {
		const own = [U("u1", "one"), A("a1"), U("u2", "back"), A("a2", ["c1"]), R("r1", "c1")];
		expect(planContext(own, opts({ coldCap: 1000, promptPending: false, relax: true }))!.folds).toHaveLength(0);
		const mutating = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "back")];
		(mutating[1].messages[0] as any).content[1].arguments = { command: "npm test" };
		expect(planContext(mutating, opts({ coldCap: 1000, promptPending: false, relax: true }))!.folds).toHaveLength(0);
	});
});

describe("summary gain gate", () => {
	test("a ~3K summary of 180K is skipped; 60K of 180K is allowed; below 10K absolute is skipped", () => {
		expect(summaryGainOk(3_797, 1_240, 180_340)).toBe(false);
		expect(summaryGainOk(70_000, 7_000, 180_000)).toBe(true);
		expect(summaryGainOk(12_000, 3_000, 40_000)).toBe(false);
	});
	const sumCtx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5")];
	test("a big prefix plans the same cut in the settle and run-start views; folds before the cut are void", () => {
		const s = planContext(sumCtx, opts({ coldCap: 6000 }))!;
		const r = planContext([...sumCtx, U("u4", "back")], opts({ coldCap: 6000, promptPending: false }))!;
		expect(s.cutIdx).not.toBeNull();
		expect(s.firstKeptEntryId).toBe("u3");
		expect(r.firstKeptEntryId).toBe("u3");
		expect(s.prefixTokens).toBe(r.prefixTokens);
		expect(s.folds).toHaveLength(0);
	});
	test("one summary per warm stretch: noSummary blocks a second cut below the compaction room, not at it", () => {
		const view = [...sumCtx, U("u4", "back")];
		expect(planContext(view, opts({ coldCap: 6000, promptPending: false, mode: "warm" }))!.cutIdx).not.toBeNull();
		expect(planContext(view, opts({ coldCap: 6000, promptPending: false, mode: "warm", noSummary: true }))?.cutIdx ?? null).toBeNull();
		const tiny = { contextWindow: 60_000 }; // ~83K estimated context is above this room
		expect(planContext(view, opts({ coldCap: 6000, promptPending: false, mode: "warm", noSummary: true, model: tiny }))!.cutIdx).not.toBeNull();
	});
	test("the next summary is planned at least as big as the previous one it carries (no re-summary of a small new prefix)", () => {
		const SUM = "S".repeat(48_000); // previous summary ~12K tokens, as in a real migrated session
		const comp = { sourceEntry: { id: "cmp", type: "compaction", summary: SUM, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: SUM, content: SUM }] };
		const view = [comp, U("k1", "one"), A("a1", ["c1"]), R("r1", "c1", 14_000), AX("a2", 8_000), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		// legacy gate: prefix ~18K, a 1.8K planned summary would "gain" 16K; planned at >= 12K the gain is ~6K: no summary
		expect(planContext(view, opts({ coldCap: 6000, promptPending: false, relax: false }))!.cutIdx).toBeNull();
	});
	test("no summary when the gain gate fails (small context)", () => {
		const small = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 3000), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		expect(planContext(small, opts({ coldCap: 100, promptPending: false, relax: false }))!.cutIdx).toBeNull();
	});
});

describe("applyPlanToMessages", () => {
	const cold3 = [...prevRun, U("u3", "back after the idle")];
	const visible = flat(cold3);
	const base = () => {
		const p = planContext(cold3, opts({ promptPending: false }))!;
		const plan: RunPlan = { source: "runstart", folds: p.folds, cut: null, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds, ms: 0, persisted: false };
		return { p, plan };
	};
	test("folds with the plan's exact placeholder text and touches nothing else", () => {
		const { p, plan } = base();
		const out = applyPlanToMessages(visible, plan)!;
		const r1 = out.messages.find((m: any) => m.toolCallId === "c1");
		expect(r1.content).toEqual([{ type: "text", text: p.folds[0].ph }]);
		out.messages.forEach((m: any, i: number) => { if (m.toolCallId !== "c1") expect(m).toBe(visible[i]); });
	});
	test("a persisted plan, an empty plan, no plan, and an already-folded result all apply nothing", () => {
		const { plan } = base();
		expect(applyPlanToMessages(visible, { ...plan, persisted: true })).toBeNull();
		expect(applyPlanToMessages(visible, null)).toBeNull();
		expect(applyPlanToMessages(visible, { ...plan, folds: [] })).toBeNull();
		const folded = applyPlanToMessages(visible, plan)!.messages;
		expect(applyPlanToMessages(folded, plan)).toBeNull();
	});
	test("a shifted request view drops the cut (never an inconsistent split) but still folds", () => {
		const sumCtx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5"), U("u4", "back")];
		const p = planContext(sumCtx, opts({ coldCap: 6000, promptPending: false }))!;
		const cut: Cut = { firstKeptEntryId: "u3", text: "[summary] TEST", trigger: "cold", count: 2, prefixTokens: p.prefixTokens, summaryTokens: 100, llmOk: true, llmError: null, costUsd: 0, ms: 0 };
		const mk = (): RunPlan => ({ source: "settle", folds: [], cut: { ...cut }, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false, cutVisibleIdx: p.cutVisibleIdx, cutKeptFirstMsg: p.cutKeptFirstMsg });
		const vis = flat(sumCtx);
		const ok = applyPlanToMessages(vis, mk())!;
		expect(ok.messages[0].role).toBe("compactionSummary");
		expect(ok.messages[0].summary).toBe("[summary] TEST");
		expect(ok.messages).toHaveLength(vis.length - p.cutVisibleIdx + 1);
		const shiftedPlan = mk();
		shiftedPlan.folds = planContext(buildBlocksEntries(), opts({ promptPending: false }))!.folds;
		const shifted = applyPlanToMessages([{ role: "user", content: "steering" }, ...vis], shiftedPlan)!;
		expect(shifted.droppedCut).toBe(true);
		expect(shiftedPlan.cut).toBeNull();
	});
});
describe("recall results and reused tool call ids", () => {
	test("a zip_recall result is never folded (it is the content the model just asked for)", () => {
		const rec = R("r1", "c1");
		(rec.messages[0] as any).toolName = "zip_recall";
		(rec.sourceEntry.message as any).toolName = "zip_recall";
		const call = A("a1", ["c1"]);
		(call.messages[0] as any).content[1].name = "zip_recall";
		const ctx = [U("u1", "one"), call, rec, R("r2", "c2"), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		ctx.splice(3, 1, { ...R("r2", "c2"), messages: [{ ...R("r2", "c2").messages[0], toolCallId: "c2" }] });
		const folds = planContext(ctx, opts({ promptPending: false }))!.folds.map((t) => t.entryId);
		expect(folds).not.toContain("r1");
	});
	test("a server that reuses tool call ids (call_0): each result is folded by its own position and content", () => {
		const mk = (id: string, ch: string) => R(id, "call_0", 9000, `${ch} `.repeat(4500));
		const ctx = [U("u1", "one"), A("a1", ["call_0"]), mk("r1", "x"), A("a2"), U("u2", "two"), A("a3", ["call_0"]), mk("r2", "y"), A("a4"), U("u3", "three"), A("a5", ["call_0"]), mk("r3", "z"), A("a6"), U("u4", "four"), A("a7")];
		const p = planContext(ctx, opts({ promptPending: false }))!;
		expect(p.folds.map((t) => t.entryId)).toEqual(["r1", "r2"]);
		const plan: RunPlan = { source: "runstart", folds: p.folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		const out = applyPlanToMessages(flat(ctx), plan)!.messages.filter((m: any) => m.role === "toolResult");
		expect(out[0].content[0].text).toBe(p.folds[0].ph);
		expect(out[1].content[0].text).toBe(p.folds[1].ph);
		expect(out[2].content[0].text.startsWith("z z")).toBe(true); // the third result, same id, untouched
		// the request view shifted (steering message in front): position no longer matches, content still does
		const shifted = applyPlanToMessages([{ role: "user", content: "steering" }, ...flat(ctx)], plan)!.messages.filter((m: any) => m.role === "toolResult");
		expect(shifted[0].content[0].text).toBe(p.folds[0].ph);
		expect(shifted[1].content[0].text).toBe(p.folds[1].ph);
		expect(shifted[2].content[0].text.startsWith("z z")).toBe(true);
		// two identical results under one id and only one planned: ambiguity is never guessed (left unfolded)
		const dupe = [U("u1", "one"), A("a1", ["call_0"]), mk("r1", "x"), A("a2"), U("u2", "two"), A("a3", ["call_0"]), mk("r2", "x"), A("a4"), U("u3", "three"), A("a5"), U("u4", "four"), A("a6")];
		const pd = planContext(dupe, opts({ promptPending: false }))!;
		const onlyFirst: RunPlan = { source: "runstart", folds: [pd.folds[0]], cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		expect(applyPlanToMessages([{ role: "user", content: "steering" }, ...flat(dupe)], onlyFirst)).toBeNull(); // nothing applied
		const inPlace = applyPlanToMessages(flat(dupe), onlyFirst)!.messages.filter((m: any) => m.role === "toolResult"); // unshifted: position decides
		expect(inPlace[0].content[0].text).toBe(pd.folds[0].ph);
		expect(inPlace[1].content[0].text.startsWith("x x")).toBe(true);
	});
});
test("folds already saved in the old placeholder format stay byte-identical: they are never re-rendered", () => {
	const old = '[folded by pi-zip · bash ls · 9000 chars, 1 lines · handle abcdefghij]\nFull original is saved and stays recallable even after later summaries or compaction: call zip_recall("abcdefghij") to get it back exactly (optionally with grep or range). Do not guess its content.';
	const e = R("r1", "c1");
	const saved = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: old }] }] };
	const entries = [U("u1", "one"), A("a1", ["c1"]), saved, A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "three"), A("a5"), U("u4", "back")];
	const p = planContext(entries, opts({ promptPending: false }))!;
	expect(p.folds.map((t) => t.entryId)).toEqual(["r2"]); // the saved fold is not a candidate again
	expect(p.folds[0].ph).toContain("· turn 2 ·"); // new folds get the new format
	expect(applyPlanToMessages(flat(entries), { source: "runstart", folds: p.folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false })!.messages.find((m: Any) => m.toolCallId === "c1").content[0].text).toBe(old);
	expect(buildBlocks(entries)[2]).toMatchObject({ edited: true, ours: true });
});

const buildBlocksEntries = () => [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];

test("buildBlocks flags our placeholders as ours and foreign edits as edited", () => {
	const e = R("r1", "c1");
	const folded = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "[folded by pi-zip · x]" }] }] };
	const foreign = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "someone else" }] }] };
	expect(buildBlocks([folded])[0]).toMatchObject({ edited: true, ours: true });
	expect(buildBlocks([foreign])[0]).toMatchObject({ edited: true, ours: false });
});

// =============================================================================================================
describe("cold cap default", () => {
	const saved = process.env.PI_ZIP_COLD_CAP;
	afterEach(() => { if (saved === undefined) delete process.env.PI_ZIP_COLD_CAP; else process.env.PI_ZIP_COLD_CAP = saved; });

	test("40K real tokens by default; PI_ZIP_COLD_CAP still overrides", () => {
		delete process.env.PI_ZIP_COLD_CAP;
		expect(settings().coldCap).toBe(40_000);
		process.env.PI_ZIP_COLD_CAP = "25000";
		expect(settings().coldCap).toBe(25_000);
	});

	test("a ~45K context is over the default cap (it would have been under the old 60K)", () => {
		delete process.env.PI_ZIP_COLD_CAP;
		const prose = [U("u1", "one"), AX("x1", 90_000), U("u2", "two"), AX("x2", 90_000), U("u3", "three"), A("a3"), U("u4", "now")]; // ~45K tokens of prose
		const p = planContext(prose, { sys: 0, cwd: ".", promptPending: false })!;
		expect(p.ctxTokens).toBeGreaterThan(40_000);
		expect(p.ctxTokens).toBeLessThan(60_000);
		expect(p.sumTrigger).toBe("cold");
		expect(planContext(prose, { sys: 0, cwd: ".", promptPending: false, coldCap: 60_000 })!.sumTrigger).toBeNull();
	});
});

// =============================================================================================================
describe("warm valve gate (VALVE_MIN_REDUCTION)", () => {
	test("the rule is one pure function: fire only when after <= 0.5 x before", () => {
		expect(VALVE_MIN_REDUCTION).toBe(0.5);
		expect(legacyValve(183_000, 131_000, null)).toBe(false); // a 28% cut does not pay back the rewrite of a warm cache
		expect(legacyValve(200_000, 90_000, null)).toBe(true); // 55%
		expect(legacyValve(200_000, 100_000, null)).toBe(true); // exactly r = 0.5
		expect(legacyValve(200_000, 100_001, null)).toBe(false);
		expect(legacyValve(200_000, 200_000, null)).toBe(false); // nothing removed
		expect(legacyValve(200_000, 210_000, null)).toBe(false);
	});

	test("hard floor: at or above Pi's compaction room any reduction fires, nothing still does not", () => {
		const room = compactionRoom({ contextWindow: 200_000 })!; // 200000 - 16384 - 8192
		expect(room).toBe(175_424);
		expect(legacyValve(room, room - 1, room)).toBe(true);
		expect(legacyValve(180_000, 170_000, room)).toBe(true);
		expect(legacyValve(180_000, 180_000, room)).toBe(false);
		expect(legacyValve(room - 1, room - 10_000, room)).toBe(false); // just below the danger zone the ordinary rule applies
		expect(legacyValve(183_000, 131_000, null)).toBe(false); // unknown window: no floor
	});

	// old turns: `oldOutputs` foldable 9000-char reads; the previous user turn holds one `bigChars` write result that can never be folded
	// (not re-readable), so it stays and decides how much of the context a plan can remove
	const session = (oldOutputs: number, bigChars: number) => {
		const e: Any[] = [];
		for (let t = 0; t < oldOutputs; t++) e.push(U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9000), A(`z${t}`));
		const call = A("aw", ["cw"]);
		(call.messages[0] as Any).content[1].name = "write";
		const big = R("rw", "cw", bigChars);
		(big.messages[0] as Any).toolName = "write";
		e.push(U("uw", "write it"), call, big, A("zw"), U("uN", "now"));
		return e;
	};
	const warm = (entries: Any[], contextWindow?: number) => planContext(entries, { mode: "warm", sys: 0, cwd: ".", promptPending: false, model: contextWindow ? { provider: "p", id: "m", contextWindow } : undefined });

	test("planner: 183K -> 131K is blocked, 200K -> 90K fires (unknown window, V = 160K)", () => {
		const blocked = session(24, 512_000); // ~54K of foldable reads + a ~128K protected write
		const cold = planContext(blocked, { sys: 0, cwd: ".", promptPending: false, coldCap: 1000 })!;
		expect(cold.ctxTokens).toBeGreaterThan(180_000);
		expect(cold.ctxTokens).toBeLessThan(186_000);
		expect(cold.ctxAfterFolds).toBeGreaterThan(128_000);
		expect(cold.ctxAfterFolds).toBeLessThan(134_000);
		expect(warm(blocked)).toBeNull(); // above V, but the plan only cuts ~28%

		const allowed = session(49, 352_000); // ~110K of foldable reads + a ~88K protected write
		const p = warm(allowed)!;
		expect(p).not.toBeNull();
		expect(p.ctxTokens).toBeGreaterThan(195_000);
		expect(p.ctxAfterFolds).toBeLessThan(0.5 * p.ctxTokens);
		expect(p.folds.length).toBe(49);
	});

	test("planner: inside the danger zone (window 200K) a 15% cut still fires; the same context at a 1M window is blocked", () => {
		const entries = session(13, 600_000); // ~29K of foldable reads + a 150K protected write: ~180K, above room 175,424
		const p = warm(entries, 200_000)!;
		expect(p).not.toBeNull();
		expect(p.ctxTokens).toBeGreaterThanOrEqual(compactionRoom({ contextWindow: 200_000 })!);
		expect(p.ctxAfterFolds).toBeGreaterThan(0.5 * p.ctxTokens); // small reduction: the ordinary rule would block it
		expect(p.folds.length).toBe(13);
		expect(warm(entries, 1_000_000)).toBeNull(); // V = 160K is passed, but nothing makes the cut worth a rewrite
	});

	test("planner: in the danger zone with nothing to remove the valve has nothing to do", () => {
		const entries = [U("u0", "q"), A("a0", ["cw"]), R("rw", "cw", 720_000), A("z0"), U("uN", "now")];
		(entries[1].messages[0] as Any).content[1].name = "write";
		(entries[2].messages[0] as Any).toolName = "write";
		expect(warm(entries, 200_000)).toBeNull();
	});
});

describe("in-turn folds (PI_ZIP_INTURN_AGE)", () => {
	const saved = process.env.PI_ZIP_INTURN_AGE;
	afterEach(() => { if (saved === undefined) delete process.env.PI_ZIP_INTURN_AGE; else process.env.PI_ZIP_INTURN_AGE = saved; });
	const ids = (p: Any) => p.folds.map((f: Any) => f.entryId).sort();
	const rr = (from: number, to: number, skip: number[] = []) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`).filter((x) => !skip.includes(Number(x.slice(1)))).sort();

	test("default 60, 0 disables; the setting reads PI_ZIP_INTURN_AGE", () => {
		delete process.env.PI_ZIP_INTURN_AGE;
		expect(settings().inturnAge).toBe(60);
		process.env.PI_ZIP_INTURN_AGE = "0";
		expect(settings().inturnAge).toBe(0);
		process.env.PI_ZIP_INTURN_AGE = "35";
		expect(settings().inturnAge).toBe(35);
	});

	test("a single user turn: outputs of every class at least 20 requests old fold; newer and zip_recall results stay", () => {
		delete process.env.PI_ZIP_INTURN_AGE;
		const s = longTurn(60, { mutating: [3, 10, 50], recalls: [7] });
		const p = planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 20 }))!;
		// 61 assistant messages: call i is answered i requests in, so its age is 61 - i; age >= 20  <=>  i <= 41
		expect(ids(p)).toEqual(rr(1, 41, [7])); // the non-rereadable r3 and r10 fold too (final model: one age for every class)
		expect(p.folds.every((f) => f.trig === "cold(inturn)")).toBe(true);
		expect(p.folds.filter((f) => f.recover !== "rereadable").map((f) => f.entryId).sort()).toEqual(["r10", "r3"]);
		expect(p.cutIdx).toBeNull(); // the whole session is the protected turn: nothing to summarise
		expect(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 0 }))!.folds).toHaveLength(0);
	});

	test("the boundary is exact: age 20 folds, age 19 stays; a larger setting moves it", () => {
		const s = longTurn(60);
		expect(ids(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 20 }))!)).toEqual(rr(1, 41));
		expect(ids(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 40 }))!)).toEqual(rr(1, 21));
		process.env.PI_ZIP_INTURN_AGE = "30";
		expect(ids(planContext(s, opts({ coldCap: 8000, promptPending: false }))!)).toEqual(rr(1, 31));
	});

	test("folds stop at the cap, biggest first (same order as the sim)", () => {
		const s = longTurn(60);
		// make r5 and r9 much bigger than the rest
		for (const id of ["r5", "r9"]) { const e = s.find((x: Any) => x.sourceEntry.id === id)!; e.messages[0].content[0].text = e.messages[0].content[0].text.repeat(4); }
		const total = buildBlocks(s).reduce((a, b) => a + b.tokens, 0);
		const p = planContext(s, opts({ coldCap: total - 3000, promptPending: false, inturnAge: 20 }))!; // needs ~3K tokens: the two big ones are enough
		expect(ids(p)).toEqual(["r5", "r9"]);
	});

	test("under the cap nothing folds; the settle view and the run-start view agree", () => {
		const s = longTurn(60);
		expect(planContext(s, opts({ coldCap: 1_000_000, promptPending: false }))!.folds).toHaveLength(0);
		const settle = planContext(s, opts({ coldCap: 8000 }))!; // prompt pending: the finished turn is the previous one
		const run = planContext([...s, U("u2", "next")], opts({ coldCap: 8000, promptPending: false }))!;
		expect(ids(settle)).toEqual(ids(run));
		expect(settle.folds.map((f) => f.ph)).toEqual(run.folds.map((f) => f.ph));
	});

	test("recalled outputs and outputs below foldMin are never folded in-turn either", () => {
		const { handleFor } = require("../src/placeholder.ts");
		const s = longTurn(60);
		const p = planContext(s, opts({ coldCap: 8000, promptPending: false, recalled: new Set([handleFor("r1")]) }))!;
		expect(ids(p)).not.toContain("r1");
		const small = longTurn(60, { chars: 400 });
		expect(planContext(small, opts({ coldCap: 100, promptPending: false }))!.folds).toHaveLength(0);
	});

	test("warm valve: a long single-turn session above V folds old outputs when that halves the context", () => {
		const s = longTurn(60, { chars: 24_000 }); // ~4K tokens per output, ~240K estimated (V = 160K)
		const p = planContext(s, opts({ coldCap: 40_000, promptPending: false, mode: "warm", inturnAge: 20 }))!;
		expect(p).not.toBeNull();
		expect(p.folds.length).toBeGreaterThan(0);
		expect(p.folds.every((f) => f.trig === "valve(inturn)")).toBe(true);
		expect(p.ctxAfterFolds).toBeLessThanOrEqual(0.5 * p.ctxTokens);
		// ... and not when the age rule is off (nothing else is foldable in one turn)
		expect(planContext(s, opts({ coldCap: 40_000, promptPending: false, mode: "warm", inturnAge: 0 }))).toBeNull();
	});

	test("a tool call id reused by the server counts its age from the latest call that used it", () => {
		const s = longTurn(30);
		// results r1 and r30 both answer "call_0"; r1's age must come from the assistant right before it
		for (const id of ["a1", "a30"]) (s.find((x: Any) => x.sourceEntry.id === id)!.messages[0].content[1] as Any).id = "call_0";
		for (const id of ["r1", "r30"]) s.find((x: Any) => x.sourceEntry.id === id)!.messages[0].toolCallId = "call_0";
		const b = buildBlocks(s);
		const age = (id: string) => b.find((x) => x.entryId === id)!.age;
		expect(age("r30")).toBe(1);
		expect(age("r1")).toBe(30);
	});
});

describe("age counts only assistant messages the model is sent", () => {
	test("aborted and final-error assistant messages add no age; the calls they issued still count as issued", () => {
		const mk = (stop: string) => {
			const bad = A("bad", ["c2"]);
			Object.assign(bad.sourceEntry.message, { stopReason: stop });
			Object.assign(bad.messages[0], { stopReason: stop });
			return [U("u1", "go"), A("a1", ["c1"]), R("r1", "c1"), bad, R("r2", "c2"), A("a3"), A("a4")];
		};
		const ageOf = (stop: string) => { const bl = buildBlocks(mk(stop)); return [bl.find((b: Any) => b.entryId === "r1")!.age, bl.find((b: Any) => b.entryId === "r2")!.age]; };
		expect(ageOf("stop")).toEqual([3, 2]);
		expect(ageOf("aborted")).toEqual([2, 2]);
		expect(ageOf("error")).toEqual([2, 2]);
	});
});
