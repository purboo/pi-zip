// zip_recall (F3): exact, batched retrieval of folded originals from the session file (I2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleFor, RECALL_TOOL } from "./placeholder.ts";
import { type Any, textOf } from "./util.ts";

const RECALL_MAX_CHARS = 20_000;
const RECALL_MAX_HITS = 400;

export function parseRange(spec: string): { from: number; to: number } | null {
	const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec ?? "");
	if (!m) return null;
	const from = parseInt(m[1], 10);
	const to = m[2] ? parseInt(m[2], 10) : from;
	return from >= 1 && to >= from && to - from <= 100_000 ? { from, to } : null;
}

export interface RecallSlice {
	text: string;
	totalLines: number;
	matched: number | null;
	clipped: boolean;
}

/** Full text, a line range, or grep matches of an original; bounded, with a paging hint. */
export function sliceRecall(text: string, opts: { grep?: string; range?: string }): RecallSlice {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let sel: string[];
	let matched: number | null = null;
	let header = "";
	if (opts.grep !== undefined && String(opts.grep).trim() !== "") {
		const p = String(opts.grep);
		let re: RegExp;
		try {
			re = new RegExp(p, "i");
		} catch {
			re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		}
		const hits: string[] = [];
		for (let i = 0; i < lines.length && hits.length < RECALL_MAX_HITS; i++) if (re.test(lines[i])) hits.push(`${i + 1}: ${lines[i]}`);
		matched = hits.length;
		sel = hits;
		header = `[grep: ${matched} matching line(s) of ${totalLines}]\n`;
	} else if (opts.range !== undefined && String(opts.range).trim() !== "") {
		const r = parseRange(String(opts.range));
		if (!r) return { text: `(invalid range "${opts.range}"; use e.g. range="120-240")`, totalLines, matched: null, clipped: false };
		sel = lines.slice(r.from - 1, r.to);
		header = `[range: lines ${r.from}-${Math.min(r.to, totalLines)} of ${totalLines}]\n`;
	} else {
		sel = lines;
	}
	let body = sel.join("\n");
	const clipped = body.length > RECALL_MAX_CHARS;
	if (clipped) body = body.slice(0, RECALL_MAX_CHARS);
	const hint = clipped ? `\n[… clipped at ${RECALL_MAX_CHARS} chars; total ${totalLines} lines — call ${RECALL_TOOL} again with grep or range for the rest]` : "";
	return { text: header + body + hint, totalLines, matched, clipped };
}

export interface RecallItem {
	handle: string;
	text: string | null;
	tool: string | null;
}

export function recallSections(items: RecallItem[], opts: { grep?: string; range?: string }): { text: string; ok: number; missing: number } {
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
			"Get back the EXACT original content of tool outputs that pi-zip folded earlier in this session. " +
			"Every folded block shows a handle (10 characters) in its marker line, and summaries carry a handle table; handles stay valid " +
			"after later summaries or compaction. Pass one handle, or several at once with handles for a batch. " +
			"The full text may be large: prefer grep (case-insensitive regular expression; returns matching lines with their line numbers) " +
			'or range (e.g. "120-240" for that line range) and repeat as needed. Never guess the content of a folded block.',
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "A single handle from a folded block's marker line or the summary's handle table" },
				handles: { type: "array", items: { type: "string" }, description: "Optional batch: several handles at once; each is returned as its own labelled section" },
				grep: { type: "string", description: "Optional: only lines matching this case-insensitive regular expression, with line numbers (applied to every handle)" },
				range: { type: "string", description: 'Optional: only this line range, e.g. "120-240" (applied to every handle)' },
			},
			required: [],
		} as Any,
		async execute(_id: string, params: Any, _signal: Any, _onUpdate: Any, ctx: Any): Promise<Any> {
			const grep = params?.grep !== undefined ? String(params.grep) : undefined;
			const range = params?.range !== undefined ? String(params.range) : undefined;
			const handles: string[] = [];
			if (typeof params?.handle === "string" && params.handle.trim()) handles.push(params.handle.trim());
			if (Array.isArray(params?.handles)) for (const h of params.handles) if (typeof h === "string" && h.trim() && !handles.includes(h.trim())) handles.push(h.trim());
			if (!handles.length) return { content: [{ type: "text", text: "Pass handle (one string) or handles (array), copied exactly from the folded block marker lines or the summary handle table." }], details: {}, isError: true };
			try {
				const { items, entryIds } = resolveHandlesInBranch(ctx.sessionManager.getBranch() as Any[], handles);
				const out = recallSections(items, { grep, range });
				hooks.onRecall(handles, items.reduce((a, it) => a + (it.text?.length ?? 0), 0), entryIds);
				return { content: [{ type: "text", text: out.text }], details: { handles, resolved: out.ok, missing: out.missing }, isError: out.ok === 0 };
			} catch (err) {
				return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
			}
		},
	});
}
