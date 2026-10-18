import { afterEach, describe, expect, test } from "bun:test";
import { applyPlanToMessages, buildBlocks, compactionRoom, contentKeyOf, plan, planContext, settings, type Cut, type FoldTarget, type PlanOpts, type RunPlan } from "../src/plan.ts";
import { lawPrices } from "../src/learn.ts";
import { buildCut } from "../src/summary.ts";
import { mandatoryUserTokens } from "../src/user-text.ts";
import { A, AX, flat, longTurn, R, U, type Any } from "./helpers.ts";
import { validateEdits } from "../src/guard.ts";
const blockIdx = (blocks: { entryId: string | null }[], id: string) => blocks.findIndex((b) => b.entryId === id);

// a small working view: these sessions are a few thousand tokens, and below the working view nothing is planned
const opts = (over: Partial<PlanOpts> = {}): PlanOpts => ({ coldCap: 1000, cwd: process.cwd(), promptPending: true, ...over });
/** The law at P(warm) `p` with the explicit class ratios (the planner's default is P = 0). */
const at = (p: number, g = 2_500) => ({ pr: lawPrices("explicit", false), g, pWarm: p });
const foldIds = (p: { folds: FoldTarget[] } | null) => p?.folds.map((t) => t.entryId) ?? [];

// settle view of a finished run: 2 user turns, big outputs in both
const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];

describe("cold plan", () => {
	test("settle plan is non-empty once an older turn has big outputs; the newest turn's outputs stay protected", () => {
		const p = planContext(prevRun, opts());
		expect(p!.folds.map((t) => t.entryId)).toEqual(["r1"]);
	});

	test("a one-user-turn session plans nothing (that turn is protected once the prompt arrives)", () => {
		const one = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2")];
		expect(planContext(one, opts())).toBeNull();
		expect(planContext(one, opts({ promptPending: false }))).toBeNull();
	});
	test("below the working view nothing is planned, whatever P (one planner: P enters only the law)", () => {
		for (const p of [0, 0.3, 1]) expect(planContext(prevRun, opts({ coldCap: 60_000, law: at(p) }))).toBeNull();
		expect(foldIds(planContext(prevRun, opts({ law: at(0) })))).toEqual(["r1"]);
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
		expect(planContext(ctx, opts({ promptPending: false, recalled: new Set([handleFor("r1")]) }))).toBeNull();
		expect(h.recover).toBe("rereadable");
	});

	test("images are never folded", () => {
		const img = R("r1", "c1");
		(img.messages[0] as any).content = [{ type: "text", text: "y".repeat(9000) }, { type: "image", data: "x", mimeType: "image/png" }];
		const ctx = [U("u1", "one"), A("a1", ["c1"]), img, A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		expect(planContext(ctx, opts({ promptPending: false }))).toBeNull();
	});
});

describe("after a pause (previous user turn)", () => {
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "back")];
	test("no pause: the previous turn is protected, at any P", () => {
		for (const p of [0, 1]) expect(planContext(ctx, opts({ promptPending: false, law: at(p) }))).toBeNull();
	});
	test("after a pause: a rereadable previous-turn output folds while above the working view", () => {
		const p = planContext(ctx, opts({ promptPending: false, pause: true }))!;
		expect(p.folds.map((f) => f.trig)).toEqual(["cold(relax)"]);
	});
	test("after a pause but under the working view: nothing folds", () => {
		expect(planContext(ctx, opts({ coldCap: 60_000, promptPending: false, pause: true }))).toBeNull();
	});
	test("a pause never takes the latest user turn's own outputs, nor non-rereadable ones", () => {
		const own = [U("u1", "one"), A("a1"), U("u2", "back"), A("a2", ["c1"]), R("r1", "c1")];
		expect(planContext(own, opts({ promptPending: false, pause: true }))).toBeNull();
		const mutating = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "back")];
		(mutating[1].messages[0] as any).content[1].arguments = { command: "npm test" };
		expect(planContext(mutating, opts({ promptPending: false, pause: true }))).toBeNull();
	});
});

describe("summary gate", () => {
	test("prior non-user narrative plus new long request is priced against the actual buildCut", async () => {
		const previousUser = "initial";
		const previousText = "[summary of earlier conversation by pi-zip]\nCovers 4 earlier messages.\n## Narrative (model-written)\n" + "carry-forward-fact ".repeat(100) + "\n## User requests (available originals, oldest first; JSON strings decode to exact user messages)\n" + JSON.stringify({ messages: [previousUser], unavailableEarlier: 0 });
		const newUser = "retain-this-approval ".repeat(2200);
		const comp = { sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: previousText }] };
		const entries = [comp, U("u1", newUser), AX("a1", 160_000), U("u2", "second"), AX("a2", 160_000), U("u3", "current"), A("a3"), U("u4", "now")];
		const trace: NonNullable<PlanOpts["trace"]> = [];
		const q = plan(entries, opts({ coldCap: 5000, promptPending: false, trace }));
		const cut = q?.c;
		expect(cut?.cutIdx).not.toBeNull();
		const actual = await buildCut(cut!, { model: null } as Any);
		const mandatory = mandatoryUserTokens({ items: [previousUser], omitted: 0 }, [newUser, "second"]);
		expect(actual.summaryTokens).toBeGreaterThan(Math.max(8000, cut!.blocks[0].tokens, mandatory + 300));
		expect(cut!.summaryTokensPlanned).toBeGreaterThanOrEqual(mandatory + 300);
		expect(cut!.summaryTokensPlanned).toBeGreaterThanOrEqual(actual.summaryTokens);
	});
	test("legacy user section is not charged twice with its retained non-user narrative", () => {
		const oldRequest = "legacy-request ".repeat(1800);
		const previousText = `## User requests (verbatim, oldest first)\n1. ${oldRequest}\n## Narrative (model-written)\n${"retained-note ".repeat(120)}`;
		const nextRequest = "new-request ".repeat(1000);
		const comp = { sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: previousText }] };
		const entries = [comp, U("u1", nextRequest), AX("a1", 200_000), U("u2", "second"), AX("a2", 200_000), U("u3", "current"), A("a3"), U("u4", "now")];
		const cut = plan(entries, opts({ coldCap: 5000, promptPending: false }))?.c;
		expect(cut?.cutIdx).not.toBeNull();
		const mandatory = mandatoryUserTokens({ items: [oldRequest], omitted: 0 }, [nextRequest, "second"]);
		expect(cut!.summaryTokensPlanned).toBeGreaterThanOrEqual(mandatory + 300);
		expect(cut!.summaryTokensPlanned).toBeLessThan(cut!.blocks[0].tokens + mandatory);
	});

	test("legacy clipped summary is priced using active-branch user originals", () => {
		const original = "approval constraint ".repeat(3500);
		const head = "## User requests (verbatim, oldest first, continuation lines indented)\n1. ≈ clipped approval\n## Narrative\nold";
		const comp = { sourceEntry: { id: "cmp", type: "compaction", firstKeptEntryId: "tail" }, messages: [{ role: "compactionSummary", summary: head }] };
		const entries = [comp, U("tail", "kept"), AX("old", 90_000), U("u2", "second"), AX("more", 90_000), U("u3", "third"), A("last"), U("u4", "now")];
		const branch = [U("original", original).sourceEntry, { id: "cmp", type: "compaction", firstKeptEntryId: "tail" }, U("tail", "kept").sourceEntry];
		const trace: NonNullable<PlanOpts["trace"]> = [];
		plan(entries, opts({ coldCap: 3000, promptPending: false, branch, trace }));
		expect(trace.filter((t) => t.where === "summary").length).toBeGreaterThan(0);
		expect(trace.filter((t) => t.where === "summary").every((t) => t.A > original.length / 4)).toBe(true);
	});

	test("mandatory user text can exceed the summary cap and blocks a false saving", () => {
		const large = "approval constraint ".repeat(4000);
		const entries = [U("u1", large), AX("x1", 90_000), U("u2", large), AX("x2", 90_000), U("u3", "current"), A("a3"), U("u4", "now")];
		const trace: NonNullable<PlanOpts["trace"]> = [];
		const q = plan(entries, opts({ coldCap: 3000, promptPending: false, trace }));
		expect(q).not.toBeNull();
		if (q!.c) expect(q!.c.summaryTokensPlanned).toBeGreaterThan(large.length / 2);
		else expect(trace.filter((t) => t.where === "summary").every((t) => t.A > large.length / 2 || !t.ok)).toBe(true);
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
	test("successive warm summaries pay below the previous starting size without a regrowth budget", () => {
		const o = opts({ coldCap: 6000, promptPending: false, law: at(1, 500) });
		const first = planContext([...sumCtx, U("u4", "back")], o)!;
		const summary = "S".repeat(4 * first.summaryTokensPlanned);
		const comp = { sourceEntry: { type: "compaction", id: "cmp", details: { by: "pi-zip" } }, messages: [{ role: "compactionSummary", summary }] };
		const view = [comp, U("u3", "three"), AX("a5", 160_000), U("u4", "four"), A("a6"), U("u5", "five"), A("a7")];
		const second = planContext(view, o)!;
		expect(second.ctxAfterFolds).toBeLessThan(first.ctxAfterFolds);
		expect(second.firstKeptEntryId).toBe("u4");
		expect(second.prefixTokens).toBeGreaterThanOrEqual(2 * second.summaryTokensPlanned);
		// The new turn boundary makes fresh prose eligible; the protected turns and the carried summary still stay.
		expect(second.blocks[second.cutIdx!].userTurn).toBe(second.userTurns - 1);
	});
	test("the next summary is planned at least as big as the previous one it carries (no re-summary of a small new prefix)", () => {
		const SUM = "S".repeat(48_000); // previous summary ~12K tokens, as in a real migrated session
		const comp = { sourceEntry: { id: "cmp", type: "compaction", summary: SUM, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: SUM, content: SUM }] };
		const view = [comp, U("k1", "one"), A("a1", ["c1"]), R("r1", "c1", 14_000), AX("a2", 8_000), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		// prefix ~18K: a 1.8K planned summary would remove 16K; planned at >= 12K it removes ~6K, which does not pay for its call
		expect(planContext(view, opts({ coldCap: 6000, promptPending: false }))?.cutIdx ?? null).toBeNull();
	});
	test("no summary when it does not pay for its call (small context)", () => {
		const small = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 3000), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		expect(planContext(small, opts({ coldCap: 100, promptPending: false }))?.cutIdx ?? null).toBeNull();
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
		expect(foldIds(planContext(ctx, opts({ promptPending: false })))).not.toContain("r1");
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
		const p = planContext(prose, { cwd: ".", promptPending: false })!;
		expect(p.ctxTokens).toBeGreaterThan(40_000);
		expect(p.ctxTokens).toBeLessThan(60_000);
		expect(p.sumTrigger).toBe("cold");
		expect(planContext(prose, { cwd: ".", promptPending: false, coldCap: 60_000 })).toBeNull(); // below the working view: no plan at all
	});
});

// =============================================================================================================
describe("the law at P = 1 (a warm cache)", () => {
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
	const warm = (entries: Any[], contextWindow?: number) => planContext(entries, { law: at(1), cwd: ".", promptPending: false, model: contextWindow ? { provider: "p", id: "m", contextWindow } : undefined });

	test("planner: 183K -> 131K is blocked, 200K -> 90K fires (unknown window, V = 160K)", () => {
		const blocked = session(24, 512_000); // ~54K of foldable reads + a ~128K protected write
		const cold = planContext(blocked, { cwd: ".", promptPending: false, coldCap: 1000 })!;
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
		expect(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 0 }))).toBeNull();
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
		expect(planContext(s, opts({ coldCap: 1_000_000, promptPending: false }))).toBeNull();
		const settle = planContext(s, opts({ coldCap: 8000 }))!; // prompt pending: the finished turn is the previous one
		const run = planContext([...s, U("u2", "next")], opts({ coldCap: 8000, promptPending: false }))!;
		expect(ids(settle)).toEqual(ids(run));
		expect(settle.folds.map((f) => f.ph)).toEqual(run.folds.map((f) => f.ph));
	});

	test("recalled outputs and outputs below foldMin are never folded in-turn either", () => {
		const { handleFor } = require("../src/placeholder.ts");
		const s = longTurn(60);
		expect(foldIds(planContext(s, opts({ coldCap: 8000, promptPending: false, recalled: new Set([handleFor("r1")]) })))).not.toContain("r1");
		const small = longTurn(60, { chars: 400 });
		expect(planContext(small, opts({ coldCap: 100, promptPending: false }))).toBeNull();
	});

	test("warm valve: a long single-turn session above V folds old outputs when that halves the context", () => {
		const s = longTurn(60, { chars: 24_000 }); // ~4K tokens per output, ~240K estimated (V = 160K)
		const p = planContext(s, opts({ coldCap: 40_000, promptPending: false, law: at(1, 500), inturnAge: 20 }))!;
		expect(p).not.toBeNull();
		expect(p.folds.length).toBeGreaterThan(0);
		expect(p.folds.every((f) => f.trig === "valve(inturn)")).toBe(true);
		expect(p.ctxAfterFolds).toBeLessThanOrEqual(0.5 * p.ctxTokens);
		// ... and not when the age rule is off (nothing else is foldable in one turn)
		expect(planContext(s, opts({ coldCap: 40_000, promptPending: false, law: at(1, 500), inturnAge: 0 }))).toBeNull();
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

describe("native compaction: folds are planned on the resulting projection", () => {
	test("duplicate results are folded by their positions after the native summary", () => {
		const same = "same output line\n".repeat(600);
		const post = [{ sourceEntry: { id: "cmp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: "S", timestamp: 0 }] }, U("u2", "two"), A("a3", ["c9"]), R("r2", "c9", 0, same), A("a4", ["c9"]), R("r3", "c9", 0, same), U("u3", "three"), A("a6"), U("u4", "back")];
		const p = planContext(post, opts({ coldCap: 1000, promptPending: false, foldsOnly: true }))!;
		const folds = p.folds.filter((t) => t.entryId === "r3");
		expect(folds).toHaveLength(1);
		expect(folds[0].visIdx).toBe(5);
		const plan: RunPlan = { source: "settle", folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		const out = applyPlanToMessages(flat(post), plan)!;
		expect(out.applied).toEqual(new Set(["r3"]));
		expect(out.messages[5].content[0].text).toBe(folds[0].ph);
		expect(out.messages[3].content[0].text).toBe(same);
	});
});

// ---- item 5: a custom message that starts a run ends the protected tail like a user prompt ---------------------------------
describe("driven runs (an extension's triggerTurn message): turn boundaries", () => {
	const C = (id: string, text = "drive the owed work") => {
		const m = { role: "custom", customType: "owed-drive", content: text, display: true, timestamp: 1 };
		return { sourceEntry: { id, type: "custom_message" }, messages: [m] };
	};
	const turns = (entries: Any[]) => buildBlocks(entries).map((b) => b.userTurn);

	test("a custom message after a final answer starts a turn; one mid-run (after a tool result) does not; a prompt that follows its own starter is the same turn", () => {
		const e = [U("u1", "first"), A("a1", ["c1"]), R("r1", "c1", 400), A("a2"), C("k1"), A("a3", ["c2"]), R("r2", "c2", 400), C("k2"), A("a4"), C("k3"), U("u2", "typed"), A("a5")];
		// u1 a1 r1 a2 | k1 a3 r2 k2(mid-run: after a tool result) a4 | k3 u2 (one turn) a5
		expect(turns(e)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3]);
	});

	// review P0-2: Pi 1.1.0 stores the prompt FIRST and then the nextTurn / before_agent_start messages that ride with it
	// (agent-session.js prompt); a user message never cleared afterAnswer, so that custom message started a turn of its own: three prompts
	// counted as five turns, and "the current turn and the previous one" covered only the current prompt
	test("a prompt followed by the custom messages Pi stores after it is ONE turn (user then custom, as Pi 1.1.0 appends them)", () => {
		const e = [U("u1", "a"), A("a1"), U("u2", "b"), C("k2"), A("a2"), U("u3", "c"), C("k3"), C("k3b")];
		expect(turns(e)).toEqual([1, 1, 2, 2, 2, 3, 3, 3]); // old code: 1 1 2 3 3 4 5 5
		// a driven run's starter followed by another custom message (before_agent_start of a later prompt is not involved): one turn
		expect(turns([U("u1", "a"), A("a1"), C("k1"), C("k1b"), A("a2")])).toEqual([1, 1, 2, 2, 2]);
		// steering after a final answer (the run goes on) and a custom message after it: the same run
		expect(buildBlocks([U("u1", "a"), A("a1"), U("s1", "also"), C("k1"), A("a2")], new Set(["s1"])).map((b) => b.userTurn)).toEqual([1, 1, 1, 1, 1]);
	});

	// formal TR, round 4: a run that ended in a failed (refused) or aborted request is over; the run an extension's message starts next
	// is a new turn (old code: it joined the failed run's turn, which then stayed protected and kept a 20K output from folding)
	test("a custom message after a failed or aborted request starts a turn (the run ended there)", () => {
		const err = (id: string, stopReason: string) => {
			const message = { role: "assistant", content: [], stopReason, timestamp: 1 };
			return { sourceEntry: { id, type: "message", message }, messages: [message] };
		};
		expect(turns([U("u1", "a"), A("a1", ["c1"]), R("r1", "c1", 400), err("x1", "error"), C("k1"), A("a2")])).toEqual([1, 1, 1, 1, 2, 2]);
		expect(turns([U("u1", "a"), err("x1", "aborted"), C("k1"), A("a2")])).toEqual([1, 1, 2, 2]);
	});

	test("the protected tail with a nextTurn message after each prompt is still the current prompt and the previous one", () => {
		const e: Any[] = [];
		for (let i = 1; i <= 4; i++) e.push(U(`u${i}`, `p${i}`), C(`k${i}`), A(`a${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 20_000), AX(`e${i}`, 30_000));
		const p = planContext(e, { cwd: process.cwd(), coldCap: 3000, promptPending: false, law: at(0, 100) })!;
		// the latest two user turns are prompts 3 and 4: nothing of turn 3 may be cut (old code: turns 6..8 were 3's and 4's, so the
		// window covered only prompt 4 and its nextTurn message, and prompt 3's turn was summarised)
		expect(p.cutIdx).not.toBeNull();
		const firstKept = p.blocks[p.cutIdx!];
		expect(firstKept.userTurn).toBeLessThanOrEqual(3);
		const kept = p.blocks.slice(p.cutIdx!).map((b) => b.entryId);
		for (const id of ["u3", "k3", "a3", "r3", "e3", "u4", "k4"]) expect(kept).toContain(id);
	});

	// formal TR, round 4: a summary may keep from the custom message that started a run (Pi's own cut points include it); before, the
	// first kept block had to be a user or assistant message, so the kept tail in front of a driven run began at the previous turn's
	// final answer (29K of prose kept at a cold return)
	test("a summary before a driven run keeps from the custom message that started it, not from the previous final answer", () => {
		const e = [U("u1", "the one real prompt"), A("a1", ["c1"]), R("r1", "c1", 30_000), AX("a2", 60_000), C("k2"), AX("a3", 400)];
		const p = planContext(e, { cwd: process.cwd(), coldCap: 3000, promptPending: true, law: at(0, 100) })!;
		expect(p.cutIdx).not.toBeNull();
		expect(p.firstKeptEntryId).toBe("k2"); // old code: "a2" (the 60K answer stayed)
		expect(validateEdits(p.blocks, { folds: new Map(p.folds.map((f) => [blockIdx(p.blocks, f.entryId), f.ph])), recover: new Map(p.folds.map((f) => [blockIdx(p.blocks, f.entryId), f.recover])), cut: p.cutIdx }, p.userTurns)).toBeNull();
	});

	test("with no custom messages nothing changes (prompts count as before; steering stays in its turn)", () => {
		const e = [U("u1", "a"), A("a1"), U("u2", "b"), A("a2"), U("u3", "c")];
		expect(turns(e)).toEqual([1, 1, 2, 2, 3]);
		const steer = buildBlocks(e, new Set(["u3"])).map((b) => b.userTurn);
		expect(steer).toEqual([1, 1, 2, 2, 2]);
	});

	test("a driven run sequence keeps only the latest run protected: the user's old prompt and the runs after it are summarised, as at a prompt", () => {
		const old = [U("u1", "the one real prompt"), A("a1", ["c0"]), R("r0", "c0", 30_000), A("a2")];
		const driven: Any[] = [];
		for (let i = 1; i <= 6; i++) driven.push(C(`k${i}`), A(`d${i}`, [`x${i}`]), R(`rx${i}`, `x${i}`, 30_000), AX(`e${i}`, 60_000));
		const e = [...old, ...driven];
		const p = planContext(e, { cwd: process.cwd(), coldCap: 3000, promptPending: true })!;
		// the pending prompt is turn 8, the last run turn 7: only they are protected. Old code: every run belonged to turn 1 and the cut
		// could not pass the real prompt's turn (the protected tail reached back to it: 273K kept of 518K).
		expect(p.cutIdx).not.toBeNull();
		const kept = p.blocks.slice(p.cutIdx!).map((b) => b.entryId);
		expect(kept).toContain("k6");
		expect(kept).not.toContain("k5");
		expect(kept.length).toBeLessThan(p.blocks.length / 2);
	});
});
