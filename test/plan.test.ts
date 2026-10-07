import { describe, expect, test } from "bun:test";
import { applyPlanToMessages, buildBlocks, planContext, RELAX_PREV_TURN, summaryGainOk, type Cut, type PlanOpts, type RunPlan } from "../src/plan.ts";
import { A, AX, flat, R, U } from "./helpers.ts";

const opts = (over: Partial<PlanOpts> = {}): PlanOpts => ({ coldCap: 60_000, base: 0, cwd: process.cwd(), promptPending: true, ...over });

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
const buildBlocksEntries = () => [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];

test("buildBlocks flags our placeholders as ours and foreign edits as edited", () => {
	const e = R("r1", "c1");
	const folded = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "[folded by pi-zip · x]" }] }] };
	const foreign = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "someone else" }] }] };
	expect(buildBlocks([folded])[0]).toMatchObject({ edited: true, ours: true });
	expect(buildBlocks([foreign])[0]).toMatchObject({ edited: true, ours: false });
});
