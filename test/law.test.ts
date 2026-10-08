// The round-5 law (verdict section 8, tests 1-7), the suffix rewrite base T, and the learned cache survival / regime class.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lawPrices, loadStats, pWarm, record, sample, type Prices } from "../src/learn.ts";
import { compactionRoom, editAllowed, lawTerms, legacyValve, planContext, settings, type Law } from "../src/plan.ts";
import { Zip } from "../src/run.ts";
import { A, AX, fakeCtx, fakePi, flat, longTurn, project, R, U, type Any } from "./helpers.ts";

const ANTH: Prices = { r: 0.3, w: 3.75, input: 3, out: 15, cls: "explicit", src: "class" };
const ANTH_1H: Prices = { ...ANTH, w: 6 };
const GLM: Prices = { r: 0.186, w: 1, input: 1, out: 4.4 / 1.4, cls: "automatic", src: "class" };
describe("verdict section 8 tests", () => {
	test("1. warm valve (EOQ): with g = 2.4K and A = 40K the first fire is at 47K (5 min), 60K (1 h), 29K (GLM), +-1K", () => {
		const at = (pr: Prices) => { let D = 0; while (!editAllowed(40_000 + D, 40_000, 1, null, pr, 2_400)) D += 100; return D; };
		expect(Math.abs(at(ANTH) - 47_000)).toBeLessThanOrEqual(1_000);
		expect(Math.abs(at(ANTH_1H) - 60_000)).toBeLessThanOrEqual(1_000);
		expect(Math.abs(at(GLM) - 29_000)).toBeLessThanOrEqual(1_000);
	});

	test("2. any cold plan (P = 0) with A < B fires, at any size and price", () => {
		for (const pr of [ANTH, ANTH_1H, GLM]) for (const [B, A] of [[41_000, 40_000], [1e6, 999_999], [60_000, 1_000]]) expect(editAllowed(B, A, 0, null, pr, 2_400)).toBe(true);
		expect(editAllowed(40_000, 40_000, 0, null, ANTH, 2_400)).toBe(false); // nothing removed
	});

	test("3. 128K window at B = room: a single 3K fold never fires, a 30K batch fires (Anthropic 5 min), the GLM minimum batch is ~24K", () => {
		const room = compactionRoom({ contextWindow: 128_000 })!;
		expect(editAllowed(room, room - 3_000, 1, room, ANTH, 2_400)).toBe(false);
		expect(editAllowed(room, room - 30_000, 1, room, ANTH, 2_400)).toBe(true);
		expect(editAllowed(room, room - 30_000, 1, null, ANTH, 2_400)).toBe(false); // the window term is what opens it
		let D = 0;
		while (!editAllowed(room, room - D, 1, room, GLM, 2_400)) D += 100;
		expect(D).toBeGreaterThan(23_000);
		expect(D).toBeLessThan(25_500);
	});

	test("4. in-turn audit template (106K -> 53K at request 57, in-turn outputs): with INTURN_AGE 60 the plan is empty", () => {
		delete process.env.PI_ZIP_INTURN_AGE;
		expect(settings().inturnAge).toBe(60);
		const s = longTurn(56, { chars: 11_500 }); // ~1.9K tokens per output, ~106K in one user turn
		const o = { sys: 0, cwd: ".", promptPending: false, model: { contextWindow: 1_000_000 }, law: { pr: ANTH, g: 2_400, pWarm: 1 } as Law };
		const ctx = planContext(s, { ...o, mode: "cold" })!;
		expect(Math.abs(ctx.ctxTokens - 106_000)).toBeLessThan(2_000);
		expect(ctx.folds).toHaveLength(0);
		expect(planContext(s, { ...o, mode: "warm" })).toBeNull();
		expect(planContext(s, { ...o, mode: "warm", inturnAge: 20 })!.folds.length).toBeGreaterThan(0); // the old age 20 did fold here
	});

	test("5. summary step at ctx 100K, Anthropic 5 min, S = 0.1 X, shared call: K <= 0 iff dS >= 16.8K (17.7K with 500 instruction tokens)", () => {
		const K = (dS: number, instr: number) => {
			const X = dS / 0.9, S = 0.1 * X;
			return lawTerms(X, S, 0, null, ANTH, 2_500, ANTH.r * 100_000 + ANTH.input * instr + ANTH.out * S).K;
		};
		expect(K(16_850, 0)).toBeLessThanOrEqual(0);
		expect(K(16_750, 0)).toBeGreaterThan(0);
		expect(K(17_700, 500)).toBeLessThanOrEqual(0);
		expect(K(17_600, 500)).toBeGreaterThan(0);
		const ok = (dS: number) => editAllowed(dS / 0.9, dS / 9, 0, null, ANTH, 2_500, ANTH.r * 100_000 + ANTH.out * (dS / 9));
		expect(ok(16_000)).toBe(true); // the growth term opens the gate slightly earlier than K <= 0
		expect(ok(10_000)).toBe(false);
	});

	test("6. class unknown (no response yet) -> the legacy rule; a known class always uses the class ratios", () => {
		expect(lawPrices(undefined, false)).toBeNull();
		for (const [B, A, room] of [[200_000, 90_000, null], [183_000, 131_000, null], [180_000, 170_000, 175_424]] as const) expect(editAllowed(B, A, 1, room, null, 2_400)).toBe(legacyValve(B, A, room));
		expect(lawPrices("explicit", false)).toEqual({ r: 0.1, w: 1.25, input: 1, out: 5, cls: "explicit", src: "class" });
		expect(lawPrices("explicit", true)).toEqual({ r: 0.1, w: 2, input: 1, out: 5, cls: "explicit", src: "class" });
		expect(lawPrices("automatic", false)).toEqual({ r: 0.2, w: 1, input: 1, out: 4, cls: "automatic", src: "class" });
	});

	test("7. GLM without cacheWrite: a 365 s return with a full read makes the next 365 s return warm, and 65K -> 35K still passes", () => {
		const path = tmpFile();
		const e = record("zhipu/glm", { explicit: false, total: 65_000, gapS: 365, alive: sample(64_000, 64_000, 65_000) }, path);
		expect(e.cls).toBe("automatic");
		const p = pWarm(e, 365, 300);
		expect(p.p).toBeGreaterThanOrEqual(0.5);
		expect(editAllowed(65_000, 35_000, p.p, null, GLM, 2_400)).toBe(true);
		expect(editAllowed(65_000, 35_000, 1, null, GLM, 2_400)).toBe(true); // D 30K >= 29K even fully warm
		expect(editAllowed(65_000, 38_000, 1, null, GLM, 2_400)).toBe(false); // D 27K < EOQ 28.3K at A = 38K
		rmSync(path, { force: true });
	});
});

describe("rewrite base T: the law accepts any T <= A; the planner passes T = A", () => {
	test("the law: T < A lowers K and opens the warm valve earlier; T = A by default", () => {
		expect(editAllowed(70_000, 40_000, 1, null, ANTH, 2_400)).toBe(false); // D 30K < 47K
		expect(editAllowed(70_000, 40_000, 1, null, ANTH, 2_400, 0, 10_000)).toBe(true); // EOQ at T = 10K: 23.5K
		expect(lawTerms(70_000, 40_000, 1, null, ANTH, 2_400, 0, 10_000).K).toBeCloseTo(3.45 * 10_000);
		expect(lawTerms(70_000, 40_000, 1, null, ANTH, 2_400, 0, 90_000).K).toBeCloseTo(3.45 * 40_000); // never above A
		expect(lawTerms(70_000, 40_000, 0, null, ANTH, 2_400, 0, 10_000).K).toBeCloseTo(-3.45 * 30_000); // cold: T is irrelevant
	});

	test("the planner prices T = A wherever the edit starts; the suffix after the earliest edit is only logged (Tsuf)", () => {
		const outs = (n: number) => Array.from({ length: n }, (_, t) => [U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 12_000), A(`z${t}`)]).flat();
		const tail = [U("uP", "prev"), A("aP"), U("uN", "now")];
		const prose = [U("up", "talk"), AX("x0", 160_000)]; // ~40K tokens nothing can fold
		const o = { mode: "warm" as const, sys: 0, cwd: ".", promptPending: false, coldCap: 45_000, model: { contextWindow: 1_000_000 }, law: { pr: ANTH, g: 2_400, pWarm: 1 }, trace: [] as Any[] };
		expect(planContext([...prose, ...outs(10), ...tail], o)).toBeNull(); // folds start after the prose: the suffix ~3K would fire, T = A does not
		const t = o.trace.at(-1);
		expect(t.T).toBe(t.A);
		expect(t.Tsuf).toBeLessThan(5_000);
		expect(editAllowed(t.B, t.A, 1, null, ANTH, 2_400, 0, t.Tsuf)).toBe(true); // what the old suffix rule would have done
		const late = { ...o, trace: [] as Any[] };
		expect(planContext([...outs(10), ...prose, ...tail], late)).toBeNull(); // folds start at the top: suffix = A
		expect(late.trace.at(-1).T).toBe(late.trace.at(-1).A);
		expect(late.trace.at(-1).Tsuf).toBeGreaterThan(40_000);
	});
});

const tmpFile = () => join(tmpdir(), `pi-zip-surv-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

describe("through the extension: the free signal is learned, persisted and used; the ledger carries the law", () => {
	const keep = ["PI_ZIP_TTL_SECS", "PI_ZIP_LEDGER", "PI_ZIP_CACHE_STATS", "PI_ZIP_COLD_CAP"];
	let saved: Record<string, string | undefined> = {};
	beforeEach(() => { saved = Object.fromEntries(keep.map((k) => [k, process.env[k]])); delete process.env.PI_ZIP_TTL_SECS; process.env.PI_ZIP_CACHE_STATS = tmpFile(); process.env.PI_ZIP_LEDGER = tmpFile(); });
	afterEach(() => { for (const k of ["PI_ZIP_CACHE_STATS", "PI_ZIP_LEDGER"]) rmSync(process.env[k]!, { force: true }); keep.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); });

	test("GLM: a 365 s return read in full -> learned alive -> the next 365 s return is warm (pWarm, survSrc, class, law fields in the ledger)", () => {
		const model = { provider: "zhipu", id: "glm", contextWindow: 1_000_000, cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } };
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two")];
		const back = (ms: number) => [{ type: "message", message: { role: "assistant", provider: "zhipu", model: "glm", stopReason: "stop", timestamp: ms, usage: { input: 100, cacheRead: 60_000, cacheWrite: 0 }, content: [] } }];
		const zip = new Zip(fakePi().pi as Any);
		const t0 = Date.now() - 365_000;
		const { ctx } = fakeCtx(entries, { model, branch: back(t0) });
		zip.sessionStart(ctx);
		zip.beforeAgentStart(ctx); // prior: 365 s > 300 s -> cold
		zip.providerRequest({ payload: {} });
		zip.messageEnd({ role: "assistant", stopReason: "stop", usage: { input: 900, cacheRead: 60_032, cacheWrite: 0, output: 10 } });
		const e = loadStats().models["zhipu/glm"];
		expect(e.cls).toBe("automatic");
		expect(e.n).toBe(1);
		const zip2 = new Zip(fakePi().pi as Any); // a fresh process: only the file remembers
		const { ctx: ctx2 } = fakeCtx(entries, { model, branch: back(Date.now() - 365_000) });
		zip2.sessionStart(ctx2);
		zip2.beforeAgentStart(ctx2);
		const rows = readFileSync(process.env.PI_ZIP_LEDGER!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const prompts = rows.filter((r) => r.type === "prompt");
		expect(prompts[0]).toMatchObject({ cold: true, survSrc: "prior", pWarm: 0 });
		expect(prompts[1]).toMatchObject({ cold: false, survSrc: "learned", cls: "automatic" });
		expect(prompts[1].pWarm).toBeGreaterThanOrEqual(0.5);
		expect(rows.find((r) => r.type === "cache_sample")).toMatchObject({ gapS: 365, expect: 60_100, alive: true, edited: false });
		expect(zip2.status()).toContain("cache zhipu/glm: automatic (from usage), read 0.2 / write 1 / output 4 x input (class ratios), survival 360-420s 0.80 n1"); // model.cost (0.26 / 1.4 / 4.4) is never read
	});

	test("a cold run plan logs Phi, K, eta, T, g, w/r, P(warm) and the price and survival sources", async () => {
		process.env.PI_ZIP_COLD_CAP = "3000";
		record("p/m", { explicit: true, total: 10_000 }); // the class is known from an earlier response
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 40_000), A("a2"), U("u2", "two"), A("a3"), U("u3", "now")];
		const zip = new Zip(fakePi().pi as Any);
		const { ctx } = fakeCtx(entries, { branch: [{ type: "message", message: { role: "assistant", provider: "p", model: "m", stopReason: "stop", timestamp: Date.now() - 400_000, content: [] } }] });
		zip.sessionStart(ctx);
		zip.beforeAgentStart(ctx);
		await zip.context({ messages: entries.flatMap((x: Any) => x.messages) }, ctx);
		const law = readFileSync(process.env.PI_ZIP_LEDGER!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.type === "law");
		expect(law).toMatchObject({ where: "run", g: 2500, pWarm: 0, survSrc: "prior", cls: "explicit", wr: 12.5, prSrc: "class" });
		expect(law.steps.at(-1)).toMatchObject({ at: "plan", ok: true });
		expect(law.steps.at(-1).K).toBeLessThan(0);
		expect(Object.keys(law.steps.at(-1))).toEqual(["at", "ok", "B", "A", "T", "Tsuf", "phi", "K", "eta"]);
		expect(law.steps.at(-1).T).toBe(law.steps.at(-1).A);
	});
});

describe("final model (research round 5, final-model.md section 8 tests 1-5)", () => {
	const keep = ["PI_ZIP_TTL_SECS", "PI_ZIP_LEDGER", "PI_ZIP_CACHE_STATS", "PI_ZIP_COLD_CAP", "PI_ZIP_INTURN_AGE"];
	let saved: Record<string, string | undefined> = {};
	beforeEach(() => { saved = Object.fromEntries(keep.map((k) => [k, process.env[k]])); for (const k of ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_INTURN_AGE"]) delete process.env[k]; process.env.PI_ZIP_CACHE_STATS = tmpFile(); process.env.PI_ZIP_LEDGER = tmpFile(); });
	afterEach(() => { for (const k of ["PI_ZIP_CACHE_STATS", "PI_ZIP_LEDGER"]) rmSync(process.env[k]!, { force: true }); keep.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); });
	const base = { sys: 0, cwd: ".", promptPending: false, model: { contextWindow: 1_000_000 } };
	const ids = (p: Any) => p.folds.map((f: Any) => f.entryId).sort();
	const ledger = () => readFileSync(process.env.PI_ZIP_LEDGER!, "utf8").trim().split("\n").map((l) => JSON.parse(l));

	test("1. a big rereadable read of the previous user turn: a warm plan keeps it, the same plan cold (P = 0) folds it", () => {
		const older = Array.from({ length: 10 }, (_, t) => [U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9_000), A(`z${t}`)]).flat();
		const s = [...older, U("uP", "prev"), A("aP", ["cP"]), R("rP", "cP", 40_000), A("zP"), U("uN", "now")];
		const cold = planContext(s, { ...base, coldCap: 1_000, mode: "cold" })!;
		expect(ids(cold)).toContain("rP");
		expect(cold.folds.find((f) => f.entryId === "rP")!.trig).toBe("cold(relax)");
		const warm = planContext(s, { ...base, coldCap: 1_000, mode: "warm", law: { pr: null, g: 2_400, pWarm: 1 } })!;
		expect(warm).not.toBeNull(); // the older turns still fold (legacy rule: > 50% of the context)
		expect(ids(warm)).not.toContain("rP");
		expect(warm.folds).toHaveLength(10);
	});

	test("2. a protected-turn test output (not rereadable) folds at age 60, not at age 59", () => {
		const s = longTurn(60, { mutating: [1, 2] }); // call i has age 61 - i: r1 = 60, r2 = 59
		const p = planContext(s, { ...base, coldCap: 8_000 })!;
		const r1 = p.folds.find((f) => f.entryId === "r1");
		expect(r1?.recover).toBe("nonrereadable");
		expect(r1?.trig).toBe("cold(inturn)");
		expect(ids(p)).toEqual(["r1"]);
	});

	test("3. T = A: with A ~ 40K, g = 2.4K and the explicit class ratios the first warm fire is at D ~ sqrt(2 g kappa A) ~ 47K, not ~ 30K", () => {
		const pr = lawPrices("explicit", false)!;
		const prose = [U("up", "talk"), AX("x0", 140_000)]; // ~35K tokens nothing can fold, BEFORE the outputs: the suffix after the first fold is small
		const outs = (n: number) => Array.from({ length: n }, (_, t) => [U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 4_000), A(`z${t}`)]).flat();
		const tail = [U("uP", "prev"), A("aP"), U("uN", "now")];
		let first: Any = null, before: Any = null;
		for (let n = 20; n <= 80 && !first; n++) {
			const o = { ...base, mode: "warm" as const, coldCap: 45_000, law: { pr, g: 2_400, pWarm: 1 }, trace: [] as Any[] };
			const p = planContext([...prose, ...outs(n), ...tail], o);
			const t = o.trace.at(-1);
			if (p) first = t; else before = t;
		}
		expect(first).not.toBeNull();
		expect(first.T).toBe(first.A);
		const eoq = Math.sqrt(2 * 2_400 * 11.5 * first.A);
		expect(first.B - first.A).toBeGreaterThanOrEqual(eoq);
		expect(before.B - before.A).toBeLessThan(eoq);
		expect(Math.abs(first.B - first.A - 47_000)).toBeLessThan(3_000);
		expect(first.Tsuf).toBeLessThan(0.25 * first.A); // the suffix rule would have fired long before:
		expect(editAllowed(before.B, before.A, 1, null, pr, 2_400, 0, before.Tsuf)).toBe(true);
	});

	test("4. two consecutive turn_ends with a large D: only the first edits; the one after that may edit again", async () => {
		record("p/m", { explicit: true, total: 10_000 });
		const turns = (from: number, n: number) => Array.from({ length: n }, (_, i) => [U(`u${from + i}`, `q${from + i}`), A(`a${from + i}`, [`c${from + i}`]), R(`r${from + i}`, `c${from + i}`, 16_000), A(`z${from + i}`)]).flat();
		const zip = new Zip(fakePi().pi as Any);
		const small = [U("u0", "go")];
		const { ctx } = fakeCtx(small);
		zip.sessionStart(ctx);
		zip.beforeAgentStart(ctx);
		await zip.context({ messages: flat(small) }, ctx); // warm, below the cap: no run plan
		const reply = (total: number) => { zip.providerRequest({ payload: {} }); zip.messageEnd({ role: "assistant", stopReason: "stop", usage: { input: total, cacheRead: 0, cacheWrite: 0, output: 10 } }); };
		const end = (entries: Any[]) => zip.turnEnd({ message: { role: "assistant", stopReason: "stop", usage: { input: 1_000, cacheRead: 0, cacheWrite: 0 } }, context: { contextEntries: entries }, entries: [], turnIndex: 0 }, ctx);
		reply(5_000);
		const s1 = [...turns(1, 40), U("uN", "now"), A("aN")]; // ~160K estimated: far above any EOQ threshold
		const te1 = await end(s1);
		expect(te1.entries.filter((e: Any) => e.type === "context_edit").length).toBeGreaterThan(30);
		reply(5_000); // the request that first carries the edit
		const s2 = [...project(s1, te1.entries), ...turns(100, 40), U("uM", "more"), A("aM")]; // 40 new foldable outputs: the law would fire again
		expect(await end(s2)).toBeUndefined();
		expect(ledger().filter((r) => r.type === "b2b_skip")).toEqual([expect.objectContaining({ where: "turn_end" })]);
		reply(5_000); // a plain request in between
		const te3 = await end(s2);
		expect(te3.entries.filter((e: Any) => e.type === "context_edit").length).toBeGreaterThan(30);
	});

	test("4b. the guard covers a warm run start too: a prompt right after the edited request plans nothing", async () => {
		record("p/m", { explicit: true, total: 10_000 });
		const turns = Array.from({ length: 40 }, (_, i) => [U(`u${i}`, `q${i}`), A(`a${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 16_000), A(`z${i}`)]).flat();
		const big = [...turns, U("uN", "now")];
		const zip = new Zip(fakePi().pi as Any);
		const { ctx } = fakeCtx(big);
		zip.sessionStart(ctx);
		const reply = (total: number) => { zip.providerRequest({ payload: {} }); zip.messageEnd({ role: "assistant", stopReason: "stop", usage: { input: total, cacheRead: 0, cacheWrite: 0, output: 10 } }); };
		zip.beforeAgentStart(ctx);
		const req = await zip.context({ messages: flat(big) }, ctx); // warm run start, far above the threshold: the valve fires
		expect(req).toBeDefined();
		reply(5_000); // this request first carried the edit
		zip.beforeAgentStart(ctx); // the user answers at once (warm)
		expect(await zip.context({ messages: flat(big) }, ctx)).toBeUndefined();
		expect(ledger().filter((r) => r.type === "b2b_skip")).toEqual([expect.objectContaining({ where: "run" })]);
	});

	test("5. lawPrices ignores a present model.cost: the ledger prices any model by its class ratios", async () => {
		expect(lawPrices.length).toBe(2); // (class, long tier): the model is not even an argument
		record("q/odd", { explicit: false, total: 10_000 });
		process.env.PI_ZIP_COLD_CAP = "3000";
		const model = { provider: "q", id: "odd", contextWindow: 1_000_000, cost: { input: 10, output: 1, cacheRead: 9, cacheWrite: 50 }, promptCache: { short: 300 } };
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 40_000), A("a2"), U("u2", "two"), A("a3"), U("u3", "now")];
		const zip = new Zip(fakePi().pi as Any);
		const { ctx } = fakeCtx(entries, { model, branch: [{ type: "message", message: { role: "assistant", provider: "q", model: "odd", stopReason: "stop", timestamp: Date.now() - 400_000, content: [] } }] });
		zip.sessionStart(ctx);
		zip.beforeAgentStart(ctx);
		await zip.context({ messages: flat(entries) }, ctx);
		expect(ledger().find((r) => r.type === "law")).toMatchObject({ cls: "automatic", wr: 5, prSrc: "class" }); // w/r = 1 / 0.2: kappa = 4
		expect(zip.status()).toContain("cache q/odd: automatic (from usage), read 0.2 / write 1 / output 4 x input (class ratios)");
	});
});
