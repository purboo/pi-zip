// Token-scale calibration: k = real / estimate, read from the branch itself (no in-memory state), used by every limit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { DEFAULT_K, K_MAX, buildBlocks, calibrate, planContext } from "../src/plan.ts";
import { A, AX, fakeCtx, fakePi, flat, project, R, U, withK, type Any } from "./helpers.ts";

const ENV = ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_OFF", "PI_ZIP_LEDGER", "PI_ZIP_MIN_GAIN"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); ENV.forEach((k) => delete process.env[k]); process.env.PI_ZIP_TTL_SECS = "1"; });
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

const est = (entries: Any[], upTo?: number) => buildBlocks(entries).slice(0, upTo).reduce((a, b) => a + b.tokens, 0);
const usage = (e: Any, u: Any, over: Any = {}) => Object.assign(e.sourceEntry.message, { usage: u, ...over });
const session = () => [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 8000), A("a2"), U("u2", "two"), A("a3")];

describe("calibrate: k from the newest assistant message with usage", () => {
	test("real = input + cacheRead + cacheWrite over the estimate of what preceded that message (output is not part of it)", () => {
		const entries = session();
		const before = est(entries, 5); // blocks before a3, the last assistant message
		usage(entries[5], { input: 100, cacheRead: before, cacheWrite: 400, output: 9999 });
		const c = calibrate(entries, 10);
		expect(c.source).toBe("usage");
		expect(c.real).toBe(before + 500);
		expect(c.est).toBe(before + 10);
		expect(c.k).toBeCloseTo((before + 500) / (before + 10), 9);
	});

	test("no usage anywhere: the documented default, not an additive fallback", () => {
		expect(calibrate(session(), 10)).toEqual({ k: DEFAULT_K, real: 0, est: 0, source: "default" });
		expect(DEFAULT_K).toBe(1.7);
		expect(calibrate([], 0).source).toBe("default");
	});

	test("an aborted message without usage (or with all-zero usage) and an errored one are skipped: the previous usable message calibrates", () => {
		const entries = [...session(), U("u3", "three"), A("a4"), A("a5")];
		const before = est(entries, 5);
		usage(entries[5], { input: Math.round(before * 1.5), cacheRead: 0, cacheWrite: 0 }); // a3: usable
		usage(entries[7], { input: 99_999, cacheRead: 0, cacheWrite: 0 }, { stopReason: "error" }); // a4: errored, ignored even with a number
		Object.assign(entries[8].sourceEntry.message, { stopReason: "aborted" }); // a5: aborted, no usage at all
		const c = calibrate(entries, 0);
		expect(c.source).toBe("usage");
		expect(c.k).toBeCloseTo(1.5, 2);
		usage(entries[8], { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, { stopReason: "aborted" });
		expect(calibrate(entries, 0).k).toBeCloseTo(1.5, 2);
	});

	test("the ratio is clamped to [1, 2.5]: an estimate above the real count is not trusted, a wild ratio does not run away", () => {
		const low = session();
		usage(low[5], { input: 10, cacheRead: 0, cacheWrite: 0 });
		expect(calibrate(low, 0).k).toBe(1);
		const high = session();
		usage(high[5], { input: 5_000_000, cacheRead: 0, cacheWrite: 0 });
		expect(calibrate(high, 0).k).toBe(K_MAX);
	});

	test("after a fold the last request carried placeholders: the estimate uses the projection as persisted, so k is not inflated", () => {
		const entries = session();
		const ph = "[folded by pi-zip · bash ls · 8000 chars]\nFull original is saved: call zip_recall(\"h\")";
		const projected = project(entries, [{ type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: ph }] } }]);
		const foldedBefore = est(projected, 5);
		const unfoldedBefore = est(entries, 5);
		expect(foldedBefore).toBeLessThan(unfoldedBefore - 1500);
		const real = Math.round(foldedBefore * 1.7);
		usage(projected[5], { input: real, cacheRead: 0, cacheWrite: 0 }); // what the request with the placeholders really cost
		const c = calibrate(projected, 0);
		expect(c.est).toBe(foldedBefore);
		expect(c.k).toBeCloseTo(1.7, 1);
		// had the estimate used the unfolded text, the same usage would have looked like a ratio of ~1
		expect(real / unfoldedBefore).toBeLessThan(1.1);
	});

	test("an assistant message older than a compaction Pi made is not usable (its request had text the projection lost); ours is", () => {
		const a = A("a1");
		Object.assign(a.sourceEntry.message, { timestamp: Date.parse("2024-01-01T00:00:00Z"), usage: { input: 50_000, cacheRead: 0, cacheWrite: 0 } });
		const comp = (by: string) => ({ sourceEntry: { id: "cmp", type: "compaction", timestamp: "2024-01-01T01:00:00Z", details: { by } }, messages: [{ role: "compactionSummary", summary: "s".repeat(2000), tokensBefore: 0, timestamp: 0 }] });
		expect(calibrate([comp("pi"), U("u1", "x".repeat(4000)), a], 0).source).toBe("default");
		expect(calibrate([comp("pi-zip"), U("u1", "x".repeat(4000)), a], 0).source).toBe("usage");
	});
});

describe("every limit is compared on the calibrated scale", () => {
	const prose = [U("u1", "one"), A("a1"), AX("x1", 60_000), U("u2", "two"), A("a2"), AX("x2", 60_000), U("u3", "three"), A("a3"), U("u4", "now")];
	const lots = () => {
		const e: Any[] = [];
		for (let t = 0; t < 12; t++) e.push(U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 20_000), A(`z${t}`));
		e.push(U("uN", "now"));
		return e;
	};
	const sig = (p: Any) => ({ folds: p.folds.map((f: Any) => f.entryId), cut: p.cutIdx, trig: p.sumTrigger });

	test("k x estimate against the cap equals the estimate against cap / k: cold cap, cut search and min gain", () => {
		for (const entries of [prose, lots()]) {
			const scaled = planContext(entries, { sys: 0, cwd: ".", promptPending: false, k: 2, coldCap: 40_000 })!;
			const plain = planContext(entries, { sys: 0, cwd: ".", promptPending: false, k: 1, coldCap: 20_000, minGain: 5_000 })!;
			expect(sig(scaled)).toEqual(sig(plain));
			expect(scaled.ctxTokens).toBeCloseTo(2 * plain.ctxTokens, 6);
			expect(scaled.ctxAfterFolds).toBeCloseTo(2 * plain.ctxAfterFolds, 6);
			expect(scaled.k).toBe(2);
		}
		// ~30K estimated tokens of prose: under a 60K cap at k = 1, ~75K real (over the cap, summary needed) at k = 2.5
		expect(planContext(prose, { sys: 0, cwd: ".", promptPending: false, k: 1, coldCap: 60_000 })!.cutIdx).toBeNull();
		expect(planContext(prose, { sys: 0, cwd: ".", promptPending: false, k: 2.5, coldCap: 60_000 })!.cutIdx).not.toBeNull();
	});

	test("the compaction room guard is in real tokens too: a window that is small in real tokens clamps the cap harder at higher k", () => {
		const model = { provider: "p", id: "m", contextWindow: 64_000 }; // room = 64000 - 16384 - 8192 = 39424 real tokens
		const at = (k: number) => planContext(prose, { sys: 0, cwd: ".", promptPending: false, model, coldCap: 1_000_000, k })!.sumTrigger;
		expect(at(1)).toBeNull(); // ~30K estimated: under the room
		expect(at(1.5)).not.toBeNull(); // ~45K real: over it
	});

	test("the warm cap is measured in calibrated tokens: the same chars/4 estimate is under it at k = 1 and over it at k = 1.7", () => {
		const warm = (entries: Any[], k: number) => planContext(entries, { mode: "warm", sys: 0, cwd: ".", promptPending: false, k, coldCap: 160_000, model: { provider: "p", id: "m" } });
		const big: Any[] = [];
		for (let t = 0; t < 50; t++) big.push(U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9000), A(`z${t}`));
		big.push(U("uN", "now"));
		expect(warm(big, 1)).toBeNull(); // 112K < 160K
		expect(warm(big, 1.7)).not.toBeNull(); // 190K > 160K
	});

	test("through the extension: a warm return whose usage says 1.7x is over the cap, one that says 1.0x is not", async () => {
		const { default: piZip } = await import("../src/index.ts");
		process.env.PI_ZIP_COLD_CAP = "160000"; // ~112K estimated: under it at k = 1, ~190K real over it at k = 1.7
		const mk = async (k: number) => {
			const entries = withK(Array.from({ length: 50 }, (_, t) => [U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9000), A(`z${t}`)]).flat().concat(U("uN", "now")), k);
			const f = fakePi();
			piZip(f.pi);
			const { ctx } = fakeCtx(entries, { branch: [{ type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now(), content: [] } }] });
			await f.handlers.get("before_agent_start")({}, ctx);
			return f.handlers.get("context_with_system")({ messages: flat(entries) }, ctx);
		};
		expect(await mk(1)).toBeUndefined();
		expect(await mk(1.7)).toBeDefined();
	});
});

describe("regression (fresh process, print mode): the last usage says ~88K real while chars/4 says ~51K", () => {
	// previous turn: 8 re-readable reads of ~6K estimated tokens each; an older turn with one more; then the new prompt
	const entries = () => {
		const e: Any[] = [U("u1", "one"), A("a1", ["c0"]), R("r0", "c0", 16_000), A("a1e"), U("u2", "two")];
		for (let i = 1; i <= 8; i++) e.push(A(`a2_${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 24_000));
		e.push(A("a2e"), U("u3", "back after the idle"));
		return e;
	};
	const REAL = 88_000;
	const ledger = `/tmp/pi-zip-test-calibration-${process.pid}.jsonl`;

	async function coldReturn(all: Any[]) {
		process.env.PI_ZIP_LEDGER = ledger;
		try { unlinkSync(ledger); } catch {}
		const { default: piZip } = await import("../src/index.ts");
		const f = fakePi();
		piZip(f.pi); // a new Zip: nothing from an earlier request exists in memory
		const branch = [...all.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { ctx } = fakeCtx(all, { branch });
		await f.handlers.get("before_agent_start")({}, ctx);
		const req = await f.handlers.get("context_with_system")({ messages: flat(all) }, ctx);
		const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		unlinkSync(ledger);
		return { req, plan: lines.find((l: Any) => l.type === "cold_plan") };
	}

	test("the plan folds down to <= 40K real-equivalent, where the uncalibrated estimate (k = 1) would have stopped far above it", async () => {
		const all = entries();
		const last = all.find((x) => x.sourceEntry.id === "a2e")!;
		const view = est(all, all.findIndex((x) => x.sourceEntry.id === "a2e"));
		expect(view).toBeGreaterThan(48_000);
		expect(view).toBeLessThan(55_000); // chars/4 of what the last request carried: ~51K
		Object.assign(last.sourceEntry.message, { stopReason: "stop", usage: { input: 2_000, cacheRead: 80_000, cacheWrite: REAL - 82_000, output: 300 } });

		const { req, plan } = await coldReturn(all);
		expect(plan.source).toBe("runstart");
		expect(plan.calSource).toBe("usage");
		expect(plan.calReal).toBe(REAL);
		expect(plan.k).toBeGreaterThan(1.6);
		expect(plan.k).toBeLessThan(1.8);
		expect(plan.ctxBefore).toBeGreaterThan(REAL - 1_000); // scaled: the whole view incl. the new prompt, in real tokens
		expect(plan.ctxAfter).toBeLessThanOrEqual(40_000);
		expect(plan.folds).toBeGreaterThanOrEqual(4); // the old output + 3 of the previous turn's (relax), biggest first, until the cap
		expect(req.messages.filter((m: Any) => m.role === "toolResult" && m.content[0].text.startsWith("[folded by pi-zip")).length).toBe(plan.folds);

		// what the old estimate did: k = 1 sees ~51K, stops folding once under 40K (~36K, 3 folds), which is ~62K in real tokens
		const old = planContext(all, { sys: 0, cwd: process.cwd(), promptPending: false, k: 1 })!;
		expect(1.7 * old.ctxAfterFolds).toBeGreaterThan(40_000);
		expect(old.folds.length).toBeLessThan(plan.folds); // k = 1 stops folding the previous turn earlier than the calibrated plan
	});

	test("without usage in the branch the default k applies (the same fold depth, never the old additive ~3K base)", async () => {
		const { plan } = await coldReturn(entries());
		expect(plan.calSource).toBe("default");
		expect(plan.k).toBe(DEFAULT_K);
		expect(plan.calReal).toBe(0);
		expect(plan.ctxAfter).toBeLessThanOrEqual(40_000);
	});
});

describe("stats and notices use the plan's scale", () => {
	test("the fold ledger line carries k and scaled tokens: ctxBefore = k x (system + view)", async () => {
		const ledger = `/tmp/pi-zip-test-calibration-fold-${process.pid}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
		try { unlinkSync(ledger); } catch {}
		const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 20_000), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];
		const cold = withK([...prevRun, U("u3", "back after the idle")], 2);
		const { default: piZip } = await import("../src/index.ts");
		const f = fakePi();
		piZip(f.pi);
		const branch = [...cold.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { ctx, notes } = fakeCtx(cold, { branch });
		await f.handlers.get("before_agent_start")({}, ctx);
		await f.handlers.get("context_with_system")({ messages: flat(cold) }, ctx);
		const all = [...cold, A("a5")];
		await f.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop", usage: { input: 1, cacheRead: 0, cacheWrite: 0 } }, messageEntryId: "a5", context: { contextEntries: all }, entries: [], turnIndex: 0 }, ctx);
		const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		unlinkSync(ledger);
		const plan = lines.find((l: Any) => l.type === "cold_plan");
		const fold = lines.find((l: Any) => l.type === "fold");
		expect(plan.k).toBe(2);
		expect(fold.k).toBe(2);
		expect(Math.abs(fold.ctxBefore - 2 * (1 + est(all)))).toBeLessThanOrEqual(1);
		expect(fold.entryTokensBefore).toBe(Math.round(2 * buildBlocks(all).find((b) => b.entryId === "r1")!.tokens));
		expect(fold.ctxAfter).toBe(fold.ctxBefore - (fold.entryTokensBefore - fold.entryTokensAfter));
		expect(notes).toHaveLength(1);
	});
});
