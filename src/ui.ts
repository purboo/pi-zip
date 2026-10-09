// Transcript surfaces (pure, testable): the status card, state lines, the zip_recall row and the fold mark on a folded output.
// One visual grammar everywhere: "▸ pi-zip" in the accent colour, numbers in the text colour, everything else dim, no boxes;
// collapsed = the conclusion, ctrl+o = the detail. Every returned line fits the given width.
import { PRODUCT } from "./util.ts";

export interface Th {
	fg(color: string, text: string): string;
}
/** Display width and truncation: Pi's visibleWidth / truncateToWidth in the renderer, string length in tests. */
export interface Measure {
	vw(s: string): number;
	cut(s: string, width: number): string; // plain text, at most width columns, with "…" when cut
}
export const plainMeasure: Measure = {
	vw: (s) => s.length,
	cut: (s, w) => (s.length <= w ? s : w <= 0 ? "" : s.slice(0, w - 1) + "…"),
};
/** The measure renderers use: index.ts swaps in Pi's own (pi-tui) when it loads. */
export let measure: Measure = plainMeasure;
export function setMeasure(m: Measure) {
	measure = m;
}

export const MARK = "▸ ";
const HEAD = MARK + PRODUCT;
const LABEL_W = 9;

/** Plain text without control characters (tabs become two spaces): recalled output goes into the TUI as text, never as escape codes. */
export const clean = (s: string): string => s.replace(/\t/g, "  ").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

// ---- state lines -------------------------------------------------------------------------------------------------------

export type StateWord = "on" | "off" | "paused" | "reread-only" | "quiet" | "notices on" | "cache";
const WARN = new Set<StateWord>(["off", "paused", "reread-only"]);

/** "▸ pi-zip  paused  billion-context also manages context · run: pi remove npm:billion-context" */
export function renderState(word: StateWord, reason: string, width: number, th: Th, m: Measure = plainMeasure): string[] {
	const wordC = th.fg(WARN.has(word) ? "warning" : "accent", word);
	const base = `${HEAD}  ${word}`;
	if (m.vw(base) > width) return m.vw(word) <= width ? [wordC] : [];
	const room = width - m.vw(base) - 2;
	const r = reason && room >= 12 ? m.cut(reason, room) : "";
	return [`${th.fg("accent", HEAD)}  ${wordC}${r ? "  " + th.fg("dim", r) : ""}`];
}

// ---- status card ------------------------------------------------------------------------------------------------------

export interface CardData {
	state: "on" | "off" | "paused" | "reread-only";
	stateNote?: string; // why paused / reread-only
	model?: string; // provider/id
	cls?: string; // explicit | automatic
	life?: string; // "~5 min (declared)" | "~1 h (learned from 42 returns)"
	alive?: number[]; // P(warm) at SPARK_GAPS
	folds: number;
	foldedTokens: string; // "310K"
	summaries: number;
	summaryUsd: number;
	recalls: number;
	last?: string; // "10:50  folded 12 old outputs · cache cold (away 47 min)"
	quiet: boolean;
}

/** Gaps (seconds) the "alive" sparkline samples: 30 s to 2 h, denser where caches usually expire. */
export const SPARK_GAPS = [30, 60, 120, 180, 240, 300, 360, 420, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200];
const SPARK = "▁▂▃▄▅▆▇█";
export const sparkline = (ps: number[]): string => ps.map((p) => SPARK[Math.max(0, Math.min(7, Math.round(p * 7)))]).join("");

/** "~5 min", "~1 h", "~2.5 h" */
export function fmtLife(s: number): string {
	if (s < 90) return `~${Math.round(s)} s`;
	if (s < 5400) return `~${Math.round(s / 60)} min`;
	return `~${+(s / 3600).toFixed(1)} h`;
}

export function cardText(c: CardData): string[] {
	const rows: [string, string][] = [];
	if (c.model) rows.push(["cache", [c.model, c.cls ?? "class unknown until the first reply", c.life ? `lives ${c.life}` : ""].filter(Boolean).join(" · ")]);
	if (c.alive?.length) rows.push(["alive", `${sparkline(c.alive)}  30 s → 2 h`]);
	const n = (x: number, one: string, many = one + "s") => `${x} ${x === 1 ? one : many}`;
	rows.push(["session", `${n(c.folds, "fold")} ~${c.foldedTokens}  ·  ${n(c.summaries, "summary", "summaries")}${c.summaryUsd > 0 ? ` $${c.summaryUsd.toFixed(2)}` : ""}  ·  ${n(c.recalls, "recall")}`]);
	if (c.last) rows.push(["last", c.last]);
	const mode = c.state === "reread-only" ? "reread-only (zip_recall hidden by a tool allowlist)" : "full (zip_recall available)";
	rows.push(["mode", `${mode}${c.quiet ? " · notices off" : ""}`]);
	return rows.map(([k, v]) => `${k.padEnd(LABEL_W)}${v}`);
}

export function renderCard(c: CardData, width: number, th: Th, m: Measure = plainMeasure): string[] {
	const out = renderState(c.state, c.stateNote ?? "", width, th, m);
	const indent = "  ";
	for (const row of cardText(c)) {
		const line = m.cut(indent + row, width);
		if (!line) continue;
		const warn = row.startsWith("mode") && c.state === "reread-only";
		const k = line.slice(0, indent.length + LABEL_W), v = line.slice(indent.length + LABEL_W);
		out.push(th.fg("dim", k) + (row.startsWith("session") ? th.fg("text", v) : th.fg(warn ? "warning" : "dim", v)));
	}
	return out;
}

// ---- zip_recall row ------------------------------------------------------------------------------------------------------

export interface RecallSectionInfo {
	handle: string;
	label?: string; // "bash npm test"
	turn?: number;
	totalLines?: number;
	shownLines?: number;
	how?: "all" | "grep" | "range" | "page";
	missing?: boolean;
}

/** "↺ recall k3x9q2m7ab  grep "Expected"" */
export function recallCallLine(args: { handle?: string; handles?: string[]; grep?: string; range?: string; offset?: number }, width: number, th: Th, m: Measure = plainMeasure): string[] {
	const hs = [...(typeof args?.handle === "string" ? [args.handle] : []), ...(Array.isArray(args?.handles) ? args.handles.filter((h) => typeof h === "string") : [])];
	const what = hs.length > 1 ? `${hs.length} handles` : (hs[0] ?? "");
	const opt = [args?.grep ? `grep "${args.grep}"` : "", args?.range ? `lines ${args.range}` : "", args?.offset ? `from char ${args.offset}` : ""].filter(Boolean).join(" · ");
	const plain = m.cut(`↺ recall ${what}${opt ? "  " + opt : ""}`, width);
	const head = "↺ recall";
	if (!plain.startsWith(head)) return [th.fg("toolTitle", plain)];
	return [th.fg("toolTitle", head) + th.fg("accent", plain.slice(head.length, head.length + 1 + what.length)) + th.fg("dim", plain.slice(head.length + 1 + what.length))];
}

export function sectionLine(s: RecallSectionInfo): string {
	if (s.missing) return `${s.handle} not found`;
	const where = [s.label, s.turn ? `turn ${s.turn}` : ""].filter(Boolean).join(" · ");
	const total = s.totalLines ?? 0;
	const got = s.how === "all" ? `all ${total} lines` : `${s.shownLines ?? 0} of ${total} lines`;
	return `${where || s.handle}  ${got}`;
}

/** Collapsed: one line per handle ("bash npm test · turn 1  3 of 812 lines"). Expanded: the recalled text, at most maxLines. */
export function recallResultLines(sections: RecallSectionInfo[], text: string, expanded: boolean, width: number, th: Th, m: Measure = plainMeasure, maxLines = 40): string[] {
	const out: string[] = [];
	for (const s of sections) {
		const l = m.cut(sectionLine(s), width);
		if (l) out.push(s.missing ? th.fg("error", l) : th.fg("dim", l));
	}
	if (!sections.length && text) out.push(th.fg("dim", m.cut(clean(text.split("\n")[0]), width)));
	if (!expanded || !text) return out;
	const lines = clean(text).split("\n");
	for (const l of lines.slice(0, maxLines)) out.push(th.fg("toolOutput", m.cut(l, width)));
	if (lines.length > maxLines) out.push(th.fg("dim", m.cut(`… ${lines.length - maxLines} more lines (the model got them all)`, width)));
	return out;
}

// ---- the mark on a folded output ---------------------------------------------------------------------------------------

/** Right-aligns "▸ folded · <handle>" on the first line of a tool call row, if it fits; otherwise leaves the row alone. */
export function markFirstLine(lines: string[], handle: string, width: number, th: Th, m: Measure = plainMeasure): string[] {
	if (!lines.length) return lines;
	const mark = `${MARK}folded · ${handle}`;
	// renderers often pad a row to the full width (and may close styles after the padding): drop the padding, keep the codes
	const first = lines[0].replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
	const gap = width - m.vw(first) - m.vw(mark);
	if (gap < 2) return lines;
	return [first + " ".repeat(gap) + th.fg("dim", mark), ...lines.slice(1)];
}
