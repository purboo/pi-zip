import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairPayload } from "../src/guard.ts";
import { detectCold, isColdByTtl, lastMessageMs, observedTier, payloadRetention, resolveTtl } from "../src/cache.ts";
import { classifyRecoverability, isReadOnlyBash } from "../src/classify.ts";
import { colorTail, fmtK, noticeText, renderNotice, splitDesc, type NoticeAction, type NoticeData } from "../src/notice.ts";
import { clipMid, handleFor, makePlaceholder, makePlaceholderFor, outcomeHint, pickKeyLines, shortArgs } from "../src/placeholder.ts";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { A, type Any, fakeCtx, fakePi, R, startZip, U } from "./helpers.ts";
import { branchOutputs, parseRange, recalledHandlesFromBranch, recallSections, resolveHandlesInBranch, searchOutputs, sliceRecall } from "../src/recall.ts";
import { handleRowsOf, handleTable, INDEX_TOKENS, skeleton, TABLE_ROWS } from "../src/summary.ts";
import { TOOL_FRAME_CHARS, tokensOf } from "../src/util.ts";

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
	test("the summary header says the codes are recall handles and that recalling beats re-running or re-reading", () => {
		const text = skeleton(buildBlocks([U("u1", "x"), A("a1", ["c1"]), R("r1", "c1", 9000), A("a2")]), null).text;
		const head = text.split("\n")[1];
		expect(head).toMatch(/^Covers \d+ earlier messages\. Their tool outputs are no longer in your context but are kept exactly/);
		expect(head).toContain("is its handle");
		expect(head).toContain(`${zipRecallName} it (grep/range for a part; grep alone searches every earlier output) rather than re-running or re-reading`);
		const again = skeleton(buildBlocks([{ sourceEntry: { id: "s", type: "compaction" }, messages: [{ role: "compactionSummary", summary: text }] }, U("u2", "y")]).slice(1), text).text;
		expect(again.split("\n").filter((l) => l.startsWith("Covers "))).toHaveLength(1); // carried forward, the header is not taken for content
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
		expect(table).toContain(`${70 - TABLE_ROWS} older folded outputs omitted`);
		expect(table).toContain("- h69 ");
		expect(table).not.toContain(`- h${69 - TABLE_ROWS} `);
		expect(table).toContain(`- h${70 - TABLE_ROWS} `);
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
			{ handle: c, tool: "bash", args: "bun test", when: "turn 4" },
			{ handle: d, tool: "web_fetch", args: '{"url":"https://x"}', when: "turn 2" },
			{ handle: e, tool: "bash", args: "cat f", when: "turn 7" },
			{ handle: b, tool: "read", args: "src/z.ts", when: "turn 3" },
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
	const call = (id: string, cid: string, name: string, args: object) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: cid, name, arguments: args }] } });
	const res = (id: string, cid: string, name: string, text: string) => ({ type: "message", id, message: { role: "toolResult", toolCallId: cid, toolName: name, content: [{ type: "text", text }] } });
	const session = [
		{ type: "message", id: "u1", message: { role: "user", content: "go" } },
		call("a1", "c1", "bash", { command: "npm test" }),
		res("e1", "c1", "bash", "ok 1\nERROR one: timeout 30s\nok 3"),
		{ type: "compaction", id: "k1", summary: "s", firstKeptEntryId: "u2" },
		{ type: "message", id: "u2", message: { role: "user", content: "more" } },
		call("a2", "c2", "read", { path: "src/a.ts" }),
		res("e2", "c2", "read", "x\nthrow new Error('ERROR two')"),
		call("a3", "c3", zipRecallName, { handle: handleFor("e1") }),
		res("e3", "c3", zipRecallName, "ERROR one (a recall result)"),
	];
	test("recalled sections name the call that produced the output, so look-alike outputs can be told apart", () => {
		const out = recallSections(resolveHandlesInBranch(session, [handleFor("e1")]).items, { grep: "error" });
		expect(out.text).toBe(`[handle ${handleFor("e1")} \u00b7 bash npm test \u00b7 32 chars \u00b7 3 lines]\n[grep: 1 matching line(s) of 3]\n2: ERROR one: timeout 30s`);
	});
	test("grep without a handle searches every earlier output (before a compaction too), newest first, labelled; recall results are skipped", () => {
		const outs = branchOutputs(session);
		expect(outs.map((o) => o.label)).toEqual(["bash npm test", "read src/a.ts", `${zipRecallName} {"handle":"${handleFor("e1")}"}`]);
		const s = searchOutputs(outs, "error");
		expect(s.text.split("\n")[0]).toBe("[grep over all 2 earlier tool outputs (no handle given): 2 matching line(s) in 2 output(s), newest output first]");
		expect(s.text).not.toContain("a recall result");
		const a = s.text.indexOf(`[handle ${handleFor("e2")} \u00b7 read src/a.ts \u00b7`), b = s.text.indexOf(`[handle ${handleFor("e1")} \u00b7 bash npm test \u00b7`);
		expect(a > 0 && b > a).toBe(true); // newest output first
		expect(s.text).toContain("2: throw new Error('ERROR two')");
		expect(s.text).toContain("2: ERROR one: timeout 30s");
		expect(s.sections.map((x) => x.handle)).toEqual([handleFor("e2"), handleFor("e1")]);
		const none = searchOutputs(outs, "zzznope");
		expect(none.matched).toBe(0);
		expect(none.text).toContain("Nothing matched");
		const paged = searchOutputs(outs, "error", { limit: 40 });
		expect(paged.text).toContain("offset=40"); // pages like any recall
		expect(paged.text).toContain("or narrow the pattern, or pass one of the handles above with grep]");
	});
	test("a search pages by 8,000 characters by default (a recall by handle by 20,000); an explicit limit still wins", () => {
		const big = [{ handle: "h1", tool: "bash", label: "bash x", text: Array.from({ length: 600 }, (_, i) => `error ${i} ` + "x".repeat(40)).join("\n") }];
		const s = searchOutputs(big, "error");
		expect(s.chars).toBe(8000);
		expect(s.text).toMatch(/\[chars 0-8000 of \d+\]/);
		expect(s.text).toContain("call zip_recall again with offset=8000");
		expect(searchOutputs(big, "error", { limit: 20_000 }).chars).toBe(20_000);
		expect(sliceRecall(big[0].text, {}).body.length).toBe(20_000);
	});
	test("a later page of a search sees the pool of its first page: an output that arrived in between does not shift the offsets", async () => {
		const { registerRecallTool, searchPoolOf } = await import("../src/recall.ts");
		let def: any;
		registerRecallTool({ registerTool: (t: any) => (def = t) } as any, { onRecall: () => {} });
		const lines = (tag: string) => Array.from({ length: 300 }, (_, i) => `hit ${tag} ${i} ` + "y".repeat(30)).join("\n");
		const branch: any[] = [
			{ type: "message", id: "u1", message: { role: "user", content: "go" } },
			call("a1", "c1", "bash", { command: "one" }),
			res("e1", "c1", "bash", lines("A")),
			call("a2", "c2", "bash", { command: "two" }),
			res("e2", "c2", "bash", lines("B")),
		];
		const ctx = { sessionManager: { getBranch: () => branch } };
		const p1 = await def.execute("t", { grep: "hit" }, undefined, undefined, ctx);
		expect(p1.details.pool).toBe(2);
		const whole = searchOutputs(branchOutputs(branch), "hit", { limit: 50_000 }).text;
		// page 1 lands in the session, then a parallel call's output arrives before page 2
		const r1 = res("e3", "c3", zipRecallName, p1.content[0].text);
		branch.push(call("a3", "c3", zipRecallName, { grep: "hit" }), { ...r1, message: { ...r1.message, details: p1.details } });
		branch.push(call("a4", "c4", "bash", { command: "three" }), res("e4", "c4", "bash", lines("C")));
		expect(searchPoolOf(branch, "hit")).toBe(2);
		const p2 = await def.execute("t", { grep: "hit", offset: 8000 }, undefined, undefined, ctx);
		expect(p2.content[0].text).toContain("over all 2 earlier tool outputs");
		expect(p2.content[0].text).not.toContain("hit C");
		const body = (t: string) => t.slice(t.indexOf("]\n", t.indexOf("[chars ")) + 2, t.lastIndexOf("\n[…"));
		const bodyOf = (t: string) => t.slice(t.indexOf("\n") + 1);
		expect(body(p1.content[0].text) + body(p2.content[0].text)).toBe(bodyOf(whole).slice(0, 16_000)); // pages join up exactly
		// a new first page (no offset) searches everything again, including the new output
		const fresh = await def.execute("t", { grep: "hit" }, undefined, undefined, ctx);
		expect(fresh.details.pool).toBe(3);
		expect(fresh.content[0].text).toContain("hit C");
	});
	test("zip_recall with grep alone goes through execute as a search; with neither handle nor grep it says what to pass", async () => {
		const { registerRecallTool } = await import("../src/recall.ts");
		let def: any;
		const seen: any[] = [];
		registerRecallTool({ registerTool: (t: any) => (def = t) } as any, { onRecall: (...a: any[]) => seen.push(a) });
		const ctx = { sessionManager: { getBranch: () => session } };
		const r = await def.execute("t", { grep: "timeout [0-9][0-9]s" }, undefined, undefined, ctx);
		expect(r.isError).toBe(false);
		const unsupported = await def.execute("t", { grep: "timeout \\d+s" }, undefined, undefined, ctx);
		expect(unsupported.content[0].text).toContain("searched as literal text");
		expect(unsupported.content[0].text).toContain("0 matching line(s)");
		expect(r.content[0].text).toContain("1 matching line(s) in 1 output(s)");
		expect(r.content[0].text).toContain(`[handle ${handleFor("e1")} \u00b7 bash npm test`);
		expect(seen[0][0]).toEqual([]); // a search marks nothing as recalled
		const bad = await def.execute("t", {}, undefined, undefined, ctx);
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toContain("grep alone");
		expect(def.description).toContain("grep alone searches every earlier tool output");
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
		registerZipCommand({ registerCommand: (_n: string, c: any) => (cmd = c) } as any, { status: () => "pi-zip: on", setOff: () => "", toggleQuiet: () => "" });
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

	test("one form: /zip shows the card; status and stats are silent aliases; completion offers off, on, quiet only", async () => {
		const { registerZipCommand } = await import("../src/notice.ts");
		let cmd: any;
		registerZipCommand({ registerCommand: (_n: string, c: any) => (cmd = c) } as any, { status: () => "pi-zip: on", setOff: () => "", toggleQuiet: () => "" });
		expect(cmd.description).toBe("pi-zip: off | on | quiet");
		const seen: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (t: string) => seen.push(t) } };
		for (const a of ["", "  ", "status", "STATS"]) await cmd.handler(a, ctx);
		expect(seen).toEqual(["pi-zip: on", "pi-zip: on", "pi-zip: on", "pi-zip: on"]);
		await cmd.handler("nope", ctx);
		expect(seen.at(-1)).toContain("use /zip, or /zip off | on | quiet");
		expect(cmd.getArgumentCompletions("").map((i: any) => i.value)).toEqual(["off", "on", "quiet"]);
		expect(cmd.getArgumentCompletions("o").map((i: any) => i.value)).toEqual(["off", "on"]);
		expect(cmd.getArgumentCompletions("st")).toBeNull();
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
	test("the lifetime is the one the request asks for (short 300 s, PI_CACHE_RETENTION=long 1 h), never the model catalogue", () => {
		const pc = { short: 60, long: 120 }; // a catalogue entry is not read
		expect(resolveTtl({ promptCache: pc }, []).ms).toBe(300_000);
		expect(resolveTtl({ promptCache: pc }, [], "long").ms).toBe(3_600_000);
		const t0 = 1_000_000;
		expect(isColdByTtl(t0, t0 + 9_000, 300_000)).toBe(false);
		expect(isColdByTtl(t0, t0 + 360_000, 300_000)).toBe(true);
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
		expect(detectCold(model, 0, [fresh], now)).toMatchObject({ pause: false });
		expect(detectCold(model, 0, [old], now)).toMatchObject({ cold: true, pause: true });
		const warmLearned = () => ({ p: 0.8, src: "learned" }); // a provider that outlives the lifetime asked for: warm, yet a pause
		expect(detectCold(model, 0, [old], now, "", warmLearned)).toMatchObject({ cold: false, pWarm: 0.8, pause: true });
		expect(detectCold({ provider: "p", id: "other", promptCache: { short: 300 } }, 0, [fresh], now)).toMatchObject({ cold: true, pause: false, reason: expect.stringContaining("model switch") });
		expect(detectCold({ provider: "q", id: "m", promptCache: { short: 300 } }, 0, [fresh], now).cold).toBe(true);
		expect(detectCold({ provider: "p", id: "other" }, now - 1000, [], now, "p/m").cold).toBe(true); // in-process memory of the last request's model
		expect(detectCold(model, 0, [], now)).toMatchObject({ cold: true, pWarm: 0, pause: false }); // no prior request: nothing is cached, nobody left
	});
	test("exactly the TTL is still warm by the prior (and already a pause); no prior request is never cold by the TTL", () => {
		expect(isColdByTtl(1000, 4001, 3000)).toBe(true);
		expect(isColdByTtl(1000, 4000, 3000)).toBe(false);
		expect(isColdByTtl(0, 999_999, 3000)).toBe(false);
	});
	afterEach(() => delete process.env.PI_ZIP_TTL_SECS);
	test("detectCold reads the requested lifetime, the branch clock, and PI_ZIP_TTL_SECS", () => {
		const now = 10_000_000;
		const branch = [{ type: "message", message: { timestamp: now - 100_000 } }];
		expect(detectCold({ promptCache: { short: 300 } }, 0, branch, now).cold).toBe(false);
		expect(detectCold({ promptCache: { short: 60 } }, 0, branch, now).cold).toBe(false); // the catalogue's 60 s is not read
		process.env.PI_ZIP_TTL_SECS = "20";
		expect(detectCold({ promptCache: { short: 300 } }, now - 5000, branch, now).cold).toBe(false);
		expect(detectCold({ promptCache: { short: 300 } }, 0, branch, now).cold).toBe(true);
		expect(detectCold({}, 0, [], now)).toMatchObject({ cold: true, reason: "no prior request" });
	});
});

describe("the cache clock ignores a request the provider refused (GC)", () => {
	const m = (role: string, t: number, over: Record<string, unknown> = {}) => ({ type: "message", id: `${role}${t}`, message: { role, timestamp: t, ...over } });
	const ok = (t: number) => m("assistant", t, { stopReason: "stop", usage: { input: 10, cacheRead: 1000, cacheWrite: 0 } });
	const refused = (t: number, over: Record<string, unknown> = {}) => m("assistant", t, { stopReason: "error", usage: { input: 0, cacheRead: 0, cacheWrite: 0 }, ...over });
	test("an error without usage is no touch, nor are the prompt and tool results that went with it", () => {
		expect(lastMessageMs([m("user", 1000), ok(1100), m("user", 5000), refused(5100)])).toBe(1100);
		expect(lastMessageMs([m("user", 1000), ok(1100), m("toolResult", 1200), refused(1300), m("user", 9000), refused(9100)])).toBe(1100);
	});
	test("an abort (Esc) comes after the provider read the prompt: a touch, with or without usage; an error that reports usage too", () => {
		expect(lastMessageMs([m("user", 1000), ok(1100), m("user", 5000), refused(5100, { stopReason: "aborted" })])).toBe(5100);
		const read = (t: number, stopReason: string) => m("assistant", t, { stopReason, usage: { input: 5, cacheRead: 30_000, cacheWrite: 0 } });
		expect(lastMessageMs([m("user", 1000), ok(1100), m("user", 5000), read(5100, "error")])).toBe(5100);
		expect(lastMessageMs([m("user", 1000), ok(1100), m("user", 5000), read(5100, "aborted")])).toBe(5100);
	});
	test("what is still running counts: trailing prompt or tool result without a response, a cache_warm entry, a branch with no response at all", () => {
		expect(lastMessageMs([m("user", 1000), ok(1100), m("toolResult", 1200)])).toBe(1200);
		expect(lastMessageMs([m("user", 1000), ok(1100), { type: "usage", kind: "cache_warm", timestamp: new Date(7000).toISOString() }])).toBe(7000);
		expect(lastMessageMs([m("user", 1000)])).toBe(1000);
		expect(lastMessageMs([])).toBe(0);
	});
	test("a model switch after a request the provider refused: the new model's cache is not the refused one's, so the return is cold", () => {
		expect(detectCold({ provider: "p", id: "m2", promptCache: { short: 300 } }, 0, [m("user", 0), refused(10)], 60_000, "p/m1").cold).toBe(true);
		expect(detectCold({ provider: "p", id: "m2", promptCache: { short: 300 } }, 0, [m("user", 0)], 60_000, "")).toMatchObject({ cold: true, pWarm: 0, pause: false, src: "no prior request" }); // nothing was ever sent: no touch, no pause
	});
	test("a return after a refused request is cold by the last real touch", () => {
		const branch = [m("user", 0), ok(1_000), m("user", 290_000), refused(291_000)];
		expect(detectCold({ promptCache: { short: 300 } }, 0, branch, 302_000).cold).toBe(true); // 301 s since request 1, not 11 s since the error
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
	test("detectCold: long requested but 5m written -> 5m TTL, once-noticeable; short requested but 1h written -> 1h", () => {
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
		expect(detectCold({ ...model, promptCache: { short: 300 } }, 0, [a(5000, 5000), gap], now).ttl).toMatchObject({ ms: 3_600_000, source: "observed" }); // the catalogue is not read
	});
});

describe("cache retention from the provider-scoped env and the request payload (pi-tricks §3.1)", () => {
	const ENVS = ["PI_ZIP_TTL_SECS", "PI_CACHE_RETENTION"];
	let kept: Record<string, string | undefined> = {};
	beforeEach(() => { kept = Object.fromEntries(ENVS.map((k) => [k, process.env[k]])); ENVS.forEach((k) => delete process.env[k]); });
	afterEach(() => ENVS.forEach((k) => (kept[k] === undefined ? delete process.env[k] : (process.env[k] = kept[k]))));
	const model = { provider: "relay", id: "claude-x", contextWindow: 1_000_000, promptCache: { short: 300, long: 3600 } };

	test("the tier a request asked for, read from the payload Pi built", () => {
		const cc = (ttl?: string) => ({ type: "text", text: "x", cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } });
		expect(payloadRetention({ system: [cc("1h")], messages: [] })).toBe("long");
		expect(payloadRetention({ system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: [cc()] }] })).toBe("short");
		expect(payloadRetention({ tools: [{ name: "t", cache_control: { type: "ephemeral", ttl: "5m" } }], messages: [] })).toBe("short");
		expect(payloadRetention({ messages: [{ role: "user", content: [cc(), cc("1h")] }] })).toBe("long");
		expect(payloadRetention({ model: "gpt", input: [], prompt_cache_retention: "24h" })).toBe("long");
		expect(payloadRetention({ model: "gpt", input: [], prompt_cache_retention: "in_memory" })).toBe("short");
		for (const p of [{ messages: [{ role: "user", content: "hi" }] }, {}, null, "x", undefined]) expect(payloadRetention(p)).toBeNull(); // nothing said
	});

	test("resolveTtl takes the tier it is given; without one the process env decides, as before", () => {
		expect(resolveTtl(model, [], "long").ms).toBe(3_600_000);
		expect(resolveTtl(model, [], "short").ms).toBe(300_000);
		expect(resolveTtl(model, []).ms).toBe(300_000);
		process.env.PI_CACHE_RETENTION = "long";
		expect(resolveTtl(model, []).ms).toBe(3_600_000);
		expect(resolveTtl(model, [], "short").ms).toBe(300_000); // a known tier beats the process env
	});

	async function returnAfter(gapS: number, registry: Any, payload?: Any) {
		const ledger = `/tmp/pi-zip-retention-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
		try {
			const { Zip } = await import("../src/run.ts");
			const zip = new Zip(fakePi().pi as Any);
			const entries = [U("u1", "one"), A("a1"), U("u2", "now")];
			const last = { type: "message", id: "a1", message: { role: "assistant", provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() - gapS * 1000, content: [], usage: { input: 9000, cacheRead: 0, cacheWrite: 0 } } };
			const { ctx } = fakeCtx(entries, { model, branch: [last], modelRegistry: registry });
			zip.sessionStart(ctx);
			if (payload) {
				await startZip(zip, ctx); // a run that sends one request with this payload ...
				zip.providerRequest({ payload });
				zip.messageEnd({ role: "assistant", stopReason: "stop", usage: { input: 9000, cacheRead: 0, cacheWrite: 0 } });
				(zip as Any).lastReqMs = Date.now() - gapS * 1000; // ... gapS ago
			}
			await startZip(zip, ctx);
			return readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "prompt").at(-1);
		} finally {
			rmSync(ledger, { force: true });
			delete process.env.PI_ZIP_LEDGER;
		}
	}

	test("PI_CACHE_RETENTION=long in the provider's env (auth.json), not in the process: a 400 s return is still warm (1 h tier), resolved once per run", async () => {
		let asked = 0;
		const scoped = { getApiKeyAndHeaders: async (m: Any) => (asked++, { ok: true, apiKey: "k", env: m === model ? { PI_CACHE_RETENTION: "long" } : {} }) };
		expect(await returnAfter(400, scoped)).toMatchObject({ cold: false, ttlMs: 3_600_000 });
		expect(asked).toBe(1);
		expect(await returnAfter(400, {})).toMatchObject({ cold: true, ttlMs: 300_000 }); // an older Pi without the API: the process env, as before
		expect(await returnAfter(400, { getApiKeyAndHeaders: async () => { throw new Error("no key"); } })).toMatchObject({ cold: true, ttlMs: 300_000 });
	});

	test("the request payload wins: the provider env says long, the request carried a 5-minute cache_control, so a 400 s return is cold", async () => {
		const scoped = { getApiKeyAndHeaders: async () => ({ ok: true, env: { PI_CACHE_RETENTION: "long" } }) };
		const short = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [] };
		expect(await returnAfter(400, scoped, short)).toMatchObject({ cold: true, ttlMs: 300_000 });
		process.env.PI_CACHE_RETENTION = "short";
		const long = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [] };
		expect(await returnAfter(400, {}, long)).toMatchObject({ cold: false, ttlMs: 3_600_000 });
	});
});

test("a read slice is written the way Pi's read row writes it", async () => {
	const { shortArgs } = await import("../src/placeholder.ts");
	expect(shortArgs({ path: "src/a.ts" })).toBe("src/a.ts");
	expect(shortArgs({ path: "src/a.ts", offset: 1, limit: 2000 })).toBe("src/a.ts:1-2000");
	expect(shortArgs({ path: "src/a.ts", offset: 50 })).toBe("src/a.ts:50");
	expect(shortArgs({ path: "src/a.ts", limit: 20 })).toBe("src/a.ts:1-20");
});

describe("notices and stats", () => {
	test("fmtK", () => expect([fmtK(84200), fmtK(31500), fmtK(182000), fmtK(41000)]).toEqual(["84.2K", "31.5K", "182K", "41K"]));
	const fold: NoticeAction = { kind: "fold", count: 12, tokensBefore: 84200, tokensAfter: 31500, ms: 0.94 };
	const sync: NoticeAction = { kind: "summary", count: 64, tokensBefore: 182000, tokensAfter: 41000, ms: 8400 };
	test("exact formats; fold and summary merge into ONE line: words, numbers, then how long", () => {
		expect(noticeText([fold])).toBe("pi-zip  zipped 12 old outputs  84.2K → 31.5K  1 ms");
		expect(noticeText([{ ...fold, ms: 1234 }])).toBe("pi-zip  zipped 12 old outputs  84.2K → 31.5K  1.2 s");
		expect(noticeText([sync])).toBe("pi-zip  summarized 64 requests  182K → 41K  waited 8.4 s"); // waited for all of it
		expect(noticeText([{ ...sync, ms: 41200, waitMs: 12000 }])).toBe("pi-zip  summarized 64 requests  182K → 41K  41.2 s · waited 12.0 s"); // started while away
		expect(noticeText([{ ...sync, ms: 41200, prepared: true }])).toBe("pi-zip  summarized 64 requests  182K → 41K  41.2 s · ready while you were away");
		const merged = noticeText([fold, { ...sync, tokensBefore: 31500, tokensAfter: 20000 }]);
		expect(merged).toBe("pi-zip  zipped 12 old outputs · summarized 64 requests  84.2K → 20K  1 ms · waited 8.4 s");
		expect(noticeText([{ ...fold, count: 1 }])).toBe("pi-zip  zipped 1 old output  84.2K → 31.5K  1 ms");
	});
	test("old entries ('folded …') read the same way", () => {
		expect(splitDesc("folded 12 old outputs in 6 ms")).toEqual({ verbs: ["zipped 12 old outputs"], tail: ["6 ms"] });
		expect(splitDesc("folded 12 old outputs")).toEqual({ verbs: ["zipped 12 old outputs"], tail: [] });
		expect(splitDesc("summarized 3 requests in 38.2 s · ready while you were away")).toEqual({ verbs: ["summarized 3 requests"], tail: ["38.2 s", "ready while you were away"] });
	});
	const th = { fg: (_c: string, t: string) => t };
	const data: NoticeData = {
		v: 2, text: "", before: 74000, after: 43000, desc: "zipped 12 old outputs in 6 ms", why: "cache cold · away 47 min",
		items: [{ label: "bash npm test", turn: 1, tokens: 14000, handle: "k3x9q2m7ab" }, { label: "read src/payment.ts", turn: 1, tokens: 9000, handle: "p8d2x1qa0m" }], more: 10,
	};
	test("collapsed: one line; narrow terminals drop the time, then the words, never the numbers; nothing exceeds the width", () => {
		expect(renderNotice(data, false, 120, th)).toEqual(["ƶ zipped 12 old outputs   74K → 43K   6 ms"]);
		expect(renderNotice(data, false, 38, th)).toEqual(["ƶ zipped 12 old outputs   74K → 43K"]);
		expect(renderNotice(data, false, 25, th)).toEqual(["ƶ 74K → 43K"]);
		expect(renderNotice(data, false, 10, th)).toEqual(["74K → 43K"]);
		expect(renderNotice(data, false, 5, th)).toEqual([]);
		for (const w of [5, 12, 25, 40, 60, 80, 120]) for (const ex of [false, true]) for (const l of renderNotice({ ...data, first: true }, ex, w, th)) expect(l.length).toBeLessThanOrEqual(w);
	});
	test("the session's first notice says once that originals are kept; expanded lists what, then the facts", () => {
		expect(renderNotice({ ...data, first: true }, false, 120, th)[1]).toBe("  originals are kept · the model can unzip any of them");
		const ex = renderNotice(data, true, 120, th);
		expect(ex[1]).toMatch(/^ {2}bash npm test +14K   k3x9q2m7ab$/);
		expect(ex[2]).toMatch(/^ {2}read src\/payment\.ts +\d+K   \w{10}$/);
		expect(ex[3]).toBe("  … 10 more");
		expect(ex[4]).toBe("  cache cold · away 47 min");
	});
	test("colours by meaning: monogram accent+bold, words muted, the size now success+bold, the rest dim", () => {
		const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*` };
		const len = (s: string) => s.replace(/<\/?\w+>|\*/g, "").length;
		expect(renderNotice(data, false, 120, tag, len)[0]).toBe("<accent>*ƶ*</accent> <muted>zipped 12 old outputs</muted>   <dim>74K</dim><dim> → </dim><success>*43K*</success>   <dim>6 ms</dim>");
		expect(colorTail(["38.2 s", "ready while you were away"], tag)).toBe("<dim>38.2 s</dim><dim> · </dim><dim>ready while you were away</dim>");
		// only a wait the user really sat through gets the warning colour
		expect(colorTail(["waited 43.4 s"], tag)).toBe("<warning>waited 43.4 s</warning>");
		expect(colorTail(["waited 0.6 s"], tag)).toBe("<dim>waited 0.6 s</dim>");
		// monochrome: stripping colour leaves exactly the plain text
		expect(len(renderNotice(data, false, 120, tag, len)[0])).toBe(renderNotice(data, false, 120, { fg: (_c, t) => t })[0].length);
	});
});

test("token estimate follows Pi's chars/4 rules, plus each tool block's id and framing (what the wire carries and Pi's rule skips)", () => {
	expect(tokensOf({ role: "user", content: "x".repeat(400) })).toBe(100);
	const id = "toolu_01DjyfbHC97yoxCz9pDv7T6R"; // 30 chars, in the call and again in its result
	expect(tokensOf({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "x".repeat(400) }, { type: "image" }] })).toBe(Math.ceil((400 + 4800 + 30 + TOOL_FRAME_CHARS) / 4));
	expect(tokensOf({ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(40) }, { type: "toolCall", id, name: "bash", arguments: { command: "ls" } }] })).toBe(Math.ceil((40 + 4 + JSON.stringify({ command: "ls" }).length + 30 + TOOL_FRAME_CHARS) / 4));
	expect(tokensOf({ role: "assistant", content: [{ type: "text", text: "x".repeat(40) }] })).toBe(10); // no tool block, no framing
	expect(tokensOf({ role: "compactionSummary", summary: "x".repeat(80) })).toBe(20);
	expect(tokensOf({ role: "system", content: "x".repeat(400) })).toBe(0); // part of O, never content
});

describe("/zip status after a restart", async () => {
	const { Zip } = await import("../src/run.ts");
	const { fakeCtx, fakePi } = await import("./helpers.ts");
	test("reports what the session carries (folds and summaries persisted in its file), not only this process's counters", () => {
		const ph = (id: string) => ({ type: "context_edit", targetId: id, replacement: { content: [{ type: "text", text: `[folded by pi-zip · bash ls · handle ${id}]` }] } });
		const out = (id: string) => ({ type: "message", id, message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(40_000) }] } });
		const recall = { type: "message", id: "rc", message: { role: "toolResult", toolName: "zip_recall", content: [{ type: "text", text: "y" }] } };
		const branch = [out("a"), out("b"), out("c"), ph("a"), ph("b"), ph("c"), recall, { type: "context_edit", targetId: "x", replacement: { content: [{ type: "text", text: "someone else" }] } }, { type: "compaction", summary: "s", details: { by: "pi-zip" } }, { type: "compaction", summary: "pi", details: {} }];
		const zip = new Zip(fakePi().pi); // a fresh process: its own counters are all 0
		const { ctx } = fakeCtx([], { branch });
		// 30K chars/4 of folded text on the provider's scale: x c, here C0 = 1.5 (this branch has no usage to calibrate from)
		expect(zip.status(ctx)).toContain("this session: 3 zipped (~45K tokens), 1 summary, 1 unzip");
		expect(zip.status(ctx)).not.toContain("since pi started");
		expect(zip.statsLine(ctx)).toContain("this session: 3 zipped (~45K tokens), 1 summary, 1 unzip");
	});
});
