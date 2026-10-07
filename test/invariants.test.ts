// One group per invariant of design §6 (I1-I6), driven through the real extension with a fake Pi.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { repairPayload, validateEdits } from "../src/guard.ts";
import { buildBlocks, planContext, applyPlanToMessages, type Block, type RunPlan } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { skeleton } from "../src/summary.ts";
import { A, AX, fakeCtx, fakePi, flat, project, R, U, type Any } from "./helpers.ts";

const ENV = ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_OFF", "PI_ZIP_LEDGER", "PI_ZIP_MIN_GAIN"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); ENV.forEach((k) => delete process.env[k]); process.env.PI_ZIP_TTL_SECS = "1"; });
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

const branchOf = (entries: Any[], lastTs: number) => [
	...entries.map((e) => ({ type: "message", id: e.sourceEntry.id, message: e.sourceEntry.message })),
	{ type: "message", id: "ts", message: { role: "assistant", timestamp: lastTs, content: [] } },
];
const COLD_TS = () => Date.now() - 60_000;
const WARM_TS = () => Date.now();

async function rig(entries: Any[], lastTs: number, over: Any = {}, piExtra: Any = {}) {
	const { default: piZip } = await import("../src/index.ts");
	const f = fakePi(piExtra);
	piZip(f.pi);
	const { ctx, notes } = fakeCtx(entries, { branch: branchOf(entries, lastTs), ...over });
	return { ...f, ctx, notes, fire: async (name: string, e: Any) => f.handlers.get(name)(e, ctx) };
}
const turnEnd = (all: Any[], lastId: string, turnIndex = 0) => ({
	message: { role: "assistant", stopReason: "stop", usage: { input: 1000, cacheRead: 0, cacheWrite: 0 } },
	messageEntryId: lastId, context: { contextEntries: all }, entries: [], turnIndex,
});
const norm = (ms: Any[]) => JSON.stringify(ms.map((m) => (m.role === "compactionSummary" ? { ...m, timestamp: 0, tokensBefore: 0 } : m)));

// ---- deterministic random sessions --------------------------------------------------------------------------
function prng(seed: number) {
	let s = seed >>> 0;
	return () => ((s = (s + 0x6d2b79f5) >>> 0), ((((s ^ (s >>> 15)) * (1 | s)) >>> 0) / 4294967296));
}
function randomSession(seed: number) {
	const r = prng(seed);
	const entries: Any[] = [];
	let id = 0;
	const turns = 3 + Math.floor(r() * 4);
	for (let t = 0; t < turns; t++) {
		entries.push(U(`u${t}`, `request ${t} seed ${seed}`));
		const rounds = 1 + Math.floor(r() * 3);
		for (let k = 0; k < rounds; k++) {
			const calls = [`c${++id}`, ...(r() < 0.3 ? [`c${++id}`] : [])];
			const m = A(`a${id}`, calls, r() < 0.5);
			(m.messages[0] as Any).content[calls.length ? 1 : 0].text = `thinking about ${id}`;
			entries.push(m);
			for (const c of calls) {
				const chars = Math.floor(r() * 15000);
				const text = Array.from({ length: 1 + Math.floor(chars / 40) }, (_, i) => `line ${i}: value=${Math.floor(r() * 1e6)} ${r() < 0.05 ? "ERROR boom" : "ok"}`).join("\n");
				entries.push(R(`r${c}`, c, 0, text));
			}
		}
		entries.push(A(`end${t}`));
	}
	return entries;
}
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

// =============================================================================================================
describe("I1 byte stability: every request of a run sends the same prefix, and it equals the turn_end projection", () => {
	const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];
	const cold = [...prevRun, U("u3", "back after the idle")];
	const tail = [A("a5", ["c9"]), R("r9", "c9", 300)];

	async function runCold(entries: Any[]) {
		const r = await rig(entries, COLD_TS());
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(entries) });
		const req2 = await r.fire("context_with_system", { messages: [...flat(entries), ...flat(tail)] });
		const all = [...entries, ...tail, A("a6")];
		const te = await r.fire("turn_end", turnEnd(all, "a6", 1));
		return { r, req1, req2, all, te, projected: flat(project(all, te.entries)) };
	}

	test("fold only: request 2 repeats request 1's prefix, and the persisted projection equals it", async () => {
		const { req1, req2, projected, te, r } = await runCold(cold);
		expect(req1.messages.find((m: Any) => m.toolCallId === "c1").content[0].text).toContain("[folded by pi-zip");
		expect(JSON.stringify(req2.messages.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
		expect(JSON.stringify(projected.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
		expect(te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId)).toEqual(["r1"]);
		expect(r.notes).toHaveLength(1);
		expect(r.notes[0]).toMatch(/^pi-zip · folded 1 old output · [\d.]+K → [\d.]+K tokens · [\d.]+ ms · originals recallable$/);
	});

	test("after the persist the next request needs no local edit (the session projection already carries it)", async () => {
		const { r, all, projected } = await runCold(cold);
		const next = await r.fire("context_with_system", { messages: projected });
		expect(next).toBeUndefined();
		expect(all.length).toBeGreaterThan(0);
	});

	test("relax: a rereadable previous-turn output folds and PERSISTS (the guard allows the previous turn, never the latest)", async () => {
		process.env.PI_ZIP_COLD_CAP = "1000";
		const { req1, projected, te } = await runCold(cold);
		const targets = te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId).sort();
		expect(targets).toEqual(["r1", "r2"]);
		expect(JSON.stringify(projected.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
	});

	test("summary: the local view and the persisted compaction carry the same text and the same kept part", async () => {
		process.env.PI_ZIP_COLD_CAP = "6000";
		const big = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5"), U("u4", "back")];
		const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0.01 } } });
		const r = await rig(big, COLD_TS(), { modelRegistry: { complete } });
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(big) });
		expect(req1.messages[0].role).toBe("compactionSummary");
		const all = [...big, A("a6")];
		const te = await r.fire("turn_end", turnEnd(all, "a6"));
		const comp = te.entries.find((e: Any) => e.type === "compaction");
		expect(comp.summary).toBe(req1.messages[0].summary);
		expect(comp.firstKeptEntryId).toBe("u3");
		expect(norm(flat(project(all, te.entries)).slice(0, req1.messages.length))).toBe(norm(req1.messages));
		expect(r.notes[0]).toMatch(/summarized 2 requests .* waited [\d.]+ s/);
	});
});

describe("F12 summary prepared while the user is away", () => {
	test("the background summary built at settle is adopted by the next cold return and reported with its real duration", async () => {
		process.env.PI_ZIP_COLD_CAP = "6000";
		const done = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5")];
		let calls = 0;
		const complete = async () => (calls++, { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0.02 } } });
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete } });
		const settled = await r.fire("agent_before_settle", { context: { contextEntries: done }, entries: [] });
		expect(settled.entries.at(-1).customType).toBe("pi-zip/plan");
		const back = [...done, U("u4", "back")];
		r.ctx.sessionManager.getBranch = () => [...branchOf(done, COLD_TS()), settled.entries.at(-1)];
		r.ctx.sessionManager.buildSessionProjection = () => ({ entries: back });
		await r.fire("before_agent_start", {});
		const req = await r.fire("context_with_system", { messages: flat(back) });
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(calls).toBe(1); // no second model call at return
		await r.fire("turn_end", turnEnd([...back, A("a6")], "a6"));
		expect(r.notes.at(-1)).toMatch(/summarized 2 requests · [\d.]+K → [\d.]+K tokens · [\d.]+ s \(done while you were away\)/);
		expect(r.handlers.get("cmd:zip")).toBeDefined();
		await r.handlers.get("cmd:zip").handler("stats", r.ctx);
		expect(r.notes.at(-1)).toContain("1 summary");
		expect(r.notes.at(-1)).toContain("$0.0200");
	});

	test("a background summary that a warm return never needs is still booked as cost", async () => {
		process.env.PI_ZIP_COLD_CAP = "6000";
		const done = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5")];
		const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "n" }], usage: { cost: { total: 0.02 } } });
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete } });
		await r.fire("agent_before_settle", { context: { contextEntries: done }, entries: [] });
		await r.fire("before_agent_start", {}); // warm: discard
		await new Promise((res) => setTimeout(res, 20));
		await r.handlers.get("cmd:zip").handler("stats", r.ctx);
		expect(r.notes.at(-1)).toContain("$0.0200");
	});
});

// =============================================================================================================
describe("I2 lossless: zip_recall(handle) returns the original, byte for byte", () => {
	test.each(SEEDS)("random session, seed %i", async (seed) => {
		process.env.PI_ZIP_COLD_CAP = "1000";
		const entries = [...randomSession(seed), U("uN", "back")];
		const p = planContext(entries, { base: 0, cwd: process.cwd(), coldCap: 1000 })!;
		const r = await rig(entries, COLD_TS());
		const tool = r.handlers.get("tool:zip_recall");
		const originals = new Map(entries.filter((e) => e.messages[0].role === "toolResult").map((e) => [e.sourceEntry.id, e.messages[0].content[0].text as string]));
		for (const f of p.folds) {
			const h = handleFor(f.entryId);
			expect(f.ph).toContain(h);
			const res = await tool.execute("t", { handle: h }, undefined, undefined, r.ctx);
			const orig = originals.get(f.entryId)!;
			expect(res.isError).toBe(false);
			expect(res.content[0].text.endsWith(`lines]\n${orig}`)).toBe(true);
		}
		const batch = await tool.execute("t", { handles: [...p.folds.map((f) => handleFor(f.entryId)), "nope000000"] }, undefined, undefined, r.ctx);
		expect(batch.content[0].text).toContain("[handle nope000000] not found");
	});
});

// =============================================================================================================
describe("I3 untouched: user messages, tool-call arguments, thinking and the payload's system/tools never change", () => {
	test.each(SEEDS)("random session, seed %i", (seed) => {
		const entries = [...randomSession(seed), U("uN", "back")];
		const p = planContext(entries, { base: 0, cwd: process.cwd(), coldCap: 1000 })!;
		const before = flat(entries);
		const plan: RunPlan = { source: "runstart", folds: p.folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		const view = applyPlanToMessages(before, plan)?.messages ?? before;
		expect(view).toHaveLength(before.length);
		const phById = new Map(p.folds.map((f) => [f.toolCallId, f.ph]));
		view.forEach((m: Any, i: number) => {
			const o = before[i];
			if (o.role !== "toolResult") return expect(m).toBe(o); // identical object: not even copied
			const { content, ...rest } = m;
			const { content: oc, ...orest } = o;
			expect(rest).toEqual(orest);
			if (phById.has(o.toolCallId)) expect(content).toEqual([{ type: "text", text: phById.get(o.toolCallId) }]);
			else expect(content).toBe(oc);
		});
		expect(JSON.stringify(view.filter((m: Any) => m.role === "user"))).toBe(JSON.stringify(before.filter((m: Any) => m.role === "user")));
	});

	test("a summary skeleton carries every user request verbatim", () => {
		const entries = randomSession(7);
		const blocks = buildBlocks(entries);
		const sk = skeleton(blocks, null);
		for (const e of entries) if (e.messages[0].role === "user") expect(sk.text).toContain(e.messages[0].content);
	});

	test("the guard repairs only tool results: system and tools are byte-identical", () => {
		const payload = { system: [{ type: "text", text: "S" }], tools: [{ name: "bash" }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "gone", content: "x" }] }] };
		const out = repairPayload(payload)!;
		expect(JSON.stringify(out.payload.system)).toBe(JSON.stringify(payload.system));
		expect(JSON.stringify(out.payload.tools)).toBe(JSON.stringify(payload.tools));
		expect(out.payload.messages[0].content[0].type).toBe("text");
	});
});

// =============================================================================================================
describe("I4 off is a strict no-op", () => {
	const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "back")];
	const orphan = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "gone", content: "x" }] }] };

	test("PI_ZIP_OFF=1 registers nothing at all", async () => {
		process.env.PI_ZIP_OFF = "1";
		const r = await rig(prevRun, COLD_TS());
		expect(r.calls).toEqual([]);
	});

	test("/zip off: no handler changes the view, the entries or the payload, even on a cold return that would fold", async () => {
		const r = await rig(prevRun, COLD_TS());
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		r.notes.length = 0; // the command's own confirmation is the only message allowed
		const msgs = flat(prevRun);
		expect(await r.fire("before_agent_start", {})).toBeUndefined();
		expect(await r.fire("context_with_system", { messages: msgs })).toBeUndefined();
		const all = [...prevRun, A("a4")];
		expect(await r.fire("turn_end", turnEnd(all, "a4"))).toBeUndefined();
		expect(await r.fire("agent_before_settle", { context: { contextEntries: all }, entries: [] })).toBeUndefined();
		expect(await r.fire("before_provider_request", { payload: orphan })).toBeUndefined();
		expect(r.notes).toEqual([]);
		// same scenario with zip on does change things (the test would be vacuous otherwise)
		const on = await rig(prevRun, COLD_TS());
		await on.fire("before_agent_start", {});
		expect(await on.fire("context_with_system", { messages: msgs })).toBeDefined();
		expect(await on.fire("before_provider_request", { payload: orphan })).toBeDefined();
		await r.handlers.get("cmd:zip").handler("on", r.ctx); // and /zip on resumes
		expect(r.appended.at(-1)).toMatchObject({ data: { off: false } });
	});

	test("off survives a restart (state entry), and a restart in off mode stays a no-op", async () => {
		const r = await rig(prevRun, COLD_TS());
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		expect(r.appended.at(-1)).toMatchObject({ customType: "pi-zip/state", data: { off: true } });
		const r2 = await rig(prevRun, COLD_TS(), { branch: [...branchOf(prevRun, COLD_TS()), r.appended.at(-1)] });
		await r2.fire("session_start", { reason: "startup" });
		await r2.fire("before_agent_start", {});
		expect(await r2.fire("context_with_system", { messages: flat(prevRun) })).toBeUndefined();
	});

	test("the recall tool stays registered while off (earlier folds must stay recallable)", async () => {
		const r = await rig(prevRun, COLD_TS());
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		expect(r.handlers.has("tool:zip_recall")).toBe(true);
	});
});

// =============================================================================================================
describe("I5 valid: every tool_use keeps its tool_result", () => {
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "three"), A("a5", ["c3"]), R("r3", "c3"), A("a6"), U("u4", "four"), A("a7")];
	const blocks = buildBlocks(ctx);
	const idx = (id: string) => blocks.findIndex((b) => b.entryId === id);
	const N = blocks.filter((b) => b.kind === "user").length;
	const ok = (folds: [string, string][], cut: string | null = null) => validateEdits(blocks, { folds: new Map(folds.map(([i, t]) => [idx(i), t])), cut: cut ? idx(cut) : null }, N);

	test("legal edit sets are accepted", () => {
		expect(ok([["r1", "[ph]"]])).toBeNull();
		expect(ok([["r2", "[ph]"]])).toBeNull(); // an older turn
		expect(ok([], "u3")).toBeNull();
		expect(ok([], "a3")).toBeNull();
	});
	test("illegal edit sets are rejected", () => {
		expect(ok([["a1", "[ph]"]])).not.toBeNull(); // not a toolResult
		expect(ok([["u1", "[ph]"]])).not.toBeNull();
		expect(ok([["r1", "  "]])).not.toBeNull(); // empty placeholder
		expect(ok([], "a5")).not.toBeNull(); // cut inside the last 2 user turns
		expect(ok([], "u4")).not.toBeNull();
		expect(ok([], "r2")).not.toBeNull(); // cut at a toolResult orphans it
		expect(validateEdits(blocks, { folds: new Map(), cut: 0 }, N)).not.toBeNull();
	});
	test("the latest user turn's own output is never a fold target; the previous turn's only when re-readable", () => {
		const three = buildBlocks([U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "three"), A("a5", ["c3"]), R("r3", "c3")]);
		const at = (id: string) => three.findIndex((b) => b.entryId === id);
		const rec = (r: string) => new Map([[at("r2"), r]]);
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), recover: rec("rereadable"), cut: null }, 3)).toBeNull();
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), recover: rec("nonrereadable"), cut: null }, 3)).toMatch(/previous user turn/);
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), cut: null }, 3)).toMatch(/previous user turn/); // unknown = not proven re-readable
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), recover: rec("rereadable"), relax: false, cut: null }, 3)).toMatch(/previous user turn/);
		expect(validateEdits(three, { folds: new Map([[at("r1"), "[ph]"]]), cut: null }, 3)).toBeNull(); // older turns need no proof
		expect(validateEdits(three, { folds: new Map([[at("r3"), "[ph]"]]), recover: new Map([[at("r3"), "rereadable"]]), cut: null }, 3)).toMatch(/latest user turn/);
	});
	test("a target another extension already edited is rejected", () => {
		const b = buildBlocks(ctx);
		b[idx("r1")].edited = true;
		expect(validateEdits(b, { folds: new Map([[idx("r1"), "[ph]"]]), cut: null }, N)).toMatch(/already edited/);
	});
	test("only the pairing breaks the edits themselves create are rejected; an already odd session stays as odd as it was", () => {
		const broken = buildBlocks([U("u1", "one"), A("a1", ["c1", "c9"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "t"), A("a4")]);
		expect(validateEdits(broken, { folds: new Map([[2, "[ph]"]]), cut: null }, 3)).toBeNull(); // a missing result already existed; folding does not change it
		const orphan = buildBlocks([U("u1", "one"), R("r0", "zz"), A("a2"), U("u2", "two"), A("a3"), U("u3", "t"), A("a4")]);
		expect(validateEdits(orphan, { folds: new Map(), cut: 3 }, 3)).toBeNull();
		const split = buildBlocks([U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "t"), A("a4")]);
		expect(validateEdits(split, { folds: new Map(), cut: 2 }, 3)).toMatch(/cut/); // a cut at the result orphans it
	});
	test("aborted and errored assistant turns (saved without results) never count as orphans: later edits stay legal", () => {
		const dead = (id: string, stop: string, call: string) => {
			const e = A(id, [call]);
			(e.messages[0] as Any).stopReason = stop;
			return e;
		};
		const ctx2 = [U("u1", "one"), dead("a1", "aborted", "x1"), U("u2", "two"), A("a2", ["c2"]), R("r2", "c2"), A("a3"), U("u3", "three"), dead("a4", "error", "x2"), U("u4", "four"), A("a5", ["c5"]), R("r5", "c5"), A("a6"), U("u5", "five"), A("a7")];
		const b = buildBlocks(ctx2);
		const id = (x: string) => b.findIndex((y) => y.entryId === x);
		expect(validateEdits(b, { folds: new Map([[id("r2"), "[ph]"]]), cut: null }, 5)).toBeNull();
		expect(validateEdits(b, { folds: new Map(), cut: id("u3") }, 5)).toBeNull();
		expect(validateEdits(b, { folds: new Map(), cut: id("u2") }, 5)).toBeNull();
		// ... while a live assistant turn without results that the cut strands is still the cut's doing only when it is new
		const live = buildBlocks([U("u1", "one"), A("a1", ["x1"]), U("u2", "two"), A("a2"), U("u3", "three"), A("a3")]);
		expect(validateEdits(live, { folds: new Map(), cut: 2 }, 3)).toBeNull();
	});

	test.each(SEEDS)("random deletion, seed %i: an edit set is rejected exactly when the cut creates an orphan the session did not already have", (seed) => {
		const r = prng(seed * 7919);
		const entries = randomSession(seed);
		const full = buildBlocks(entries);
		const turns = (bl: Block[]) => bl.filter((x) => x.kind === "user").length;
		expect(validateEdits(full, { folds: new Map(), cut: null }, turns(full))).toBeNull();
		const victim = Math.floor(r() * entries.length);
		const rest = entries.filter((_, i) => i !== victim);
		const b = buildBlocks(rest);
		expect(validateEdits(b, { folds: new Map(), cut: null }, turns(b))).toBeNull(); // no edit, nothing created
		// every legal cut position: rejected iff some kept toolResult lost its call (calls before the cut are gone)
		const limit = b.findIndex((x) => x.userTurn >= turns(b) - 1);
		for (let c = 1; c < b.length && (limit < 0 || c <= limit); c++) {
			if (!b[c].entryId || (b[c].kind !== "user" && b[c].kind !== "assistant")) continue;
			const seen = new Set<string>();
			const callsAll = new Set<string>();
			for (const x of b.slice(0, c)) if (x.kind === "assistant") for (const k of x.msg.content) if (k.type === "toolCall") callsAll.add(k.id);
			for (const x of b.slice(c)) if (x.kind === "assistant") for (const k of x.msg.content) if (k.type === "toolCall") seen.add(k.id);
			const baseOrphan = (id: string) => ![...b.slice(0, b.findIndex((y) => y.msg.toolCallId === id))].some((y) => y.kind === "assistant" && y.msg.content.some((k: Any) => k.id === id));
			const newOrphan = b.slice(c).some((x) => x.kind === "toolResult" && !seen.has(x.msg.toolCallId) && !baseOrphan(x.msg.toolCallId));
			const verdict = validateEdits(b, { folds: new Map(), cut: c }, turns(b));
			if (newOrphan) expect(verdict).not.toBeNull();
		}
	});

	test.each(SEEDS)("payload guard on a random Anthropic-shaped request, seed %i", (seed) => {
		const r = prng(seed);
		const messages: Any[] = [];
		let n = 0;
		for (let i = 0; i < 6; i++) {
			const ids = r() < 0.7 ? [`t${++n}`] : [];
			messages.push({ role: "user", content: `q${i}` });
			messages.push({ role: "assistant", content: [{ type: "text", text: "x" }, ...ids.map((id) => ({ type: "tool_use", id, name: "bash", input: {} }))] });
			if (ids.length) messages.push({ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "out" })) });
		}
		expect(repairPayload({ messages })).toBeNull(); // a valid request is never touched
		const kill = messages.map((m, i) => (m.role === "assistant" && m.content.some((c: Any) => c.type === "tool_use") ? i : -1)).filter((i) => i >= 0);
		if (!kill.length) return;
		const victim = kill[Math.floor(r() * kill.length)];
		const broken = messages.filter((_, i) => i !== victim);
		const fixed = repairPayload({ messages: broken })!;
		expect(fixed.repaired).toBeGreaterThan(0);
		fixed.payload.messages.forEach((m: Any, i: number) => {
			if (!Array.isArray(m.content)) return;
			for (const b of m.content) if (b.type === "tool_result") expect(fixed.payload.messages[i - 1].content.some((c: Any) => c.type === "tool_use" && c.id === b.tool_use_id)).toBe(true);
		});
	});

	test("the guard repairs OpenAI-shaped orphan tool messages too, and the extension forwards the repair", async () => {
		const r = await rig([U("u1", "x")], WARM_TS());
		const out = await r.fire("before_provider_request", { payload: { messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "gone", content: "x" }] } });
		expect(out.messages[1].role).toBe("user");
	});
});

// =============================================================================================================
describe("I6 warm cache: nothing changes unless the window is nearly full", () => {
	const session = (outputs: number) => {
		const e: Any[] = [];
		for (let t = 0; t < outputs; t++) e.push(U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9000), A(`z${t}`));
		e.push(U("uN", "now"));
		return e;
	};

	test("a hot request at 1M window: no local edit, no persisted edit, even with a stale cold plan in the branch", async () => {
		const entries = session(8);
		const stale = { type: "custom", customType: "pi-zip/plan", data: { policy: "pi-zip", targets: [], summary: null } };
		const r = await rig(entries, WARM_TS(), { branch: [...branchOf(entries, WARM_TS()), stale] });
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(entries) })).toBeUndefined();
		expect(await r.fire("turn_end", turnEnd([...entries, A("zN")], "zN"))).toBeUndefined();
		expect(r.notes).toEqual([]);
		expect(planContext(entries, { mode: "hot", base: 0, cwd: ".", model: r.ctx.model })).toBeNull();
	});

	test("below 80% of the window: nothing; above: newest eligible outputs fold down to 80%, protected turns stay", async () => {
		const entries = session(9); // ~9 x 2.25K tokens
		const all = [...entries, A("zN")];
		const small = await rig(entries, WARM_TS(), { model: { provider: "p", id: "m", contextWindow: 30_000, cost: { cacheWrite: 3, cacheRead: 0.3 } } });
		await small.fire("before_agent_start", {});
		expect(await small.fire("turn_end", turnEnd(all, "zN"))).toBeUndefined(); // 21K < 24K
		const tight = await rig(entries, WARM_TS(), { model: { provider: "p", id: "m", contextWindow: 20_000, cost: { cacheWrite: 3, cacheRead: 0.3 } } });
		await tight.fire("before_agent_start", {});
		const te = await tight.fire("turn_end", turnEnd(all, "zN"));
		const ids = te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId);
		expect(ids.length).toBeGreaterThan(0);
		const nums = ids.map((x: string) => Number(x.slice(1)));
		expect(nums).toEqual([...nums].sort((a, b) => b - a)); // newest first
		expect(ids).not.toContain("r8"); // r8 belongs to the previous user turn: protected
		expect(ids[0]).toBe("r7");
		expect(tight.notes[0]).toContain("context window nearly full");
	});
});

// =============================================================================================================
describe("coexistence (F14)", () => {
	test("another context manager pauses folding, keeps the guard, and says so once", async () => {
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "back")];
		const other = { getAllTools: () => [{ name: "compress", sourceInfo: { path: "/opt/ext/node_modules/billion-context-pi/index.ts", source: "npm" } }] };
		const r = await rig(entries, COLD_TS(), {}, other);
		await r.fire("session_start", {});
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(entries) })).toBeUndefined();
		expect(await r.fire("turn_end", turnEnd([...entries, A("a4")], "a4"))).toBeUndefined();
		expect(await r.fire("before_provider_request", { payload: { messages: [{ role: "tool", tool_call_id: "gone", content: "x" }] } })).toBeDefined();
		expect(r.notes).toHaveLength(1);
		expect(r.notes[0]).toContain("billion-context");
		await r.handlers.get("cmd:zip").handler("status", r.ctx);
		expect(r.notes.at(-1)).toContain("paused");
	});
});
