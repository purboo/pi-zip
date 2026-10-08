// Sectioned carry-forward of the previous summary (synthetic sessions only): merge, dedupe, oldest dropped first with a count,
// old formats and Pi's own free-text compaction summaries.
import { describe, expect, test } from "bun:test";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { buildCut, FOREIGN_SUMMARY_CHARS, handleRowsOf, handleTable, parseSummary, PREV_NARRATIVE_CHARS, skeleton } from "../src/summary.ts";
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

/** The real buildCut over [previous summary?] + one level, with a stub model that writes narrativeFor(L). */
async function cutOver(L: number, previous: string | null): Promise<string> {
	const entries = [...(previous ? [summaryEntry(previous)] : []), ...level(L), U(`keep${L}`, "kept"), A(`keepA${L}`)];
	const blocks = buildBlocks(entries);
	const cutIdx = blocks.findIndex((b) => b.entryId === `keep${L}`);
	const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: narrativeFor(L) }], usage: { cost: { total: 0 } } });
	const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx, prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
	return (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
}
async function chain(levels: number) {
	const texts: string[] = [];
	let prev: string | null = null;
	for (let L = 1; L <= levels; L++) texts.push((prev = await cutOver(L, prev)));
	return texts;
}
const requestsOf = (t: string) => t.split("\n").filter((l) => /^\d+\. REQ-\d+-\d+ /.test(l)).map((l) => /REQ-(\d+)-(\d+)/.exec(l)!.slice(1).map(Number) as [number, number]);
const sec = (t: string, head: string) => { const i = t.indexOf(head); const j = t.indexOf("\n## ", i + 1); return t.slice(i, j < 0 ? undefined : j); };
/** The earlier-narrative excerpt: it holds "## ..." headings of its own, so it runs to the next top-level header of ours. */
const excerptOf = (t: string) => t.slice(t.indexOf("## Earlier narrative"), t.indexOf("\n## Narrative (model-written)"));
const cmdHandle = (L: number, k: number) => handleFor(`r-b${L}-${k}`);

describe("sectioned carry-forward: nested summaries, 4 levels deep", () => {
	test("the newest requests survive every level, the oldest go first, and the omission count adds up", async () => {
		const texts = await chain(4);
		const last = texts[3];
		const kept = requestsOf(last);
		// every request of the newest level is verbatim; whatever is kept is a contiguous newest suffix of the 16 requests, oldest dropped first
		for (let k = 1; k <= 4; k++) expect(last).toContain(`REQ-4-${k} please keep working on item 4.${k}; `.repeat(1).trim());
		const all: Array<[number, number]> = [1, 2, 3, 4].flatMap((L) => [1, 2, 3, 4].map((k) => [L, k] as [number, number]));
		expect(kept).toEqual(all.slice(all.length - kept.length));
		expect(kept.length).toBeLessThan(16); // the budget did drop something
		expect(kept[0][0]).toBeGreaterThanOrEqual(2); // ... and what it dropped is the oldest
		const m = /\[… (\d+) older requests omitted …\]/.exec(last)!;
		expect(Number(m[1])).toBe(16 - kept.length);
		// numbering continues over what was left out
		expect(last).toContain(`\n${16 - kept.length + 1}. REQ-${kept[0][0]}-${kept[0][1]} `);
		expect(last).not.toContain("REQ-1-1 ");
		// level 3 -> level 4: a summary of a summary does not lose what the previous one still held beyond the budget
		const k3 = requestsOf(texts[2]);
		expect(kept.slice(0, Math.max(0, kept.length - 4)).every(([L, k]) => k3.some(([l, kk]) => l === L && kk === k))).toBe(true);
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

	test("narrative: the newest narrative is whole, the previous ones survive only as a bounded tail excerpt", async () => {
		const texts = await chain(4);
		const last = texts[3];
		expect(last).toContain("KEYFACT-4: value-4");
		const excerpt = excerptOf(last);
		expect(excerpt).toContain("KEYFACT-3: value-3"); // the tail of the previous narrative: todos and key facts
		expect(excerpt).toContain("TODO-3");
		expect(excerpt).not.toContain("DECISION-1"); // the head of old narratives is what goes first
		expect(excerpt.length).toBeLessThanOrEqual(PREV_NARRATIVE_CHARS + 200);
		expect(last.match(/## Narrative \(model-written\)/g)).toHaveLength(1);
		expect(last).not.toContain("## Earlier summary (carried forward)");
	});

	test("size stays flat from level 2 on (it does not grow with depth)", async () => {
		const sizes = (await chain(5)).map((t) => Math.ceil(t.length / 4));
		expect(sizes[4]).toBeLessThan(sizes[2] * 1.25);
		expect(sizes[4]).toBeLessThan(12_000); // tokens (chars/4)
	});

	test("the folded-outputs table keeps earlier rows with their hints, newest 40, and counts the rest", async () => {
		const last = (await chain(4))[3];
		const t = sec(last, "## Folded outputs");
		expect(t).toContain(`- ${cmdHandle(4, 30)} · bash make step-4-30`); // newest first-class
		expect(t).toContain("KEY-4-30: value"); // hint
		expect(t).toContain("KEY-3-30: value"); // a row carried from the previous summary keeps its hint
		const rows = t.split("\n").filter((l) => l.startsWith("- "));
		expect(rows.length).toBeLessThanOrEqual(40);
		expect(t).toMatch(/\[… \d+ older folded outputs omitted from this table …\]/);
	});
});

describe("handleTable merge", () => {
	const row = (i: number) => ({ handle: `h${String(i).padStart(9, "0")}x`.slice(0, 10), tool: "bash", args: `c${i}`, hint: `hint ${i}`, turn: i });
	test("previous rows are kept (hints included), a handle appears once with its newest text, and omissions accumulate", () => {
		const a = handleTable(Array.from({ length: 45 }, (_, i) => row(i)))!;
		expect(a).toContain("5 older folded outputs omitted");
		const b = handleTable([row(44), ...Array.from({ length: 10 }, (_, i) => ({ ...row(100 + i), hint: "new" }))], a)!;
		expect(b).toContain("[… 15 older folded outputs omitted from this table …]");
		expect(b.match(new RegExp(row(44).handle, "g"))).toHaveLength(1);
		expect(b).toContain("hint 43"); // an earlier row, with its hint
		expect(b).not.toContain("hint 10 ");
		expect(b.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(40);
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
		expect(t).toContain("3. NEW-ONE");
		expect(t).toContain("`bun test` -> exit 1 (turn 1, " + H("o1") + ")");
		expect(t).toContain("`ls` -> exit 0 (turn 1)");
		expect(t).toContain("- src/a.ts (read, edit)");
		expect(t).toContain("OLD-DECISION use bun");
		expect(handleTable([], aeText)).toContain("FAIL x");
	});

	test("pre-v2: the omission marker in the middle of the list is counted and the numbering gap is accepted", () => {
		const p = parseSummary(preV2);
		expect(p.users.items).toEqual(["P1", "P2", "P3", "P9", "P10"]);
		expect(p.users.omitted).toBe(5);
		expect(p.narrative).toEqual([]); // "(unavailable ...)" is not content
		const t = skeleton(buildBlocks([U("u1", "N1"), A("e")]), preV2).text;
		expect(t).toContain("[… 5 older requests omitted …]\n6. P1\n7. P2\n8. P3\n9. P9\n10. P10\n11. N1");
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
		expect(t).toContain("KEYFACT-MID");
	});

	test("a native Pi compaction summary (free text) is kept as a head and a long tail excerpt, never dropped, never crashes", () => {
		const native = "## Goal\nGOAL-LINE ship the synthetic feature\n## Progress\n" + "progress line\n".repeat(900) + "## Next Steps\nNEXT-STEP do the final thing\n<read-files>\nsrc/x.ts\n</read-files>";
		const p = parseSummary(native);
		expect(p.structured).toBe(false);
		const t = skeleton(buildBlocks([U("u1", "NEW"), A("e")]), native).text;
		expect(t).toContain("GOAL-LINE");
		expect(t).toContain("NEXT-STEP do the final thing");
		expect(t).toContain("</read-files>");
		expect(t).toContain("[… middle of the earlier narrative omitted …]");
		expect(t.slice(t.indexOf("## Earlier narrative")).length).toBeLessThanOrEqual(FOREIGN_SUMMARY_CHARS + 200);
		expect(t).toContain("1. NEW");
	});

	test("empty, '(none)'-only, null and a bare mark all merge into an empty-but-valid summary", () => {
		for (const prev of [null, "", "[summary of earlier conversation by pi-zip]", "## User requests (verbatim, oldest first)\n(none)\n## Files touched\n(none)"]) {
			const t = skeleton(buildBlocks([U("u1", "ONLY"), A("e")]), prev).text;
			expect(t).toContain("## User requests (verbatim, oldest first)\n1. ONLY\n## Files touched\n(none)");
			expect(t).not.toContain("Earlier narrative");
		}
	});

	test("the first request of the session is not pinned: with nothing left of the budget it goes first, with a count", () => {
		const big = (n: number) => `R${n} ` + "w".repeat(2700);
		let prev: string | null = null;
		for (let i = 0; i < 4; i++) prev = skeleton(buildBlocks([U(`a${i}`, big(i * 3)), U(`b${i}`, big(i * 3 + 1)), U(`c${i}`, big(i * 3 + 2)), A(`e${i}`)]), prev).text;
		const t = prev!;
		expect(t).not.toContain("R0 ");
		expect(t).toContain("R11 ");
		expect(/\[… (\d+) older requests omitted …\]/.exec(t)![1]).toBe(String(12 - (t.match(/^\d+\. R\d+ /gm) ?? []).length));
	});
});
