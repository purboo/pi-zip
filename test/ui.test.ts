import { describe, expect, test } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { recallSections, resolveHandlesInBranch } from "../src/recall.ts";
import { handleFor } from "../src/placeholder.ts";
import { cardText, fmtLife, markFirstLine, recallCallLine, recallResultLines, renderCard, renderState, sparkline, type CardData } from "../src/ui.ts";
import { fakeCtx, fakePi } from "./helpers.ts";

type Any = any;
const th = { fg: (_c: string, t: string) => t };
const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
const plainW = (s: string) => s.replace(/<\/?\w+>/g, "").length;
const fits = (lines: string[], w: number, vw = (s: string) => s.length) => lines.every((l) => vw(l) <= w);

describe("state lines", () => {
	test("one line: product, word, dim reason; warning colour for off/paused/reread-only", () => {
		expect(renderState("paused", "billion-context also manages context", 120, th)).toEqual(["▸ pi-zip  paused  billion-context also manages context"]);
		expect(renderState("paused", "x", 120, tag)[0]).toContain("<warning>paused</warning>");
		expect(renderState("on", "x", 120, tag)[0]).toContain("<accent>on</accent>");
		for (const w of [3, 8, 15, 20, 40, 120]) expect(fits(renderState("reread-only", "a tool allowlist hides zip_recall, so only rereadable outputs fold", w, th), w)).toBe(true);
		expect(renderState("paused", "a long reason", 18, th)).toEqual(["▸ pi-zip  paused"]);
	});
});

const card: CardData = {
	state: "on", model: "sota-gpt/gpt-6.1-sol", cls: "explicit", life: "~1 h (learned from 42 replies)", alive: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0.95, 0.9, 0.85, 0.6, 0.4, 0.1, 0],
	folds: 56, foldedTokens: "310K", summaries: 2, summaryUsd: 0.41, recalls: 3, last: "10:50  folded 12 old outputs · cache cold (away 47 min)", quiet: false,
};
describe("status card", () => {
	test("labelled rows, sparkline of what the cache learner believes", () => {
		expect(sparkline([0, 0.5, 1])).toBe("▁▅█");
		expect(cardText(card)).toEqual([
			"cache    sota-gpt/gpt-6.1-sol · explicit · lives ~1 h (learned from 42 replies)",
			"alive    ██████████▇▇▅▄▂▁  30 s → 2 h",
			"session  56 folds ~310K  ·  2 summaries $0.41  ·  3 recalls",
			"last     10:50  folded 12 old outputs · cache cold (away 47 min)",
			"mode     full (zip_recall available)",
		]);
		const lines = renderCard(card, 120, th);
		expect(lines[0]).toBe("▸ pi-zip  on");
		expect(lines[3]).toBe("  session  56 folds ~310K  ·  2 summaries $0.41  ·  3 recalls");
		for (const w of [10, 30, 60, 120]) expect(fits(renderCard(card, w, tag), w, plainW)).toBe(true);
	});
	test("reread-only and quiet show up; the session row is the only one in the text colour", () => {
		const t = cardText({ ...card, state: "reread-only", quiet: true });
		expect(t.at(-1)).toBe("mode     reread-only (zip_recall hidden by a tool allowlist) · notices off");
		const l = renderCard(card, 200, tag);
		expect(l.filter((x) => x.includes("<text>"))).toHaveLength(1);
		expect(renderCard({ ...card, state: "reread-only" }, 200, tag).at(-1)).toContain("<warning>");
	});
	test("fmtLife", () => expect([fmtLife(45), fmtLife(300), fmtLife(3600), fmtLife(9000)]).toEqual(["~45 s", "~5 min", "~60 min", "~2.5 h"]));
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
		expect(recallCallLine({ handle: h, grep: "Expected" }, 120, th)).toEqual([`↺ recall ${h}  grep "Expected"`]);
		expect(recallCallLine({ handles: [h, "x"] }, 120, th)).toEqual(["↺ recall 2 handles"]);
		const secs = [{ handle: h, label: "bash npm test", turn: 1, totalLines: 812, shownLines: 1, how: "grep" as const }];
		expect(recallResultLines(secs, "x", false, 120, th)).toEqual(["bash npm test · turn 1  1 of 812 lines"]);
		const long = Array.from({ length: 50 }, (_, i) => `\x1b[31mrow\t${i}\x07`).join("\n");
		const ex = recallResultLines(secs, long, true, 120, th, undefined, 40);
		expect(ex[1]).toBe("row  0");
		expect(ex.at(-1)).toBe("… 10 more lines (the model got them all)");
		for (const w of [5, 20, 60]) expect(fits(recallResultLines(secs, long, true, w, th), w)).toBe(true);
		expect(recallResultLines([{ handle: "nope", missing: true }], "", false, 80, tag)).toEqual(["<error>nope not found</error>"]);
	});
});

describe("the mark on a folded output", () => {
	test("right-aligned on the first line when it fits, untouched otherwise", () => {
		expect(markFirstLine(["$ npm test", "out"], "k3x9q2m7ab", 50, th)).toEqual([`$ npm test${" ".repeat(50 - 10 - 21)}▸ folded · k3x9q2m7ab`, "out"]);
		// a row padded to the full width (styles closed after the padding) still gets the mark, at the same width
		const padded = markFirstLine(["\x1b[1m$ npm test" + " ".repeat(40) + "\x1b[0m"], "k3x9q2m7ab", 50, th, { vw: (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "").length, cut: (x: string) => x });
		expect(padded[0]).toBe(`\x1b[1m$ npm test\x1b[0m${" ".repeat(50 - 10 - 21)}▸ folded · k3x9q2m7ab`);
		expect(markFirstLine(["$ npm test"], "k3x9q2m7ab", 30, th)).toEqual(["$ npm test"]);
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
		expect(folded.render(60)[0]).toEndWith(`▸ folded · ${handleFor("r1")}`);
		expect(folded.extra).toBe(7); // everything else passes through
		expect(r.renderCall({ command: "ls" }, th, { toolCallId: "c2" }).render(60)).toEqual(["$ ls"]);
		expect(resolver("zip_recall", () => base)).toBe(base);
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
		return { f, ctx, notes, render };
	};
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
		expect(c[0]).toBe("▸ pi-zip  on");
		expect(c.join("\n")).toContain("cache    p/m · class unknown until the first reply · lives ~5 min (declared)");
		expect(c.join("\n")).toContain("session  0 folds ~0K");
		expect(render(kept[1])[0]).toStartWith("▸ pi-zip  off  Nothing is folded");
		expect(render(kept[2])[0]).toBe("▸ pi-zip  on  folding resumes");
		expect(render(kept[3])[0]).toBe("▸ pi-zip  quiet  per-turn notices off (folding continues)");
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
	test("a tool allowlist that hides zip_recall: one reread-only line per session", async () => {
		const { f, ctx, render } = await setup([], { getActiveTools: () => ["read", "bash"] });
		await f.handlers.get("session_start")({}, ctx);
		await f.handlers.get("before_agent_start")({}, ctx);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept).toHaveLength(1);
		expect(render(kept[0])[0]).toStartWith("▸ pi-zip  reread-only  a tool allowlist hides zip_recall");
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
		expect(a.render(w[0])[0]).toBe("▸ pi-zip  on  folds old tool output after the prompt cache expires (5 min here) · nothing to set up · /zip for status");
		expect(existsSync(flag)).toBe(true);
		const b = await setup();
		await b.f.handlers.get("session_start")({}, b.ctx);
		expect(b.f.appended.filter((x: Any) => x.customType === "pi-zip/notice")).toHaveLength(0);
	});
});
