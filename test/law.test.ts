// The round-5 law (verdict section 8, tests 1-7), the suffix rewrite base T, and the learned cache survival / regime class.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lawPrices, loadStats, pWarm, record, sample, type Prices } from "../src/learn.ts";
import { compactionRoom, editAllowed, lawTerms, legacyValve, planContext, settings, type Law } from "../src/plan.ts";
import { Zip } from "../src/run.ts";
import { A, AX, fakeCtx, fakePi, longTurn, R, U, type Any } from "./helpers.ts";

const ANTH: Prices = { r: 0.3, w: 3.75, input: 3, out: 15, cls: "explicit", src: "model.cost" };
const ANTH_1H: Prices = { ...ANTH, w: 6 };
const GLM: Prices = { r: 0.186, w: 1, input: 1, out: 4.4 / 1.4, cls: "automatic", src: "model.cost" };
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

	test("6. no model.cost (and no response yet) -> the legacy rule; a known class without prices uses the class ratios", () => {
		expect(lawPrices({ provider: "p", id: "m" }, undefined, false)).toBeNull();
		for (const [B, A, room] of [[200_000, 90_000, null], [183_000, 131_000, null], [180_000, 170_000, 175_424]] as const) expect(editAllowed(B, A, 1, room, null, 2_400)).toBe(legacyValve(B, A, room));
		expect(lawPrices({}, "explicit", false)).toMatchObject({ r: 0.1, w: 1.25, src: "class default" });
		expect(lawPrices({}, "explicit", true)).toMatchObject({ w: 2 });
		expect(lawPrices({}, "automatic", false)).toMatchObject({ r: 0.2, w: 1 });
		expect(lawPrices({ cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } }, undefined, false)).toMatchObject({ r: 0.26, w: 1.4, cls: "automatic", src: "model.cost" });
		expect(lawPrices({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, undefined, false)).toMatchObject({ w: 3.75, cls: "explicit" });
		expect(lawPrices({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, "automatic", false)).toMatchObject({ w: 3 }); // usage says no write premium
		expect(lawPrices({ cost: { input: 1, cacheRead: 2 } }, "automatic", false)).toMatchObject({ src: "class default" }); // insane: read above input
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

describe("rewrite base T: only the suffix after the earliest edit is rewritten", () => {
	test("the law: T < A lowers K and opens the warm valve earlier; T = A by default", () => {
		expect(editAllowed(70_000, 40_000, 1, null, ANTH, 2_400)).toBe(false); // D 30K < 47K
		expect(editAllowed(70_000, 40_000, 1, null, ANTH, 2_400, 0, 10_000)).toBe(true); // EOQ at T = 10K: 23.5K
		expect(lawTerms(70_000, 40_000, 1, null, ANTH, 2_400, 0, 10_000).K).toBeCloseTo(3.45 * 10_000);
		expect(lawTerms(70_000, 40_000, 1, null, ANTH, 2_400, 0, 90_000).K).toBeCloseTo(3.45 * 40_000); // never above A
		expect(lawTerms(70_000, 40_000, 0, null, ANTH, 2_400, 0, 10_000).K).toBeCloseTo(-3.45 * 30_000); // cold: T is irrelevant
	});

	test("the planner measures T: the same 30K fold fires when an old untouched prefix stays cached, not when it would be rewritten", () => {
		const outs = (n: number) => Array.from({ length: n }, (_, t) => [U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 12_000), A(`z${t}`)]).flat();
		const tail = [U("uP", "prev"), A("aP"), U("uN", "now")];
		const prose = [U("up", "talk"), AX("x0", 160_000)]; // ~40K tokens nothing can fold
		const o = { mode: "warm" as const, sys: 0, cwd: ".", promptPending: false, coldCap: 45_000, model: { contextWindow: 1_000_000 }, law: { pr: ANTH, g: 2_400, pWarm: 1 }, trace: [] as Any[] };
		const early = planContext([...prose, ...outs(10), ...tail], o); // folds start after the prose: T ~ 3K
		expect(early).not.toBeNull();
		expect(o.trace.at(-1).T).toBeLessThan(5_000);
		const late = { ...o, trace: [] as Any[] };
		expect(planContext([...outs(10), ...prose, ...tail], late)).toBeNull(); // folds start at the top: T = A ~ 43K
		expect(late.trace.at(-1).T).toBeGreaterThan(40_000);
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
		expect(zip2.status()).toContain("cache zhipu/glm: automatic (from usage), read 0.26 / write 1.4 / output 4.4 $/M (model.cost), survival 360-420s 0.80 n1");
	});

	test("a cold run plan logs Phi, K, eta, T, g, w/r, P(warm) and the price and survival sources", async () => {
		process.env.PI_ZIP_COLD_CAP = "3000";
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 40_000), A("a2"), U("u2", "two"), A("a3"), U("u3", "now")];
		const zip = new Zip(fakePi().pi as Any);
		const { ctx } = fakeCtx(entries, { branch: [{ type: "message", message: { role: "assistant", provider: "p", model: "m", stopReason: "stop", timestamp: Date.now() - 400_000, content: [] } }] });
		zip.sessionStart(ctx);
		zip.beforeAgentStart(ctx);
		await zip.context({ messages: entries.flatMap((x: Any) => x.messages) }, ctx);
		const law = readFileSync(process.env.PI_ZIP_LEDGER!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.type === "law");
		expect(law).toMatchObject({ where: "run", g: 2500, pWarm: 0, survSrc: "prior", cls: "explicit", wr: 12.5, prSrc: "model.cost" });
		expect(law.steps.at(-1)).toMatchObject({ at: "plan", ok: true });
		expect(law.steps.at(-1).K).toBeLessThan(0);
		expect(Object.keys(law.steps.at(-1))).toEqual(["at", "ok", "B", "A", "T", "phi", "K", "eta"]);
	});
});
