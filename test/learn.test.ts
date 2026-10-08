// Learned cache survival and regime class (learn.ts): counts only, monotone in the gap, censoring, forgetting, persistence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as describeSurvival, HALF_LIFE, loadStats, pWarm, record, sample } from "../src/learn.ts";

const tmpFile = () => join(tmpdir(), `pi-zip-surv-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

describe("learned cache survival", () => {
	let path = "";
	beforeEach(() => (path = tmpFile()));
	afterEach(() => rmSync(path, { force: true }));

	test("Claude: a 360 s return that reads nothing is dead; the class is explicit from the first write", () => {
		const e = record("s2a/claude", { explicit: true, total: 50_000, gapS: 360, alive: sample(49_000, 0, 50_000) }, path);
		expect(e.cls).toBe("explicit");
		expect(pWarm(e, 360, 300).p).toBeLessThan(0.5);
		expect(pWarm(e, 200, 300)).toEqual({ p: 1, src: "prior" }); // shorter gaps keep the declared TTL
		// a provider that declared 1 h but kills at 360 s: one miss overrides the prior
		const one = record("x/declared-1h", { explicit: true, total: 50_000, gapS: 400, alive: false }, path);
		expect(pWarm(one, 400, 3600).p).toBeLessThan(0.5);
		expect(pWarm(one, 2000, 3600).p).toBeLessThan(0.5); // monotone: longer gaps are no more alive than a dead one
	});

	test("GLM: one alive read at 365 s makes every shorter gap warm, longer gaps keep the prior", () => {
		const e = record("zhipu/glm", { explicit: false, total: 60_000, gapS: 365, alive: true }, path);
		expect(pWarm(e, 340, 300)).toMatchObject({ src: "learned" });
		expect(pWarm(e, 340, 300).p).toBeGreaterThanOrEqual(0.5);
		expect(pWarm(e, 900, 300)).toEqual({ p: 0, src: "prior" });
		expect(describeSurvival(e, 300)).toContain("360-420s 0.80 n1");
	});

	test("censoring: small prompts, misses right after our own edit, and prompts someone else shrank prove nothing", () => {
		expect(sample(5_000, 0, 6_000)).toBeNull(); // the shared system prefix alone could explain it
		expect(sample(50_000, 0, 60_000, true)).toBeNull(); // after our edit: the provider may not look back that far
		expect(sample(50_000, 30_000, 60_000, true)).toBe(true); // ... but a read of the untouched prefix proves the cache alive
		expect(sample(50_000, 0, 30_000)).toBeNull(); // Pi compacted in between
		expect(sample(50_000, 20_000, 30_000)).toBe(true);
		expect(sample(50_000, 0, 60_000)).toBe(false);
		const e = record("p/m", { explicit: false, total: 60_000, gapS: 400, alive: null }, path);
		expect(e.n).toBe(0);
		expect(e.bins).toEqual({});
		expect(record("p/m", { explicit: false, total: 60_000, gapS: 10, alive: true }, path).n).toBe(0); // below 30 s: not a return
	});

	test("forgetting: an observation counts half after HALF_LIFE newer ones in its bin; the curve stays monotone", () => {
		record("p/m", { explicit: false, total: 60_000, gapS: 400, alive: true }, path);
		let e = record("p/m", { explicit: false, total: 60_000, gapS: 400, alive: false }, path);
		for (let i = 1; i < HALF_LIFE; i++) e = record("p/m", { explicit: false, total: 60_000, gapS: 400, alive: false }, path);
		expect(e.bins["7"][0]).toBeCloseTo(0.5, 2);
		record("q/m", { explicit: false, total: 60_000, gapS: 1000, alive: true }, path);
		const q = record("q/m", { explicit: false, total: 60_000, gapS: 100, alive: false }, path);
		expect(pWarm(q, 100, 300).p).toBeCloseTo(pWarm(q, 1000, 300).p); // a contradiction is pooled, never inverted
	});

	test("persistence round-trip, and a corrupt or malformed file is ignored (then rewritten)", () => {
		record("a/b", { explicit: true, total: 60_000, gapS: 365, alive: false }, path);
		const f = loadStats(path);
		expect(f.models["a/b"]).toEqual({ cls: "explicit", n: 1, bins: { "7": [0, 1] } });
		expect(JSON.parse(readFileSync(path, "utf8")).models["a/b"].bins["7"]).toEqual([0, 1]); // counts only: no content, no paths
		writeFileSync(path, "{not json");
		expect(loadStats(path)).toEqual({ v: 1, models: {} });
		writeFileSync(path, JSON.stringify({ v: 1, models: { "a/b": { cls: "weird", n: "x", bins: { "7": [1, -1], "99": [1, 1], "3": [2, 1] } } } }));
		expect(loadStats(path).models["a/b"]).toEqual({ n: 0, bins: { "3": [2, 1] } });
		writeFileSync(path, "[]");
		expect(record("a/b", { explicit: false, total: 60_000, gapS: 365, alive: true }, path).n).toBe(1);
		expect(loadStats(path).models["a/b"].cls).toBe("automatic");
	});
});

