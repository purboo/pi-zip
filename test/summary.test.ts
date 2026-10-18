// Sectioned carry-forward of the previous summary (synthetic sessions only): merge, dedupe, oldest dropped first with a count,
// old formats and Pi's own free-text compaction summaries.
import { describe, expect, test } from "bun:test";
import { buildBlocks, NARRATIVE_CALL_MAX, NARRATIVE_MAX, toolCallIndex } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { BUDGET, buildCut, handleRowsOf, handleTable, parseSummary, PREV_NARRATIVE_CHARS, previousNarrative, narrative, skeleton, TABLE_ROWS, EFFORT_REFUSED_RE } from "../src/summary.ts";
import { A, R, U, type Any } from "./helpers.ts";

const tcall = (id: string, name: string, args: Any) => {
	const m = { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: `c-${id}`, name, arguments: args }] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const tres = (id: string, name: string, text: string) => {
	const m = { role: "toolResult", toolCallId: `c-${id}`, toolName: name, isError: false, content: [{ type: "text", text }] };
	return { sourceEntry: { id: `r-${id}`, type: "message", message: m }, messages: [m] };
};
const summaryEntry = (text: string) => ({ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: text, tokensBefore: 0, timestamp: 0 }] });

/** One level of a long session: 4 requests of ~2.5K chars, 30 commands (15 with a big output), 2 reads, 1 pathless call. */
function level(L: number): Any[] {
	const out: Any[] = [];
	for (let k = 1; k <= 4; k++) out.push(U(`u${L}-${k}`, `REQ-${L}-${k} ` + `please keep working on item ${L}.${k}; `.repeat(80)));
	for (let k = 1; k <= 30; k++) {
		out.push(tcall(`b${L}-${k}`, "bash", { command: `make step-${L}-${k}` }));
		out.push(tres(`b${L}-${k}`, "bash", k % 2 === 0 ? `KEY-${L}-${k}: value\n` + "padding line\n".repeat(300) : "ok"));
	}
	for (let k = 1; k <= 2; k++) {
		out.push(tcall(`f${L}-${k}`, "read", { path: `src/mod${L}_${k}.ts` }));
		out.push(tres(`f${L}-${k}`, "read", "export const x = 1;"));
	}
	out.push(tcall(`w${L}`, "web_fetch", { url: `https://example.test/${L}` }));
	out.push(tres(`w${L}`, "web_fetch", "page"));
	out.push(A(`end${L}`));
	return out;
}
const narrativeFor = (L: number) => `## Decisions and rationale\nDECISION-${L}: chose plan ${L}.\n## Current state of the work\n` + `state line for level ${L}\n`.repeat(40) + `## Open todos / next steps\nTODO-${L}: finish ${L}\n## Key facts to remember\nKEYFACT-${L}: value-${L}`;

/** The real buildCut over [previous summary?] + one level, with a stub model that writes narrativeFor(L); `prompts` collects what it was sent. */
async function cutOver(L: number, previous: string | null, prompts: string[] = []): Promise<string> {
	const entries = [...(previous ? [summaryEntry(previous)] : []), ...level(L), U(`keep${L}`, "kept"), A(`keepA${L}`)];
	const blocks = buildBlocks(entries);
	const cutIdx = blocks.findIndex((b) => b.entryId === `keep${L}`);
	const complete = async (_m: Any, c: Any, options: Any) => (expect(options.maxTokens).toBe(NARRATIVE_CALL_MAX), prompts.push(c.messages[0].content[0].text), { stopReason: "stop", content: [{ type: "text", text: narrativeFor(L) }], usage: { cost: { total: 0 } } });
	const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx, prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
	return (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
}
async function chain(levels: number, prompts: string[] = []) {
	const texts: string[] = [];
	let prev: string | null = null;
	for (let L = 1; L <= levels; L++) texts.push((prev = await cutOver(L, prev, prompts)));
	return texts;
}
const requestsOf = (t: string) => t.split("\n").filter((l) => /^\d+\. REQ-\d+-\d+ /.test(l)).map((l) => /REQ-(\d+)-(\d+)/.exec(l)!.slice(1).map(Number) as [number, number]);
const sec = (t: string, head: string) => { const i = t.indexOf(head); const j = t.indexOf("\n## ", i + 1); return t.slice(i, j < 0 ? undefined : j); };
const prevBlockOf = (prompt: string) => /<previous-narrative[^>]*>\n([\s\S]*?)\n<\/previous-narrative>/.exec(prompt)?.[1] ?? null;
const cmdHandle = (L: number, k: number) => handleFor(`r-b${L}-${k}`);

describe("sectioned carry-forward: nested summaries, 4 levels deep", () => {
	test("all requests survive every summary in order without shortening", async () => {
		const texts = await chain(4);
		const requests = Array.from({ length: 4 }, (_, i) => level(i + 1).filter((e) => e.sourceEntry.message?.role === "user").map((e) => e.sourceEntry.message.content)).flat();
		for (let i = 0; i < texts.length; i++) {
			expect(parseSummary(texts[i]).users.items).toEqual(requests.slice(0, (i + 1) * 4));
			expect(texts[i].endsWith(JSON.stringify({ messages: requests.slice(0, (i + 1) * 4), unavailableEarlier: 0 }))).toBe(true);
		}
	});

	test("handles: the newest commands are listed, older ones are counted and their handles move to the index; nothing newer than the budget is lost", async () => {
		const last = (await chain(4))[3];
		const cmds = sec(last, "## Commands run");
		for (let k = 1; k <= 30; k++) expect(cmds).toContain(cmdHandle(4, k)); // newest level in full
		expect(cmds.split("\n").filter((l) => l.startsWith("`")).length).toBeLessThanOrEqual(60);
		expect(cmds).toMatch(/\[… \d+ older omitted …\]/);
		const listed = new Set(handleRowsOf(last).map((r) => r.handle));
		for (const L of [3, 2, 1]) for (let k = 1; k <= 30; k++) expect(listed.has(cmdHandle(L, k))).toBe(true); // 120 handles fit the index budget
		expect(listed.has(handleFor("r-f4-1")) && listed.has(handleFor("r-w4"))).toBe(true);
		// each handle is written once in the lists and index (the index never repeats a listed one)
		const rows = handleRowsOf(last.slice(0, last.indexOf("## Narrative")));
		expect(new Set(rows.map((r) => `${r.handle}|${r.tool}`)).size).toBe(rows.length);
	});

	test("files: a path touched again moves to the newest end and keeps its newest handle", async () => {
		const t1 = await cutOver(1, null);
		const again = [U("ua", "again"), tcall("g1", "read", { path: "src/mod1_1.ts" }), tres("g1", "read", "export const x = 2;"), A("ea")];
		const blocks = buildBlocks([summaryEntry(t1), ...again]);
		const files = sec(skeleton(blocks.slice(1), t1).text, "## Files touched").split("\n");
		expect(files.at(-1)).toBe(`- src/mod1_1.ts (read: ${handleFor("r-g1")})`);
		expect(files.filter((l) => l.includes("src/mod1_1.ts"))).toHaveLength(1);
		expect(files.some((l) => l.startsWith("- src/mod1_2.ts"))).toBe(true);
	});

	test("narrative: ONE merged narrative; the previous one goes to the call as its own block (narrative only, not the lists), never into the summary", async () => {
		const prompts: string[] = [];
		const texts = await chain(4, prompts);
		const last = texts[3];
		expect(last).toContain("KEYFACT-4: value-4");
		expect(last).not.toContain("Earlier narrative");
		expect(last).not.toContain("KEYFACT-3"); // what the model did not keep is gone: no stale copy next to the new narrative
		expect(last.match(/^## Key facts to remember/gm)).toHaveLength(1);
		expect(last.match(/## Narrative \(model-written\)/g)).toHaveLength(1);
		expect(prevBlockOf(prompts[0])).toBeNull(); // the first summary has nothing to merge
		for (let L = 2; L <= 4; L++) {
			const block = prevBlockOf(prompts[L - 1])!;
			expect(block).toBe(narrativeFor(L - 1)); // exactly the previous narrative ...
			expect(block).not.toContain("REQ-"); // ... not its request list, commands or tables
			expect(block).not.toContain("## Commands run");
			expect(block).not.toContain("## Folded outputs");
			expect(prompts[L - 1]).toContain("Write ONE updated narrative");
			expect(prompts[L - 1]).toMatch(/keep only the newer one/);
			expect(prompts[L - 1]).toMatch(/drop todos that are done or obsolete/);
		}
		expect(last).not.toContain("## Earlier summary (carried forward)");
	});

	test("an older summary with an 'Earlier narrative' excerpt: excerpt and narrative are merged by the call, and the excerpt is not carried", async () => {
		const old = (await chain(1))[0] + "";
		const withExcerpt = old.replace("\n## Narrative (model-written)\n", "\n## Earlier narrative (excerpt of the previous summary, newest part)\nKey facts: npm latest 0.2.8\n## Narrative (model-written)\n");
		const prompts: string[] = [];
		const t = await cutOver(2, withExcerpt, prompts);
		expect(prevBlockOf(prompts[0])).toContain("npm latest 0.2.8");
		expect(prevBlockOf(prompts[0])).toContain("KEYFACT-1");
		expect(t).not.toContain("0.2.8");
		expect(t).not.toContain("Earlier narrative");
	});

	test("a merge asks for at most 1,000 words and says the limit is hard; a narrative over its budget keeps its head and its tail (the key facts)", async () => {
		const prompts: string[] = [];
		const first = await cutOver(1, null, prompts);
		const entries = [summaryEntry(first), ...level(2), U("keep2", "kept"), A("keepA2")];
		const blocks = buildBlocks(entries);
		const long = "## Decisions and rationale\nHEAD-DECISION\n" + "a sentence of the current state of the work.\n".repeat(2000) + "## Key facts to remember\nTAIL-KEYFACT: 42";
		const complete = async (_m: Any, c: Any, options: Any) => (expect(options.maxTokens).toBe(NARRATIVE_CALL_MAX), prompts.push(c.messages[0].content[0].text), { stopReason: "stop", content: [{ type: "text", text: long }], usage: { cost: { total: 0 } } });
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep2"), prefixTokens: 50_000, summaryTokensPlanned: 40_000, sumTrigger: "cold" };
		const t = (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
		expect(Number(/under about (\d+) words/.exec(prompts[0])![1])).toBe(1500); // no previous narrative: the old budget
		expect(Number(/under about (\d+) words/.exec(prompts[1])![1])).toBe(1000);
		expect(prompts[1]).toContain("a hard limit");
		expect(t).toContain("HEAD-DECISION");
		expect(t).toContain("TAIL-KEYFACT: 42");
		expect(t).toContain("[… middle of the narrative omitted …]");
		const narr = t.slice(t.indexOf("## Narrative (model-written)"), t.indexOf("\n## Folded outputs"));
		expect(narr.length).toBeLessThanOrEqual(4000 * 6 + 100); // the narrative budget's clip (4,000 tokens x 6)
		expect(narr.length).toBeGreaterThan(20_000);
	});

	test("the previous narrative sent is bounded (head and tail of a longer one), so the chain cannot grow without limit", () => {
		const huge = "[summary of earlier conversation by pi-zip]\n## User requests (verbatim, oldest first)\n1. x\n## Narrative (model-written)\nHEAD-FACT\n" + "middle line of an endless narrative\n".repeat(3000) + "TAIL-FACT";
		const p = previousNarrative(huge)!;
		expect(p.text.length).toBeLessThanOrEqual(PREV_NARRATIVE_CHARS + 100);
		expect(p.text).toContain("HEAD-FACT");
		expect(p.text).toContain("TAIL-FACT");
		expect(p.text).toContain("[… middle of the narrative omitted …]");
		expect(p.foreign).toBe(false);
	});

	test("narrative call failed after an earlier summary: the previous narrative is carried whole, marked possibly stale, with its time; the next call merges it", async () => {
		const t1 = await cutOver(1, null);
		const at = new Date(2026, 9, 11, 2, 31).getTime();
		const entries = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: t1, tokensBefore: 0, timestamp: at }] }, ...level(2), U("keep2", "kept"), A("keepA2")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep2"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		const down = async () => ({ stopReason: "error", errorMessage: "down", content: [], usage: { cost: { total: 0 } } });
		const cut = await buildCut(p, { model: { id: "m" }, modelRegistry: { complete: down } } as Any);
		expect(cut.llmOk).toBe(false);
		expect(cut.text).toContain("## Narrative (carried forward from the summary of 10-11 02:31; possibly stale: a new one could not be written: down)");
		expect(cut.text).toContain("KEYFACT-1: value-1");
		expect(cut.text).not.toContain("(unavailable");
		const prompts: string[] = [];
		await cutOver(3, cut.text, prompts);
		expect(prevBlockOf(prompts[0])).toContain("KEYFACT-1: value-1");
		expect(prompts[0]).toContain('<previous-narrative written="10-11 02:31">');
	});

	test("no narrative (model call failed): the fallback line points at recall by handle, like the header, not at re-reading", async () => {
		const entries = [...level(1), U("keep1", "kept"), A("keepA1")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		const complete = async () => ({ stopReason: "error", errorMessage: "down", content: [], usage: { cost: { total: 0 } } });
		const cut = await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any);
		expect(cut.llmOk).toBe(false);
		const line = cut.text.split("\n")[cut.text.split("\n").indexOf("## Narrative") + 1];
		expect(line).toMatch(/^\(unavailable: .*; rely on the sections above and zip_recall an output by its handle rather than re-running or re-reading\)$/);
		expect(cut.text).not.toContain("re-read files as needed");
		expect(parseSummary(cut.text).narrative).toEqual([]); // still not taken for content when carried forward
	});

	// 0.4.0/0.4.1 capped the call at the budget: a real CJK merge (5,331 tokens out, 589 of them reasoning) hit the cap on every call
	test("the call's cap is not the narrative budget: a reply past the budget is taken, the cap stays within the model's own limit", async () => {
		const entries = [...level(1), U("keep1", "kept"), A("keepA1")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 40_000, sumTrigger: "cold" };
		const caps: number[] = [];
		// the reply needs 5,400 tokens: cut at any cap below that, like a provider does
		const complete = async (_m: Any, _c: Any, options: Any) => (caps.push(options.maxTokens), options.maxTokens < 5400
			? { stopReason: "length", content: [{ type: "text", text: "## Decisions and rationale\ncut" }], usage: { output: options.maxTokens, cost: { total: 0.01 } } }
			: { stopReason: "stop", content: [{ type: "text", text: "## Decisions and rationale\nWHOLE-REPLY" }], usage: { output: 5400, cost: { total: 0.01 } } });
		for (const [maxTokens, cap] of [[undefined, NARRATIVE_CALL_MAX], [8192, 8192], [128_000, NARRATIVE_CALL_MAX]] as const) {
			caps.length = 0;
			const cut = await buildCut(p, { model: { id: "m", ...(maxTokens ? { maxTokens } : {}) }, modelRegistry: { complete } } as Any);
			expect(cut.llmOk).toBe(true);
			expect(cut.text).toContain("WHOLE-REPLY");
			expect(caps).toEqual([cap]);
		}
		expect(NARRATIVE_CALL_MAX).toBeGreaterThanOrEqual(4 * NARRATIVE_MAX);
	});

	test("a reply cut at the cap is not retried identically: one call, and the summary carries the previous narrative", async () => {
		const t1 = await cutOver(1, null);
		const entries = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: t1, tokensBefore: 0, timestamp: Date.now() }] }, ...level(2), U("keep2", "kept"), A("keepA2")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep2"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		let calls = 0;
		const complete = async () => (calls++, { stopReason: "length", content: [{ type: "text", text: "runaway" }], usage: { cost: { total: 0.2 } } });
		const cut = await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any);
		expect(calls).toBe(1);
		expect(cut.llmOk).toBe(false);
		expect(cut.llmError).toBe("narrative hit the token cap");
		expect(cut.costUsd).toBe(0.2);
		expect(cut.text).toContain("KEYFACT-1: value-1");
	});

	test("non-user sections stay bounded while mandatory user text grows with the session", async () => {
		const summaries = await chain(5);
		const sizes = summaries.map((t) => Math.ceil(t.slice(0, t.indexOf("## User requests")).length / 4));
		expect(sizes[4]).toBeLessThan(sizes[2] * 1.5);
		expect(parseSummary(summaries[4]).users.items).toHaveLength(20);
	});

	test("the folded-outputs table keeps earlier rows with their hints, newest TABLE_ROWS, and counts the rest", async () => {
		const last = (await chain(4))[3];
		const t = sec(last, "## Folded outputs");
		expect(t).toContain(`- ${cmdHandle(4, 30)} · bash make step-4-30`); // newest first-class
		expect(t).toContain("KEY-4-30: value"); // hint
		expect(t).toContain("KEY-3-30: value"); // a row carried from the previous summary keeps its hint
		const rows = t.split("\n").filter((l) => l.startsWith("- "));
		expect(rows.length).toBeLessThanOrEqual(TABLE_ROWS);
		expect(t).toMatch(/\[… \d+ older folded outputs omitted from this table …\]/);
	});
});

describe("handleTable merge", () => {
	const row = (i: number) => ({ handle: `h${String(i).padStart(9, "0")}x`.slice(0, 10), tool: "bash", args: `c${i}`, hint: `hint ${i}`, turn: i });
	test("previous rows are kept (hints included), a handle appears once with its newest text, and omissions accumulate", () => {
		const a = handleTable(Array.from({ length: 45 }, (_, i) => row(i)))!;
		expect(a).toContain(`${45 - TABLE_ROWS} older folded outputs omitted`);
		const b = handleTable([row(44), ...Array.from({ length: 10 }, (_, i) => ({ ...row(100 + i), hint: "new" }))], a)!;
		expect(b).toContain(`[… ${45 - TABLE_ROWS + 10} older folded outputs omitted from this table …]`);
		expect(b.match(new RegExp(row(44).handle, "g"))).toHaveLength(1);
		expect(b).toContain("hint 43"); // an earlier row, with its hint
		expect(b).not.toContain("hint 10 ");
		expect(b.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(TABLE_ROWS);
	});
});

describe("old formats and foreign summaries", () => {
	const H = (n: string) => handleFor(n);
	// ae3b971: commands with or without a handle, files without handles, a table without a turn; the carried-forward block of that era
	const aeText = [
		"[summary of earlier conversation by pi-zip]",
		"Covers 40 earlier messages. Tool outputs in the kept part of the conversation may have been folded; call zip_recall with a handle to get one back exactly.",
		"## User requests (verbatim, oldest first)",
		"1. OLD-ONE first request",
		"with a second line",
		"2. OLD-TWO second request",
		"## Files touched",
		"- src/a.ts (read, edit)",
		"## Commands run (with exit status)",
		`\`bun test\` -> exit 1 (turn 1, ${H("o1")})`,
		"`ls` -> exit 0 (turn 1)",
		"## Errors",
		"- bash bun test: 2 failed",
		"## Narrative (model-written)",
		"## Decisions and rationale\nOLD-DECISION use bun",
		`## Folded outputs (originals recallable with zip_recall)`,
		`- ${H("o1")} · bash bun test · turn 1 · exit 1, 8 passed, 2 failed · FAIL x`,
	].join("\n");
	// pre-v2 (d0e8892): the request list keeps the first three and a tail with a gap in the numbering
	const preV2 = [
		"[summary of earlier conversation by pi-zip]",
		"## User requests (verbatim, oldest first)",
		"1. P1", "2. P2", "3. P3", "[… 5 requests omitted …]", "9. P9", "10. P10",
		"## Files touched", "(none)",
		"## Commands run (with exit status)", "`ls` -> exit 0",
		"## Errors", "(none)",
		"## Narrative", "(unavailable: no model; rely on the sections above and re-read files as needed)",
		`## Folded outputs`, `- ${H("p1")} · read src/p.ts · big file`,
	].join("\n");

	test("an ae3b971-style summary parses: items, multi-line requests, files without handles, table rows", () => {
		const p = parseSummary(aeText);
		expect(p.structured).toBe(true);
		expect(p.users.items).toEqual(["OLD-ONE first request\nwith a second line", "OLD-TWO second request"]);
		expect([...p.files.rows[0].ops]).toEqual([["read", null], ["edit", null]]);
		expect(p.cmds.items).toHaveLength(2);
		expect(p.errors.items).toEqual(["- bash bun test: 2 failed"]);
		expect(p.table.items).toHaveLength(1);
		expect(p.narrative).toEqual(["## Decisions and rationale\nOLD-DECISION use bun"]);
	});

	test("merging it: new requests come last, old ones are kept while they fit, the old table row and narrative survive", () => {
		const blocks = buildBlocks([U("u1", "NEW-ONE"), tcall("n1", "bash", { command: "make" }), tres("n1", "bash", "ok"), A("e")]);
		const t = skeleton(blocks, aeText).text;
		expect(t.indexOf("OLD-ONE")).toBeLessThan(t.indexOf("OLD-TWO"));
		expect(t.indexOf("OLD-TWO")).toBeLessThan(t.indexOf("NEW-ONE"));
		expect(parseSummary(t).users.items.at(-1)).toBe("NEW-ONE");
		expect(t).toContain("`bun test` -> exit 1 (turn 1, " + H("o1") + ")");
		expect(t).toContain("`ls` -> exit 0 (turn 1)");
		expect(t).toContain("- src/a.ts (read, edit)");
		expect(t).not.toContain("OLD-DECISION use bun"); // the narrative is the narrative call's to merge ...
		expect(previousNarrative(aeText)!.text).toContain("OLD-DECISION use bun"); // ... which reads it
		expect(handleTable([], aeText)).toContain("FAIL x");
	});

	test("pre-v2: the omission marker in the middle of the list is counted and the numbering gap is accepted", () => {
		const p = parseSummary(preV2);
		expect(p.users.items).toEqual(["P1", "P2", "P3", "P9", "P10"]);
		expect(p.users.omitted).toBe(5);
		expect(p.narrative).toEqual([]); // "(unavailable ...)" is not content
		const t = skeleton(buildBlocks([U("u1", "N1"), A("e")]), preV2).text;
		expect(parseSummary(t).users.items).toEqual(["P1", "P2", "P3", "P9", "P10", "N1"]);
		expect(t).not.toContain("requests omitted");
	});

	test("the older nested format (clipped carried-forward block inside a carried-forward block) keeps the newest level's items", () => {
		const inner = aeText.split("\n").filter((l) => !l.startsWith("Covers ") && l !== "[summary of earlier conversation by pi-zip]").join("\n");
		const outer = [
			"[summary of earlier conversation by pi-zip]", "Covers 9 earlier messages. x",
			"## Earlier summary (carried forward)", inner.slice(0, 600), // clipped mid-line
			"## User requests (verbatim, oldest first)", "1. MID-ONE", "## Files touched", "- src/b.ts (read: " + H("m1") + ")",
			"## Commands run (with exit status)", `\`make\` -> exit 0 (turn 3, ${H("m2")})`, "## Errors", "(none)",
			"## Narrative (model-written)", "MID narrative KEYFACT-MID",
		].join("\n");
		const p = parseSummary(outer);
		expect(p.users.items[0]).toBe("OLD-ONE first request\nwith a second line");
		expect(p.users.items.at(-1)).toBe("MID-ONE");
		expect(p.narrative.at(-1)).toBe("MID narrative KEYFACT-MID");
		const t = skeleton(buildBlocks([U("u1", "NEW"), A("e")]), outer).text;
		expect(t.indexOf("OLD-ONE")).toBeLessThan(t.indexOf("MID-ONE"));
		expect(t.indexOf("MID-ONE")).toBeLessThan(t.indexOf("NEW"));
		expect(t).toContain(H("m2"));
		expect(previousNarrative(outer)!.text).toContain("KEYFACT-MID");
	});

	test("a native Pi compaction summary (free text) goes to the narrative call as the previous narrative (head and tail if long); the fallback carries it", async () => {
		const native = "## Goal\nGOAL-LINE ship the synthetic feature\n## Progress\n" + "progress line\n".repeat(900) + "## Next Steps\nNEXT-STEP do the final thing\n<read-files>\nsrc/x.ts\n</read-files>";
		const p = parseSummary(native);
		expect(p.structured).toBe(false);
		const t = skeleton(buildBlocks([U("u1", "NEW"), A("e")]), native).text;
		expect(parseSummary(t).users.items).toEqual(["NEW"]);
		expect(t).not.toContain("GOAL-LINE"); // not an excerpt in the skeleton any more
		const prompts: string[] = [];
		const merged = await cutOver(1, native, prompts);
		const block = prevBlockOf(prompts[0])!;
		expect(block).toContain("GOAL-LINE");
		expect(block).toContain("NEXT-STEP do the final thing");
		expect(prompts[0]).toContain("earlier summary (written by another summariser)");
		expect(merged).toContain("KEYFACT-1");
		const huge = native.replace("progress line\n".repeat(900), "progress line\n".repeat(4000));
		expect(previousNarrative(huge)!.text.length).toBeLessThanOrEqual(PREV_NARRATIVE_CHARS + 100);
		expect(previousNarrative(huge)!.text).toContain("NEXT-STEP");
		// the call fails: Pi's summary is carried, not lost
		const blocks = buildBlocks([summaryEntry(native), ...level(1), U("keep1", "kept"), A("keepA1")]);
		const pl: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		const down = async () => ({ stopReason: "error", errorMessage: "down", content: [], usage: { cost: { total: 0 } } });
		const cut = await buildCut(pl, { model: { id: "m" }, modelRegistry: { complete: down } } as Any);
		expect(cut.text).toContain("GOAL-LINE");
		expect(cut.text).toContain("NEXT-STEP do the final thing");
		expect(cut.text).toContain("possibly stale");
	});

	test("empty, '(none)'-only, null and a bare mark all merge into an empty-but-valid summary", () => {
		for (const prev of [null, "", "[summary of earlier conversation by pi-zip]", "## User requests (verbatim, oldest first)\n(none)\n## Files touched\n(none)"]) {
			const t = skeleton(buildBlocks([U("u1", "ONLY"), A("e")]), prev).text;
			expect(t).toContain("## Files touched\n(none)");
			expect(parseSummary(t).users.items).toEqual(["ONLY"]);
			expect(t).not.toContain("Earlier narrative");
		}
	});

	test("every request stays verbatim even when their combined length exceeds the former budgets", () => {
		const big = (n: number) => `R${n} ` + "w".repeat(2700);
		let prev: string | null = null;
		for (let i = 0; i < 4; i++) prev = skeleton(buildBlocks([U(`a${i}`, big(i * 3)), U(`b${i}`, big(i * 3 + 1)), U(`c${i}`, big(i * 3 + 2)), A(`e${i}`)]), prev).text;
		const t = prev!;
		expect(parseSummary(t).users.items).toEqual(Array.from({ length: 12 }, (_, i) => big(i)));
		// short first requests: the first FIRST_REQUESTS stay
		let q: string | null = null;
		for (let i = 0; i < 6; i++) q = skeleton(buildBlocks([U(`s${i}`, i === 0 ? "TASK: build X" : i === 1 ? "TASK2: and Y" : big(i)), A(`f${i}`)]), q).text;
		expect(parseSummary(q).users.items.slice(0, 2)).toEqual(["TASK: build X", "TASK2: and Y"]);
	});
});

describe("user requests survive carry-forward intact", () => {
	test("middle approval over 3000 characters, duplicates and whitespace survive repeated summaries", () => {
		const approval = "  approve ONLY option B  \n" + "constraint=retain-this; ".repeat(220) + "\n\n## Errors\n1. literal heading  \n";
		const items = [" first  ", approval, "same", "same", "\nlast\n"];
		let t = skeleton(buildBlocks(items.flatMap((value, i) => [U(`req${i}`, value), A(`ans${i}`)])), null).text;
		for (let i = 0; i < 3; i++) t = skeleton(buildBlocks([U(`later${i}`, `later ${i}`), A(`answer${i}`)]), t).text;
		expect(parseSummary(t).users.items).toEqual([...items, "later 0", "later 1", "later 2"]);
		expect(t.endsWith(JSON.stringify({ messages: parseSummary(t).users.items, unavailableEarlier: 0 }))).toBe(true);
	});

	test("clipped legacy requests recover only from active branch before its kept boundary", async () => {
		const approval = "approve B " + "do not drop this constraint ".repeat(150);
		const old = skeleton(buildBlocks([U("a", "first"), U("b", approval), U("c", "last")]), null).text;
		const clipped = old.replace(JSON.stringify({ messages: ["first", approval, "last"], unavailableEarlier: 0 }), JSON.stringify({ messages: ["first", "last"], unavailableEarlier: 1 }));
		const abandoned = U("abandoned", "approval from abandoned branch").sourceEntry;
		const branch = [U("a", "first").sourceEntry, U("b", approval).sourceEntry, U("c", "last").sourceEntry,
			{ type: "compaction", id: "comp", firstKeptEntryId: "tail" }, U("tail", "already kept").sourceEntry, U("new", "new instruction").sourceEntry];
		const entries = [summaryEntry(clipped), U("tail", "already kept"), A("old"), U("new", "new instruction"), U("keep", "kept")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep"), prefixTokens: 20000, summaryTokensPlanned: 2000 };
		const ctx = { model: { id: "m" }, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "narrative" }] }) }, sessionManager: { getBranch: () => branch } };
		const recovered = parseSummary((await buildCut(p, ctx)).text).users;
		expect(recovered.items).toEqual(["first", approval, "last", "already kept", "new instruction"]);
		expect(recovered.omitted).toBe(0);
		expect(branch).not.toContain(abandoned);
		expect(recovered.items).not.toContain("approval from abandoned branch");
		const unavailable = parseSummary((await buildCut(p, { ...ctx, sessionManager: { getBranch: () => branch.slice(3) } })).text).users;
		expect(unavailable.items).toEqual(["first", "last", "already kept", "new instruction"]);
		expect(unavailable.omitted).toBe(1);
	});
	const reqs = ["Steps:\n1. fix A\n2. fix B\n3. fix C", "ok go"];
	const level = (names: string[]) => buildBlocks(names.flatMap((t, i) => [U(`x${i}-${t.length}-${Math.random()}`, t), A(`a${i}-${Math.random()}`)]));
	const users = (text: string) => parseSummary(text).users;

	test("a numbered list or a '## ' heading inside a request stays one request, across levels", () => {
		const heading = "Please look at this output:\n## Errors\nboom\n## Files touched\n- x\n1. not a request";
		let t = skeleton(level([...reqs, heading]), null).text;
		expect(users(t).items).toEqual([...reqs, heading]);
		t = skeleton(level(["next"]), t).text;
		expect(users(t).items).toEqual([...reqs, heading, "next"]);
		expect(t).toContain(JSON.stringify(reqs[0]));
		t = skeleton(level(["last"]), t).text;
		expect(users(t).items).toEqual([...reqs, heading, "next", "last"]);
		expect(users(t).items.slice(-2)).toEqual(["next", "last"]);
		// the heading inside the request did not cut the real sections short
		expect(t).toContain("\n## Files touched\n");
	});

	test("no request is shortened or dropped under a large former-budget overflow", () => {
		const big = (n: number) => `REQ${n}\n1. item\n2. item\n` + "x".repeat(5000);
		let t = skeleton(level(Array.from({ length: 10 }, (_, i) => big(i + 1))), null).text;
		t = skeleton(level(Array.from({ length: 10 }, (_, i) => big(i + 11))), t).text;
		t = skeleton(level([big(21)]), t).text;
		const u = users(t);
		expect(u.items).toEqual(Array.from({ length: 21 }, (_, i) => big(i + 1)));
		expect(u.omitted).toBe(0);
	});

	test("repeated identical requests are all kept, in order, across levels", () => {
		let t = skeleton(level(["first", "yes", "now do Y", "yes"]), null).text;
		expect(users(t).items).toEqual(["first", "yes", "now do Y", "yes"]);
		t = skeleton(level(["yes", "yes"]), t).text;
		expect(users(t).items).toEqual(["first", "yes", "now do Y", "yes", "yes", "yes"]);
		expect(t).toContain(JSON.stringify({ messages: users(t).items, unavailableEarlier: 0 }));
	});

	test("an older-format summary still parses heuristically (list numbers do not split when they are not last+1)", () => {
		const old = "## User requests (verbatim, oldest first)\n1. one\n2. two\n## Files touched\n(none)";
		expect(users(old).items).toEqual(["one", "two"]);
		expect(users(skeleton(level(["three"]), old).text).items).toEqual(["one", "two", "three"]);
	});
});


describe("a reasoning model whose provider refuses effort none (sota gpt-6.1-sol)", () => {
	const REFUSED = "unsupported_value: Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.";
	const refusing = (efforts: (string | undefined)[]) => async (_m: Any, _c: Any, o: Any) => (efforts.push(o?.reasoningEffort), o?.reasoningEffort
		? { stopReason: "stop", content: [{ type: "text", text: "narrative" }], usage: { cost: { total: 0.01 } } }
		: { stopReason: "error", errorMessage: REFUSED, usage: { cost: { total: 0 } } });
	test("asked again with low effort without using up the retry, then low at once for that model", async () => {
		const efforts: (string | undefined)[] = [];
		const ctx = { model: { provider: "sota", id: "unit-refuses-none", reasoning: true }, modelRegistry: { complete: refusing(efforts) } } as Any;
		expect((await narrative(buildBlocks([U("u", "work"), A("a")]), ctx, 1000)).ok).toBe(true);
		expect(efforts).toEqual([undefined, "low"]);
		expect((await narrative(buildBlocks([U("u", "work"), A("a")]), ctx, 1000)).ok).toBe(true);
		expect(efforts).toEqual([undefined, "low", "low"]);
	});
	test("a model without reasoning is not asked for an effort; other errors are not read as a refused effort", async () => {
		const efforts: (string | undefined)[] = [];
		const plain = { model: { provider: "x", id: "unit-plain", reasoning: false }, modelRegistry: { complete: refusing(efforts) } } as Any;
		expect((await narrative(buildBlocks([U("u", "work"), A("a")]), plain, 1000)).ok).toBe(false);
		expect(efforts).toEqual([undefined, undefined]);
		expect(EFFORT_REFUSED_RE.test(REFUSED)).toBe(true);
		for (const other of ["rate limit exceeded", "context length exceeded", "content policy refusal", "Unsupported value: 'image_url'"]) expect(EFFORT_REFUSED_RE.test(other)).toBe(false);
	});
});

describe("narrative cost survives unsuccessful responses", () => {
	test("a terminal policy refusal retains its reported charge", async () => {
		let calls = 0;
		const n = await narrative(buildBlocks([U("u", "work"), A("a")]), { model: { id: "m" }, modelRegistry: { complete: async () => {
			calls++; return { stopReason: "error", errorMessage: "content policy refusal", usage: { cost: { total: 0.17 } } };
		} } } as Any, 1000);
		expect(n.ok).toBe(false);
		expect(n.costUsd).toBe(0.17);
		expect(calls).toBe(1);
	});
	test("a successful retry retains the charge of its failed attempt", async () => {
		let calls = 0;
		const n = await narrative(buildBlocks([U("u", "work"), A("a")]), { model: { id: "m" }, modelRegistry: { complete: async () => ++calls === 1
			? { stopReason: "error", errorMessage: "transient error", usage: { input: 10, output: 2, totalTokens: 12, cost: { input: 0.01, output: 0.01, total: 0.02 } } }
			: { stopReason: "stop", content: [{ type: "text", text: "finished" }], usage: { input: 20, output: 4, totalTokens: 24, cost: { input: 0.02, output: 0.01, total: 0.03 } } },
		} } as Any, 1000);
		expect(n.ok).toBe(true);
		expect(n.costUsd).toBe(0.05);
		expect(n.usage).toEqual({ input: 30, output: 6, totalTokens: 36, cost: { input: 0.03, output: 0.02, total: 0.05 } });
		expect(calls).toBe(2);
	});
});
