// User-facing text (F15, F16): one notice line per turn, honest stats, the /zip command. Notices never enter model context.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Any, PRODUCT } from "./util.ts";

export interface NoticeAction {
	kind: "fold" | "summary";
	count: number;
	tokensBefore: number;
	tokensAfter: number;
	ms: number;
	prepared?: boolean; // summary computed while the user was away
	pressure?: boolean; // done by the warm valve (the law fired while the cache is still warm), not because the cache was cold
}

export const fmtK = (tokens: number): string => `${tokens >= 99_500 ? Math.round(tokens / 1000) : Math.round(tokens / 100) / 10}K`;

export function noticeText(actions: NoticeAction[]): string {
	const segs = actions.map((a) => {
		const sizes = `${fmtK(a.tokensBefore)} → ${fmtK(a.tokensAfter)} tokens`;
		if (a.kind === "fold") {
			const ms = a.ms < 10 ? (Math.round(a.ms * 10) / 10).toFixed(1) : String(Math.round(a.ms));
			return `folded ${a.count} old output${a.count === 1 ? "" : "s"} · ${sizes} · ${ms} ms · originals recallable${a.pressure ? " · context over the warm-cache limit" : ""}`;
		}
		const s = (Math.round(a.ms / 100) / 10).toFixed(1);
		return `summarized ${a.count} request${a.count === 1 ? "" : "s"} · ${sizes} · ${a.prepared ? `${s} s (done while you were away)` : `waited ${s} s`}`;
	});
	return `${PRODUCT} · ${segs.join(" · ")}`;
}

/** Prices are $ per million tokens, as declared by the model. */
export interface Prices {
	cacheWrite: number;
	cacheRead: number;
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

	/** Estimated $ saved versus doing nothing: avoided cache writes and reads, minus summary calls, recalled content re-entering the context, and warm-valve rewrites. */
	savedUsd(p: Prices | null): number | null {
		if (!p) return null;
		const gross = (this.writeSavedTokens * p.cacheWrite + this.readSavedTokens * p.cacheRead) / 1e6;
		const recall = (this.recallChars / 4) * p.cacheWrite / 1e6;
		const pressure = this.pressureRewriteTokens * Math.max(p.cacheWrite - p.cacheRead, 0) / 1e6;
		return gross - this.summaryUsd - recall - pressure;
	}
}

export const pricesOf = (model: Any): Prices | null => {
	const c = model?.cost;
	const cw = c?.cacheWrite > 0 ? c.cacheWrite : c?.input > 0 ? c.input : 0;
	const cr = c?.cacheRead > 0 ? c.cacheRead : cw * 0.1;
	return cw > 0 ? { cacheWrite: cw, cacheRead: cr } : null;
};

export function statsText(s: Stats, model: Any): string {
	const usd = s.savedUsd(pricesOf(model));
	const money = usd === null ? "n/a (model declares no prices)" : `${usd < 0 ? "-" : ""}$${Math.abs(usd).toFixed(usd !== 0 && Math.abs(usd) < 0.1 ? 4 : 2)}`;
	return (
		`${PRODUCT} stats (since pi started): folded ${s.folds} output${s.folds === 1 ? "" : "s"} (${fmtK(s.foldedTokens)} tokens), ` +
		`${s.summaries} summar${s.summaries === 1 ? "y" : "ies"} (${fmtK(s.summarizedTokens)} tokens, ${(s.summaryMs / 1000).toFixed(1)} s waited, $${s.summaryUsd.toFixed(4)}), ` +
		`${s.recalls} recall${s.recalls === 1 ? "" : "s"} (~${fmtK(s.recallChars / 4)} tokens re-read). ` +
		`Estimated saved vs doing nothing: ${money}, counting avoided cache writes and reads minus summary calls, recalled content and warm-valve rewrites; token counts are chars/4 estimates.`
	);
}

export interface ZipControl {
	status(): string;
	statsLine(): string;
	setOff(off: boolean): string;
	toggleQuiet(): string;
}

export function registerZipCommand(pi: ExtensionAPI, zip: ZipControl) {
	pi.registerCommand("zip", {
		description: `${PRODUCT}: status | stats | off | on | quiet`,
		handler: async (args: string, cctx: Any) => {
			const sub = (args ?? "").trim().toLowerCase() || "status";
			const text =
				sub === "status" ? zip.status()
				: sub === "stats" ? zip.statsLine()
				: sub === "off" ? zip.setOff(true)
				: sub === "on" ? zip.setOff(false)
				: sub === "quiet" ? zip.toggleQuiet()
				: `${PRODUCT}: unknown subcommand "${sub}" (use status | stats | off | on | quiet)`;
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
