import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recallSections, resolveHandlesInBranch } from "../src/recall.ts";
import { handleFor } from "../src/placeholder.ts";
import { CHART_W, STACK_CAP, cardText, colW, fmtLife, markFirstLine, recallCallLine, recallResultLines, renderCard, renderState, stackRows, type CardData } from "../src/ui.ts";
import { fakeCtx, fakePi, startPrompt } from "./helpers.ts";

type Any = any;
const IND_ = 11; // the values column
const th = { fg: (_c: string, t: string) => t };
const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
const plainW = (s: string) => s.replace(/<\/?\w+>/g, "").length;
const fits = (lines: string[], w: number, vw = (s: string) => s.length) => lines.every((l) => vw(l) <= w);

describe("state lines", () => {
	test("one line: product, word, dim reason; warning colour for off/paused/reread-only", () => {
		expect(renderState("paused", "billion-context also manages context", 120, th)).toEqual(["ƶ pi-zip  paused  billion-context also manages context"]);
		expect(renderState("paused", "x", 120, tag)[0]).toContain("<warning>paused</warning>");
		expect(renderState("on", "x", 120, tag)[0]).toContain("<success>on</success>");
		expect(renderState("on", "x", 120, tag)[0]).toStartWith("<accent>ƶ</accent> <muted>pi-zip</muted>");
		for (const w of [3, 8, 15, 20, 40, 120]) expect(fits(renderState("reread-only", "a tool allowlist hides zip_recall, so only rereadable outputs fold", w, th), w)).toBe(true);
		expect(renderState("paused", "a long reason", 18, th)).toEqual(["ƶ pi-zip  paused"]);
	});
});

const card: CardData = {
	state: "on", model: "sota-gpt/gpt-6.1-sol", life: "~1 h",
	folds: 56, foldedTokens: "310K", summaries: 2, summaryUsd: 0.41, recalls: 3, last: "10:50  folded 12 old outputs · cache cold (away 47 min)", quiet: false,
};
describe("status card", () => {
	test("labelled rows in plain words: no classes, no curves, no row that only states the default", () => {
		expect(cardText(card)).toEqual([
			"model    sota-gpt/gpt-6.1-sol",
			"cache    expires after ~1 h idle · a chart appears once you come back after a break",
			"session  56 zipped ~310K  ·  2 summaries $0.41  ·  3 unzips",
			"last     10:50  folded 12 old outputs · cache cold (away 47 min)",
		]);
		const lines = renderCard(card, 120, th);
		expect(lines[0]).toBe("ƶ pi-zip  on");
		expect(lines[3]).toBe("  session  56 zipped ~310K  ·  2 summaries $0.41  ·  3 unzips");
		for (const w of [10, 30, 60, 120]) expect(fits(renderCard(card, w, tag), w, plainW)).toBe(true);
	});
	test("reread-only and quiet show up; the session row is the only one in the text colour", () => {
		const t = cardText({ ...card, state: "reread-only", quiet: true });
		expect(t.at(-1)).toBe("notices  off  (/zip quiet turns them back on)");
		const l = renderCard(card, 200, tag);
		expect(l.filter((x) => x.includes("<text>"))).toHaveLength(1);
		expect(renderCard({ ...card, state: "reread-only", stateNote: "a tool allowlist hides zip_recall" }, 200, tag)[0]).toContain("<warning>reread-only</warning>");
	});
	test("failed narrative calls get one warning row: how many, when and why the newest failed; none, no row", () => {
		const c: CardData = { ...card, failed: 59, failedWhy: "07:10 narrative hit the token cap" };
		expect(cardText(c)).toContain("errors   59 narrative calls failed \u00b7 last 07:10 narrative hit the token cap");
		expect(cardText({ ...card, failed: 1 })).toContain("errors   1 narrative call failed");
		expect(cardText(card).some((r) => r.startsWith("errors"))).toBe(false);
		const l = renderCard(c, 200, tag);
		expect(l.filter((x) => x.includes("<warning>59 narrative calls failed"))).toHaveLength(1);
		for (const w of [10, 30, 60, 120]) expect(fits(renderCard(c, w, tag), w, plainW)).toBe(true);
		const raw = cardText({ ...card, failed: 2, failedWhy: "07:10 overloaded:\n\t\x1b[31mretry\x1b[0m later\r\n" });
		expect(raw).toContain("errors   2 narrative calls failed \u00b7 last 07:10 overloaded: retry later");
		expect(raw.join("\n")).not.toMatch(/\x1b|\r|\t|overloaded:\n/);
	});
	test("nothing learned yet: one line, no empty chart, the declared lifetime and what makes a chart appear; narrow keeps the fact whole", () => {
		const c: CardData = { ...card, life: "~5 min" };
		expect(renderCard(c, 120, th).slice(1, 3)).toEqual(["  model    sota-gpt/gpt-6.1-sol", "  cache    expires after ~5 min idle · a chart appears once you come back after a break"]);
		expect(renderCard(c, 60, th)[2]).toBe("  cache    expires after ~5 min idle");
		const wide = renderCard(c, 120, th);
		expect(wide.some((l) => /[●○━┅]/.test(l))).toBe(false);
		for (const w of [10, 30, 43, 60, 80, 120]) expect(fits(renderCard(c, w, tag), w, plainW)).toBe(true);
	});

	// 3 + 1 + ... the bins of a Claude-like model (5-min cliff)
	const bin = (lo: number, hi: number, alive: number, gone: number) => ({ lo, hi, alive, gone });
	const few: CardData = { ...card, model: "anthropic/claude-sonnet-5-5", life: "~5 min", s1: 300, s2: 330, usually: false, bins: [bin(30, 60, 2, 0), bin(120, 180, 1, 0), bin(240, 300, 2, 0), bin(360, 420, 0, 1)] };
	test("a few samples: alive dots above the axis, gone below, rows = the tallest stack, legend beside, axis bands, caption", () => {
		const l = renderCard(few, 120, th);
		const at = (k: string) => l.findIndex((x) => x.startsWith(`  ${k}`));
		expect(l.slice(1, 3)).toEqual(["  model    anthropic/claude-sonnet-5-5", "  cache    each dot is one time you came back"]);
		const axis = l.findIndex((x) => x.startsWith("           ━"));
		expect(l.slice(3, axis)).toHaveLength(2); // the tallest alive stack has 2 dots
		expect(l.slice(axis + 1, at("away"))).toHaveLength(1); // one gone sample: one row below
		expect(l[axis - 1]).toMatch(/● still there  5$/);
		expect(l[axis + 1]).toMatch(/○ gone  1$/);
		expect(l[axis - 1][IND_ + colW(Math.sqrt(30 * 60))]).toBe("●");
		expect(l[axis + 1][IND_ + colW(Math.sqrt(360 * 420))]).toBe("○");
		expect(l[axis].length).toBe(IND_ + CHART_W + 1);
		expect(l[at("away")]).toMatch(/^  away     30s +1m +2m +5m +10m +30m +1h +2h$/);
		expect(l[at("away") + 1]).toBe("           under 5 min: still there  ·  5–5.5 min: not sure yet  ·  over 5.5 min: gone");
		const t = renderCard(few, 120, tag);
		const ax = t.find((x) => x.includes("━"))!;
		expect(ax).toStartWith(`           <accent>${"━".repeat(colW(300) + 1)}`.slice(0, 20)); // solid while under s1
		expect(ax).toContain("<warning>┅");
		expect(ax).toContain("<dim>─");
		expect(t[axis - 1]).toContain("<accent>●</accent>");
		expect(t[axis + 1]).toContain("<dim>○</dim>");
	});
	test("'usually' only when a bin under s1 is not nearly always alive; no middle part when s2 <= s1", () => {
		expect(renderCard({ ...few, usually: true }, 120, th).join("\n")).toContain("under 5 min: usually still there");
		const c = renderCard({ ...few, s1: 300, s2: 300 }, 120, th).join("\n");
		expect(c).toContain("under 5 min: still there  ·  over 5 min: gone");
		expect(c).not.toContain("not sure yet");
	});
	test("a heavy-gone history: both sides stack to 4 rows, the 4th mark of a long stack is the count", () => {
		const heavy = [bin(30, 60, 3, 0), bin(60, 120, 6, 1), bin(120, 180, 5, 0), bin(180, 240, 3, 1), bin(240, 300, 2, 2), bin(300, 330, 0, 1), bin(420, 480, 0, 4), bin(600, 900, 0, 12), bin(900, 1200, 0, 7), bin(1200, 1800, 0, 9), bin(1800, 2700, 0, 15), bin(2700, 3600, 0, 6), bin(3600, 5400, 0, 11), bin(5400, 7200, 0, 5)];
		const c: CardData = { ...few, bins: heavy, s1: 120, s2: 300, usually: true };
		const l = renderCard(c, 120, th);
		const axis = l.findIndex((x) => x.startsWith("           ━")), away = l.findIndex((x) => x.startsWith("  away"));
		expect(axis - 3).toBe(4); // header row + ... : 4 rows above (rows 3..6)
		expect(away - axis - 1).toBe(4); // 4 rows below
		expect(l[axis - 1]).toMatch(/● still there  19$/);
		expect(l[axis + 1]).toMatch(/○ gone  74$/);
		// the count of a stack beyond the cap sits on its far end, in its column: 12 gone in 600-900 s
		const col = IND_ + colW(Math.sqrt(600 * 900));
		expect(l[axis + 4].slice(col, col + 2)).toBe("12");
		expect([1, 2, 3].map((k) => l[axis + k][col])).toEqual(["○", "○", "○"]);
		expect(l[axis - 4].slice(IND_ + colW(Math.sqrt(60 * 120)), IND_ + colW(Math.sqrt(60 * 120)) + 1)).toBe("6");
		expect(l.join("\n")).toContain("under 2 min: usually still there  ·  2–5 min: not sure yet  ·  over 5 min: gone");
	});
	test("collisions: bins on the same column merge, counts keep a blank from every neighbour and from each other, nothing is overwritten", () => {
		// same column: merged
		let r = stackRows([{ col: 10, n: 1 }, { col: 10, n: 2 }]);
		expect(r.rows.map((x) => x[10])).toEqual(["●", "●", "●"]);
		// a count between dots of the neighbouring columns: it keeps one blank on each side
		r = stackRows([{ col: 20, n: 17 }, { col: 21, n: 4 }, { col: 19, n: 4 }]);
		const top = r.rows[STACK_CAP - 1].join("");
		expect(top).toContain("17");
		expect(top.replace(/ /g, "")).toMatch(/^●?17●?$|^●●17$|^17●●$|^●17●$/);
		expect(top.match(/●/g)!.length).toBe(2); // both neighbours keep their top dot
		const at = top.indexOf("17");
		for (const k of [at - 1, at + 2]) expect(top[k] ?? " ").toBe(" ");
		// adjacent heavy columns: every count is whole, in order, separated
		r = stackRows([{ col: 26, n: 17 }, { col: 27, n: 120 }, { col: 28, n: 33 }]);
		const row = r.rows[STACK_CAP - 1].join("");
		expect(row.match(/\d+/g)).toEqual(["17", "120", "33"]);
		expect(row).not.toMatch(/\d\d?\d? ?\d/.source === "" ? /x/ : /\d{4,}/); // never run together into one number
		expect(/\d \d/.test(row) || /\d{1,3}\s+\d/.test(row)).toBe(true);
		// the dots of the stacks below the count are still there, at their own column
		for (const col of [26, 27, 28]) expect(r.rows.slice(0, STACK_CAP - 1).map((x) => x[col])).toEqual(["●", "●", "●"]);
		// the edges: a count at the last column stays inside the chart
		r = stackRows([{ col: CHART_W, n: 120 }]);
		expect(r.rows[STACK_CAP - 1].join("").trimEnd().endsWith("120")).toBe(true);
		// deterministic: the same input, the same rows
		expect(stackRows([{ col: 28, n: 33 }, { col: 26, n: 17 }, { col: 27, n: 120 }]).rows).toEqual(stackRows([{ col: 26, n: 17 }, { col: 27, n: 120 }, { col: 28, n: 33 }]).rows);
	});
	test("narrow: the legend moves to one line under the chart; when the chart does not fit only the caption is shown, never cut mid-fact", () => {
		const c: CardData = { ...few };
		const mid = renderCard(c, 80, th); // the chart (72) fits, the legend beside it does not
		const away = mid.findIndex((x) => x.startsWith("  away"));
		expect(mid[away + 1]).toBe("           ● still there  5   ○ gone  1");
		expect(mid.filter((x) => x.includes("still there  5"))).toHaveLength(1);
		expect(mid.some((x) => /^ {11}━/.test(x))).toBe(true);
		const tight = renderCard(c, 71, th);
		expect(tight.some((x) => /[●○━┅]/.test(x))).toBe(false);
		expect(tight.slice(1, 4)).toEqual(["  model    anthropic/claude-sonnet-5-5", "  cache    under 5 min: still there  ·  5–5.5 min: not sure yet", "           over 5.5 min: gone"]);
		for (const w of [10, 30, 40, 50, 60, 71, 72, 80, 90, 110, 120, 160]) for (const x of [few, { ...few, usually: true }]) expect(fits(renderCard(x, w, tag), w, plainW)).toBe(true);
	});
	test("fmtLife", () => expect([fmtLife(45), fmtLife(300), fmtLife(3600), fmtLife(9000)]).toEqual(["~45 s", "~5 min", "~1 h", "~2.5 h"]));
	test("the unzip row: narrow, the bracketed reason goes first, so where the files are is never cut mid-word", () => {
		const c: CardData = { ...card, unzip: "from files in ~/.cache/pi-zip/recall (a tool allowlist hides zip_recall)" };
		const row = (w: number) => renderCard(c, w, th).find((l) => l.startsWith("  unzip "));
		expect(row(120)).toBe("  unzip    from files in ~/.cache/pi-zip/recall (a tool allowlist hides zip_recall)");
		expect(row(80)).toBe("  unzip    from files in ~/.cache/pi-zip/recall");
		expect(row(47)).toBe("  unzip    from files in ~/.cache/pi-zip/recall");
		expect(row(46)).toBe("  unzip    from files in ~/.cache/pi-zip/reca\u2026"); // narrower than the place itself: cut like any row
		for (const w of [10, 30, 46, 47, 60, 80, 120]) expect(fits(renderCard(c, w, tag), w, plainW)).toBe(true);
	});
});

describe("zip_recall row", () => {
	const branch: Any[] = [
		{ id: "u1", type: "message", message: { role: "user", content: "go" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] } },
		{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: Array.from({ length: 812 }, (_, i) => (i === 246 ? "Expected: 108.5" : `line ${i + 1}`)).join("\n") }] } },
	];
	const h = handleFor("r1");
	test("sections carry label, turn and how much was shown", () => {
		const { items } = resolveHandlesInBranch(branch, [h, "nope000000"]);
		const out = recallSections(items, { grep: "Expected" });
		expect(out.sections).toEqual([
			{ handle: h, label: "bash npm test", turn: 1, totalLines: 812, shownLines: 1, how: "grep" },
			{ handle: "nope000000", missing: true },
		]);
		expect(recallSections(items.slice(0, 1), {}).sections[0]).toMatchObject({ how: "all", shownLines: 812 });
	});
	test("collapsed: one quiet line per handle; expanded: the text, capped, control characters stripped", () => {
		// like Pi's own tool rows: the name, then WHAT comes back (the folded output's label when known, else the handle)
		expect(recallCallLine({ handle: h, grep: "Expected" }, 120, th)).toEqual([`ƶ unzip ${h}  /Expected/`]);
		expect(recallCallLine({ handle: h, grep: "Expected" }, 120, th, undefined, (x) => (x === h ? "bash npm test" : undefined))).toEqual([`ƶ unzip bash npm test  /Expected/`]);
		expect(recallCallLine({ handle: h }, 120, { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*` }, undefined, () => "read src/a.ts")).toEqual(["<accent>*ƶ*</accent> <toolTitle>*unzip*</toolTitle> <accent>src/a.ts</accent><dim></dim>"]);
		expect(recallCallLine({ handles: [h, "x"] }, 120, th)).toEqual(["ƶ unzip 2 outputs"]);
		expect(recallCallLine({ grep: "Expected" }, 120, th)).toEqual(["ƶ unzip all outputs  /Expected/"]); // grep without a handle searches every output
		const secs = [{ handle: h, label: "bash npm test", turn: 1, totalLines: 812, shownLines: 1, how: "grep" as const }];
		expect(recallResultLines(secs, "x", false, 120, th)).toEqual(["1 of 812 lines"]);
		expect(recallResultLines([...secs, { ...secs[0], label: "read a.ts", how: "all" as const, totalLines: 9 }], "x", false, 120, th)).toEqual(["bash npm test  1 of 812 lines", "read a.ts  all 9 lines"]);
		const long = Array.from({ length: 50 }, (_, i) => `\x1b[31mrow\t${i}\x07`).join("\n");
		const ex = recallResultLines(secs, long, true, 120, th, undefined, 40);
		expect(ex[1]).toBe("row  0");
		expect(ex.at(-1)).toBe("… 10 more lines (the model got them all)");
		for (const w of [5, 20, 60]) expect(fits(recallResultLines(secs, long, true, w, th), w)).toBe(true);
		expect(recallResultLines([{ handle: "nope", missing: true }], "", false, 80, tag)).toEqual(["<error>nope not found</error>"]);
		// expanded: only the recalled text, not the framing the model gets (it repeats the collapsed line)
		const framed = `[handle ${h} · read · 7089 chars · 117 lines]\n[grep: 2 matching line(s) of 117]\n31: const HALF_LIFE = 16;\n89: x\n[… 900 more chars: call zip_recall again with offset=10]`;
		expect(recallResultLines(secs, framed, true, 120, th)).toEqual(["1 of 812 lines", "31: const HALF_LIFE = 16;", "89: x"]);
		expect(recallResultLines(secs, `[handle ${h} · read · 7089 chars · 117 lines]\n[grep: 0 matching line(s) of 117]\n`, true, 120, th)).toEqual(["1 of 812 lines"]);
	});
});

describe("the mark on a folded output", () => {
	test("right after the row's own text when it fits (row width kept), untouched otherwise", () => {
		expect(markFirstLine(["$ npm test", "out"], "k3x9q2m7ab", 50, th)).toEqual([`$ npm test  ƶ zipped${" ".repeat(50 - 10 - 10)}`, "out"]);
		// a row padded to the full width (styles closed after the padding) still gets the mark, at the same width
		const padded = markFirstLine(["\x1b[1m$ npm test" + " ".repeat(40) + "\x1b[0m"], "k3x9q2m7ab", 50, th, { vw: (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "").length, cut: (x: string) => x });
		expect(padded[0]).toBe(`\x1b[1m$ npm test\x1b[0m  ƶ zipped${" ".repeat(50 - 10 - 10)}`);
		expect(markFirstLine(["$ npm test"], "k3x9q2m7ab", 19, th)).toEqual(["$ npm test"]);
	});
	test("wired through registerToolRenderer: wraps the built-in renderer and marks only folded calls", async () => {
		const { default: piZip } = await import("../src/index.ts");
		let resolver: Any = null;
		const f = fakePi({ registerToolRenderer: (r: Any) => (resolver = r), registerEntryRenderer: () => {} });
		piZip(f.pi);
		const base = { renderCall: (args: Any) => ({ render: () => [`$ ${args.command}`], invalidate: () => {}, extra: 7 }) };
		const r = resolver("bash", () => base);
		const branch: Any[] = [
			{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(5000) }] } },
			{ id: "e1", type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "[folded by pi-zip · bash" }] } },
		];
		const { ctx } = fakeCtx([], { branch });
		await f.handlers.get("session_start")({}, ctx);
		const folded = r.renderCall({ command: "npm test" }, th, { toolCallId: "c1" });
		expect(folded.render(60)[0].trimEnd()).toBe("$ npm test  ƶ zipped");
		expect(folded.extra).toBe(7); // everything else passes through
		expect(r.renderCall({ command: "ls" }, th, { toolCallId: "c2" }).render(60)).toEqual(["$ ls"]);
		expect(resolver("zip_recall", () => base)).toBe(base);
	});
	test("a built-in renderer that reuses context.lastComponent gets the bare component back, so streaming does not nest wrappers", async () => {
		const { default: piZip } = await import("../src/index.ts");
		let resolver: Any = null;
		const f = fakePi({ registerToolRenderer: (r: Any) => (resolver = r), registerEntryRenderer: () => {} });
		piZip(f.pi);
		const seen: Any[] = [];
		// Pi's read/write/find renderers: `context.lastComponent ?? new Text()`, updated in place and returned
		const base = {
			renderCall: (args: Any, _t: Any, c: Any) => {
				seen.push(c.lastComponent);
				const comp = c.lastComponent ?? { text: "", render() { return [this.text]; }, invalidate: () => {} };
				comp.text = `write ${args.path} (${args.n})`;
				return comp;
			},
		};
		const r = resolver("write", () => base);
		const { ctx } = fakeCtx([], { branch: [] });
		await f.handlers.get("session_start")({}, ctx);
		// tool-execution.js: every args update calls renderCall with the component it returned last time
		let last: Any;
		const t0 = performance.now();
		for (let n = 1; n <= 3000; n++) {
			last = r.renderCall({ path: "a.ts", n }, th, { toolCallId: "w1", lastComponent: last });
			last.render(80);
		}
		expect(performance.now() - t0).toBeLessThan(500);
		expect(last.render(80)).toEqual(["write a.ts (3000)"]);
		expect(seen[0]).toBeUndefined();
		expect(seen[1]).toBe(seen[2999]); // the same bare component every time, never a wrapper of a wrapper
		expect(r.renderCall({ path: "a.ts", n: 1 }, th, { toolCallId: "w1", lastComponent: last })).toBe(last); // one wrapper per component
		// a row pi-zip drew itself (a read of a recall file) is never handed to the built-in renderer to update
		const rr = resolver("read", () => base);
		const row = rr.renderCall({ path: "/home/u/.cache/pi-zip/recall/s1/k3x9q2m7ab.txt" }, th, { toolCallId: "r1" });
		seen.length = 0;
		rr.renderCall({ path: "src/a.ts" }, th, { toolCallId: "r1", lastComponent: row });
		expect(seen).toEqual([undefined]);
	});
});

describe("transcript wiring", () => {
	const setup = async (branch: Any[] = [], over: Any = {}) => {
		const { default: piZip } = await import("../src/index.ts");
		const renderers = new Map<string, Any>();
		const f = fakePi({ registerEntryRenderer: (t: string, fn: Any) => renderers.set(t, fn), registerToolRenderer: () => {}, ...over });
		piZip(f.pi);
		const { ctx, notes } = fakeCtx([], { branch });
		const render = (e: Any, w = 120, expanded = false) => renderers.get("pi-zip/notice")({ data: e.data }, { expanded }, th).render(w);
		return { f, ctx, notes, render, renderers };
	};
	test("successful compaction has a plain dim confirmation, including after transcript rebuild", async () => {
		const { renderers } = await setup();
		const entry = { id: "zipped-1", data: { v: 2, kind: "zipped", text: "Conversation zipped!", before: 0, after: 0, desc: "" } };
		const build = (expanded: boolean) => renderers.get("pi-zip/notice")(entry, { expanded }, tag);
		expect(build(false).render(80)).toEqual(["<dim>Conversation zipped!</dim>"]);
		expect(build(true).render(80)).toEqual(build(false).render(80));
		expect(build(false).handleMouse({ type: "click", button: "left" })).toBeUndefined();
		for (const width of [0, 1, 5, 20, 80]) expect(fits(build(false).render(width), width, (s) => visibleWidth(s.replace(/<\/?\w+>/g, "")))).toBe(true);
	});
	test("/zip status is a card in the transcript; off/on/quiet are state lines", async () => {
		const { f, ctx, notes, render } = await setup();
		await f.handlers.get("session_start")({}, ctx);
		const cmd = f.handlers.get("cmd:zip");
		await cmd.handler("status", ctx);
		await cmd.handler("off", ctx);
		await cmd.handler("on", ctx);
		await cmd.handler("quiet", ctx);
		expect(notes).toHaveLength(0);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept.map((x: Any) => x.data.kind)).toEqual(["card", "state", "state", "state"]);
		const c = render(kept[0]);
		expect(c[0]).toBe("ƶ pi-zip  on");
		expect(c.join("\n")).toContain("model    p/m");
		// the declared 5-min TTL, nothing learned yet: one line, no chart
		expect(c.join("\n")).toContain("cache    expires after ~5 min idle · a chart appears once you come back after a break");
		expect(c.some((x: string) => /[●○━┅]/.test(x))).toBe(false);
		expect(c.join("\n")).toContain("session  0 zipped ~0K");
		expect(render(kept[1])[0]).toStartWith("ƶ pi-zip  off  Nothing is folded");
		expect(render(kept[2])[0]).toBe("ƶ pi-zip  on  folding resumes");
		expect(render(kept[3])[0]).toBe("ƶ pi-zip  quiet  per-turn notices off (folding continues)");
	});
	test("/zip with a learned history draws the dot chart from the stats file (counts, bands from the learned curve)", async () => {
		const { record } = await import("../src/learn.ts");
		const dir = mkdtempSync(join(tmpdir(), "pi-zip-card-"));
		const was = process.env.PI_ZIP_CACHE_STATS;
		process.env.PI_ZIP_CACHE_STATS = join(dir, "s.json");
		try {
			for (const [gap, alive, n] of [[45, true, 3], [200, true, 2], [270, true, 2], [400, false, 3], [1500, false, 5]] as const)
				for (let i = 0; i < n; i++) record("p/m", { explicit: true, total: 50_000, gapS: gap, alive });
			const { f, ctx, render } = await setup();
			await f.handlers.get("session_start")({}, ctx);
			await f.handlers.get("cmd:zip").handler("status", ctx);
			const c = render(f.appended.filter((x: Any) => x.customType === "pi-zip/notice").at(-1), 120);
			const axis = c.findIndex((x: string) => x.startsWith("           ━"));
			expect(c[axis - 1]).toMatch(/● still there  7$/);
			expect(c[axis + 1]).toMatch(/○ gone  8$/);
			expect(c[axis - 1][11 + colW(Math.sqrt(30 * 60))]).toBe("●"); // the 30-60 s bin, at its geometric middle
			expect(c.join("\n")).toMatch(/under 5 min: .*still there/);
			expect(c.join("\n")).toContain("over 6 min: gone");
		} finally {
			if (was === undefined) delete process.env.PI_ZIP_CACHE_STATS;
			else process.env.PI_ZIP_CACHE_STATS = was;
		}
	});
	test("a notice shows the real size of the request that carried its plan once that request is answered, and a zip's before-size on the same scale (estimate before; errors skipped; old notices unchanged)", async () => {
		const { default: piZip } = await import(process.env.PI_ZIP_TEST_SRC ? `${process.env.PI_ZIP_TEST_SRC}/index.ts` : "../src/index.ts"); // the mutants' copy
		const renderers = new Map<string, Any>();
		const f = fakePi({ registerEntryRenderer: (t: string, fn: Any) => renderers.set(t, fn), registerToolRenderer: () => {} });
		piZip(f.pi);
		const branch: Any[] = [];
		let walks = 0;
		const { ctx } = fakeCtx([], { sessionManager: { getBranch: () => (walks++, branch), getEntryCount: () => branch.length, buildSessionProjection: () => ({ entries: [] }) } });
		await f.handlers.get("session_start")({}, ctx);
		const t0 = Date.now();
		const data = { v: 2, text: "x", before: 74_000, after: 43_000, desc: "zipped 12 old outputs in 6 ms", reqTs: t0 };
		const render = (d: Any) => renderers.get("pi-zip/notice")({ id: "n1", data: d }, { expanded: false }, th).render(120)[0];
		walks = 0;
		expect(render(data)).toBe("ƶ zipped 12 old outputs   74K → 43K   6 ms"); // not answered yet: the estimate
		render(data);
		expect(walks).toBe(1); // nothing new in the session: not looked at again
		branch.push({ type: "message", id: "a0", message: { role: "assistant", timestamp: t0 - 5, usage: { input: 1, cacheRead: 99_000, cacheWrite: 0 } } }); // an earlier request
		branch.push({ type: "message", id: "a1", message: { role: "assistant", timestamp: t0 + 3, stopReason: "error", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } }); // failed: its retry carries the plan
		expect(render(data)).toBe("ƶ zipped 12 old outputs   74K → 43K   6 ms");
		branch.push({ type: "message", id: "a2", message: { role: "assistant", timestamp: t0 + 9, stopReason: "toolUse", usage: { input: 1_200, cacheRead: 38_000, cacheWrite: 1_300 } } });
		expect(render(data)).toBe("ƶ zipped 12 old outputs   69.7K → 40.5K   6 ms"); // input + cacheRead + cacheWrite; before x 40.5/43
		const w = walks;
		branch.push({ type: "message", id: "a3", message: { role: "assistant", timestamp: t0 + 20, usage: { input: 5, cacheRead: 60_000, cacheWrite: 0 } } });
		for (let i = 0; i < 5; i++) expect(render(data)).toBe("ƶ zipped 12 old outputs   69.7K → 40.5K   6 ms");
		expect(walks).toBe(w); // found once, kept
		expect(render({ ...data, reqTs: undefined })).toBe("ƶ zipped 12 old outputs   74K → 43K   6 ms"); // a notice from before: as it was
		// live, 10-15: a provider switch left the first request's estimate at half its real size; the zip read "93.1K → 184K"
		const off = { ...data, before: 93_121, after: 81_979, desc: "zipped 6 old outputs in 5 ms", reqTs: t0 + 100 };
		branch.push({ type: "message", id: "a4", message: { role: "assistant", timestamp: t0 + 120, stopReason: "toolUse", usage: { input: 4, cacheRead: 0, cacheWrite: 183_611 } } });
		expect(render(off)).toBe("ƶ zipped 6 old outputs   209K → 184K   5 ms"); // never a zip that grew
		expect(render({ ...off, after: 0 })).toBe("ƶ zipped 6 old outputs   93.1K → 184K   5 ms"); // no estimate to scale by: as recorded
		// a summary's "before" is Pi's own number (its "Compacted from N tokens"): kept, only "after" becomes real (review P1)
		branch.push({ type: "message", id: "a5", message: { role: "assistant", timestamp: t0 + 220, stopReason: "stop", usage: { input: 2_000, cacheRead: 0, cacheWrite: 58_000 } } });
		const sum = { ...data, before: 150_000, after: 30_000, desc: "summarized 64 requests in 38.2 s · written while you worked", reqTs: t0 + 200 };
		expect(render(sum)).toContain("150K → 60K");
		expect(render({ ...sum, desc: "zipped 3 old outputs in 4 ms · summarized earlier turns in 38.2 s" })).toContain("150K → 60K");
	});
	test("print mode: /zip status stays plain text on stderr, nothing appended", async () => {
		const { f, ctx } = await setup();
		ctx.mode = "print";
		const w = process.stderr.write;
		let out = "";
		process.stderr.write = ((s: string) => ((out += s), true)) as Any;
		try {
			await f.handlers.get("cmd:zip").handler("status", ctx);
		} finally {
			process.stderr.write = w;
		}
		expect(out).toContain("pi-zip: on");
		expect(f.appended.filter((x: Any) => x.customType === "pi-zip/notice")).toHaveLength(0);
	});
	test("a tool allowlist that hides zip_recall, read, grep and bash: one reread-only line per session", async () => {
		const { f, ctx, render } = await setup([], { getActiveTools: () => ["edit", "write"] });
		await f.handlers.get("session_start")({}, ctx);
		await startPrompt((n, e) => f.handlers.get(n)(e, ctx));
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept).toHaveLength(1);
		expect(render(kept[0])[0]).toStartWith("ƶ pi-zip  reread-only  a tool allowlist hides zip_recall");
	});
	test("an allowlist that hides zip_recall but keeps read or bash: file recall is a full mode, one 'on' line naming the recall directory", async () => {
		const { f, ctx, render } = await setup([], { getActiveTools: () => ["read", "bash"] });
		ctx.sessionManager.getSessionId = () => "01a120cb-3d40-75a6-aeac-320e71967606";
		ctx.sessionManager.getSessionFile = () => "/tmp/pi-zip-test-sessions/s.jsonl";
		await f.handlers.get("session_start")({}, ctx);
		await startPrompt((n, e) => f.handlers.get(n)(e, ctx));
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept).toHaveLength(1);
		const where = join(process.env.XDG_CACHE_HOME!, "pi-zip", "recall"); // where the copies are ($XDG_CACHE_HOME here), not always ~/.cache
		expect(render(kept[0], 200)[0]).toBe(`ƶ pi-zip  on  a tool allowlist hides zip_recall · zipped outputs are read back from files in ${where}`);
		// the card: on, with the unzip row; the chart rows are untouched
		await f.handlers.get("cmd:zip").handler("status", ctx);
		const card = render(f.appended.filter((x: Any) => x.customType === "pi-zip/notice").at(-1), 200);
		expect(card[0]).toBe("ƶ pi-zip  on");
		expect(card).toContain(`  unzip    from files in ${where} (a tool allowlist hides zip_recall)`);
		expect(card.some((l: string) => l.startsWith("  model "))).toBe(true);
		expect(card.some((l: string) => l.startsWith("  cache    expires after "))).toBe(true); // nothing learned in this test: the one line
	});
	test("a read or grep of a recall file is drawn like zip_recall's row", async () => {
		const { default: piZip } = await import("../src/index.ts");
		let resolver: Any = null;
		const f = fakePi({ registerToolRenderer: (r: Any) => (resolver = r), registerEntryRenderer: () => {} });
		piZip(f.pi);
		const base = { renderCall: (args: Any) => ({ render: () => [`read ${args.path}`], invalidate: () => {} }) };
		const sid = "01a120cb-3d40-75a6-aeac-320e71967606";
		const read = resolver("read", () => base).renderCall({ path: `~/.cache/pi-zip/recall/${sid}/k3f9a0x1qz.txt`, offset: 120, limit: 40 }, th, { toolCallId: "c1" });
		expect(read.render(80)).toEqual(["ƶ unzip k3f9a0x1qz  lines 120-159"]);
		const grep = resolver("grep", () => base).renderCall({ pattern: "SKU-03903", path: `~/.cache/pi-zip/recall/${sid}` }, th, { toolCallId: "c2" });
		expect(grep.render(80)).toEqual(["ƶ unzip all outputs  /SKU-03903/"]);
		expect(resolver("read", () => base).renderCall({ path: "src/a.ts" }, th, { toolCallId: "c3" }).render(80)).toEqual(["read src/a.ts"]);
	});
	test("a conflicting context manager: a paused line", async () => {
		const { f, ctx, render } = await setup([], { getAllTools: () => [{ name: "compress", sourceInfo: { path: "/x/node_modules/billion-context/index.js" } }] });
		await f.handlers.get("session_start")({}, ctx);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept.map((x: Any) => x.data.word)).toEqual(["paused"]);
		expect(render(kept[0])[0]).toContain("paused  billion-context also manages context");
	});
	test("the welcome line appears once per machine, in the TUI only", async () => {
		const flag = join(dirname(process.env.PI_ZIP_CACHE_STATS!), "welcomed");
		rmSync(flag, { force: true });
		const a = await setup();
		await a.f.handlers.get("session_start")({}, a.ctx);
		const w = a.f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(w).toHaveLength(1);
		expect(a.render(w[0])[0]).toBe("ƶ pi-zip  on  older context gets zipped when the savings pay for the rewrite · /zip");
		expect(existsSync(flag)).toBe(true);
		const b = await setup();
		await b.f.handlers.get("session_start")({}, b.ctx);
		expect(b.f.appended.filter((x: Any) => x.customType === "pi-zip/notice")).toHaveLength(0);
	});
});
