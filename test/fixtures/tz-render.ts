// A fixed persisted session rendered in a fresh process, so TZ and locale are set before any module loads.
import { buildBlocks, toolCallIndex } from "../../src/plan.ts";
import { handleFor, makePlaceholderFor } from "../../src/placeholder.ts";
import { branchOutputs, recallSections, searchOutputs } from "../../src/recall.ts";
import { buildCut, handleRowsOf, previousNarrative, skeleton } from "../../src/summary.ts";
import { fmtWhen } from "../../src/util.ts";
import { A, type Any, R, U } from "../helpers.ts";

// UTC year/day boundaries, leap day, and both sides of a daylight-saving change.
const times = ["2026-12-31T23:58:00Z", "2024-02-29T00:05:00Z", "2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z"].map(Date.parse);
const entries: Any[] = [U("u1", "Inspect build output and İstanbul identifiers.")];
for (let i = 0; i < 65; i++) {
	const a = A(`a${i}`, [`c${i}`]);
	const call = a.messages[0].content.find((c: Any) => c.type === "toolCall") as Any;
	if (i === 0) Object.assign(call, { name: "web_fetch", arguments: { url: "https://example.test/İ" } });
	else if (i === 1) Object.assign(call, { name: "read", arguments: { path: "src/İ.ts" } });
	else call.arguments = { command: `step ${i}` };
	const r = R(`r${i}`, `c${i}`, 0, `result ${i}\n` + "unchanged output\n".repeat(i % 2 ? 80 : 800) + "2 passed\n");
	Object.assign(r.messages[0], { toolName: call.name, timestamp: times[i % times.length] });
	entries.push(a, r);
}
entries.push(U("keep", "Continue."), A("keepA"));
const blocks = buildBlocks(entries), calls = toolCallIndex(blocks);
const p: Any = { blocks, calls, cutIdx: blocks.findIndex((b) => b.entryId === "keep"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
const prompts: string[] = [];
const ctx = (fail = false): Any => ({ model: { id: "m" }, modelRegistry: { complete: async (_m: Any, c: Any) => {
	prompts.push(c.messages[0].content[0].text);
	return fail ? { stopReason: "error", errorMessage: "offline", content: [] }
		: { stopReason: "stop", content: [{ type: "text", text: "## Key facts to remember\nPersisted fact: 42." }] };
} } });
const placeholders = blocks.filter((b) => b.kind === "toolResult").map((b) => makePlaceholderFor(b, calls));
const first = (await buildCut(p, ctx())).text;
const compaction = { sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: first, tokensBefore: 0, timestamp: times[0] }] };
const nextBlocks = buildBlocks([compaction, ...entries]);
const nextPlan = { ...p, blocks: nextBlocks, calls: toolCallIndex(nextBlocks), cutIdx: nextBlocks.findIndex((b) => b.entryId === "keep") };
const failed = (await buildCut(nextPlan, ctx(true))).text;
// Reading a carried narrative must keep its original written label, despite a newer compaction timestamp.
const carried = previousNarrative(failed, times[1]);
const branch = entries.map((e) => e.sourceEntry);
const outputs = branchOutputs(branch);
const recall = recallSections(outputs.slice(0, 2), { range: "1-2" }).text;
const search = searchOutputs(outputs, "result", { limit: 50_000 }).text;
console.log(JSON.stringify({
	zoneOffset: new Date(times[0]).getTimezoneOffset(), locale: new Intl.DateTimeFormat().resolvedOptions().locale,
	rendered: { formatted: times.map(fmtWhen), placeholders, first, failed, carried, prompts,
		merged: skeleton([], first).text, rows: handleRowsOf(first), recall, search,
		missing: recallSections([{ handle: handleFor("missing"), tool: null, text: null }], {}).text },
}));
