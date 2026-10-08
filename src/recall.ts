// zip_recall (F3): exact, batched retrieval of folded originals from the session file (I2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleFor, RECALL_TOOL } from "./placeholder.ts";
import { type Any, clamp, textOf } from "./util.ts";

const RECALL_PAGE_CHARS = 20_000; // default page
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
export function sliceRecall(text: string, opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown }): RecallSlice {
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
	const limit = clamp(limitIn ?? RECALL_PAGE_CHARS, 1, RECALL_MAX_PAGE_CHARS);
	let offset = clamp(int(opts.offset) ?? 0, 0, sel.length);
	if (offset > 0 && offset < sel.length && isLow(sel.charCodeAt(offset))) offset--; // never start inside a surrogate pair
	let end = Math.min(sel.length, offset + limit);
	if (end < sel.length && isHigh(sel.charCodeAt(end - 1))) end += end - 1 > offset ? -1 : 1; // ... or end inside one (a 1-char page takes the whole pair)
	const body = sel.slice(offset, end);
	const more = end < sel.length;
	const paged = more || offset > 0;
	const pageHeader = paged ? `[chars ${offset}-${end} of ${sel.length}${header ? " of the selection" : ""}]\n` : "";
	const hint = more
		? `\n[… ${sel.length - end} more chars: call ${RECALL_TOOL} again with offset=${end} for the next page (limit up to ${RECALL_MAX_PAGE_CHARS}), or narrow it with grep or range]`
		: "";
	return { text: header + pageHeader + body + hint, body, totalLines, matched, clipped: more, offset, nextOffset: more ? end : null, selectionChars: sel.length };
}

export interface RecallItem {
	handle: string;
	text: string | null;
	tool: string | null;
}

export function recallSections(items: RecallItem[], opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown }): { text: string; ok: number; missing: number } {
	const parts: string[] = [];
	let ok = 0;
	let missing = 0;
	for (const it of items) {
		if (it.text === null) {
			missing++;
			parts.push(`[handle ${it.handle}] not found. Copy the handle exactly from the folded block's marker line or the summary's handle table.`);
			continue;
		}
		ok++;
		const slice = sliceRecall(it.text, opts);
		parts.push(`[handle ${it.handle}${it.tool ? " · " + it.tool : ""} · ${it.text.length} chars · ${slice.totalLines} lines]\n${slice.text}`);
	}
	return { text: parts.join("\n\n"), ok, missing };
}

/** Resolve handles against the session branch (which spans entries before any compaction): exact originals. */
export function resolveHandlesInBranch(branch: Any[], handles: string[]): { items: RecallItem[]; entryIds: (string | null)[] } {
	const items: RecallItem[] = handles.map((h) => ({ handle: h, text: null, tool: null }));
	const entryIds: (string | null)[] = handles.map(() => null);
	for (const en of branch) {
		if (en?.type !== "message" || en.message?.role !== "toolResult") continue;
		const k = handles.indexOf(handleFor(en.id));
		if (k < 0) continue;
		items[k] = { handle: handles[k], text: textOf(en.message.content), tool: en.message.toolName ?? null };
		entryIds[k] = en.id;
	}
	return { items, entryIds };
}

/** Handles the model already recalled in this branch (F4: never refold them). */
export function recalledHandlesFromBranch(branch: Any[]): Set<string> {
	const out = new Set<string>();
	for (const en of branch) {
		const m = en?.type === "message" ? en.message : null;
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const c of m.content) {
			if (c?.type !== "toolCall" || c.name !== RECALL_TOOL) continue;
			const a: Any = c.arguments ?? {};
			if (typeof a.handle === "string" && a.handle.trim()) out.add(a.handle.trim());
			if (Array.isArray(a.handles)) for (const h of a.handles) if (typeof h === "string" && h.trim()) out.add(h.trim());
		}
	}
	return out;
}

export interface RecallHooks {
	onRecall(handles: string[], chars: number, entryIds: (string | null)[]): void;
}

export function registerRecallTool(pi: ExtensionAPI, hooks: RecallHooks) {
	pi.registerTool({
		name: RECALL_TOOL,
		label: "Recall folded output",
		description:
			"Get back the EXACT original content of tool outputs that pi-zip folded earlier in this session. It is instant, free and has no side effects: " +
			"prefer it over re-running a command or re-reading a file when you need the exact earlier output (a re-run may give different results). " +
			"Every folded block shows a handle (10 characters) in its marker line, and summaries carry a handle table; handles stay valid " +
			"after later summaries or compaction. Pass one handle, or several at once with handles for a batch. " +
			"The text may be large and comes in pages of characters: prefer grep (case-insensitive regular expression; returns matching lines with their line numbers) " +
			'or range (e.g. "120-240" for that line range); when a page says more is left, call again with offset to continue. Never guess the content of a folded block.',
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "A single handle from a folded block's marker line or the summary's handle table" },
				handles: { type: "array", items: { type: "string" }, description: "Optional batch: several handles at once; each is returned as its own labelled section" },
				grep: { type: "string", description: "Optional: only lines matching this case-insensitive regular expression, with line numbers (applied to every handle)" },
				range: { type: "string", description: 'Optional: only this line range, e.g. "120-240" (applied to every handle)' },
				offset: { type: "number", description: "Optional: start this many characters into the (selected) text, for the next page of a large output or a very long single line (applied to every handle)" },
				limit: { type: "number", description: `Optional: page size in characters (default ${RECALL_PAGE_CHARS}, at most ${RECALL_MAX_PAGE_CHARS})` },
			},
			required: [],
		} as Any,
		async execute(_id: string, params: Any, _signal: Any, _onUpdate: Any, ctx: Any): Promise<Any> {
			const grep = params?.grep !== undefined ? String(params.grep) : undefined;
			const range = params?.range !== undefined ? String(params.range) : undefined;
			const offset = params?.offset;
			const limit = params?.limit;
			const handles: string[] = [];
			if (typeof params?.handle === "string" && params.handle.trim()) handles.push(params.handle.trim());
			if (Array.isArray(params?.handles)) for (const h of params.handles) if (typeof h === "string" && h.trim() && !handles.includes(h.trim())) handles.push(h.trim());
			if (!handles.length) return { content: [{ type: "text", text: "Pass handle (one string) or handles (array), copied exactly from the folded block marker lines or the summary handle table." }], details: {}, isError: true };
			try {
				const { items, entryIds } = resolveHandlesInBranch(ctx.sessionManager.getBranch() as Any[], handles);
				const out = recallSections(items, { grep, range, offset, limit });
				hooks.onRecall(handles, items.reduce((a, it) => a + (it.text?.length ?? 0), 0), entryIds);
				return { content: [{ type: "text", text: out.text }], details: { handles, resolved: out.ok, missing: out.missing }, isError: out.ok === 0 };
			} catch (err) {
				return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
			}
		},
	});
}
