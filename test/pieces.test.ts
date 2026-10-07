import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheTtlMs, detectCold, isColdByTtl } from "../src/cache.ts";
import { classifyRecoverability, isReadOnlyBash } from "../src/classify.ts";
import { fmtK, noticeText, Stats, statsText, type NoticeAction } from "../src/notice.ts";
import { handleFor, makePlaceholder, pickKeyLines } from "../src/placeholder.ts";
import { parseRange, recalledHandlesFromBranch, recallSections, resolveHandlesInBranch, sliceRecall } from "../src/recall.ts";
import { handleTable } from "../src/summary.ts";
import { tokensOf } from "../src/util.ts";

describe("handles and placeholders", () => {
	const h = handleFor("abc123");
	test("handle is a deterministic 10-char base36 string, distinct per entry", () => {
		expect(h).toBe(handleFor("abc123"));
		expect(h).toMatch(/^[0-9a-z]{10}$/);
		expect(handleFor("abc124")).not.toBe(h);
	});
	test("marker line, recall line, and refusal of short outputs", () => {
		const ph = makePlaceholder("y".repeat(9000), "bash", "cat data/f3.txt", h)!;
		expect(ph.startsWith(`[folded by pi-zip · bash cat data/f3.txt · 9000 chars, 1 lines · handle ${h}]`)).toBe(true);
		expect(ph).toContain(`zip_recall("${h}")`);
		expect(ph).toContain("stays recallable even after later summaries or compaction");
		expect(ph).toContain("Do not guess its content");
		expect(makePlaceholder("short", "bash", "", h)).toBeNull();
	});
	const ktxt = ["record 0001: alpha-beta-gamma", "SECRET-CODE-1: zebra111", "nothing interesting here", "note=lorem ipsum dolor", "checksum=00491 note=x", "ERROR: connection reset by peer", "hash a1b2c3d4e5f60718 written", "took 250 ms to complete", "92345678", "final line ok"].join("\n");
	test("key lines: first+last, errors, ids, key=value, hex, labelled numbers; sorted, capped, deterministic", () => {
		const kl = pickKeyLines(ktxt, 8);
		const nos = kl.map((k) => k.no);
		expect(nos[0]).toBe(1);
		expect(nos.at(-1)).toBe(10);
		for (const n of [2, 4, 5, 6, 7, 8]) expect(nos).toContain(n);
		expect(nos).not.toContain(3); // filler
		expect(nos).not.toContain(9); // digits only is not id-like
		expect(nos).toEqual([...nos].sort((a, b) => a - b));
		expect(pickKeyLines(ktxt, 3).length).toBeLessThanOrEqual(3);
		expect(pickKeyLines(ktxt, 0)).toEqual([]);
		expect(JSON.stringify(pickKeyLines(ktxt, 8))).toBe(JSON.stringify(kl));
	});
	test("the placeholder lists key lines with original line numbers", () => {
		const ph = makePlaceholder(ktxt + "\n" + "pad ".repeat(400), "bash", "cat f", h)!;
		expect(ph).toMatch(/6: ERROR: connection reset by peer/);
	});
	test("handle table: one row per folded output, header explains recallability", () => {
		const t = handleTable([{ handle: h, tool: "bash", args: "cat f", hint: "SECRET-CODE-3: falcon333" }, { handle: "x", tool: "read", args: "", hint: "" }])!;
		expect(t).toContain(`- ${h} · bash cat f · SECRET-CODE-3: falcon333`);
		expect(t).toMatch(/recallable with zip_recall/);
		expect(handleTable([])).toBeNull();
	});
});

describe("recall", () => {
	const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}: alpha beta`).join("\n");
	test("full text exact; range; grep; clip", () => {
		const full = sliceRecall(long, {});
		expect(full.text).toBe(long);
		expect(full.totalLines).toBe(500);
		expect(sliceRecall(long, { range: "2-4" }).text).toBe("[range: lines 2-4 of 500]\nline 2: alpha beta\nline 3: alpha beta\nline 4: alpha beta");
		expect(sliceRecall(long, { range: "7" }).text.endsWith("line 7: alpha beta")).toBe(true);
		expect(sliceRecall(long, { range: "x-y" }).text).toContain("invalid range");
		const g = sliceRecall(long, { grep: "line 4[0-9]:" });
		expect(g.matched).toBe(10);
		expect(g.text).toContain("41: line 41");
		expect(sliceRecall(long, { grep: "zzzznope" }).matched).toBe(0);
		expect(sliceRecall(long, { grep: "(" }).matched).toBe(0); // an invalid regex falls back to a literal match
		const huge = sliceRecall("z".repeat(60_000), {});
		expect(huge.clipped).toBe(true);
		expect(huge.text.length).toBeLessThan(21_000);
		expect(huge.text).toContain("clipped");
		expect(parseRange("3-1")).toBeNull();
	});
	const tool = (id: string, text: string) => ({ type: "message", id, message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] } });
	test("recall resolves entries before a compaction, batches, and labels missing handles", () => {
		const a = tool("entryA", Array.from({ length: 50 }, (_, i) => `line ${i + 1}: alpha`).join("\n"));
		const branch = [{ type: "message", id: "m0", message: { role: "user", content: "q" } }, a, { type: "compaction", id: "c1", summary: "s", firstKeptEntryId: "m0b" }, { type: "message", id: "m0b", message: { role: "user", content: "q2" } }, tool("entryB", "beta output\nsecond line")];
		const hA = handleFor("entryA");
		const hB = handleFor("entryB");
		const res = resolveHandlesInBranch(branch, [hA, hB, "zzzzzzzzzz"]);
		expect(res.items[0].text).toBe(a.message.content[0].text);
		expect(res.items[1].text).toBe("beta output\nsecond line");
		expect(res.items[2].text).toBeNull();
		const secs = recallSections(res.items, { grep: "line 4[0-9]:" });
		expect(secs).toMatchObject({ ok: 2, missing: 1 });
		expect(secs.text).toContain("[handle zzzzzzzzzz] not found");
		expect(secs.text).toContain("41: line 41: alpha");
	});
	test("the recalled set is rebuilt from zip_recall calls in the branch (and only those)", () => {
		const call = (id: string, name: string, args: object) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: "t" + id, name, arguments: args }] } });
		const set = recalledHandlesFromBranch([call("1", "zip_recall", { handle: "aaaaaaaaaa" }), call("2", "zip_recall", { handles: ["bbbbbbbbbb", "cccccccccc"] }), call("3", "other", { handle: "dddddddddd" })]);
		expect([...set].sort()).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
	});
});

describe("classify", () => {
	test("read-only bash whitelist", () => {
		for (const c of ["ls -la /tmp", "cat a b | wc -l", "git log --oneline -5", "cat missing 2>/dev/null", "LC_ALL=C cat f.txt"]) expect(isReadOnlyBash(c)).toBe(true);
		for (const c of ["npm test", "git push origin main", "cat a > b", "cat a && rm -rf /tmp/x", "python3 build.py", ""]) expect(isReadOnlyBash(c)).toBe(false);
	});
	test("read: rereadable iff the file is unchanged on disk; a changed or missing file is not", () => {
		const dir = mkdtempSync(join(tmpdir(), "zip-"));
		writeFileSync(join(dir, "f.txt"), "hello\nworld\n");
		expect(classifyRecoverability("read", { path: "f.txt" }, "hello\nworld\n", dir)).toBe("rereadable");
		expect(classifyRecoverability("read", { path: "f.txt" }, "hello\nworld\n\n[Showing lines 1-2 of 2]", dir)).toBe("rereadable");
		expect(classifyRecoverability("read", { path: "f.txt" }, "stale", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("read", { path: "nope.txt" }, "x", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("write", { path: "f.txt" }, "x", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("grep", {}, "x", dir)).toBe("rereadable");
	});
});

describe("cache", () => {
	test("promptCache is in SECONDS (reading it as ms would make every prompt cold)", () => {
		expect(cacheTtlMs({ short: 300 }, 1)).toBe(300_000);
		expect(cacheTtlMs({ long: 3600 }, 1)).toBe(3_600_000);
		expect(cacheTtlMs(undefined, 300_000)).toBe(300_000);
		const t0 = 1_000_000;
		expect(isColdByTtl(t0, t0 + 9_000, cacheTtlMs({ short: 300 }))).toBe(false);
		expect(isColdByTtl(t0, t0 + 360_000, cacheTtlMs({ short: 300 }))).toBe(true);
	});
	test("exactly the TTL is still warm; no prior request is warm", () => {
		expect(isColdByTtl(1000, 4001, 3000)).toBe(true);
		expect(isColdByTtl(1000, 4000, 3000)).toBe(false);
		expect(isColdByTtl(0, 999_999, 3000)).toBe(false);
	});
	afterEach(() => delete process.env.PI_ZIP_TTL_SECS);
	test("detectCold reads the model's TTL, the branch clock, and PI_ZIP_TTL_SECS", () => {
		const now = 10_000_000;
		const branch = [{ type: "message", message: { timestamp: now - 100_000 } }];
		expect(detectCold({ promptCache: { short: 300 } }, 0, branch, now).cold).toBe(false);
		expect(detectCold({ promptCache: { short: 60 } }, 0, branch, now).cold).toBe(true);
		process.env.PI_ZIP_TTL_SECS = "20";
		expect(detectCold({ promptCache: { short: 300 } }, now - 5000, branch, now).cold).toBe(false);
		expect(detectCold({ promptCache: { short: 300 } }, 0, branch, now).cold).toBe(true);
		expect(detectCold({}, 0, [], now)).toMatchObject({ cold: false, reason: "no prior request" });
	});
});

describe("notices and stats", () => {
	test("fmtK", () => expect([fmtK(84200), fmtK(31500), fmtK(182000), fmtK(41000)]).toEqual(["84.2K", "31.5K", "182K", "41K"]));
	const fold: NoticeAction = { kind: "fold", count: 12, tokensBefore: 84200, tokensAfter: 31500, ms: 0.94 };
	test("exact formats; fold and summary merge into ONE line", () => {
		expect(noticeText([fold])).toBe("pi-zip · folded 12 old outputs · 84.2K → 31.5K tokens · 0.9 ms · originals recallable");
		const sync: NoticeAction = { kind: "summary", count: 64, tokensBefore: 182000, tokensAfter: 41000, ms: 8400 };
		expect(noticeText([sync])).toBe("pi-zip · summarized 64 requests · 182K → 41K tokens · waited 8.4 s");
		expect(noticeText([{ ...sync, prepared: true }])).toBe("pi-zip · summarized 64 requests · 182K → 41K tokens · 8.4 s (done while you were away)");
		const merged = noticeText([fold, sync]);
		expect(merged).not.toContain("\n");
		expect(merged.startsWith("pi-zip · folded 12")).toBe(true);
		expect(merged).toContain("waited 8.4 s");
		expect(noticeText([{ ...fold, count: 1, ms: 4.44 }])).toContain("folded 1 old output · ");
	});
	test("honest stats: avoided writes and reads, minus summary calls, recalls and pressure rewrites", () => {
		const s = new Stats();
		s.writeSavedTokens = 100_000;
		s.readSavedTokens = 1_000_000;
		s.summaryUsd = 0.05;
		s.recallChars = 40_000; // ~10K tokens re-entering the context at the write price
		s.pressureRewriteTokens = 100_000;
		const p = { cacheWrite: 3.75, cacheRead: 0.3 };
		// 100K*3.75 + 1M*0.3 = 0.675 ; - 0.05 - 10K*3.75 (0.0375) - 100K*(3.75-0.3) (0.345) = 0.2425
		expect(s.savedUsd(p)).toBeCloseTo(0.2425, 6);
		expect(s.savedUsd(null)).toBeNull();
		s.folds = 3; s.foldedTokens = 50_000; s.recalls = 2;
		const txt = statsText(s, { cost: { cacheWrite: 3.75, cacheRead: 0.3 } });
		expect(txt).toContain("folded 3 outputs (50K tokens)");
		expect(txt).toContain("2 recalls");
		expect(txt).toContain("$0.24,");
		expect(statsText(new Stats(), {})).toContain("n/a");
	});
	test("recalling costs more than it saved is reported as a loss, not hidden", () => {
		const s = new Stats();
		s.writeSavedTokens = 1000;
		s.recallChars = 400_000;
		expect(s.savedUsd({ cacheWrite: 3.75, cacheRead: 0.3 })!).toBeLessThan(0);
	});
});

test("token estimate follows Pi's chars/4 rules", () => {
	expect(tokensOf({ role: "user", content: "x".repeat(400) })).toBe(100);
	expect(tokensOf({ role: "toolResult", content: [{ type: "text", text: "x".repeat(400) }, { type: "image" }] })).toBe(100 + 1200);
	expect(tokensOf({ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(40) }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] })).toBe(Math.ceil((40 + 4 + JSON.stringify({ command: "ls" }).length) / 4));
	expect(tokensOf({ role: "compactionSummary", summary: "x".repeat(80) })).toBe(20);
});
