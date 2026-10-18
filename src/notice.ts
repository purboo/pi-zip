// User-facing text (F15, F16): one notice line per turn, honest stats, the /zip command. Notices never enter model context.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Any, PRODUCT } from "./util.ts";
import { brand, type CardData, type StateWord, SYM } from "./ui.ts";

export interface NoticeAction {
	kind: "fold" | "summary";
	count: number;
	tokensBefore: number;
	tokensAfter: number;
	ms: number;
	waitMs?: number; // summary: how long the user waited for it (ms = how long it took to write)
	prepared?: boolean; // summary computed while the user was away
	background?: boolean; // summary computed in the background while the run went on (the warm valve, never waited for)
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
	kind?: "state" | "card" | "zipped"; // absent: a fold/summary notice
	word?: StateWord;
	key?: string; // a state line shown once per session under this key (default: its word)
	reason?: string;
	card?: CardData;
	text: string;
	before: number;
	after: number;
	desc: string; // "zipped 12 old outputs in 6 ms · summarized 64 requests in 38.2 s · ready while you were away" (older entries: "folded …")
	why?: string; // expanded view: why now
	items?: NoticeItem[];
	more?: number; // folded outputs not listed
	first?: boolean; // the session's first notice: say once that originals are kept
	native?: string; // a summary's way into the session: "ok" (Pi's compaction, before the run) or why it went the draft way (a skip or off reason)
	nativeMs?: number; // the whole ctx.compact() call, when it ran
	nativeAskMs?: number; // ... how long it took to reach pi-zip's session_before_compact handler (the handlers before ours)
	reqTs?: number; // when the first request carrying this plan went out (ms): the renderer shows that request's real size as "after"
}

export const fmtK = (tokens: number): string => `${tokens >= 99_500 ? Math.round(tokens / 1000) : Math.round(tokens / 100) / 10}K`;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const secs = (ms: number) => `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
const dur = (ms: number) => (ms < 950 ? `${Math.max(1, Math.round(ms))} ms` : secs(ms));

/** The words after the numbers: what happened, plus how long the user waited for a summary (if at all). */
export function noticeDesc(actions: NoticeAction[]): string {
	return actions
		.map((a) => {
			if (a.kind === "fold") return `zipped ${plural(a.count, "old output")} in ${dur(a.ms)}`;
			const wait = a.prepared ? 0 : (a.waitMs ?? a.ms);
			// count = the user's requests in the summarized stretch; a stretch driven by an extension (custom prompts) has none
			const took = a.count > 0 ? `summarized ${plural(a.count, "request")}` : "summarized earlier turns";
			if (a.prepared) return `${took} in ${dur(a.ms)} · ready while you were away`;
			if (a.background) return `${took} in ${dur(a.ms)} · written while you worked`;
			if (wait >= a.ms - 500) return `${took} · waited ${secs(wait)}`; // the user waited for all of it
			return `${took} in ${dur(a.ms)} · waited ${secs(wait)}`; // started while away, finished after the return
		})
		.join(" · ");
}

/** The description split for the line: what happened (verbs) and how long it took / waited (tail). Reads old entries too. */
export function splitDesc(desc: string): { verbs: string[]; tail: string[] } {
	const verbs: string[] = [], tail: string[] = [];
	for (const part of desc.split(" · ").filter(Boolean)) {
		const m = /^(?:folded|zipped|summarized) (.*?)(?: in ([\d.]+ m?s))?$/.exec(part);
		if (m) {
			verbs.push(part.replace(/^folded /, "zipped ").replace(/ in [\d.]+ m?s$/, ""));
			if (m[2]) tail.push(m[2]);
		} else tail.push(part);
	}
	return { verbs, tail };
}

export function noticeText(actions: NoticeAction[]): string {
	const first = actions[0], last = actions[actions.length - 1];
	const { verbs, tail } = splitDesc(noticeDesc(actions));
	return `${PRODUCT}  ${verbs.join(" · ")}  ${fmtK(first.tokensBefore)} → ${fmtK(last.tokensAfter)}${tail.length ? "  " + tail.join(" · ") : ""}`;
}

export interface NoticeTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

/** Detail lines sit under the words, after the monogram and its space. */
const INDENT = " ".repeat(SYM.length + 1);
const GAP = "   ";
/** Waiting at least this long is a cost the user paid: it gets the warning colour. Shorter waits are not worth the eye. */
const WAIT_NOTICEABLE_MS = 2000;

/**
 * "ƶ zipped 12 old outputs   74K → 43K   6 ms"
 * Colour, by meaning (theme tokens only, so dark/light/custom themes keep working; monochrome still reads):
 *   accent  the monogram (bold): whose line it is
 *   muted   the words: what happened
 *   success the size now (bold): the one bright thing on the line
 *   dim     the old size, the arrow, durations, "ready while you were away", the detail lines
 *   warning only a wait the user actually sat through (>= 2 s): the one thing pi-zip cost them
 */
export function colorTail(tail: string[], th: NoticeTheme): string {
	return tail.map((part) => {
		const waited = /^waited ([\d.]+) s$/.exec(part);
		return th.fg(waited && Number(waited[1]) * 1000 >= WAIT_NOTICEABLE_MS ? "warning" : "dim", part);
	}).join(th.fg("dim", " · "));
}

/** Lines for the transcript. Narrow terminals drop whole segments in order (tail, then words); the numbers always stay.
 *  `w` measures display width (Pi's visibleWidth in the renderer; string length in tests). Every line fits `width`. */
export function renderNotice(d: NoticeData, expanded: boolean, width: number, th: NoticeTheme, w: (s: string) => number = (s) => s.length): string[] {
	const b = fmtK(d.before), a = fmtK(d.after);
	const nums = `${b} → ${a}`;
	const strong = (t: string) => (th.bold ? th.bold(t) : t);
	const numsC = `${th.fg("dim", b)}${th.fg("dim", " → ")}${th.fg("success", strong(a))}`;
	const { verbs, tail } = splitDesc(d.desc);
	const said = verbs.join(" · "), saidC = verbs.map((v) => th.fg("muted", v)).join(th.fg("dim", " · "));
	const tailP = tail.join(" · "), tailC = colorTail(tail, th);
	const mark = brand(th);
	const tries: [string, string][] = [
		...(said && tailP ? [[`${SYM} ${said}${GAP}${nums}${GAP}${tailP}`, `${mark} ${saidC}${GAP}${numsC}${GAP}${tailC}`] as [string, string]] : []),
		...(said ? [[`${SYM} ${said}${GAP}${nums}`, `${mark} ${saidC}${GAP}${numsC}`] as [string, string]] : []),
		[`${SYM} ${nums}`, `${mark} ${numsC}`],
		[nums, numsC],
	];
	const head = tries.find(([plain]) => w(plain) <= width);
	if (!head) return [];
	const out = [head[1]];
	const fit = (plain: string) => (w(INDENT + plain) <= width ? INDENT : w(plain) <= width ? "" : null);
	const sub = (plain: string) => {
		const ind = fit(plain);
		if (ind !== null) out.push(th.fg("dim", ind + plain));
	};
	if (d.first) sub("originals are kept · the model can unzip any of them");
	if (!expanded) return out;
	const items = d.items ?? [];
	const lw = Math.min(32, Math.max(0, ...items.map((i) => i.label.length)));
	for (const i of items) {
		const label = i.label.length > lw ? i.label.slice(0, lw - 1) + "…" : i.label.padEnd(lw);
		const size = fmtK(i.tokens).padStart(6);
		const plain = `${label}${size}   ${i.handle}`;
		const ind = fit(plain);
		if (ind === null) continue;
		// an item row: what it was (muted, like the words above), how big and its handle (dim: there if you need it)
		out.push(th.fg("dim", ind) + th.fg("muted", label) + th.fg("dim", size) + th.fg("dim", `   ${i.handle}`));
	}
	if (d.more) sub(`… ${d.more} more`);
	if (d.why) sub(d.why);
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
	setOff(off: boolean): string;
	toggleQuiet(): string;
}

const ZIP_SUBS: [string, string][] = [
	["off", "stop folding; requests left untouched"],
	["on", "resume folding"],
	["quiet", "toggle the per-turn notice"],
];

export function registerZipCommand(pi: ExtensionAPI, zip: ZipControl) {
	pi.registerCommand("zip", {
		description: `${PRODUCT}: off | on | quiet`,
		getArgumentCompletions: (prefix: string) => {
			const p = (prefix ?? "").trim().toLowerCase();
			const items = ZIP_SUBS.filter(([v]) => v.startsWith(p)).map(([value, description]) => ({ value, label: value, description }));
			return items.length ? items : null;
		},
		handler: async (args: string, cctx: Any) => {
			// "/zip" alone shows the card. "status" and "stats" are older spellings of the same thing: still accepted, never advertised.
			const raw = (args ?? "").trim().toLowerCase();
			const sub = raw === "" || raw === "stats" ? "status" : raw;
			if (sub === "status" && zip.card && zip.show) {
				const card = zip.card(cctx);
				if (zip.show(cctx, { v: 2, kind: "card", card, text: zip.status(cctx), before: 0, after: 0, desc: "" })) return;
			}
			const text =
				sub === "status" ? zip.status(cctx)
				: sub === "off" ? zip.setOff(true)
				: sub === "on" ? zip.setOff(false)
				: sub === "quiet" ? zip.toggleQuiet()
				: `${PRODUCT}: unknown subcommand "${sub}" (use /zip, or /zip off | on | quiet)`;
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
