import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairPayload } from "../src/guard.ts";
import { cacheTtlMs, detectCold, isColdByTtl, observedTier } from "../src/cache.ts";
import { classifyRecoverability, isReadOnlyBash } from "../src/classify.ts";
import { fmtK, noticeText, Stats, statsText, type NoticeAction } from "../src/notice.ts";
import { clipMid, handleFor, makePlaceholder, makePlaceholderFor, outcomeHint, pickKeyLines, shortArgs } from "../src/placeholder.ts";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { A, type Any, R, U } from "./helpers.ts";
import { parseRange, recalledHandlesFromBranch, recallSections, resolveHandlesInBranch, sliceRecall } from "../src/recall.ts";
import { handleRowsOf, handleTable, INDEX_TOKENS, skeleton } from "../src/summary.ts";
import { tokensOf } from "../src/util.ts";

const zipRecallName = "zip_recall";

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
		expect(ph).toContain("recallable even after summaries or compaction");
		expect(ph).toContain("Do not guess its content");
		expect(makePlaceholder("short", "bash", "", h)).toBeNull();
	});
	test("recall nudge: original bytes, instant, free, no side effects, prefer it to re-running or re-reading", () => {
		const ph = makePlaceholder("y".repeat(9000), "bash", "ls", h)!;
		expect(ph).toContain("byte for byte");
		expect(ph).toContain("instant, free, no side effects");
		expect(ph).toMatch(/prefer it to re-running or re-reading/);
	});
	test("placeholder states turn and, for bash, exit status and test counts; stays on the marker line", () => {
		const out = "ok\n".repeat(400) + " 12 pass\n 3 fail\nRan 15 tests\n\nCommand exited with code 1";
		const ph = makePlaceholder(out, "bash", "bun test", h, 8, { turn: 12, isError: true })!;
		expect(ph.split("\n")[0]).toBe(`[folded by pi-zip · bash bun test · turn 12 · exit 1, 12 passed, 3 failed · ${out.length} chars, ${out.split("\n").length} lines · handle ${h}]`);
		const clean = makePlaceholder("ok\n".repeat(400) + "5 passed, 0 failed in 1.2s", "bash", "pytest", h, 8, { turn: 3, isError: false })!;
		expect(clean.split("\n")[0]).toContain("· turn 3 · exit 0, 5 passed, 0 failed ·");
		const read = makePlaceholder("l\n".repeat(900), "read", "src/a.ts offset=10 limit=50", h, 8, { turn: 4, isError: false })!;
		expect(read.split("\n")[0]).toContain("read src/a.ts offset=10 limit=50 · turn 4 · 1800 chars"); // no exit status for non-bash tools
	});
	test("look-alike items render differently: same command, different run; same file, different slice; same command prefix", () => {
		const run = (n: number, f: number) => "ok\n".repeat(400) + ` ${n} pass\n ${f} fail` + (f ? "\n\nCommand exited with code 1" : "");
		const a = makePlaceholder(run(10, 0), "bash", "bun test", handleFor("e1"), 8, { turn: 5, isError: false })!;
		const b = makePlaceholder(run(10, 2), "bash", "bun test", handleFor("e2"), 8, { turn: 9, isError: true })!;
		const c = makePlaceholder(run(10, 2), "bash", "bun test", handleFor("e3"), 8, { turn: 9, isError: true })!;
		expect(a).not.toBe(b);
		expect(a.split("\n")[0]).not.toBe(b.split("\n")[0]);
		expect(b.split("\n")[0].replace(handleFor("e2"), "")).toBe(c.split("\n")[0].replace(handleFor("e3"), "") ); // only the handle tells identical runs apart
		expect(shortArgs({ path: "/p/a.ts", offset: 1, limit: 100 })).not.toBe(shortArgs({ path: "/p/a.ts", offset: 101, limit: 100 }));
		const base = "cd /some/long/working/directory/for/the/project && npm run test -- --runInBand --testPathPattern=";
		expect(shortArgs({ command: base + "alpha.spec.ts" })).not.toBe(shortArgs({ command: base + "bravo.spec.ts" })); // the tail survives the clip
	});
	test("byte-stable: the same item always renders the same placeholder", () => {
		const out = "line\n".repeat(300) + "7 passed, 1 failed";
		const mk = () => makePlaceholder(out, "bash", shortArgs({ command: "npm test" }), h, 8, { turn: 2, isError: false });
		expect(mk()).toBe(mk());
		const entries = [U("u1", "x"), A("a1", ["c1"]), R("r1", "c1", 0, out), A("a2"), U("u2", "y")];
		const blocks = buildBlocks(entries);
		const calls = toolCallIndex(blocks);
		const first = makePlaceholderFor(blocks[2], calls)!;
		expect(makePlaceholderFor(buildBlocks(entries)[2], toolCallIndex(buildBlocks(entries)))).toBe(first);
		expect(first).toContain("· turn 1 · exit 0, 7 passed, 1 failed ·");
		expect(first).toContain("bash ls");
	});
	test("outcomeHint and clipMid", () => {
		expect(outcomeHint("x", "read", false)).toBe("");
		expect(outcomeHint("x", "bash")).toBe("");
		expect(outcomeHint("x\nCommand timed out after 30 seconds", "bash", true)).toBe("timed out");
		expect(outcomeHint("Tests: 1 failed, 5 passed, 6 total", "bash", false)).toBe("exit 0, 5 passed, 1 failed");
		expect(outcomeHint("3 errors found", "bash")).toBe(""); // counts need passed/failed
		expect(clipMid("a  b\nc", 20)).toBe("a b c");
		const c = clipMid("x".repeat(50) + "TAIL", 21);
		expect(c).toHaveLength(21);
		expect(c.endsWith("TAIL") && c.includes("…")).toBe(true);
	});
	test("summary lists turn, outcome and handle so look-alike runs stay separable", () => {
		const t = handleTable([
			{ handle: "h1", tool: "bash", args: "bun test", hint: "x", turn: 5, outcome: "exit 0, 10 passed" },
			{ handle: "h2", tool: "bash", args: "bun test", hint: "x", turn: 9, outcome: "exit 1, 8 passed, 2 failed" },
		])!;
		expect(t).toContain("- h1 · bash bun test · turn 5 · exit 0, 10 passed · x");
		expect(t).toContain("- h2 · bash bun test · turn 9 · exit 1, 8 passed, 2 failed · x");
		const blocks = buildBlocks([U("u1", "x"), A("a1", ["c1"]), R("r1", "c1", 9000), A("a2")]);
		expect(skeleton(blocks, null).text).toMatch(/`ls` -> exit 0 \(turn 1, [0-9a-z]{10}\)/);
	});
	test("summary lists the handle of every result, small ones included, and each resolves with recall", () => {
		const tcall = (id: string, calls: Any[]) => {
			const m = { role: "assistant", content: calls.map(([cid, name, args]) => ({ type: "toolCall", id: cid, name, arguments: args })) };
			return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
		};
		const tres = (id: string, call: string, name: string, text: string) => {
			const m = { role: "toolResult", toolCallId: call, toolName: name, isError: false, content: [{ type: "text", text }] };
			return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
		};
		const entries = [
			U("u1", "go"),
			tcall("a1", [["c1", "bash", { command: "echo small" }], ["c2", "web_fetch", { url: "https://example.com/x" }], ["c3", "read", { path: "src/a.ts" }], ["c4", zipRecallName, { handle: "zzz" }]]),
			tres("r1", "c1", "bash", "small bash output"),
			tres("r2", "c2", "web_fetch", "small fetched page"),
			tres("r3", "c3", "read", "small file"),
			tres("r4", "c4", zipRecallName, "recalled"),
			A("a2"),
		];
		const text = skeleton(buildBlocks(entries), null).text;
		expect(text).toContain(`\`echo small\` -> exit 0 (turn 1, ${handleFor("r1")})`);
		expect(text).toContain(`web_fetch {"url":"https://example.com/x"} (turn 1, ${handleFor("r2")})`);
		expect(text).toContain(`- src/a.ts (read: ${handleFor("r3")})`);
		expect(text).not.toContain(handleFor("r4")); // a recall result is never listed
		const branch = entries.map((e) => e.sourceEntry);
		const { items } = resolveHandlesInBranch(branch, [handleFor("r1"), handleFor("r2"), handleFor("r3")]);
		expect(items.map((i) => i.text)).toEqual(["small bash output", "small fetched page", "small file"]);
	});
	test("capped lists and the handle table say how many older entries they left out", () => {
		const many = Array.from({ length: 70 }, (_, i) => i);
		const entries = [U("u1", "go"), ...many.flatMap((i) => [A(`a${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 0, "tiny")]), A("z")];
		const t = skeleton(buildBlocks(entries), null).text;
		expect(t).toContain("[\u2026 10 older omitted \u2026]");
		expect(t).toContain(handleFor("r69"));
		const rows = many.map((i) => ({ handle: `h${i}`, tool: "bash", args: "", hint: "" }));
		const table = handleTable(rows)!;
		expect(table).toContain("30 older folded outputs omitted");
		expect(table).toContain("- h69 ");
		expect(table).not.toContain("- h29 ");
		expect(table).toContain("- h30 ");
	});
	test("handle index: handles of an earlier summary survive when its own block is full of unrelated carried-forward text", () => {
		const session = (n: number, from = 0) => {
			const ids = Array.from({ length: n }, (_, i) => from + i);
			return [U(`u${from}`, "go"), ...ids.flatMap((i) => [A(`a${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 0, "tiny")]), A(`z${from}`)];
		};
		const older = skeleton(buildBlocks(session(30)), null).text;
		const prev = older.replace("\n## User requests", "\n## Earlier summary (carried forward)\n" + "filler ".repeat(2500) + "\n## User requests");
		const t = skeleton(buildBlocks(session(3, 100)), prev).text;
		expect((t.match(/filler/g) ?? []).length).toBeLessThan(3000 / 7 + 5); // only a bounded excerpt of the free text (17,500 chars of it)
		for (let i = 0; i < 30; i++) expect(t).toContain(handleFor(`r${i}`));
		expect(t.split("\n").filter((l) => l.includes(handleFor("r0")))).toHaveLength(1); // each handle once
	});
	test("handle index: newest first, only handles not listed elsewhere, within the token budget, and says what did not fit", () => {
		const session = (n: number) => [U("u1", "go"), ...Array.from({ length: n }, (_, i) => i).flatMap((i) => [A(`a${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 0, "tiny")]), A("z")];
		const first = skeleton(buildBlocks(session(1200)), null).text; // lists the newest 60 commands, indexes the rest under the budget
		const idx = first.slice(first.indexOf("## Handle index"));
		expect(Math.ceil(idx.length / 4)).toBeLessThanOrEqual(INDEX_TOKENS);
		expect(idx).toMatch(/\[\u2026 \d+ older handles not listed \u2026\]/);
		const rows = handleRowsOf(first).map((r) => r.handle);
		expect(rows).toContain(handleFor("r1199"));
		expect(rows).toContain(handleFor("r1139"));
		expect(rows).toContain(handleFor("r1138")); // newest of the indexed ones
		expect(rows.indexOf(handleFor("r1138"))).toBeLessThan(rows.indexOf(handleFor("r1100")));
		expect(first).not.toContain(handleFor("r0")); // oldest: over budget
		expect(new Set(rows).size).toBe(rows.length); // each handle once
		const second = skeleton(buildBlocks([U("u1", "more"), A("b1", ["d1"]), R("s1", "d1", 0, "tiny"), A("y")]), first).text;
		expect(second).toContain(handleFor("r1138"));
		expect(second).toContain(handleFor("s1"));
		expect(Math.ceil(second.slice(second.indexOf("## Handle index")).length / 4)).toBeLessThanOrEqual(INDEX_TOKENS);
	});
	test("handleRowsOf reads the commands, files, other-calls, table and index formats of earlier summaries", () => {
		const a = handleFor("e1"), b = handleFor("e2"), c = handleFor("e3"), d = handleFor("e4"), e = handleFor("e5");
		const text = [
			"[summary of earlier conversation by pi-zip]",
			"## Files touched",
			`- src/a (b).ts (read: ${a}, edit: ${b})`,
			"- src/old.ts (read)",
			"## Commands run (with exit status)",
			`\`bun test\` -> exit 1 (turn 4, ${c})`,
			"## Other tool calls (turn, handle)",
			`web_fetch {"url":"https://x"} (turn 2, ${d})`,
			"## Narrative (model-written)",
			`- ${a} \u00b7 bash not a row, narrative text`,
			"## Folded outputs (originals recallable with zip_recall)",
			`- ${e} \u00b7 bash cat f \u00b7 turn 7 \u00b7 exit 0 \u00b7 hint`,
			"## Handle index (older outputs)",
			`- ${b} \u00b7 read src/z.ts \u00b7 turn 3`,
			"[\u2026 5 older handles not listed \u2026]",
		].join("\n");
		expect(handleRowsOf(text)).toEqual([
			{ handle: a, tool: "read", args: "src/a (b).ts" },
			{ handle: b, tool: "edit", args: "src/a (b).ts" },
			{ handle: c, tool: "bash", args: "bun test", turn: 4 },
			{ handle: d, tool: "web_fetch", args: '{"url":"https://x"}', turn: 2 },
			{ handle: e, tool: "bash", args: "cat f", turn: 7 },
			{ handle: b, tool: "read", args: "src/z.ts", turn: 3 },
		]);
		expect(handleRowsOf(null)).toEqual([]);
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
		expect(huge.text).toContain("offset=20000"); // the no-argument page says how to get the rest
		expect(huge.nextOffset).toBe(20_000);
		expect(parseRange("3-1")).toBeNull();
	});
	// reassemble every page of a selection through the public slicer, following the hint's offset each time
	const pages = (text: string, opts: Record<string, unknown> = {}) => {
		let out = "";
		let off: number | null = 0;
		let n = 0;
		while (off !== null && n++ < 100_000) {
			const sl = sliceRecall(text, { ...opts, offset: off });
			out += sl.body;
			off = sl.nextOffset;
		}
		return out;
	};
	test("a single 45,000-character line is recallable in full: pages reassemble byte for byte (I2)", () => {
		const line = Array.from({ length: 45_000 }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join("");
		const text = `head\n${line}\ntail`;
		expect(pages(text)).toBe(text);
		expect(pages(text, { limit: 777 })).toBe(text);
		expect(pages(text, { range: "2" })).toBe(line);
		expect(pages(text, { range: "2", limit: 4096 })).toBe(line);
		expect(pages(text, { grep: "head|tail" })).toBe("1: head\n3: tail");
		const first = sliceRecall(text, {});
		expect(first.text).toContain("[chars 0-20000 of 45010]");
		expect(first.text).toContain("offset=20000");
		const mid = sliceRecall(text, { offset: 20_000, limit: 100 });
		expect(mid.body).toBe(text.slice(20_000, 20_100));
		expect(mid.text).toContain("[chars 20000-20100 of 45010]");
		expect(sliceRecall(text, { offset: 45_000 }).nextOffset).toBeNull();
		expect(sliceRecall(text, { offset: 99_999_999 }).body).toBe(""); // past the end: empty page, not an error
		expect(sliceRecall(text, { offset: "20000", limit: "10" }).body).toBe(text.slice(20_000, 20_010)); // models sometimes send numbers as strings
		expect(sliceRecall(text, { limit: 99_999_999 }).body.length).toBe(50_000 > text.length ? text.length : 50_000);
	});
	test("paging never splits a surrogate pair (byte-exact for non-BMP text)", () => {
		const text = "😀".repeat(30_000); // each is two UTF-16 code units
		for (const limit of [1, 2, 3, 999, 20_000]) {
			const out = pages(text.slice(0, 5000), { limit });
			expect(out).toBe(text.slice(0, 5000));
			expect(out.includes("\ufffd")).toBe(false);
		}
	});
	test("the zip_recall tool pages a long line through the real execute path and reports how to continue", async () => {
		const { registerRecallTool } = await import("../src/recall.ts");
		const line = "L".repeat(45_000);
		const entry = { type: "message", id: "e1", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: line }] } };
		let def: any;
		registerRecallTool({ registerTool: (t: any) => (def = t) } as any, { onRecall: () => {} });
		const ctx = { sessionManager: { getBranch: () => [entry] } };
		const h = handleFor("e1");
		let got = "";
		let offset = 0;
		for (let i = 0; i < 10; i++) {
			const res = await def.execute("t", { handle: h, offset }, undefined, undefined, ctx);
			const body = res.content[0].text.split("\n").slice(2).join("\n"); // [handle ...] line, [chars ...] line, then the page
			const more = /\n\[… (\d+) more chars: call zip_recall again with offset=(\d+)/.exec(body);
			got += more ? body.slice(0, more.index) : body;
			if (!more) break;
			offset = Number(more[2]);
		}
		expect(got).toBe(line);
	});
	test("grep: catastrophic patterns are searched as literal text and cannot hang; ordinary regexes still work", () => {
		const evil = "a".repeat(40) + "!";
		const t0 = Date.now();
		for (const p of ["(a+)+$", "(a|aa)+$", "(.*)*x", "(a*)*b", "^(\\w+\\s?)*$", "(x+x+)+y", "(a)\\1"]) {
			const r = sliceRecall(evil, { grep: p });
			expect(r.matched).toBe(0);
			expect(r.text).toContain("literal");
		}
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(sliceRecall("x".repeat(300), { grep: "x".repeat(300) }).text).toContain("literal"); // overlong pattern
		expect(sliceRecall("price (a+)+ here", { grep: "(a+)+" }).matched).toBe(1); // literal search finds the literal text
		const ok = sliceRecall("ERROR 12\nfine\nFAIL 7", { grep: "error|fail" });
		expect(ok.matched).toBe(2);
		expect(ok.text).not.toContain("literal");
		expect(sliceRecall("a.b\naxb", { grep: "a\\.b" }).matched).toBe(1);
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

describe("payload repair covers every request shape Pi's providers produce", () => {
	test("OpenAI Responses (input items): an output without its call becomes user text; a matched pair is untouched", () => {
		const ok = { input: [{ role: "user", content: [{ type: "input_text", text: "q" }] }, { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "fine" }] };
		expect(repairPayload(ok)).toBeNull();
		const broken = { input: [ok.input[0], ok.input[2]] };
		const r = repairPayload(broken)!;
		expect(r.repaired).toBe(1);
		expect(r.payload.input[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "[tool result, call folded]\nfine" }] });
		expect(broken.input[1].type).toBe("function_call_output"); // the original object is not mutated
		const custom = repairPayload({ input: [{ type: "custom_tool_call_output", call_id: "z", output: [{ type: "input_text", text: "o" }] }] })!;
		expect(custom.payload.input[0].content[0].text).toContain("o");
	});
	test("Google Gemini/Vertex (contents): matched by id when present, else by name; Cloud Code Assist nests contents under request", () => {
		const call = (name: string, id?: string) => ({ functionCall: { name, args: {}, ...(id ? { id } : {}) } });
		const resp = (name: string, out: string, id?: string) => ({ functionResponse: { name, response: { output: out }, ...(id ? { id } : {}) } });
		const ok = { contents: [{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [call("bash", "a"), call("read", "b")] }, { role: "user", parts: [resp("bash", "x", "a"), resp("read", "y", "b")] }] };
		expect(repairPayload(ok)).toBeNull();
		expect(repairPayload({ contents: [{ role: "model", parts: [call("bash")] }, { role: "user", parts: [resp("bash", "x")] }] })).toBeNull(); // no ids: by name
		const orphan = { contents: [ok.contents[0], { role: "user", parts: [resp("bash", "lost", "a")] }] };
		const r = repairPayload(orphan)!;
		expect(r.payload.contents[1].parts[0]).toEqual({ text: "[tool result, call folded]\nlost" });
		const half = { contents: [ok.contents[0], { role: "model", parts: [call("bash", "a")] }, { role: "user", parts: [resp("bash", "x", "a"), resp("read", "y", "b")] }] };
		const h = repairPayload(half)!;
		expect(h.repaired).toBe(1);
		expect(h.payload.contents[2].parts[0].functionResponse).toBeDefined();
		expect(h.payload.contents[2].parts[1].text).toContain("y");
		const nested = repairPayload({ request: { contents: orphan.contents } })!;
		expect(nested.payload.request.contents[1].parts[0].text).toContain("lost");
	});
	test("Bedrock Converse (toolUse/toolResult blocks)", () => {
		const ok = { messages: [{ role: "user", content: [{ text: "q" }] }, { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "bash", input: {} } }] }, { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "fine" }], status: "success" } }] }] };
		expect(repairPayload(ok)).toBeNull();
		const r = repairPayload({ messages: [ok.messages[0], ok.messages[2]] })!;
		expect(r.payload.messages[1].content[0]).toEqual({ text: "[tool result, call folded]\nfine" });
	});
	test("Mistral wire messages share the chat shape; unknown shapes and non-objects are left alone", () => {
		const r = repairPayload({ messages: [{ role: "user", content: "q" }, { role: "tool", tool_call_id: "t9", content: "lost" }] })!;
		expect(r.payload.messages[1]).toEqual({ role: "user", content: "[tool result, call folded]\nlost" });
		expect(repairPayload({ prompt: "x" })).toBeNull();
		expect(repairPayload(null)).toBeNull();
		expect(repairPayload("text")).toBeNull();
		expect(repairPayload({ messages: "nope" })).toBeNull();
	});
});

describe("/zip output", () => {
	test("without a UI to notify, command text goes to stderr and never into stdout (JSON mode)", async () => {
		const { registerZipCommand } = await import("../src/notice.ts");
		let cmd: any;
		registerZipCommand({ registerCommand: (_n: string, c: any) => (cmd = c) } as any, { status: () => "pi-zip: on", statsLine: () => "", setOff: () => "", toggleQuiet: () => "" });
		const out: string[] = [];
		const err: string[] = [];
		const so = process.stdout.write;
		const se = process.stderr.write;
		(process.stdout as any).write = (c: any) => (out.push(String(c)), true);
		(process.stderr as any).write = (c: any) => (err.push(String(c)), true);
		try {
			await cmd.handler("status", { mode: "json", ui: { notify: () => { throw new Error("no-op ui must not be used"); } } });
			await cmd.handler("status", {});
		} finally {
			process.stdout.write = so;
			process.stderr.write = se;
		}
		expect(out).toEqual([]);
		expect(err).toEqual(["pi-zip: on\n", "pi-zip: on\n"]);
		const seen: string[] = [];
		await cmd.handler("status", { mode: "tui", ui: { notify: (t: string) => seen.push(t) } });
		expect(seen).toEqual(["pi-zip: on"]);
	});
});

describe("classify", () => {
	test("read-only bash whitelist", () => {
		for (const c of ["ls -la /tmp", "cat a b | wc -l", "git log --oneline -5", "cat missing 2>/dev/null", "LC_ALL=C cat f.txt"]) expect(isReadOnlyBash(c)).toBe(true);
		for (const c of ["npm test", "git push origin main", "cat a > b", "cat a && rm -rf /tmp/x", "python3 build.py", ""]) expect(isReadOnlyBash(c)).toBe(false);
	});
	test("commands that only look read-only are not: find -delete/-exec, substitutions, redirects, background jobs, git --output, rg --pre", () => {
		for (const c of [
			"find . -name '*.tmp' -delete", "find . -type f -exec rm {} +", "find . -execdir sh -c x ;", "find . -ok rm {} ;", "find . -fprint out.txt", "find . -fprintf out %p",
			"echo $(rm -rf x)", "cat `which ls`", "ls $(pwd)", "echo hi > out.txt", "echo hi >> out.txt", "cat f 1>out", "ls &> out", "sleep 1 & ls", "cat <(ls)",
			"git diff --output=patch.txt", "git log --output patch.txt", "git show --output=x", "git diff --ext-diff", "git -c core.pager=sh diff",
			"rg --pre ./script pattern", "rg --pre=./script pattern", "file -C -m magic",
		]) expect([c, isReadOnlyBash(c)]).toEqual([c, false]);
		for (const c of ["find . -name '*.ts' -type f", "find src -maxdepth 2", "git diff --stat HEAD~1", "git log -p -3", "rg -n foo src", "file a.bin", "ls -la && cat a | head -5", "cat a 2>&1 | wc -l"]) expect([c, isReadOnlyBash(c)]).toEqual([c, true]);
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
		expect(cacheTtlMs(undefined, 300_000)).toBe(300_000);
		const t0 = 1_000_000;
		expect(isColdByTtl(t0, t0 + 9_000, cacheTtlMs({ short: 300 }))).toBe(false);
		expect(isColdByTtl(t0, t0 + 360_000, cacheTtlMs({ short: 300 }))).toBe(true);
	});
	test("the TTL tier follows Pi's getPromptCacheTtlMs: cacheRetention, else PI_CACHE_RETENTION=long, else short; no fallthrough between tiers", () => {
		const pc = { short: 300, long: 3600 };
		expect(cacheTtlMs(pc, 1, { env: {} })).toBe(300_000);
		expect(cacheTtlMs(pc, 1, { env: { PI_CACHE_RETENTION: "long" } })).toBe(3_600_000);
		expect(cacheTtlMs(pc, 1, { env: { PI_CACHE_RETENTION: "short" } })).toBe(300_000);
		expect(cacheTtlMs(pc, 1, { env: { PI_CACHE_RETENTION: "long" }, cacheRetention: "short" })).toBe(300_000); // the request option beats the env
		expect(cacheTtlMs(pc, 1, { env: {}, cacheRetention: "long" })).toBe(3_600_000);
		expect(cacheTtlMs(pc, 1, { env: {}, cacheRetention: "none" })).toBe(0);
		expect(cacheTtlMs({ long: 3600 }, 7, { env: {} })).toBe(7); // short is not declared: not the long tier's value
		expect(cacheTtlMs({ short: 300 }, 7, { env: { PI_CACHE_RETENTION: "long" } })).toBe(7);
		process.env.PI_CACHE_RETENTION = "long";
		try {
			expect(detectCold({ promptCache: pc }, 0, [{ type: "message", message: { timestamp: 10_000_000 - 1_000_000 } }], 10_000_000).cold).toBe(false); // 1000 s < 3600 s
		} finally {
			delete process.env.PI_CACHE_RETENTION;
			delete process.env.PI_ZIP_TTL_SECS;
		}
		expect(detectCold({ promptCache: pc }, 0, [{ type: "message", message: { timestamp: 10_000_000 - 1_000_000 } }], 10_000_000).cold).toBe(true); // 1000 s > 300 s
	});
	test("Pi's cache-warm usage entries touch the cache; a model switch is cold", () => {
		const now = 10_000_000;
		const model = { provider: "p", id: "m", promptCache: { short: 300 } };
		const old = { type: "message", message: { role: "assistant", provider: "p", model: "m", stopReason: "stop", timestamp: now - 1_000_000 } };
		expect(detectCold(model, 0, [old], now).cold).toBe(true);
		const warmed = { type: "usage", kind: "cache_warm", timestamp: new Date(now - 100_000).toISOString() };
		expect(detectCold(model, 0, [old, warmed], now).cold).toBe(false);
		expect(detectCold(model, 0, [old, { type: "usage", kind: "other", timestamp: new Date(now - 100_000).toISOString() }], now).cold).toBe(true);
		const fresh = { type: "message", message: { role: "assistant", provider: "p", model: "m", stopReason: "stop", timestamp: now - 1000 } };
		expect(detectCold(model, 0, [fresh], now)).toMatchObject({ cold: false });
		expect(detectCold(model, 0, [fresh], now)).toMatchObject({ pastTtl: false });
		expect(detectCold(model, 0, [old], now)).toMatchObject({ cold: true, pastTtl: true });
		const warmLearned = () => ({ p: 0.8, src: "learned" }); // a provider that outlives its declared TTL: warm, yet past the TTL
		expect(detectCold(model, 0, [old], now, "", warmLearned)).toMatchObject({ cold: false, pWarm: 0.8, pastTtl: true });
		expect(detectCold({ provider: "p", id: "other", promptCache: { short: 300 } }, 0, [fresh], now)).toMatchObject({ cold: true, reason: expect.stringContaining("model switch") });
		expect(detectCold({ provider: "q", id: "m", promptCache: { short: 300 } }, 0, [fresh], now).cold).toBe(true);
		expect(detectCold({ provider: "p", id: "other" }, now - 1000, [], now, "p/m").cold).toBe(true); // in-process memory of the last request's model
		expect(detectCold(model, 0, [], now).cold).toBe(false); // no prior request
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

describe("observed TTL tier", () => {
	const a = (cacheWrite: number, cacheWrite1h?: number, extra: Record<string, unknown> = {}) => ({
		type: "message",
		message: { role: "assistant", provider: "p", model: "m", timestamp: 9_000_000, usage: { cacheWrite, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }) }, ...extra },
	});
	test("observedTier: 1h share, absent field, mixed models, errors, small writes", () => {
		expect(observedTier([a(5000, 5000)], "p/m")).toBe("1h");
		expect(observedTier([a(5000, 0)], "p/m")).toBe("5m");
		expect(observedTier([a(5000, 2000)], "p/m")).toBeUndefined(); // split in between: no evidence
		expect(observedTier([a(5000)], "p/m")).toBeUndefined(); // API does not report it
		expect(observedTier([a(5000, 0), a(5000, 0, { model: "other" })], "p/m")).toBe("5m");
		expect(observedTier([a(5000, 0), a(5000, 5000, { model: "other" })], "p/other")).toBe("1h");
		expect(observedTier([a(5000, 0), a(5000, 5000, { stopReason: "error" }), a(5000, 5000, { stopReason: "aborted" })], "p/m")).toBe("5m");
		expect(observedTier([a(5000, 0), a(500, 500)], "p/m")).toBe("5m"); // small write ignored
		expect(observedTier([a(500, 500)], "p/m")).toBeUndefined();
		expect(observedTier([a(5000, 5000), a(5000, 0), a(5000, 0), a(5000, 0)], "p/m")).toBe("5m"); // only the newest 3
	});
	test("detectCold: long requested but 5m written -> 5m TTL, once-noticeable; short requested but 1h written -> 1h if declared", () => {
		const now = 10_000_000;
		const model = { provider: "p", id: "m", promptCache: { short: 300, long: 3600 } };
		const gap = { type: "message", message: { timestamp: now - 1_000_000 } };
		process.env.PI_CACHE_RETENTION = "long";
		try {
			expect(detectCold(model, 0, [gap], now).ttl).toMatchObject({ ms: 3_600_000, source: "declared" });
			const r = detectCold(model, 0, [a(5000, 0), gap], now);
			expect(r.cold).toBe(true); // 1000 s > 300 s
			expect(r.ttl).toMatchObject({ ms: 300_000, source: "observed", note: expect.stringContaining("requested 1h prompt cache, provider wrote 5m") });
			process.env.PI_ZIP_TTL_SECS = "20";
			expect(detectCold(model, 0, [a(5000, 0), gap], now).ttl).toMatchObject({ ms: 20_000, source: "declared" });
		} finally {
			delete process.env.PI_CACHE_RETENTION;
			delete process.env.PI_ZIP_TTL_SECS;
		}
		expect(detectCold(model, 0, [a(5000, 5000), gap], now).ttl).toMatchObject({ ms: 3_600_000, source: "observed" });
		expect(detectCold({ ...model, promptCache: { short: 300 } }, 0, [a(5000, 5000), gap], now).ttl).toMatchObject({ ms: 300_000, source: "declared" });
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
