// Summary and placeholder format (research round5/sumfmt.md): distinguishable row labels, times instead of turn numbers, smaller
// mechanical lists, short fold text, JSON key fields. Synthetic sessions only.
import { describe, expect, test } from "bun:test";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { cmdLabel, distinctLines, handleFor, jsonKeyFields, keyTexts, makePlaceholder, makePlaceholderFor, sharedCdDirs, shortArgs, strippableCdDirs } from "../src/placeholder.ts";
import { BUDGET, buildCut, handleRowsOf, INDEX_TOKENS, skeleton, TABLE_ROWS } from "../src/summary.ts";
import { A, type Any, U } from "./helpers.ts";

const tcall = (id: string, name: string, args: Any) => {
	const m = { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: `c-${id}`, name, arguments: args }] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const tres = (id: string, name: string, text: string, ts?: number) => {
	const m = { role: "toolResult", toolCallId: `c-${id}`, toolName: name, isError: false, content: [{ type: "text", text }], ...(ts ? { timestamp: ts } : {}) };
	return { sourceEntry: { id: `r-${id}`, type: "message", message: m }, messages: [m] };
};
const stub = (text = "## Decisions and rationale\nnone") => ({ model: { id: "m" }, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text }], usage: { cost: { total: 0 } } }) } }) as Any;
async function cutOf(entries: Any[]): Promise<string> {
	const all = [...entries, U("keep", "kept"), A("keepA")];
	const blocks = buildBlocks(all);
	const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
	return (await buildCut(p, stub())).text;
}
const sec = (t: string, head: string) => { const i = t.indexOf(head); const j = t.indexOf("\n## ", i + 1); return t.slice(i, j < 0 ? undefined : j); };
/** A status report of a long-running job: the same first lines every time, the line that tells it apart further down. */
const status = (n: number) => `done: alpha, beta, gamma, delta, epsilon, zeta\nopen: none\nqueue: 3 items\n` + "pad line\n".repeat(400) + `Saved #${n} state.v${60 + n}\nCopy: state.v${60 + n}\nend`;

describe("row labels tell look-alike rows apart (2026-10-11 item 3)", () => {
	test("folded-outputs table: rows of one tool that would show the same key line each show the first line that differs", async () => {
		const entries: Any[] = [U("u1", "go")];
		for (let i = 1; i <= 3; i++) entries.push(tcall(`p${i}`, "job_status", {}), tres(`p${i}`, "job_status", status(i)));
		entries.push(A("e"));
		const table = sec(await cutOf(entries), "## Folded outputs");
		const rows = table.split("\n").filter((l) => l.startsWith("- "));
		expect(rows).toHaveLength(3);
		for (let i = 1; i <= 3; i++) expect(rows[i - 1]).toContain(`Saved #${i} state.v${60 + i}`);
		expect(new Set(rows.map((r) => r.split(" · ").pop())).size).toBe(3);
		// a row whose key line differs anyway keeps it
		const one = sec(await cutOf([U("u1", "go"), tcall("q", "job_status", {}), tres("q", "job_status", status(7)), A("e")]), "## Folded outputs");
		expect(one).toContain("queue: 3 items");
	});

	test("folded-outputs table: a row is told apart from the previous summary's rows of that tool too", async () => {
		const first = await cutOf([U("u1", "go"), tcall("p1", "job_status", {}), tres("p1", "job_status", status(1)), A("e")]);
		expect(sec(first, "## Folded outputs")).toContain("queue: 3 items");
		const entries = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: first, tokensBefore: 0, timestamp: 0 }] }, U("u2", "more"), tcall("p2", "job_status", {}), tres("p2", "job_status", status(2)), A("e2")];
		const rows = sec(await cutOf(entries), "## Folded outputs").split("\n").filter((l) => l.startsWith("- "));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEndWith(" · queue: 3 items"); // the earlier row, as it was
		expect(rows[1]).not.toEndWith(" · queue: 3 items"); // the new one shows another of its lines
	});

	test("commands: a shared `cd <dir> &&` / `cd <dir>;` is left out (the heading names it), heredocs show their gist, the clip keeps head and tail", async () => {
		const dir = "/home/user/projects/example-app";
		const py = (seq: number) => `cd ${dir}; python3 - <<'EOF'\nimport json\nL=[json.loads(l) for l in open('data/ledger.jsonl')]\nfor e in L:\n    if e['seq']>${seq}: print(e['seq'], e['kind'])\nEOF`;
		const entries: Any[] = [U("u1", "go")];
		[120, 130, 140].forEach((s, i) => entries.push(tcall(`b${i}`, "bash", { command: py(s) }), tres(`b${i}`, "bash", `out ${i}`)));
		entries.push(tcall("b9", "bash", { command: `cd ${dir} && make all` }), tres("b9", "bash", "ok"), A("e"));
		const t = skeleton(buildBlocks(entries), null).text;
		const cmds = sec(t, "## Commands run");
		expect(cmds.split("\n")[0]).toBe(`## Commands run (with exit status; a leading "cd <dir> &&" is left out for: ${dir})`);
		const rows = cmds.split("\n").filter((l) => l.startsWith("`"));
		expect(rows).toHaveLength(4);
		expect(rows.every((r) => !r.includes(`cd ${dir}`))).toBe(true);
		expect(new Set(rows.map((r) => r.replace(/\(.*\)$/, ""))).size).toBe(4);
		for (const s of [120, 130, 140]) expect(cmds).toContain(`e['seq']>${s}`);
		expect(rows[3]).toMatch(/^`make all` -> exit 0/);
		// carried into the next summary, the heading keeps the dir
		const again = skeleton(buildBlocks([U("u2", "x"), tcall("c1", "bash", { command: "ls" }), tres("c1", "bash", "a"), A("e2")]), t).text;
		expect(sec(again, "## Commands run").split("\n")[0]).toContain(`left out for: ${dir}`);
		// a cd used once says where the command ran: kept
		expect(skeleton(buildBlocks([U("u1", "go"), tcall("x", "bash", { command: "cd /a/b && ls" }), tres("x", "bash", "a"), A("e")]), null).text).toContain("`cd /a/b && ls`");
	});

	test("two dirs with two commands each: no row drops its cd (it is what tells them apart), and the heading names none", () => {
		const entries: Any[] = [U("u1", "go")];
		["/srv/a", "/srv/b", "/srv/a", "/srv/b"].forEach((d, i) => entries.push(tcall(`d${i}`, "bash", { command: `cd ${d} && make t${i}` }), tres(`d${i}`, "bash", "ok")));
		entries.push(A("e"));
		const cmds = sec(skeleton(buildBlocks(entries), null).text, "## Commands run");
		expect(cmds.split("\n")[0]).toBe("## Commands run (with exit status)");
		const rows = cmds.split("\n").filter((l) => l.startsWith("`"));
		expect(rows).toHaveLength(4);
		expect(rows[0]).toStartWith("`cd /srv/a && make t0`");
		expect(rows[2]).toStartWith("`cd /srv/a && make t2`");
		expect(rows[1]).toStartWith("`cd /srv/b && make t1`");
		expect(strippableCdDirs(["cd /srv/a && x", "cd /srv/a && y"], ["/srv/b"]).size).toBe(0); // another dir was stripped earlier: keep
	});

	test("one shared dir is still stripped, also when an earlier summary stripped the same dir; the heading lists it", () => {
		const one = (id: string, n: number) => [tcall(`${id}${n}`, "bash", { command: `cd /srv/a && step ${n}` }), tres(`${id}${n}`, "bash", "ok")];
		const t1 = skeleton(buildBlocks([U("u1", "go"), ...one("x", 1), ...one("x", 2), A("e")]), null).text;
		const c1 = sec(t1, "## Commands run");
		expect(c1.split("\n")[0]).toBe('## Commands run (with exit status; a leading "cd <dir> &&" is left out for: /srv/a)');
		expect(c1).toContain("`step 1` -> exit 0");
		const t2 = skeleton(buildBlocks([U("u2", "more"), ...one("y", 3), ...one("y", 4), A("e2")]), t1).text;
		expect(sec(t2, "## Commands run")).toContain("`step 4` -> exit 0");
		expect(sec(t2, "## Commands run").split("\n")[0]).toContain("left out for: /srv/a)");
	});

	test("cmdLabel: heredoc gist (comment, else echo/print, else tail), cd only when shared, middle clip", () => {
		const hd = (body: string) => `python3 - <<'EOF'\nimport json, sys\nrows = json.load(open('x.json'))\n${body}\nEOF`;
		expect(cmdLabel(hd("# count the failed rows\nprint(len(rows))"))).toBe("python3 - <<'EOF' … # count the failed rows");
		expect(cmdLabel(hd("x = 1\nprint(len(rows))\ny = 2"))).toBe("python3 - <<'EOF' … print(len(rows))");
		expect(cmdLabel(hd("x = [r for r in rows if r['a'] > 5]\ny = sum(x)"))).toBe("python3 - <<'EOF' … x = [r for r in rows if r['a'] > 5] y = sum(x)");
		expect(cmdLabel("cat <<EOF > f.txt\nhello\nEOF\nwc -l f.txt")).toBe("cat <<EOF > f.txt … hello EOF wc -l f.txt");
		expect(cmdLabel("cd /x && ls", 90, new Set(["/x"]))).toBe("ls");
		expect(cmdLabel("cd /x && ls", 90, new Set(["/y"]))).toBe("cd /x && ls");
		const long = "npm run test -- " + "--flag ".repeat(40) + "--testPathPattern=alpha.spec.ts";
		expect(cmdLabel(long, 60).endsWith("alpha.spec.ts")).toBe(true);
		expect(shortArgs({ command: long }, 60)).toBe(cmdLabel(long, 60));
		expect(sharedCdDirs(["cd /a && x", "cd /a; y", "cd /b && z", "ls"])).toEqual(new Set(["/a"]));
	});

	test("handle index: rows of one tool and the same arguments get the first line that tells them apart", async () => {
		const entries: Any[] = [U("u1", "go")];
		for (let i = 1; i <= 70; i++) entries.push(tcall(`s${i}`, "bash", { command: "job status" }), tres(`s${i}`, "bash", status(i)));
		entries.push(A("e"));
		const t = skeleton(buildBlocks(entries), null).text;
		const index = sec(t, "## Handle index").split("\n").filter((l) => l.startsWith("- "));
		expect(index.length).toBeGreaterThan(0); // the commands list dropped the oldest: their handles are in the index
		for (const l of index) expect(l).toMatch(/ · Saved #\d+ state\.v\d+$/);
		expect(new Set(index.map((l) => l.split(" · ").pop())).size).toBe(index.length);
		// carried into the next summary's index, a row keeps its line
		const rows = handleRowsOf(t).filter((r) => r.hint);
		expect(rows.length).toBe(index.length);
	});

	test("distinctLines is pure, prefers the given key lines, skips lines a sibling or a taken label has", () => {
		const a = "same\nkey A\nonly-a", b = "same\nkey B\nonly-b";
		expect(distinctLines([a, b])).toEqual(["key A", "key B"]);
		expect(distinctLines([a, b], [["only-a"], ["only-b"]])).toEqual(["only-a", "only-b"]);
		expect(distinctLines([a, b], [], ["key A"])).toEqual(["only-a", "key B"]);
		expect(distinctLines(["x\ny", "x\ny"])).toEqual([null, null]);
		expect(distinctLines([a, b])).toEqual(distinctLines([a, b]));
	});

	test("deterministic: the same session gives byte-identical summaries", async () => {
		const mk = () => [U("u1", "go"), ...[1, 2, 3].flatMap((i) => [tcall(`p${i}`, "job_status", {}), tres(`p${i}`, "job_status", status(i))]), A("e")];
		expect(await cutOf(mk())).toBe(await cutOf(mk()));
	});
});

describe("times instead of turn numbers (2026-10-11 item 4, 2026-10-10 item 5)", () => {
	const at = (h: number, m: number) => Date.UTC(2026, 9, 11, h, m);
	test("a placeholder says the UTC time of the result, MM-DD HH:MM UTC, not a turn that restarts at every compaction", () => {
		const out = "ok\n".repeat(400) + "done";
		const ph = makePlaceholder(out, "bash", "make", handleFor("x"), 8, { at: at(2, 31), turn: 49, isError: false })!;
		expect(ph.split("\n")[0]).toBe(`[folded by pi-zip · bash make · 10-11 02:31 UTC · exit 0 · ${out.length} chars, 401 lines · handle ${handleFor("x")}]`);
		expect(ph).not.toContain("turn");
		const blocks = buildBlocks([U("u1", "go"), tcall("m", "bash", { command: "make" }), tres("m", "bash", out, at(23, 5)), A("e")]);
		expect(makePlaceholderFor(blocks[2], toolCallIndex(blocks))!.split("\n")[0]).toContain("bash make · 10-11 23:05 UTC · exit 0");
		// no timestamp (never in Pi; older harnesses): the turn, as before
		expect(makePlaceholder(out, "bash", "make", handleFor("x"), 8, { turn: 4 })!.split("\n")[0]).toContain("bash make · turn 4 ·");
	});

	test("summary rows (commands, other calls, folded-outputs table, handle index) say the time", async () => {
		const entries: Any[] = [U("u1", "go")];
		entries.push(tcall("b", "bash", { command: "make" }), tres("b", "bash", "y\n".repeat(3000), at(9, 7)));
		entries.push(tcall("w", "web_fetch", { url: "https://x.test" }), tres("w", "web_fetch", "page", at(9, 8)));
		for (let i = 1; i <= 62; i++) entries.push(tcall(`s${i}`, "bash", { command: `step ${i}` }), tres(`s${i}`, "bash", "ok", at(10, i % 60)));
		entries.push(A("e"));
		const t = await cutOf(entries);
		expect(t).not.toMatch(/turn \d/);
		expect(sec(t, "## Other tool calls")).toContain(`web_fetch {"url":"https://x.test"} (10-11 09:08 UTC, ${handleFor("r-w")})`);
		expect(sec(t, "## Other tool calls").split("\n")[0]).toBe("## Other tool calls (time, handle)");
		expect(sec(t, "## Commands run")).toContain(`\`step 62\` -> exit 0 (10-11 10:02 UTC, ${handleFor("r-s62")})`);
		expect(sec(t, "## Folded outputs")).toContain(`- ${handleFor("r-b")} · bash make · 10-11 09:07 UTC · exit 0 · y`);
		expect(sec(t, "## Handle index")).toContain(`- ${handleFor("r-s1")} · bash step 1 · 10-11 10:01 UTC`);
		// read back: every row keeps the label it was written with
		const rows = handleRowsOf(t);
		expect(rows.find((r) => r.handle === handleFor("r-s62"))?.when).toBe("10-11 10:02 UTC");
		expect(rows.find((r) => r.handle === handleFor("r-w"))?.when).toBe("10-11 09:08 UTC");
		expect(rows.find((r) => r.handle === handleFor("r-s1"))?.when).toBe("10-11 10:01 UTC");
	});

	test.each(["turn 4", "10-11 02:31", "10-11 02:31 UTC"])("persisted summaries (%s) still parse and merge: labels stay unchanged", (label) => {
		const h1 = handleFor("o1"), h2 = handleFor("o2"), h3 = handleFor("o3"), h4 = handleFor("o4");
		const old = [
			"[summary of earlier conversation by pi-zip]",
			"## User requests (verbatim, oldest first, continuation lines indented)", "1. OLD",
			"## Commands run (with exit status)", `\`bun test\` -> exit 1 (${label}, ${h1})`,
			"## Other tool calls (turn, handle)", `web_fetch {"url":"https://x"} (${label}, ${h2})`,
			"## Errors", "(none)",
			"## Handle index (older outputs)", `- ${h3} · read src/z.ts · ${label}`,
			"## Narrative (model-written)", "n",
			"## Folded outputs (originals recallable with zip_recall)", `- ${h4} · bash cat f · ${label} · exit 0 · hint`,
		].join("\n");
		const t = skeleton(buildBlocks([U("u1", "NEW"), tcall("n", "bash", { command: "ls" }), tres("n", "bash", "a", at(8, 0)), A("e")]), old).text;
		expect(t).toContain(`\`bun test\` -> exit 1 (${label}, ${h1})`);
		expect(t).toContain(`web_fetch {"url":"https://x"} (${label}, ${h2})`);
		expect(t).toContain(`\`ls\` -> exit 0 (10-11 08:00 UTC, ${handleFor("r-n")})`);
		expect(t).toContain(`- ${h3} · read src/z.ts · ${label}`); // the index carries the old row as it was
		const rows = handleRowsOf(old);
		expect(rows.map((r) => r.when)).toEqual([label, label, label, label]);
	});
});

describe("smaller mechanical lists (2026-10-11 item 2, 2026-10-10 item 3)", () => {
	test("the budgets are the eval-chosen ones (research round5/sumfmt.md), about 60% of v0.3.0's", () => {
		expect(BUDGET.users + BUDGET.usersFirst + BUDGET.usersShort).toBeLessThanOrEqual(8000); // was 16,000
		expect(BUDGET.cmds).toBeLessThanOrEqual(5000); // was 10,000
		expect(BUDGET.others).toBeLessThanOrEqual(3000); // was 5,000
		expect(BUDGET.errors).toBeLessThanOrEqual(2000); // was 4,000
		expect(TABLE_ROWS).toBeLessThanOrEqual(30); // was 40
		expect(INDEX_TOKENS).toBeGreaterThanOrEqual(2500); // was 1,500: handles moved from the lists to the index, one short row each
	});

	test("a long session: 200 requests and 600 commands give a summary of about 22K chars (v0.3.0: 31K), the first request and the newest verbatim, every handle accounted for", async () => {
		let prev: string | null = null;
		let text = "";
		for (let L = 0; L < 10; L++) {
			const entries: Any[] = [{ sourceEntry: { id: `comp${L}`, type: "compaction" }, messages: [{ role: "compactionSummary", summary: prev ?? "", tokensBefore: 0, timestamp: 0 }] }].filter(() => prev !== null);
			for (let k = 0; k < 20; k++) {
				entries.push(U(`u${L}-${k}`, `REQUEST ${L * 20 + k + 1}: ` + "please do the next thing on the list, carefully ".repeat(8)));
				for (let c = 0; c < 3; c++) entries.push(tcall(`b${L}-${k}-${c}`, "bash", { command: `cd /work/repo && make target-${L}-${k}-${c} VERBOSE=1` }), tres(`b${L}-${k}-${c}`, "bash", c ? "ok" : "line\n".repeat(400) + `RESULT ${L}-${k}`));
				entries.push(A(`a${L}-${k}`));
			}
			text = await cutOf(entries);
			prev = text;
		}
		expect(text.length).toBeLessThan(26_000); // 22.2K (v0.3.0: 31.3K)
		expect(text).toContain("\n1. REQUEST 1: please");
		expect(text).toContain("\n200. REQUEST 200: please");
		expect(text).toMatch(/\n\d+\. ≈ REQUEST \d+: please/);
		expect(text).toContain('a leading "cd <dir> &&" is left out for: /work/repo');
	});
});

describe("single-line JSON outputs (2026-10-10 item 1)", () => {
	const jobs = Array.from({ length: 45 }, (_, i) => ({ wid: `w${i}`, name: `job-${i}`, status: i < 44 ? "done" : "running", phase: i < 44 ? "finished" : "review", error: null, result: `Result of job ${i}: ` + "lorem ipsum ".repeat(30) + `VERDICT-${i} merged` }));
	const one = JSON.stringify({ count: 45, items: jobs });

	test("a one-line JSON document: key fields (status/phase/error-like, the newest record's identity, the end of the last long string), not its first 160 chars", () => {
		const ph = makePlaceholder(one, "bash", "jobs status", handleFor("j"), 8)!;
		expect(ph).toContain("key fields kept (JSON; path: value, long strings show their end; up to 8):");
		expect(ph).toContain('.items[44].status: "running"');
		expect(ph).toContain('.items[44].phase: "review"');
		expect(ph).toContain('.items[44].wid: "w44"');
		expect(ph).toMatch(/\.items\[44\]\.result: "….*VERDICT-44 merged"/);
		expect(ph).not.toContain("key lines kept");
		expect(ph).not.toContain('{"count":45,"items":[{"wid"');
	});

	test("error fields come first; null/empty ones are skipped", () => {
		const doc = JSON.stringify({ id: "run-7", steps: Array.from({ length: 30 }, (_, i) => ({ n: i, error: i === 17 ? "ENOSPC: no space left on device" : null, log: "x".repeat(200) })) });
		const f = jsonKeyFields(doc)!;
		expect(f.some((l) => l === '.steps[17].error: "ENOSPC: no space left on device"')).toBe(true);
		expect(f.filter((l) => l.includes(".error")).length).toBe(1);
	});

	test("JSON already laid out one value per line, and text that only looks like JSON, keep their key lines", () => {
		const pretty = JSON.stringify({ count: 45, items: jobs.slice(0, 5) }, null, 2) + "\n".repeat(0);
		expect(jsonKeyFields(pretty)).toBeNull();
		expect(makePlaceholder(pretty + " ".repeat(1000), "read", "x.json", handleFor("p"), 8)).toContain("key lines kept");
		expect(jsonKeyFields("{not json " + "x".repeat(2000))).toBeNull();
		expect(jsonKeyFields('"just a string"')).toBeNull();
	});

	test("the folded-outputs table shows a JSON output by its most telling field; look-alike JSON rows are told apart", async () => {
		const st = (n: number) => JSON.stringify({ count: 45, items: jobs.map((j, i) => (i === 44 ? { ...j, status: n === 1 ? "running" : "failed" } : j)) });
		const t = await cutOf([U("u1", "go"), tcall("j1", "bash", { command: "jobs status" }), tres("j1", "bash", st(1)), tcall("j2", "bash", { command: "jobs status" }), tres("j2", "bash", st(2)), A("e")]);
		const rows = sec(t, "## Folded outputs").split("\n").filter((l) => l.startsWith("- "));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain('.items[44].status: "running"');
		expect(rows[1]).toContain('.items[44].status: "failed"');
	});

	test("10,000 (and 100,000) levels of nesting: no throw (the walk stops at depth 64), and a placeholder is made", () => {
		const deep = "[".repeat(10_000) + '"x"' + "]".repeat(10_000);
		expect(() => jsonKeyFields(deep)).not.toThrow();
		const o = '{"a":' .repeat(10_000) + '{"status":"done"}' + "}".repeat(10_000);
		expect(() => jsonKeyFields(o)).not.toThrow();
		expect(makePlaceholder(o, "bash", "deep", handleFor("d"), 8)).toContain("handle");
		expect(() => keyTexts(deep)).not.toThrow();
		const deeper = "[".repeat(100_000) + '"x"' + "]".repeat(100_000); // overflows bun's stack too without the cap (node's from ~5,000)
		expect(() => jsonKeyFields(deeper)).not.toThrow();
	});

	test("JSON whose values are all empty (0, null) falls back to key lines in the placeholder and the summary hint", () => {
		const empty = JSON.stringify({ items: Array.from({ length: 300 }, () => ({ a: 0, b: null })) });
		expect(jsonKeyFields(empty)).toEqual([]);
		const ph = makePlaceholder(empty, "bash", "dump", handleFor("e"), 8)!;
		expect(ph).toContain("key lines kept");
		expect(ph).not.toContain("key fields kept");
		expect(keyTexts(empty).length).toBeGreaterThan(0);
	});

	test("deterministic", () => {
		expect(jsonKeyFields(one)).toEqual(jsonKeyFields(one));
	});
});

export { handleFor };
