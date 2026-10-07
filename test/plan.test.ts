import { describe, expect, test } from "bun:test";
import { applyPlanToMessages, buildBlocks, planContext, RELAX_PREV_TURN, summaryGainOk, type Cut, type PlanOpts, type RunPlan } from "../src/plan.ts";
import { A, AX, flat, R, U } from "./helpers.ts";

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
const buildBlocksEntries = () => [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];

test("buildBlocks flags our placeholders as ours and foreign edits as edited", () => {
	const e = R("r1", "c1");
	const folded = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "[folded by pi-zip · x]" }] }] };
	const foreign = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "someone else" }] }] };
	expect(buildBlocks([folded])[0]).toMatchObject({ edited: true, ours: true });
	expect(buildBlocks([foreign])[0]).toMatchObject({ edited: true, ours: false });
});
