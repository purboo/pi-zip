import { zipMode } from "./speed.ts";
// zip_recall (F3): exact, batched retrieval of folded originals from the session file (I2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleFor, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { commandRecallHandles, parseRecallPath } from "./recallfile.ts";
import { measure, recallCallLine, recallResultLines, type RecallSectionInfo } from "./ui.ts";
import { type Any, clamp, textOf } from "./util.ts";

const RECALL_PAGE_CHARS = 20_000; // default page
const SEARCH_PAGE_CHARS = 8_000; // default page of grep without a handle: a broad pattern over every output stays small (search results are never folded)
const RECALL_MAX_PAGE_CHARS = 50_000;
const RECALL_MAX_HITS = 400;
const GREP_MAX_PATTERN = 256;
const GREP_BUDGET_MS = 2000;

export function parseRange(spec: string): { from: number; to: number } | null {
	const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec ?? "");
	if (!m) return null;
	const from = parseInt(m[1], 10);
	const to = m[2] ? parseInt(m[2], 10) : from;
	return from >= 1 && to >= from && to - from <= 100_000 ? { from, to } : null;
}

// Regex shapes that can backtrack catastrophically on a long line: a quantified group that itself holds a quantifier or an
// alternation, and back-references. They are searched as literal text instead (a sync regex cannot be interrupted).
const RISKY_REGEX = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\}|\|)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)|\\[1-9]|\\k</;

/** Case-insensitive regex for a grep pattern, or the pattern as literal text when it does not compile or could backtrack badly. */
export function grepMatcher(p: string): { re: RegExp; literal: boolean } {
	const escaped = () => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	if (p.length > GREP_MAX_PATTERN || RISKY_REGEX.test(p)) return { re: escaped(), literal: true };
	try {
		return { re: new RegExp(p, "i"), literal: false };
	} catch {
		return { re: escaped(), literal: true };
	}
}

export interface RecallSlice {
	text: string; // what the model sees: header, the page, and a hint on how to get the rest
	body: string; // the page itself, exactly as a slice of the selected original text
	totalLines: number;
	matched: number | null;
	clipped: boolean;
	offset: number;
	nextOffset: number | null; // where the next page starts; null = this page reaches the end of the selection
	selectionChars: number;
}

const int = (v: unknown): number | null => {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null;
};
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Full text, a line range or grep matches of an original, then one page of it by CHARACTERS (offset, limit): a single
 * 45,000-character line is reachable too. Pages never split a surrogate pair, so concatenated pages are the selection byte for byte.
 */
export function sliceRecall(text: string, opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown; pageChars?: number; narrow?: string }): RecallSlice {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let sel: string;
	let matched: number | null = null;
	let header = "";
	const empty = (msg: string): RecallSlice => ({ text: msg, body: "", totalLines, matched: null, clipped: false, offset: 0, nextOffset: null, selectionChars: 0 });
	if (opts.grep !== undefined && String(opts.grep).trim() !== "") {
		const { re, literal } = grepMatcher(String(opts.grep));
		const hits: string[] = [];
		const t0 = Date.now();
		let examined = 0;
		for (; examined < lines.length && hits.length < RECALL_MAX_HITS; examined++) {
			if (re.test(lines[examined])) hits.push(`${examined + 1}: ${lines[examined]}`);
			if (Date.now() - t0 > GREP_BUDGET_MS) { examined++; break; }
		}
		matched = hits.length;
		sel = hits.join("\n");
		header = `[grep${literal ? " (searched as literal text: the pattern is not a safe regular expression)" : ""}: ${matched} matching line(s) of ${totalLines}${examined < lines.length && hits.length < RECALL_MAX_HITS ? `; stopped after ${examined} lines (time budget), use range for the rest` : ""}]\n`;
	} else if (opts.range !== undefined && String(opts.range).trim() !== "") {
		const r = parseRange(String(opts.range));
		if (!r) return empty(`(invalid range "${opts.range}"; use e.g. range="120-240")`);
		sel = lines.slice(r.from - 1, r.to).join("\n");
		header = `[range: lines ${r.from}-${Math.min(r.to, totalLines)} of ${totalLines}]\n`;
	} else {
		sel = text;
	}
	const limitIn = int(opts.limit);
	const limit = clamp(limitIn ?? opts.pageChars ?? RECALL_PAGE_CHARS, 1, RECALL_MAX_PAGE_CHARS);
	let offset = clamp(int(opts.offset) ?? 0, 0, sel.length);
	if (offset > 0 && offset < sel.length && isLow(sel.charCodeAt(offset))) offset--; // never start inside a surrogate pair
	let end = Math.min(sel.length, offset + limit);
	if (end < sel.length && isHigh(sel.charCodeAt(end - 1))) end += end - 1 > offset ? -1 : 1; // ... or end inside one (a 1-char page takes the whole pair)
	const body = sel.slice(offset, end);
	const more = end < sel.length;
	const paged = more || offset > 0;
	const pageHeader = paged ? `[chars ${offset}-${end} of ${sel.length}${header ? " of the selection" : ""}]\n` : "";
	const hint = more
		? `\n[… ${sel.length - end} more chars: call ${RECALL_TOOL} again with offset=${end} for the next page (limit up to ${RECALL_MAX_PAGE_CHARS}), or ${opts.narrow ?? "narrow it with grep or range"}]`
		: "";
	return { text: header + pageHeader + body + hint, body, totalLines, matched, clipped: more, offset, nextOffset: more ? end : null, selectionChars: sel.length };
}

export interface RecallItem {
	handle: string;
	text: string | null;
	tool: string | null;
	label?: string; // tool + short args of the call that produced it (transcript only)
	turn?: number;
}

/** "[handle h · bash npm test · 812 chars · 40 lines]": the call that produced an output, so the model can tell look-alike outputs apart. */
const sectionHead = (it: RecallItem & { text: string }) => `[handle ${it.handle}${it.label || it.tool ? " · " + (it.label ?? it.tool) : ""} · ${it.text.length} chars · ${it.text.split("\n").length} lines]`;

export function recallSections(items: RecallItem[], opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown }): { text: string; ok: number; missing: number; sections: RecallSectionInfo[] } {
	const parts: string[] = [];
	const sections: RecallSectionInfo[] = [];
	let ok = 0;
	let missing = 0;
	for (const it of items) {
		if (it.text === null) {
			missing++;
			sections.push({ handle: it.handle, missing: true });
			parts.push(`[handle ${it.handle}] not found. Copy the handle exactly from the folded block's marker line or the summary's handle table.`);
			continue;
		}
		ok++;
		const slice = sliceRecall(it.text, opts);
		const grep = opts.grep !== undefined && String(opts.grep).trim() !== "", range = opts.range !== undefined && String(opts.range).trim() !== "";
		const how = grep ? "grep" : range ? "range" : slice.clipped || slice.offset > 0 ? "page" : "all";
		const shown = grep ? (slice.matched ?? 0) : slice.body ? slice.body.split("\n").length : 0;
		sections.push({ handle: it.handle, label: it.label ?? it.tool ?? undefined, turn: it.turn, totalLines: slice.totalLines, shownLines: shown, how });
		parts.push(`${sectionHead({ ...it, text: it.text })}\n${slice.text}`);
	}
	return { text: parts.join("\n\n"), ok, missing, sections };
}

/** Every tool output of the session branch (which spans entries before any compaction), oldest first, with the call that produced it. */
export function branchOutputs(branch: Any[]): Array<RecallItem & { text: string; entryId: string }> {
	const out: Array<RecallItem & { text: string; entryId: string }> = [];
	const calls = new Map<string, Any>();
	let turn = 0;
	for (const en of branch) {
		const msg = en?.type === "message" ? en.message : null;
		if (msg?.role === "user") turn++;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) for (const c of msg.content) if (c?.type === "toolCall" && c.id) calls.set(c.id, c);
		if (msg?.role !== "toolResult" || !en.id) continue;
		const call = calls.get(msg.toolCallId);
		const tool = msg.toolName ?? call?.name ?? null;
		const args = call ? shortArgs(call.arguments) : "";
		out.push({ entryId: en.id, handle: handleFor(en.id), text: textOf(msg.content), tool, label: tool ? `${tool}${args ? " " + args : ""}` : undefined, turn: turn || undefined });
	}
	return out;
}

/** Resolve handles against the session branch: exact originals. */
export function resolveHandlesInBranch(branch: Any[], handles: string[]): { items: RecallItem[]; entryIds: (string | null)[] } {
	const items: RecallItem[] = handles.map((h) => ({ handle: h, text: null, tool: null }));
	const entryIds: (string | null)[] = handles.map(() => null);
	for (const o of branchOutputs(branch)) {
		const k = handles.indexOf(o.handle);
		if (k < 0) continue;
		const { entryId, ...it } = o;
		items[k] = it;
		entryIds[k] = entryId;
	}
	return { items, entryIds };
}

/**
 * grep without a handle: every earlier tool output of the branch (zip_recall results excepted), newest output first, each match
 * under its output's handle and call, then one page by characters (default SEARCH_PAGE_CHARS). For outputs whose handle the model
 * cannot see any more (a long summary lists only the newest) and for questions that name the content rather than the output.
 * `upTo` pins the pool to its first n outputs (branch order, oldest first; new outputs only append): a later page of the same search
 * passes the pool size of its first page, so an output that arrived in between cannot shift the character offsets.
 */
export function searchOutputs(outputs: Array<RecallItem & { text: string }>, grep: string, opts: { offset?: unknown; limit?: unknown; upTo?: number } = {}): { text: string; matched: number; hits: number; chars: number; pool: number; sections: RecallSectionInfo[] } {
	const { re, literal } = grepMatcher(grep);
	const all = outputs.filter((o) => o.tool !== RECALL_TOOL);
	const pool = opts.upTo !== undefined && opts.upTo >= 0 && opts.upTo < all.length ? all.slice(0, opts.upTo) : all;
	const parts: string[] = [];
	const sections: RecallSectionInfo[] = [];
	let hits = 0;
	let stopped = false;
	const t0 = Date.now();
	for (let k = pool.length - 1; k >= 0 && !stopped; k--) {
		const it = pool[k];
		const lines = it.text.split("\n");
		const got: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (hits >= RECALL_MAX_HITS || Date.now() - t0 > GREP_BUDGET_MS) {
				stopped = true;
				break;
			}
			if (re.test(lines[i])) {
				got.push(`${i + 1}: ${lines[i]}`);
				hits++;
			}
		}
		if (!got.length) continue;
		parts.push(`${sectionHead(it)}\n${got.join("\n")}`);
		sections.push({ handle: it.handle, label: it.label ?? it.tool ?? undefined, turn: it.turn, totalLines: lines.length, shownLines: got.length, how: "grep" });
	}
	const head = `[grep${literal ? " (searched as literal text: the pattern is not a safe regular expression)" : ""} over all ${pool.length} earlier tool outputs (no handle given): ${hits} matching line(s) in ${sections.length} output(s), newest output first${stopped ? "; stopped early (time or hit cap), narrow the pattern or pass a handle" : ""}]\n`;
	if (!hits) return { text: head + "Nothing matched. Try a shorter or different pattern, or pass the handle shown in a folded block or a summary.", matched: 0, hits, chars: 0, pool: pool.length, sections };
	const page = sliceRecall(parts.join("\n\n"), { offset: opts.offset, limit: opts.limit, pageChars: SEARCH_PAGE_CHARS, narrow: "narrow the pattern, or pass one of the handles above with grep" });
	return { text: head + page.text, matched: sections.length, hits, chars: page.body.length, pool: pool.length, sections };
}

/** The pool size recorded by the newest earlier search with this same pattern (its first page), for a later page of it. */
export function searchPoolOf(branch: Any[], grep: string): number | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (m?.role === "toolResult" && m.toolName === RECALL_TOOL && m.details?.search === grep && typeof m.details.pool === "number") return m.details.pool;
	}
	return undefined;
}

/** Handles the model already recalled in this branch (F4: never refold them). */
export function recalledHandlesFromBranch(branch: Any[]): Set<string> {
	const out = new Set<string>();
	for (const en of branch) {
		const m = en?.type === "message" ? en.message : null;
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const c of m.content) {
			if (c?.type !== "toolCall") continue;
			const a: Any = c.arguments ?? {};
			if (c.name === RECALL_TOOL) {
				if (typeof a.handle === "string" && a.handle.trim()) out.add(a.handle.trim());
				if (Array.isArray(a.handles)) for (const h of a.handles) if (typeof h === "string" && h.trim()) out.add(h.trim());
			} else if (c.name === "bash") {
				for (const h of commandRecallHandles(a.command)) out.add(h); // file recall: a shell reading a recall file
			} else if (c.name === "read" || c.name === "grep") {
				const h = parseRecallPath(a.path)?.handle; // file recall: read or grep of a recall file
				if (h) out.add(h);
			}
		}
	}
	return out;
}

export interface RecallHooks {
	onRecall(handles: string[], chars: number, entryIds: (string | null)[]): void;
	labelOf?(handle: string): string | undefined; // "read src/learn.ts" for a handle folded in this branch
}

export function registerRecallTool(pi: ExtensionAPI, hooks: RecallHooks) {
	pi.registerTool({
		name: RECALL_TOOL,
		...(zipMode() === "speed" ? { defaultActive: false } : {}),
		label: "Recall folded output",
		description:
			"Get back the EXACT original of earlier tool outputs of this session that are no longer shown in full: a [folded by pi-zip …] block, or an output " +
			"listed with a handle in a pi-zip summary. Whenever you need what such an output said, recall it first: it is instant, free and has no side effects, " +
			"while re-running a command or re-reading a file costs a step and may give a different result. Never guess the content of a folded output. " +
			"Pass its handle (10 characters, from the block's marker line or the summary; handles stay valid after later summaries or compaction), or several with handles. " +
			'For a part, add grep (case-insensitive regular expression; matching lines with line numbers) or range (e.g. "120-240"). ' +
			"No handle at hand? grep alone searches every earlier tool output of the session and labels each match with its output's handle and command. " +
			"Large results come in pages of characters: when a page says more is left, call again with offset.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "A handle from a folded block's marker line or a summary" },
				handles: { type: "array", items: { type: "string" }, description: "Optional batch: several handles at once; each is returned as its own labelled section" },
				grep: { type: "string", description: "Optional: only lines matching this case-insensitive regular expression, with line numbers (applied to every handle). Without any handle: searches every earlier tool output of the session" },
				range: { type: "string", description: 'Optional: only this line range, e.g. "120-240" (applied to every handle)' },
				offset: { type: "number", description: "Optional: start this many characters into the (selected) text, for the next page of a large output or a very long single line (applied to every handle)" },
				limit: { type: "number", description: `Optional: page size in characters (default ${RECALL_PAGE_CHARS}; ${SEARCH_PAGE_CHARS} for grep without a handle; at most ${RECALL_MAX_PAGE_CHARS})` },
			},
			required: [],
		} as Any,
		renderCall(args: Any, theme: Any) {
			return lines((w) => recallCallLine(args ?? {}, w, theme, measure, (h) => hooks.labelOf?.(h)));
		},
		renderResult(result: Any, options: Any, theme: Any) {
			const text = textOf(result?.content);
			const secs: RecallSectionInfo[] = Array.isArray(result?.details?.sections) ? result.details.sections : [];
			return lines((w) => recallResultLines(secs, text, !!options?.expanded, w, theme, measure));
		},
		async execute(_id: string, params: Any, _signal: Any, _onUpdate: Any, ctx: Any): Promise<Any> {
			const grep = params?.grep !== undefined ? String(params.grep) : undefined;
			const range = params?.range !== undefined ? String(params.range) : undefined;
			const offset = params?.offset;
			const limit = params?.limit;
			const handles: string[] = [];
			if (typeof params?.handle === "string" && params.handle.trim()) handles.push(params.handle.trim());
			if (Array.isArray(params?.handles)) for (const h of params.handles) if (typeof h === "string" && h.trim() && !handles.includes(h.trim())) handles.push(h.trim());
			if (!handles.length && grep !== undefined && grep.trim() !== "") {
				try {
					const branch = ctx.sessionManager.getBranch() as Any[];
					const later = (int(offset) ?? 0) > 0; // a later page: search the pool its first page saw
					const out = searchOutputs(branchOutputs(branch), grep, { offset, limit, upTo: later ? searchPoolOf(branch, grep) : undefined });
					hooks.onRecall([], out.chars, []); // a search marks nothing as recalled: only what the model asks for by handle is kept unfolded
					return { content: [{ type: "text", text: out.text }], details: { handles: [], search: grep, pool: out.pool, resolved: out.matched, missing: 0, sections: out.sections }, isError: false };
				} catch (err) {
					return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
				}
			}
			if (!handles.length) return { content: [{ type: "text", text: "Pass handle (one string) or handles (array), copied exactly from a folded block's marker line or a summary; or grep alone to search every earlier tool output." }], details: {}, isError: true };
			try {
				const { items, entryIds } = resolveHandlesInBranch(ctx.sessionManager.getBranch() as Any[], handles);
				const out = recallSections(items, { grep, range, offset, limit });
				hooks.onRecall(handles, items.reduce((a, it) => a + (it.text?.length ?? 0), 0), entryIds);
				return { content: [{ type: "text", text: out.text }], details: { handles, resolved: out.ok, missing: out.missing, sections: out.sections }, isError: out.ok === 0 };
			} catch (err) {
				return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
			}
		},
	});
}

/** A minimal pi-tui Component: lines computed for the width at render time. */
function lines(fn: (width: number) => string[]): Any {
	return { render: (width: number) => fn(Math.max(1, width)), invalidate: () => {} };
}
