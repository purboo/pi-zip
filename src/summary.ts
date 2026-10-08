// Summary (F11, F12): deterministic skeleton (user words verbatim + files/commands) + model-written narrative + handle table.
// Thinking is never quoted or paraphrased: it is stripped before the model sees the prefix.
import { randomUUID } from "node:crypto";
import { handleFor, outcomeHint, pickKeyLines, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { type Block, type Cut, type PlanResult, settings, toolCallIndex } from "./plan.ts";
import { type Any, clamp, clip, textOf, tok4 } from "./util.ts";

export const SUMMARY_MARK = "[summary of earlier conversation by pi-zip]";
const POLICY_BLOCK_RE = /violate|terms of service|usage polic|content polic|acceptable use/i;
const NARRATIVE_SYSTEM =
	"You are a context summarization assistant. Read the conversation and write ONLY the requested summary sections. " +
	"Do NOT continue the conversation, do NOT answer questions in it, do NOT call tools.";

export interface HandleRow {
	handle: string;
	tool: string;
	args: string;
	hint: string;
	turn?: number; // user turn of the output, so look-alike runs stay apart
	outcome?: string; // exit status / test counts (outcomeHint)
}

const TABLE_HEAD = "## Folded outputs (originals recallable with zip_recall; handles stay valid after later summaries or compaction)";
const TABLE_ROWS = 40;
const tableLine = (r: HandleRow) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${r.turn ? ` · turn ${r.turn}` : ""}${r.outcome ? ` · ${r.outcome}` : ""} · ${clip(r.hint, 90)}`;

/**
 * Compact table appended to every summary so handles survive it: this prefix's rows merged with the rows of the previous summary's
 * table(s) (hints and outcomes kept), newest TABLE_ROWS rows, each handle once, and a count of the older rows left out.
 */
export function handleTable(rows: HandleRow[], previous: string | null = null): string | null {
	const prev = parseSummary(previous);
	const merged = mergeItems(prev.table.items, rows.map(tableLine), prev.table.omitted, TABLE_ROWS, Infinity, (l) => TABLE_ROW.exec(l)?.[1]);
	if (!merged.kept.length) return null;
	const lines = merged.omitted ? [`[… ${merged.omitted} older folded outputs omitted from this table …]`, ...merged.kept] : merged.kept;
	return TABLE_HEAD + "\n" + lines.join("\n");
}

/** Keep the newest `n` lines and say how many older ones were left out (never a silent drop). */
const newest = (xs: string[], n: number): string[] => (xs.length > n ? [`[… ${xs.length - n} older omitted …]`, ...xs.slice(-n)] : xs);

const H = "[0-9a-z]{10}"; // a handle, see handleFor
const CMD_ROW = new RegExp(`^\`(.*)\` -> [^(]*\\(turn (\\d+), (${H})\\)$`);
const OTHER_ROW = new RegExp(`^(\\S+) (.*) \\(turn (\\d+), (${H})\\)$`);
const FILE_ROW = /^- (.*) \(([^()]*)\)$/;
const FILE_OP = new RegExp(`^(\\S+): (${H})$`);
const TABLE_ROW = new RegExp(`^- (${H}) · (\\S+)((?: [^·]*?)?)(?: · turn (\\d+))?(?: · .*)?$`);
const INDEX_HEAD = "## Handle index";
/** Budget of the "Handle index" section, in tokens. */
export const INDEX_TOKENS = 1500;

interface IndexRow {
	handle: string;
	tool: string;
	args: string;
	turn?: number;
}

const indexLine = (r: IndexRow) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${r.turn ? ` · turn ${r.turn}` : ""}`;

/**
 * Handle rows (oldest first) recorded in an earlier summary, read from every section that carries them: the commands, files and
 * other-calls lists, the folded-outputs table and an earlier handle index. Works on the whole text, nested carried-forward blocks
 * included, so the clip applied to the carried-forward text cannot lose them.
 */
export function handleRowsOf(text: string | null): IndexRow[] {
	const rows: IndexRow[] = [];
	let sec = "";
	for (const line of (text ?? "").split("\n")) {
		if (line.startsWith("## ")) {
			sec = line;
			continue;
		}
		let m: RegExpExecArray | null;
		if (sec.startsWith("## Commands run")) {
			if ((m = CMD_ROW.exec(line))) rows.push({ handle: m[3], tool: "bash", args: m[1], turn: Number(m[2]) });
		} else if (sec.startsWith("## Other tool calls")) {
			if ((m = OTHER_ROW.exec(line))) rows.push({ handle: m[4], tool: m[1], args: m[2], turn: Number(m[3]) });
		} else if (sec.startsWith("## Files touched")) {
			if ((m = FILE_ROW.exec(line)))
				for (const op of m[2].split(", ")) {
					const h = FILE_OP.exec(op);
					if (h) rows.push({ handle: h[2], tool: h[1], args: m[1] });
				}
		} else if (sec.startsWith("## Folded outputs") || sec.startsWith(INDEX_HEAD)) {
			if ((m = TABLE_ROW.exec(line))) rows.push({ handle: m[1], tool: m[2], args: m[3].trim(), turn: m[4] ? Number(m[4]) : undefined });
		}
	}
	return rows;
}

/**
 * Handles of the tool results the summary would otherwise lose: this prefix's results and the earlier summary's rows, newest first,
 * minus handles already written elsewhere in the summary, under a token budget. Says how many rows did not fit.
 */
function handleIndex(now: IndexRow[], previous: string | null, listed: string, budgetTokens: number): string | null {
	const seen = new Set<string>(listed.match(new RegExp(`\\b${H}\\b`, "g")) ?? []);
	const rows: IndexRow[] = [];
	for (const r of [...now].reverse().concat(handleRowsOf(previous).reverse())) {
		if (seen.has(r.handle)) continue;
		seen.add(r.handle);
		rows.push({ ...r, args: clip(r.args, 60) });
	}
	if (!rows.length) return null;
	const head = `${INDEX_HEAD} (older outputs, newest first; zip_recall with a handle returns the original)`;
	let used = tok4(head) + 12; // 12: the "not listed" line
	const lines: string[] = [];
	for (const r of rows) {
		const l = indexLine(r);
		if (used + tok4(l) + 1 > budgetTokens) break;
		used += tok4(l) + 1;
		lines.push(l);
	}
	if (lines.length < rows.length) lines.push(`[… ${rows.length - lines.length} older handles not listed …]`);
	return head + "\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Sectioned carry-forward. A summary is parsed into its sections; each section of the previous summary is merged with the same
// section of the new prefix, deduplicated, and the OLDEST items are dropped first under a per-section budget, with a running
// count of what was left out. (The earlier design clipped the whole carried text to its first 12,000 characters, which kept the
// oldest nested content and cut the newest requests and handles.)
// ---------------------------------------------------------------------------------------------------------------
interface Items {
	items: string[]; // oldest first
	omitted: number; // older items already left out by earlier merges
}
interface FileRow {
	path: string;
	ops: Map<string, string | null>; // tool -> handle of its latest result
}
export interface ParsedSummary {
	structured: boolean; // at least one section of our own format was found (false: a native Pi compaction summary, free text)
	users: Items;
	files: { rows: FileRow[]; omitted: number };
	cmds: Items;
	others: Items;
	errors: Items;
	table: Items;
	narrative: string[]; // model-written text and free text, oldest first
}

const SECTIONS: Array<[RegExp, string]> = [
	[/^## User requests/, "users"],
	[/^## Files touched/, "files"],
	[/^## Commands run/, "cmds"],
	[/^## Other tool calls/, "others"],
	[/^## Errors/, "errors"],
	[/^## Handle index/, "index"],
	[/^## Folded outputs/, "table"],
	[/^## Narrative/, "narr"],
	[/^## Earlier narrative/, "narr"],
	[/^## Earlier summary/, "free"], // the carried-forward block of the older format
];
/** Heading written for the user section. Its request bodies indent every continuation line by USER_INDENT, so a numbered list or a `## ` heading inside a request cannot be taken for an item or section start. Older summaries have no such marker and are parsed heuristically. */
const USERS_HEAD = "## User requests (verbatim, oldest first, continuation lines indented)";
const USER_INDENT = "   ";
const OMIT_ROW = /^\[… (\d+) [^\]]*?(?:omitted|not listed)[^\]]*…\]$/;
const COVERS_ROW = /^Covers \d+ earlier messages\./;
const NONE_ROW = "(none)";

/** Parse any summary text: pi-zip's current and older formats (carried-forward blocks nested inside carried-forward blocks included), or free text. */
export function parseSummary(text: string | null): ParsedSummary {
	const out: ParsedSummary = { structured: false, users: { items: [], omitted: 0 }, files: { rows: [], omitted: 0 }, cmds: { items: [], omitted: 0 }, others: { items: [], omitted: 0 }, errors: { items: [], omitted: 0 }, table: { items: [], omitted: 0 }, narrative: [] };
	if (!text) return out;
	// occurrences in text order; in the older nested format the nested (older) copy of a section comes first, so order = oldest first
	const occ: Array<{ key: string; lines: string[]; indented?: boolean }> = [{ key: "free", lines: [] }];
	for (const line of text.split("\n")) {
		if ((line.trim() === SUMMARY_MARK && !/^\s/.test(line)) || COVERS_ROW.test(line)) continue;
		const hit = line.startsWith("## ") ? SECTIONS.find(([re]) => re.test(line)) : undefined;
		if (hit) {
			occ.push({ key: hit[1], lines: [], indented: hit[1] === "users" && line.trim() === USERS_HEAD });
			if (hit[1] !== "free" && hit[1] !== "narr") out.structured = true;
			continue;
		}
		occ[occ.length - 1].lines.push(line);
	}
	const files = new Map<string, FileRow>();
	for (const { key, lines, indented } of occ) {
		const body = lines.filter((l) => l.trim() !== "" && l.trim() !== NONE_ROW);
		if (key === "users") {
			const r = indented ? parseIndentedUsers(lines) : parseUsers(lines);
			out.users.items.push(...r.items);
			out.users.omitted += r.omitted;
			continue;
		}
		const take = (dst: Items, keep: (l: string) => boolean) => {
			for (const l of body) {
				const m = OMIT_ROW.exec(l);
				if (m) dst.omitted += Number(m[1]);
				else if (keep(l)) dst.items.push(l);
			}
		};
		if (key === "files") {
			for (const l of body) {
				const m = OMIT_ROW.exec(l);
				if (m) { out.files.omitted += Number(m[1]); continue; }
				const f = FILE_ROW.exec(l);
				if (!f) continue;
				const ops = new Map<string, string | null>(files.get(f[1])?.ops ?? []);
				for (const op of f[2].split(", ")) {
					const h = FILE_OP.exec(op);
					if (h) ops.set(h[1], h[2]);
					else if (op.trim() && !ops.has(op.trim())) ops.set(op.trim(), null);
				}
				files.delete(f[1]);
				files.set(f[1], { path: f[1], ops });
			}
		} else if (key === "cmds") take(out.cmds, (l) => l.startsWith("`"));
		else if (key === "others") take(out.others, () => true);
		else if (key === "errors") take(out.errors, (l) => l.startsWith("- "));
		else if (key === "table") take(out.table, (l) => TABLE_ROW.test(l));
		else if (key === "narr" || key === "free") {
			const t = lines.join("\n").trim();
			if (t && !t.startsWith("(unavailable")) out.narrative.push(t);
		}
	}
	out.files.rows = [...files.values()];
	return out;
}

/** Current format: an unindented `N. ` line starts a request, indented lines continue it (number values are ignored: they are display only). */
function parseIndentedUsers(lines: string[]): Items {
	const out: Items = { items: [], omitted: 0 };
	let cur: string[] | null = null;
	const close = () => {
		if (cur) out.items.push(cur.join("\n").replace(/\s+$/, ""));
		cur = null;
	};
	for (const line of lines) {
		const om = OMIT_ROW.exec(line);
		if (om && /requests omitted/.test(line)) {
			close();
			out.omitted += Number(om[1]);
			continue;
		}
		const m = /^\d+\. (.*)$/.exec(line);
		if (m) {
			close();
			cur = [m[1]];
		} else if (cur) cur.push(line.startsWith(USER_INDENT) ? line.slice(USER_INDENT.length) : line.trim() === "" ? "" : line);
	}
	close();
	out.items = out.items.filter((t) => t !== NONE_ROW && t !== "");
	return out;
}

/** Older format: numbered, possibly multi-line requests, heuristic. Numbers run 1, 2, 3...; after an omission marker (or a gap in the older format) any larger number resumes. */
function parseUsers(lines: string[]): Items {
	const out: Items = { items: [], omitted: 0 };
	let cur: string[] | null = null;
	let last = 0;
	let anyNumber = true;
	const close = () => {
		if (cur) out.items.push(cur.join("\n").replace(/\s+$/, ""));
		cur = null;
	};
	for (const line of lines) {
		const om = OMIT_ROW.exec(line);
		if (om && /requests omitted/.test(line)) {
			close();
			out.omitted += Number(om[1]);
			anyNumber = true;
			continue;
		}
		const m = /^(\d+)\. (.*)$/.exec(line);
		if (m && (anyNumber ? Number(m[1]) > last || last === 0 : Number(m[1]) === last + 1)) {
			close();
			cur = [m[2]];
			last = Number(m[1]);
			anyNumber = false;
		} else if (cur) cur.push(line);
	}
	close();
	out.items = out.items.filter((t) => t !== NONE_ROW && t !== "");
	return out;
}

/**
 * older + newer, oldest first. Deduplicated by `key` (default: the item itself; the newest copy wins and keeps the newest position;
 * `null` = no dedup, for repeated user requests), then the newest items that fit `maxItems` and `maxChars` are kept (always at least the newest one). `omitted` counts every older
 * item left out so far, this merge's drops included.
 */
function mergeItems(older: string[], newer: string[], omitted: number, maxItems: number, maxChars: number, key: ((s: string) => string | undefined) | null = (s) => s): { kept: string[]; omitted: number } {
	let all = [...older, ...newer];
	if (key) {
		const seen = new Set<string>();
		all = all.reverse().filter((x) => { const k = key(x) ?? x; return seen.has(k) ? false : (seen.add(k), true); }).reverse();
	}
	let from = all.length;
	let used = 0;
	while (from > 0 && all.length - from < maxItems && used + all[from - 1].length + 1 <= maxChars) used += all[--from].length + 1;
	if (from === all.length && all.length) from--; // the newest item always stays
	return { kept: all.slice(from), omitted: omitted + from };
}

/** Per-section budgets (characters unless noted); the total stays near the old design's 12,000-char carry plus the new prefix's own lists. */
const BUDGET = { users: 16000, files: 6000, cmds: 10000, others: 5000, errors: 4000, lines: 60, errorLines: 15 };
/** The previous narrative is kept as a tail excerpt: the newest decisions, open todos and key facts sit at its end. */
export const PREV_NARRATIVE_CHARS = 3000;
/** A previous summary that is only free text (Pi's own compaction) has no lists to merge: its excerpt keeps a head (the goal) and a longer tail. */
export const FOREIGN_SUMMARY_CHARS = 6000;

function tailExcerpt(text: string, max: number, head = 0): string {
	if (text.length <= max) return text;
	const cutAtLine = (t: string) => {
		const nl = t.indexOf("\n"); // start on a line boundary, else on a word boundary: never mid-word
		if (nl >= 0 && nl < 200) return t.slice(nl + 1);
		const sp = t.indexOf(" ");
		return sp >= 0 && sp < 40 ? t.slice(sp + 1) : t;
	};
	const h = head ? text.slice(0, head).replace(/\s+\S*$/, "") : "";
	const t = cutAtLine(text.slice(-(max - h.length)));
	return (h ? h + "\n" : "") + "[… middle of the earlier narrative omitted …]\n" + t;
}

const list = (title: string, m: { kept: string[]; omitted: number }, marker: string): string[] => [title, m.kept.length ? [...(m.omitted ? [`[… ${m.omitted} ${marker} …]`] : []), ...m.kept].join("\n") : NONE_ROW];

/**
 * The deterministic part of a summary: user words verbatim, files, commands, other calls, errors and a handle index, each section
 * merged from the previous summary `previous` (any format) and this prefix. `tableText` = the folded-outputs table the caller will
 * append, so the index does not repeat its handles.
 */
export function skeleton(prefix: Block[], previous: string | null, tableText = ""): { text: string; users: number } {
	const calls = toolCallIndex(prefix);
	const results = new Map<string, Block>();
	for (const b of prefix) if (b.kind === "toolResult") results.set(b.msg.toolCallId, b);
	const users: string[] = [];
	const files = new Map<string, Map<string, string | null>>(); // path -> tool -> handle of its latest result
	const cmds: string[] = [];
	const others: string[] = []; // tools with neither a command nor a path (web fetch, pathless grep, custom tools)
	const errors: string[] = [];
	const now: IndexRow[] = []; // every recallable result of this prefix, oldest first
	for (const b of prefix) {
		if (b.kind === "user") {
			const t = textOf(b.msg.content).trim();
			if (t) users.push(t.length > 3000 ? t.slice(0, 2000) + "\n[… middle of this request omitted …]\n" + t.slice(-800) : t);
		}
		if (b.kind !== "assistant") continue;
		for (const c of b.msg.content ?? []) {
			if (c?.type !== "toolCall") continue;
			const a = c.arguments ?? {};
			const res = results.get(c.id);
			const resText = res ? textOf((res.raw ?? res.msg).content) : "";
			if (c.name === "bash") {
				const m = /Command exited with code (\d+)/.exec(resText);
				const status = m ? `exit ${m[1]}` : res?.msg.isError ? "error" : res ? "exit 0" : "no result";
				const tag = res ? ` (turn ${res.userTurn}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : ""; // every result is recallable, so every one gets its handle
				cmds.push(`\`${clip(String(a.command ?? ""), 160)}\` -> ${status}${tag}`);
			} else if (typeof a.path === "string" || typeof a.file_path === "string") {
				const p = String(a.path ?? a.file_path);
				if (!files.has(p)) files.set(p, new Map());
				const ops = files.get(p)!;
				ops.set(c.name, res?.entryId ? handleFor(res.entryId) : (ops.get(c.name) ?? null));
			} else if (c.name !== RECALL_TOOL) {
				const tag = res ? ` (turn ${res.userTurn}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : " (no result)";
				others.push(`${c.name} ${clip(shortArgs(a), 160)}${tag}`);
			}
			if (res?.entryId && c.name !== RECALL_TOOL) now.push({ handle: handleFor(res.entryId), tool: c.name, args: clip(shortArgs(a), 60), turn: res.userTurn });
			if (res?.msg.isError) errors.push(`- ${c.name} ${shortArgs(a)}: ${clip(resText, 200)}`);
		}
	}
	const prev = parseSummary(previous);
	// user requests: previous (older) then new; the oldest go first, numbering continues over what was left out
	const mu = mergeItems(prev.users.items, users, prev.users.omitted, Infinity, BUDGET.users, null); // no dedup: a repeated "yes" is a different request each time
	const userLines = mu.kept.map((u, i) => `${mu.omitted + i + 1}. ${u.replace(/\n/g, "\n" + USER_INDENT)}`);
	// files: a path touched again moves to the newest end with its newest handles
	const merged = new Map<string, FileRow>(prev.files.rows.map((r) => [r.path, r]));
	for (const [path, ops] of files) {
		const ex = merged.get(path);
		merged.delete(path);
		merged.set(path, { path, ops: new Map([...(ex?.ops ?? []), ...[...ops].filter(([t, h]) => h !== null || !ex?.ops.has(t))]) });
	}
	const fileText = [...merged.values()].map((r) => `- ${r.path} (${[...r.ops].map(([t, h]) => (h ? `${t}: ${h}` : t)).join(", ")})`);
	const mf = mergeItems(fileText, [], prev.files.omitted, BUDGET.lines, BUDGET.files, (l) => FILE_ROW.exec(l)?.[1]);
	const mc = mergeItems(prev.cmds.items, cmds, prev.cmds.omitted, BUDGET.lines, BUDGET.cmds);
	const mo = mergeItems(prev.others.items, others, prev.others.omitted, BUDGET.lines, BUDGET.others);
	const me = mergeItems(prev.errors.items, errors, prev.errors.omitted, BUDGET.errorLines, BUDGET.errors);
	const out: string[] = [SUMMARY_MARK];
	out.push(`Covers ${prefix.length} earlier messages. Tool outputs in the kept part of the conversation may have been folded; call zip_recall with a handle to get one back exactly.`);
	out.push(USERS_HEAD);
	if (mu.omitted) out.push(`[… ${mu.omitted} older requests omitted …]`);
	out.push(...(userLines.length ? userLines : [NONE_ROW]));
	out.push(...list("## Files touched", mf, "older omitted"));
	out.push(...list("## Commands run (with exit status)", mc, "older omitted"));
	if (mo.kept.length) out.push(...list("## Other tool calls (turn, handle)", mo, "older omitted"));
	out.push(...list("## Errors", me, "older omitted"));
	const index = handleIndex(now, previous, out.join("\n") + "\n" + tableText, INDEX_TOKENS);
	if (index) out.push(index);
	const foreign = !prev.structured;
	const narr = prev.narrative.join("\n\n");
	if (narr) out.push(`## Earlier narrative (excerpt of the previous summary, newest part)`, foreign ? tailExcerpt(narr, FOREIGN_SUMMARY_CHARS, 1500) : tailExcerpt(narr, PREV_NARRATIVE_CHARS));
	return { text: out.join("\n"), users: users.length };
}

/** Pi's own serializer (lazy import: only needed when a summary is actually written); a plain-text fallback if it is unavailable. */
async function serialize(msgs: Any[]): Promise<string> {
	try {
		const pi: Any = await import("@earendil-works/pi-coding-agent");
		return pi.serializeConversation(pi.convertToLlm(msgs));
	} catch {
		return msgs.map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content : textOf(m.content) || JSON.stringify(m.content ?? "")}`).join("\n\n");
	}
}

export interface Narrative {
	text: string | null;
	ok: boolean;
	ms: number;
	costUsd: number;
	usage?: Any;
	error?: string;
}

/** Narrative sections written by the current model in a separate, uncached call. Never throws. */
export async function narrative(prefix: Block[], ctx: Any, budgetTokens: number, ownSignal?: AbortSignal): Promise<Narrative> {
	const t0 = Date.now();
	const model = ctx.model;
	if (!model) return { text: null, ok: false, ms: 0, costUsd: 0, error: "no current model" };
	const msgs = prefix
		.filter((b) => b.kind !== "summary")
		.map((b) => {
			const m = b.raw && !(b.edited && !b.ours) ? b.raw : b.msg; // the summariser reads the unfolded originals
			return m.role === "assistant" ? { ...m, content: (m.content ?? []).filter((c: Any) => c?.type !== "thinking") } : m;
		});
	let lastErr = "";
	try {
		const conv = await serialize(msgs);
		const words = Math.round(clamp(budgetTokens * 0.6, 120, 1500));
		const prompt =
			`<conversation>\n${conv}\n</conversation>\n\n` +
			`Write the NARRATIVE part of a context summary for this conversation. A separate deterministic section already lists the user's ` +
			`requests, files touched, commands with exit codes and errors, so do NOT repeat those. When you refer to a specific tool output, name it by its ` +
			`tool and exact command or path (and turn) so that look-alike runs stay distinguishable; never merge similar runs into one. Output only these markdown sections:\n` +
			`## Decisions and rationale\n## Current state of the work\n## Open todos / next steps\n## Key facts to remember (exact values, paths, identifiers, results the work still depends on)\n` +
			`Be concrete and keep exact paths, names and numbers. Stay under about ${words} words. Do not call tools.`;
		const signals: AbortSignal[] = [AbortSignal.timeout(240_000)];
		// a background summary has its own signal (nothing is running, so the run's signal would be stale); a summary the user waits for follows the run's (Esc)
		const outer = ownSignal ?? ctx.signal;
		if (outer) signals.push(outer);
		const signal = AbortSignal.any(signals);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res: Any = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: NARRATIVE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
					{ maxTokens: 8192, signal, cacheRetention: "none", sessionId: randomUUID() },
				);
				if (res.stopReason === "error") throw new Error(res.errorMessage || "provider error");
				if (res.stopReason === "length") throw new Error("narrative hit the token cap");
				if ((res.content ?? []).some((c: Any) => c.type === "toolCall")) throw new Error("summariser attempted a tool call");
				const text = textOf(res.content).trim();
				if (!text) throw new Error("empty narrative");
				return { text, ok: true, ms: Date.now() - t0, costUsd: Number(res.usage?.cost?.total) || 0, usage: res.usage };
			} catch (err) {
				lastErr = err instanceof Error ? err.message : String(err);
				if (POLICY_BLOCK_RE.test(lastErr) || signal.aborted) break; // an identical retry fails the same way
			}
		}
	} catch (err) {
		lastErr = err instanceof Error ? err.message : String(err);
	}
	return { text: null, ok: false, ms: Date.now() - t0, costUsd: 0, error: lastErr };
}

/** The cold summary (skeleton + narrative + handle table) for a planned cut. */
export async function buildCut(p: PlanResult, ctx: Any, signal?: AbortSignal): Promise<Cut> {
	const { foldMin, keepLines } = settings();
	const t0 = performance.now();
	const prefix = p.blocks.slice(0, p.cutIdx!);
	const prev = prefix[0]?.kind === "summary" ? String(prefix[0].msg.summary ?? "") || null : null;
	const rows: HandleRow[] = prefix
		.filter((b) => b.kind === "toolResult" && b.entryId && (b.ours || b.tokens > foldMin))
		.map((b) => {
			const call = p.calls.get(b.msg.toolCallId);
			const keys = pickKeyLines(textOf((b.raw ?? b.msg).content), keepLines);
			const tool = call?.name ?? b.msg.toolName ?? "tool";
			return { handle: handleFor(b.entryId!), tool, args: call ? shortArgs(call.args) : "", turn: b.userTurn, outcome: outcomeHint(textOf((b.raw ?? b.msg).content), tool, !!b.msg.isError), hint: (keys.find((k) => k.why === "error" || k.why === "id") ?? keys[0])?.text ?? "" };
		});
	const table = handleTable(rows, prev);
	const sk = skeleton(prefix.filter((b) => b.kind !== "summary"), prev, table ?? "");
	const nb = clamp(p.summaryTokensPlanned - tok4(sk.text), 300, 4000);
	const nar = await narrative(prefix, ctx, nb, signal);
	let text = sk.text;
	text += nar.ok && nar.text ? `\n## Narrative (model-written)\n${nar.text.slice(0, nb * 6)}` : `\n## Narrative\n(unavailable: ${nar.error ?? "n/a"}; rely on the sections above and re-read files as needed)`;
	if (table) text += "\n" + table;
	return {
		firstKeptEntryId: p.blocks[p.cutIdx!].entryId!,
		text,
		trigger: p.sumTrigger ?? "cold",
		count: sk.users,
		prefixTokens: p.prefixTokens,
		summaryTokens: tok4(text),
		llmOk: nar.ok,
		llmError: nar.error ?? null,
		costUsd: nar.costUsd,
		usage: nar.usage,
		ms: Math.round(performance.now() - t0),
	};
}
