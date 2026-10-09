// User-facing text (F15, F16): one notice line per turn, honest stats, the /zip command. Notices never enter model context.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Any, PRODUCT } from "./util.ts";
import type { CardData, StateWord } from "./ui.ts";

export interface NoticeAction {
	kind: "fold" | "summary";
	count: number;
	tokensBefore: number;
	tokensAfter: number;
	ms: number;
	prepared?: boolean; // summary computed while the user was away
	pressure?: boolean; // done by the warm valve (the law fired while the cache is still warm), not because the cache was cold
}

/** One folded output, for the expanded (ctrl+o) view of a notice. */
export interface NoticeItem {
	label: string; // tool + short args
	turn?: number;
	tokens: number;
	handle: string;
}

/** What a transcript notice stores (custom entry data; never sent to the model). `text` is the plain one-line form (status-line fallback, ledger). */
export interface NoticeData {
	v: 2;
	kind?: "state" | "card"; // absent: a fold/summary notice
	word?: StateWord;
	reason?: string;
	card?: CardData;
	text: string;
	before: number;
	after: number;
	desc: string; // "folded 12 old outputs · summarized 64 requests · ready while you were away"
	why?: string; // expanded view: why now
	items?: NoticeItem[];
	more?: number; // folded outputs not listed
	first?: boolean; // the session's first notice: say once that originals are kept
}

export const fmtK = (tokens: number): string => `${tokens >= 99_500 ? Math.round(tokens / 1000) : Math.round(tokens / 100) / 10}K`;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const secs = (ms: number) => `${(Math.round(ms / 100) / 10).toFixed(1)} s`;

/** The words after the numbers: what happened, plus how long the user waited for a summary (if at all). */
export function noticeDesc(actions: NoticeAction[]): string {
	return actions
		.map((a) => {
			if (a.kind === "fold") return `folded ${plural(a.count, "old output")}`;
			return `summarized ${plural(a.count, "request")} · ${a.prepared ? "ready while you were away" : `waited ${secs(a.ms)}`}`;
		})
		.join(" · ");
}

export function noticeText(actions: NoticeAction[]): string {
	const first = actions[0], last = actions[actions.length - 1];
	return `${PRODUCT}  ${fmtK(first.tokensBefore)} → ${fmtK(last.tokensAfter)}  ${noticeDesc(actions)}`;
}

/** Ten cells, filled in proportion to what is left: length is read before any digit is. */
export function ratioBar(before: number, after: number, cells = 10): string {
	const f = before > 0 ? Math.min(cells, Math.max(1, Math.round((cells * after) / before))) : cells;
	return "▰".repeat(f) + "▱".repeat(cells - f);
}

export interface NoticeTheme {
	fg(color: string, text: string): string;
}

const MARK = "▸ ";
const INDENT = " ".repeat(MARK.length + PRODUCT.length + 2);

/** Lines for the transcript. Narrow terminals drop whole segments in order (description, then bar); the numbers always stay.
 *  `w` measures display width (Pi's visibleWidth in the renderer; string length in tests). Every line fits `width`. */
export function renderNotice(d: NoticeData, expanded: boolean, width: number, th: NoticeTheme, w: (s: string) => number = (s) => s.length): string[] {
	const nums = `${fmtK(d.before)} → ${fmtK(d.after)}`;
	const bar = ratioBar(d.before, d.after);
	const tries: [string, string][] = [
		[`${MARK}${PRODUCT}  ${nums}  ${bar}  ${d.desc}`, `${th.fg("accent", MARK + PRODUCT)}  ${th.fg("text", nums)}  ${th.fg("dim", bar)}  ${th.fg("dim", d.desc)}`],
		[`${MARK}${PRODUCT}  ${nums}  ${bar}`, `${th.fg("accent", MARK + PRODUCT)}  ${th.fg("text", nums)}  ${th.fg("dim", bar)}`],
		[`${MARK}${PRODUCT}  ${nums}`, `${th.fg("accent", MARK + PRODUCT)}  ${th.fg("text", nums)}`],
		[nums, th.fg("text", nums)],
	];
	const head = tries.find(([plain]) => w(plain) <= width);
	if (!head) return [];
	const out = [head[1]];
	const sub = (plain: string) => {
		const line = INDENT + plain;
		if (w(line) <= width) out.push(th.fg("dim", line));
		else if (w(plain) <= width) out.push(th.fg("dim", plain));
	};
	if (d.first) sub("originals are kept; the model can recall any of them with zip_recall");
	if (!expanded) return out;
	if (d.why) sub(d.why);
	const items = d.items ?? [];
	const lw = Math.min(28, Math.max(0, ...items.map((i) => i.label.length)));
	for (const i of items) {
		const label = i.label.length > lw ? i.label.slice(0, lw - 1) + "…" : i.label.padEnd(lw);
		sub(`${label}  ${(i.turn ? `turn ${i.turn}` : "").padEnd(8)}${fmtK(i.tokens).padStart(6)}  ${i.handle}`);
	}
	if (d.more) sub(`… ${d.more} more`);
	return out;
}

export class Stats {
	folds = 0; // outputs folded
	foldedTokens = 0; // tokens removed by folds (estimate: chars/4)
	summaries = 0;
	summarizedTokens = 0; // tokens removed by summaries
	summaryMs = 0;
	summaryUsd = 0; // what the narrative model calls cost
	recalls = 0;
	recallChars = 0;
	pressureEdits = 0; // warm-valve edits
	pressureRewriteTokens = 0; // upper bound: a valve edit on a warm cache may rewrite the whole context
	writeSavedTokens = 0; // tokens NOT rewritten at a cold return
	readSavedTokens = 0; // tokens NOT read, summed over every request sent after an edit
	activeSaved = 0; // tokens currently removed from the context by our edits
	notices = 0;

}

export interface ZipControl {
	status(ctx?: Any): string;
	card?(ctx?: Any): CardData;
	/** Show a /zip result in the transcript; false = no transcript surface here (print/json/rpc or an older Pi). */
	show?(ctx: Any, data: NoticeData): boolean;
	statsLine(ctx?: Any): string;
	setOff(off: boolean): string;
	toggleQuiet(): string;
}

export function registerZipCommand(pi: ExtensionAPI, zip: ZipControl) {
	pi.registerCommand("zip", {
		description: `${PRODUCT}: status | off | on | quiet`,
		handler: async (args: string, cctx: Any) => {
			const sub = (args ?? "").trim().toLowerCase() || "status";
			if ((sub === "status" || sub === "stats") && zip.card && zip.show) {
				const card = zip.card(cctx);
				if (zip.show(cctx, { v: 2, kind: "card", card, text: zip.status(cctx), before: 0, after: 0, desc: "" })) return;
			}
			const text =
				sub === "status" ? zip.status(cctx)
				: sub === "stats" ? zip.statsLine(cctx)
				: sub === "off" ? zip.setOff(true)
				: sub === "on" ? zip.setOff(false)
				: sub === "quiet" ? zip.toggleQuiet()
				: `${PRODUCT}: unknown subcommand "${sub}" (use status | off | on | quiet)`;
			if (zip.show && (sub === "off" || sub === "on" || sub === "quiet")) {
				const word: StateWord = sub === "quiet" ? (/notices off/.test(text) ? "quiet" : "notices on") : sub;
				const reason = text.replace(/^pi-zip: (off|on)\.? ?/, "").replace(/^pi-zip: /, "");
				if (zip.show(cctx, { v: 2, kind: "state", word, reason: reason || "folding resumes", text, before: 0, after: 0, desc: "" })) return;
			}
			if (cctx?.ui?.notify && (cctx.mode === "tui" || cctx.mode === "rpc")) {
				try {
					cctx.ui.notify(text);
					return;
				} catch {}
			}
			process.stderr.write(text + "\n"); // stdout carries the program's own output (JSON mode): never mix command text into it
		},
	});
}
