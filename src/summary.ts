// Summary (F11, F12): deterministic skeleton (user words verbatim + files/commands) + model-written narrative + handle table.
// Thinking is never quoted or paraphrased: it is stripped before the model sees the prefix.
import { randomUUID } from "node:crypto";
import { blockTime, cdDirOf, clipMid, distinctLines, handleFor, keyTexts, outcomeHint, RECALL_TOOL, shortArgs, strippableCdDirs, whenLabel } from "./placeholder.ts";
import { type Block, type Cut, type PlanResult, NARRATIVE_CALL_MAX, NARRATIVE_MAX, settings, toolCallIndex } from "./plan.ts";
import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { type Any, clamp, clip, envInt, fmtWhen, textOf, tok4 } from "./util.ts";
import { userTextBefore } from "./user-text.ts";

export const SUMMARY_MARK = "[summary of earlier conversation by pi-zip]";
const POLICY_BLOCK_RE = /violate|terms of service|usage polic|content polic|acceptable use/i;
const CAP_ERR = "narrative hit the token cap";
const NARRATIVE_SYSTEM =
	"You are a context summarization assistant. Read the conversation and write ONLY the requested summary sections. " +
	"Do NOT continue the conversation, do NOT answer questions in it, do NOT call tools.";

export interface HandleRow {
	handle: string;
	tool: string;
	args: string;
	hint: string;
	turn?: number; // user turn of the output, so look-alike runs stay apart (shown only without `at`)
	at?: number; // when the output arrived (ms), shown as local MM-DD HH:MM
	outcome?: string; // exit status / test counts (outcomeHint)
}

const TABLE_HEAD = "## Folded outputs (originals recallable with zip_recall; handles stay valid after later summaries or compaction)";
/** The same heading when zip_recall is hidden and the originals are read from recall files (parseSummary keys on "## Folded outputs"). */
const tableHead = (file?: FileRecall) => (file ? `## Folded outputs (originals in ${file.dir}/<handle>.txt; handles stay valid after later summaries or compaction)` : TABLE_HEAD);
/** The folded-outputs table: newest rows (eval-chosen with the BUDGET below, research round5/sumfmt.md). */
export const TABLE_ROWS = envInt("SUM_TABLE_ROWS", 30);
const when = (r: { at?: number; turn?: number; when?: string }) => { const w = r.when ?? whenLabel(r.at, r.turn); return w ? ` · ${w}` : ""; };
const tableLine = (r: HandleRow) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${when(r)}${r.outcome ? ` · ${r.outcome}` : ""} · ${clip(r.hint, 90)}`;

/**
 * Compact table appended to every summary so handles survive it: this prefix's rows merged with the rows of the previous summary's
 * table(s) (hints and outcomes kept), newest TABLE_ROWS rows, each handle once, and a count of the older rows left out.
 */
export function handleTable(rows: HandleRow[], previous: string | null = null, file?: FileRecall): string | null {
	const prev = parseSummary(previous);
	const merged = mergeItems(prev.table.items, rows.map(tableLine), prev.table.omitted, TABLE_ROWS, Infinity, (l) => TABLE_ROW.exec(l)?.[1]);
	if (!merged.kept.length) return null;
	const lines = merged.omitted ? [`[… ${merged.omitted} older folded outputs omitted from this table …]`, ...merged.kept] : merged.kept;
	return tableHead(file) + "\n" + lines.join("\n");
}

/** Keep the newest `n` lines and say how many older ones were left out (never a silent drop). */
const newest = (xs: string[], n: number): string[] => (xs.length > n ? [`[… ${xs.length - n} older omitted …]`, ...xs.slice(-n)] : xs);

const H = "[0-9a-z]{10}"; // a handle, see handleFor
/** The time label of a row: "turn 12" (older summaries, and outputs without a timestamp) or a local time "10-11 02:31". */
const W = "turn \\d+|\\d\\d-\\d\\d \\d\\d:\\d\\d";
const CMD_ROW = new RegExp(`^\`(.*)\` -> [^(]*\\((${W}), (${H})\\)$`);
const OTHER_ROW = new RegExp(`^(\\S+) (.*) \\((${W}), (${H})\\)$`);
const FILE_ROW = /^- (.*) \(([^()]*)\)$/;
const FILE_OP = new RegExp(`^(\\S+): (${H})$`);
const TABLE_ROW = new RegExp(`^- (${H}) · (\\S+)((?: [^·]*?)?)(?: · (${W}))?(?: · (.*))?$`);
const INDEX_HEAD = "## Handle index";
/** Budget of the "Handle index" section, in tokens. */
export const INDEX_TOKENS = envInt("SUM_INDEX_TOKENS", 2500);

interface IndexRow {
	handle: string;
	tool: string;
	args: string;
	turn?: number;
	at?: number;
	when?: string; // the time label as an earlier summary wrote it ("turn 12" or "10-11 02:31")
	hint?: string; // only for rows that would otherwise read the same: the first line of the output that tells it apart
}
const INDEX_HINT = 50;

const indexLine = (r: IndexRow) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${when(r)}${r.hint ? ` · ${clip(r.hint, INDEX_HINT)}` : ""}`;

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
			if ((m = CMD_ROW.exec(line))) rows.push({ handle: m[3], tool: "bash", args: m[1], when: m[2] });
		} else if (sec.startsWith("## Other tool calls")) {
			if ((m = OTHER_ROW.exec(line))) rows.push({ handle: m[4], tool: m[1], args: m[2], when: m[3] });
		} else if (sec.startsWith("## Files touched")) {
			if ((m = FILE_ROW.exec(line)))
				for (const op of m[2].split(", ")) {
					const h = FILE_OP.exec(op);
					if (h) rows.push({ handle: h[2], tool: h[1], args: m[1] });
				}
		} else if (sec.startsWith("## Folded outputs") || sec.startsWith(INDEX_HEAD)) {
			// an index row keeps the line that tells it apart; a table row's tail (outcome, key line) stays in the table
			if ((m = TABLE_ROW.exec(line))) rows.push({ handle: m[1], tool: m[2], args: m[3].trim(), ...(m[4] ? { when: m[4] } : {}), ...(m[5] && sec.startsWith(INDEX_HEAD) ? { hint: m[5] } : {}) });
		}
	}
	return rows;
}

/**
 * Handles of the tool results the summary would otherwise lose: this prefix's results and the earlier summary's rows, newest first,
 * minus handles already written elsewhere in the summary, under a token budget. Says how many rows did not fit.
 */
function handleIndex(now: IndexRow[], previous: string | null, listed: string, budgetTokens: number, file?: FileRecall): string | null {
	const seen = new Set<string>(listed.match(new RegExp(`\\b${H}\\b`, "g")) ?? []);
	const rows: IndexRow[] = [];
	for (const r of [...now].reverse().concat(handleRowsOf(previous).reverse())) {
		if (seen.has(r.handle)) continue;
		seen.add(r.handle);
		rows.push({ ...r, args: clipMid(r.args, 60) });
	}
	if (!rows.length) return null;
	const head = `${INDEX_HEAD} (older outputs, newest first; ${file ? `${file.dir}/<handle>.txt holds the original` : "zip_recall with a handle returns the original"})`;
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
/** Sectioned carry-forward: mechanical lists stay bounded; user messages have no budget. */
// ---------------------------------------------------------------------------------------------------------------
interface Items {
	items: string[]; // oldest first
	omitted: number; // older items already left out by earlier merges
	nums?: number[]; // user requests: the number each item was written with (1 = the session's first request), when the format says
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
	narrativeAt?: string; // a narrative carried forward unchanged (its call failed) says when it was written
	cmdDirs: string[]; // the shared `cd <dir>` prefixes the command rows leave out (oldest first)
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
/** Legacy indented user section; newer summaries use a lossless JSON section. */
const USERS_HEAD = "## User requests (verbatim, oldest first, continuation lines indented)";
/** Legacy shortened user section, read but never emitted. */
const USERS_HEAD_JSON = "## User requests (available originals, oldest first; JSON strings decode to exact user messages)";
const USERS_HEAD_SHORT = "## User requests (oldest first, continuation lines indented; the first and the newest verbatim, lines starting with ≈ shortened to their start)";
const USER_INDENT = "   ";
const OMIT_ROW = /^\[… (\d+) [^\]]*?(?:omitted|not listed)[^\]]*…\]$/;
const COVERS_ROW = /^Covers \d+ earlier messages\./;
const NONE_ROW = "(none)";
/** Heading of a previous narrative carried forward unchanged because the call for a new one failed (buildCut). */
const narrCarriedHead = (at: string | undefined, why: string) => `## Narrative (carried forward from the summary of ${at ?? "an earlier time"}; possibly stale: a new one could not be written: ${why})`;
/** The commands heading names the shared `cd <dir>` prefixes its rows leave out. */
const cmdsHead = (dirs: string[]) => `## Commands run (with exit status${dirs.length ? `; a leading "cd <dir> &&" is left out for: ${dirs.join(", ")}` : ""})`;
const CMD_DIRS_RE = /^## Commands run \(.*; a leading "cd <dir> &&" is left out for: (.*)\)$/;
const NARR_CARRIED_RE = /^## Narrative \(carried forward from the summary of ([^;]+);/;

/** Parse any summary text: pi-zip's current and older formats (carried-forward blocks nested inside carried-forward blocks included), or free text. */
export function parseSummary(text: string | null): ParsedSummary {
	const out: ParsedSummary = { cmdDirs: [], structured: false, users: { items: [], omitted: 0 }, files: { rows: [], omitted: 0 }, cmds: { items: [], omitted: 0 }, others: { items: [], omitted: 0 }, errors: { items: [], omitted: 0 }, table: { items: [], omitted: 0 }, narrative: [] };
	if (!text) return out;
	// occurrences in text order; in the older nested format the nested (older) copy of a section comes first, so order = oldest first
	const occ: Array<{ key: string; lines: string[]; indented?: boolean; json?: boolean }> = [{ key: "free", lines: [] }];
	for (const line of text.split("\n")) {
		if ((line.trim() === SUMMARY_MARK && !/^\s/.test(line)) || COVERS_ROW.test(line)) continue;
		const hit = line.startsWith("## ") ? SECTIONS.find(([re]) => re.test(line)) : undefined;
		if (hit) {
			const at = NARR_CARRIED_RE.exec(line);
			if (at) out.narrativeAt = at[1];
			const dirs = CMD_DIRS_RE.exec(line);
			if (dirs) out.cmdDirs.push(...dirs[1].split(", ").filter((d) => d && !out.cmdDirs.includes(d)));
			occ.push({ key: hit[1], lines: [], indented: hit[1] === "users" && (line.trim() === USERS_HEAD || line.trim() === USERS_HEAD_SHORT), json: hit[1] === "users" && line.trim() === USERS_HEAD_JSON });
			if (hit[1] !== "free" && hit[1] !== "narr") out.structured = true;
			continue;
		}
		occ[occ.length - 1].lines.push(line);
	}
	const files = new Map<string, FileRow>();
	for (const { key, lines, indented, json } of occ) {
		const body = lines.filter((l) => l.trim() !== "" && l.trim() !== NONE_ROW);
		if (key === "users") {
			const r = json ? parseJsonUsers(lines) : indented ? parseIndentedUsers(lines) : parseUsers(lines);
			// numbers: as written (current format), else counted (older formats: the omitted ones come first, numbering is continuous)
			const base = out.users.omitted + out.users.items.length + r.omitted;
			const nums = r.nums ?? r.items.map((_, i) => base + i + 1);
			out.users.nums = [...(out.users.nums ?? out.users.items.map((_, i) => i + 1)), ...nums];
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

/** Lossless current format: JSON escaping makes section-like text, whitespace and trailing newlines unambiguous. */
function parseJsonUsers(lines: string[]): Items {
	try {
		const value: unknown = JSON.parse(lines.join("\n"));
		if (typeof value === "object" && value !== null && "messages" in value && "unavailableEarlier" in value) {
			const { messages, unavailableEarlier } = value as { messages: unknown; unavailableEarlier: unknown };
			if (Array.isArray(messages) && messages.every((x) => typeof x === "string") && Number.isSafeInteger(unavailableEarlier) && (unavailableEarlier as number) >= 0)
				return { items: messages, omitted: unavailableEarlier as number };
		}
	} catch {}
	return { items: [], omitted: 0 };
}

/** Current format: an unindented `N. ` line starts a request, indented lines continue it (number values are ignored: they are display only). */
function parseIndentedUsers(lines: string[]): Items {
	const out: Items = { items: [], omitted: 0, nums: [] };
	let cur: string[] | null = null;
	let num = 0;
	const close = () => {
		const t = cur?.join("\n").replace(/\s+$/, "");
		if (t && t !== NONE_ROW) out.items.push(t), out.nums!.push(num);
		cur = null;
	};
	for (const line of lines) {
		const om = OMIT_ROW.exec(line);
		if (om && /requests omitted/.test(line)) {
			close();
			out.omitted += Number(om[1]);
			continue;
		}
		const m = /^(\d+)\. (.*)$/.exec(line);
		if (m) {
			close();
			num = Number(m[1]);
			cur = [m[2]];
		} else if (cur) cur.push(line.startsWith(USER_INDENT) ? line.slice(USER_INDENT.length) : line.trim() === "" ? "" : line);
	}
	close();
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

/** Every bash command of these blocks, in order. */
const bashCommands = (blocks: Block[]): string[] =>
	blocks.flatMap((b) => (b.kind === "assistant" ? (b.msg.content ?? []).filter((c: Any) => c?.type === "toolCall" && c.name === "bash").map((c: Any) => String(c.arguments?.command ?? "")) : []));

/** Budgets for non-user mechanical lists only; user text has no budget. */
export const BUDGET = {
	files: envInt("SUM_FILES", 6000),
	cmds: envInt("SUM_CMDS", 5000),
	cmdChars: envInt("SUM_CMD_CHARS", 80), // one command row's command, clipped in the middle
	others: envInt("SUM_OTHERS", 3000),
	errors: envInt("SUM_ERRORS", 2000),
	lines: envInt("SUM_LINES", 60),
	errorLines: envInt("SUM_ERROR_LINES", 8),
};
/** Render every available user message as a lossless, append-only JSON list. */
export const userSection = (users: string[], unavailableEarlier = 0): string => `${USERS_HEAD_JSON}\n${JSON.stringify({ messages: users, unavailableEarlier })}`;
/**
 * The narrative call's word budget for a narrative budget of this many tokens. A merge (a previous narrative given) asks for at most
 * MERGE_WORDS: given an old narrative to carry, the model writes about 1.55x its budget (S6 chain probe: 2,349 words for 1,500, 1,547 for
 * 1,000), and the merged narrative stays near the size of the narrative plus earlier-narrative excerpt it replaces.
 */
const narrativeWords = (budgetTokens: number, merge: boolean) => Math.round(clamp(budgetTokens * 0.6, 120, merge ? MERGE_WORDS : 1500));
const MERGE_WORDS = 1000;
/** The previous summary's narrative the narrative call merges is at most PREV_CHARS_PER_WORD characters per word of the call's budget,
 *  PREV_NARRATIVE_CHARS in all: what a merge writes (1.55 x 1,000 words x ~7.7 chars), so a merged narrative passes whole to the next merge.
 *  A longer one (Pi's own free-text summary, an older summary's narrative and its earlier excerpt) is sent as its head and its tail, so
 *  the chain cannot grow. */
const PREV_CHARS_PER_WORD = 12;
export const PREV_NARRATIVE_CHARS = MERGE_WORDS * PREV_CHARS_PER_WORD;

function excerpt(text: string, max: number, head = 0): string {
	if (text.length <= max) return text;
	const cutAtLine = (t: string) => {
		const nl = t.indexOf("\n"); // start on a line boundary, else on a word boundary: never mid-word
		if (nl >= 0 && nl < 200) return t.slice(nl + 1);
		const sp = t.indexOf(" ");
		return sp >= 0 && sp < 40 ? t.slice(sp + 1) : t;
	};
	const h = head ? text.slice(0, head).replace(/\s+\S*$/, "") : "";
	const t = cutAtLine(text.slice(-(max - h.length)));
	return (h ? h + "\n" : "") + "[… middle of the narrative omitted …]\n" + t;
}

/** The narrative part of a previous summary, as the next narrative call reads it. */
export interface PrevNarrative {
	text: string; // bounded by PREV_NARRATIVE_CHARS
	foreign: boolean; // the previous summary is free text (Pi's own compaction or another extension's), not pi-zip's sections
	at?: string; // when it was written (local MM-DD HH:MM), if known
}

/**
 * The previous summary's narrative only (not its lists): the model-written sections of pi-zip's summary (an older summary's carried
 * excerpt included, so the first merge also settles what that excerpt said), or the whole text of a free-text summary. null: none.
 * `at` = the previous summary's timestamp (ms), used when the text does not say when its narrative was written.
 */
export function previousNarrative(text: string | null, at?: number, maxChars = PREV_NARRATIVE_CHARS): PrevNarrative | null {
	const p = parseSummary(text);
	const t = p.narrative.join("\n\n").trim();
	if (!t) return null;
	const when = p.narrativeAt ?? (at && at > 0 ? fmtWhen(at) : undefined);
	const max = Math.min(maxChars, PREV_NARRATIVE_CHARS);
	return { text: excerpt(t, max, Math.floor(max / 4)), foreign: !p.structured, ...(when ? { at: when } : {}) };
}

const list = (title: string, m: { kept: string[]; omitted: number }, marker: string): string[] => [title, m.kept.length ? [...(m.omitted ? [`[… ${m.omitted} ${marker} …]`] : []), ...m.kept].join("\n") : NONE_ROW];

/**
 * The deterministic part of a summary: user words verbatim, files, commands, other calls, errors and a handle index, each section
 * merged from the previous summary `previous` (any format) and this prefix. `tableText` = the folded-outputs table the caller will
 * append, so the index does not repeat its handles.
 */
export function skeleton(prefix: Block[], previous: string | null, tableText = "", file?: FileRecall, originals?: string[]): { text: string; users: number } {
	const calls = toolCallIndex(prefix);
	const results = new Map<string, Block>();
	for (const b of prefix) if (b.kind === "toolResult") results.set(b.msg.toolCallId, b);
	const users: string[] = [];
	const files = new Map<string, Map<string, string | null>>(); // path -> tool -> handle of its latest result
	const cmds: string[] = [];
	const others: string[] = []; // tools with neither a command nor a path (web fetch, pathless grep, custom tools)
	const errors: string[] = [];
	const now: IndexRow[] = []; // every recallable result of this prefix, oldest first
	const nowText: string[] = []; // ... and its output (to tell look-alike rows apart)
	const usedDirs = new Set<string>(); // shared `cd <dir>` prefixes left out of this prefix's command rows
	const shared = strippableCdDirs(bashCommands(prefix), parseSummary(previous).cmdDirs);
	for (const b of prefix) {
		if (b.kind === "user") {
			users.push(textOf((b.raw ?? b.msg).content));
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
				const tag = res ? ` (${whenLabel(blockTime(res), res.userTurn)}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : ""; // every result is recallable, so every one gets its handle
				const d = cdDirOf(String(a.command ?? ""));
				if (d && shared.has(d)) usedDirs.add(d);
				cmds.push(`\`${shortArgs({ command: String(a.command ?? "") }, BUDGET.cmdChars, shared)}\` -> ${status}${tag}`);
			} else if (typeof a.path === "string" || typeof a.file_path === "string") {
				const p = String(a.path ?? a.file_path);
				if (!files.has(p)) files.set(p, new Map());
				const ops = files.get(p)!;
				ops.set(c.name, res?.entryId ? handleFor(res.entryId) : (ops.get(c.name) ?? null));
			} else if (c.name !== RECALL_TOOL) {
				const tag = res ? ` (${whenLabel(blockTime(res), res.userTurn)}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : " (no result)";
				others.push(`${c.name} ${shortArgs(a)}${tag}`);
			}
			if (res?.entryId && c.name !== RECALL_TOOL) {
				now.push({ handle: handleFor(res.entryId), tool: c.name, args: shortArgs(a, 60, shared), turn: res.userTurn, at: blockTime(res) });
				nowText.push(resText);
			}
			if (res?.msg.isError) errors.push(`- ${c.name} ${shortArgs(a)}: ${clip(resText, 200)}`);
		}
	}
	const prev = parseSummary(previous);
	const allUsers = [...(originals ?? prev.users.items), ...users];
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
	out.push(
		file
			? `Covers ${prefix.length} earlier messages. Their tool outputs are no longer in your context but are kept exactly: the 10-character code next to a command, file or call below is its handle, and ${file.dir}/<handle>.txt holds that output. ` +
					`To use what an output said, ${fileRecallHow(file)}${file.grep || file.bash ? ` (grep over ${file.dir} searches every earlier output)` : ""} rather than re-running or re-reading (results may differ). Folded blocks later in the conversation work the same way.`
			: `Covers ${prefix.length} earlier messages. Their tool outputs are no longer in your context but are kept exactly: the 10-character code next to a command, file or call below is its handle. ` +
					`To use what an output said, ${RECALL_TOOL} it (grep/range for a part; grep alone searches every earlier output) rather than re-running or re-reading (results may differ). Folded blocks later in the conversation work the same way.`,
	);
	out.push(...list("## Files touched", mf, "older omitted"));
	const dirs = [...new Set([...prev.cmdDirs, ...usedDirs])]; // every dir any row leaves out (at most one: strippableCdDirs)
	out.push(...list(cmdsHead(dirs), mc, "older omitted"));
	if (mo.kept.length) out.push(...list("## Other tool calls (time, handle)", mo, "older omitted"));
	out.push(...list("## Errors", me, "older omitted"));
	// index rows of this prefix that would read the same (same tool and arguments): each gets the first line of its output that tells it apart
	const groups = new Map<string, number[]>();
	now.forEach((r, i) => groups.set(`${r.tool} ${r.args}`, [...(groups.get(`${r.tool} ${r.args}`) ?? []), i]));
	for (const ix of groups.values()) {
		if (ix.length < 2) continue;
		const hints = distinctLines(ix.map((i) => nowText[i]), ix.map((i) => keyTexts(nowText[i])), [], INDEX_HINT);
		ix.forEach((i, k) => hints[k] && (now[i].hint = hints[k]!));
	}
	const index = handleIndex(now, previous, out.join("\n") + "\n" + tableText, INDEX_TOKENS, file);
	if (index) out.push(index);
	// the previous narrative is not carried here: the narrative call merges it into one (buildCut), or the fallback carries it whole
	return { text: out.join("\n") + "\n" + userSection(allUsers, originals ? 0 : prev.users.omitted), users: users.length };
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

/** A reasoning model whose provider refuses a request without reasoning (pi-ai sends effort "none" when none is asked for; sota
 *  gpt-6.1-sol answers "'none' is not supported ... Supported values are: 'low', ..."). Pi's own compaction passes the session's
 *  thinking level and never meets it. */
export const EFFORT_REFUSED_RE = /(?:'none'|"none"|reasoning|effort)[^\n]{0,80}not supported|unsupported[^\n]{0,60}(?:reasoning|effort)/i;
const lowEffort = new Set<string>(); // provider/model keys that need an explicit effort: the next narrative asks for "low" at once

/**
 * Narrative sections written by the current model in a separate, uncached call. Never throws. `previous` = the previous summary's
 * narrative: the call merges it with what the prefix adds into ONE narrative (newer values replace older ones, finished todos go,
 * durable facts stay), so no stale copy of an earlier narrative is carried next to the new one.
 */
export async function narrative(prefix: Block[], ctx: Any, budgetTokens: number, ownSignal?: AbortSignal, previous: PrevNarrative | null = null): Promise<Narrative> {
	const t0 = Date.now();
	const model = ctx.model;
	if (!model) return { text: null, ok: false, ms: 0, costUsd: 0, error: "no current model" };
	const cap = Math.min(NARRATIVE_CALL_MAX, Number(model.maxTokens) > 0 ? Number(model.maxTokens) : NARRATIVE_CALL_MAX);
	const msgs = prefix
		.filter((b) => b.kind !== "summary")
		.map((b) => {
			const m = b.raw && !(b.edited && !b.ours) ? b.raw : b.msg; // the summariser reads the unfolded originals
			return m.role === "assistant" ? { ...m, content: (m.content ?? []).filter((c: Any) => c?.type !== "thinking") } : m;
		});
	let lastErr = "", costUsd = 0;
	let usage: Any;
	try {
		const conv = await serialize(msgs);
		const words = narrativeWords(budgetTokens, !!previous);
		const prev = previous
			? `<previous-narrative${previous.at ? ` written="${previous.at}"` : ""}>\n${previous.text}\n</previous-narrative>\n\n`
			: "";
		const merge = previous
			? `The <previous-narrative> block is the narrative of the ${previous.foreign ? "earlier summary (written by another summariser)" : "previous summary"}: it covers everything before this conversation. ` +
				`Write ONE updated narrative for the whole session, merging it with what the conversation adds: where the conversation gives a newer value ` +
				`(a version, id, pid, count, status, plan, path), keep only the newer one; drop todos that are done or obsolete; keep the durable facts of the ` +
				`previous narrative (paths, identifiers, rulings, results the work still depends on) unless the conversation superseded them. ` +
				`Write the current state only; do not mention the previous narrative or list what changed.\n`
			: "";
		const prompt =
			prev +
			`<conversation>\n${conv}\n</conversation>\n\n` +
			`Write the NARRATIVE part of a context summary for this conversation. A separate deterministic section already lists the user's ` +
			`requests, files touched, commands with exit codes and errors, so do NOT repeat those. When you refer to a specific tool output, name it by its ` +
			`tool and exact command or path so that look-alike runs stay distinguishable; never merge similar runs into one. Output only these markdown sections:\n` +
			`## Decisions and rationale\n## Current state of the work\n## Open todos / next steps\n## Key facts to remember (exact values, paths, identifiers, results the work still depends on)\n` +
			merge +
			`Be concrete and keep exact paths, names and numbers. Stay under about ${words} words` +
			(previous ? ` (a hard limit: the previous narrative and the conversation together say more, so compress: keep what the work still depends on, drop how it got there and whatever is finished)` : "") +
			`. Do not call tools.`;
		const signals: AbortSignal[] = [AbortSignal.timeout(240_000)];
		// a background summary has its own signal (nothing is running, so the run's signal would be stale); a summary the user waits for follows the run's (Esc)
		const outer = ownSignal ?? ctx.signal;
		if (outer) signals.push(outer);
		const signal = AbortSignal.any(signals);
		const key = `${model.provider ?? ""}/${model.id ?? ""}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const low = lowEffort.has(key);
			try {
				signal.throwIfAborted();
				const res: Any = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: NARRATIVE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
					{ maxTokens: cap, signal, cacheRetention: "none", sessionId: randomUUID(), ...(low ? { reasoningEffort: "low" } : {}) },
				);
				costUsd += Number(res.usage?.cost?.total) || 0;
				if (res.usage) {
					const { cost, ...tokens } = res.usage;
					usage ??= { cost: {} };
					for (const [k, v] of Object.entries(tokens)) usage[k] = (Number(usage[k]) || 0) + (Number(v) || 0);
					for (const [k, v] of Object.entries(cost ?? {})) usage.cost[k] = (Number(usage.cost[k]) || 0) + (Number(v) || 0);
				}
				if (res.stopReason === "aborted" || signal.aborted) return { text: null, ok: false, ms: Date.now() - t0, costUsd, usage, error: "narrative aborted" };
				if (res.stopReason === "error") throw new Error(res.errorMessage || "provider error");
				if (res.stopReason === "length") throw new Error(CAP_ERR);
				if ((res.content ?? []).some((c: Any) => c.type === "toolCall")) throw new Error("summariser attempted a tool call");
				const text = textOf(res.content).trim();
				if (!text) throw new Error("empty narrative");
				return { text, ok: true, ms: Date.now() - t0, costUsd, usage };
			} catch (err) {
				lastErr = err instanceof Error ? err.message : String(err);
				if (!low && model.reasoning && EFFORT_REFUSED_RE.test(lastErr) && !signal.aborted) {
					lowEffort.add(key); // the request itself was refused: ask again with the lowest common effort, without using up the retry
					attempt--;
					continue;
				}
				if (POLICY_BLOCK_RE.test(lastErr) || lastErr === CAP_ERR || signal.aborted) break; // an identical retry fails the same way
			}
		}
	} catch (err) {
		lastErr = err instanceof Error ? err.message : String(err);
	}
	return { text: null, ok: false, ms: Date.now() - t0, costUsd, usage, error: lastErr };
}

/** The cold summary (skeleton + narrative + handle table) for a planned cut. */
export async function buildCut(p: PlanResult, ctx: Any, signal?: AbortSignal): Promise<Cut> {
	const { foldMin, keepLines } = settings();
	const t0 = performance.now();
	const prefix = p.blocks.slice(0, p.cutIdx!);
	const prev = prefix[0]?.kind === "summary" ? String(prefix[0].msg.summary ?? "") || null : null;
	const shared = strippableCdDirs(bashCommands(prefix.filter((b) => b.kind !== "summary")), parseSummary(prev).cmdDirs);
	const texts: string[] = [];
	const keyLists: string[][] = [];
	const rows: HandleRow[] = prefix
		.filter((b) => b.kind === "toolResult" && b.entryId && (b.ours || b.tokens > foldMin))
		.map((b) => {
			const call = p.calls.get(b.msg.toolCallId);
			const out = textOf((b.raw ?? b.msg).content);
			const keys = keyTexts(out, keepLines);
			const tool = call?.name ?? b.msg.toolName ?? "tool";
			const hint = keys[0] ?? "";
			texts.push(out);
			keyLists.push(keys);
			return { handle: handleFor(b.entryId!), tool, args: call ? shortArgs(call.args, undefined, shared) : "", turn: b.userTurn, at: blockTime(b), outcome: outcomeHint(out, tool, !!b.msg.isError), hint };
		});
	// rows of one tool that would show the same key line (the first line of every status report, say): each shows the first of its
	// lines that none of the others has, nor a row of that tool the previous summary's table already shows
	const prevHints = new Map<string, string[]>();
	for (const l of parseSummary(prev).table.items) {
		const m = TABLE_ROW.exec(l);
		if (m) prevHints.set(m[2], [...(prevHints.get(m[2]) ?? []), (m[5] ?? "").split(" · ").pop() ?? ""]);
	}
	const same = new Map<string, number[]>();
	rows.forEach((r, i) => same.set(`${r.tool}\u0000${clip(r.hint, 90)}`, [...(same.get(`${r.tool}\u0000${clip(r.hint, 90)}`) ?? []), i]));
	for (const ix of same.values()) {
		const { tool, hint } = rows[ix[0]];
		const taken = prevHints.get(tool) ?? [];
		if (ix.length < 2 && !taken.includes(clip(hint, 90))) continue;
		const hs = distinctLines(ix.map((i) => texts[i]), ix.map((i) => keyLists[i]), taken, 90);
		ix.forEach((i, k) => hs[k] && (rows[i].hint = hs[k]!));
	}
	const file = p.fileRecall; // zip_recall hidden by an allowlist: the summary names the recall files instead
	const table = handleTable(rows, prev, file);
	const branch: Any[] | undefined = ctx.sessionManager?.getBranch?.();
	const previousBoundary = branch?.find((e) => e?.id === prefix[0]?.entryId)?.firstKeptEntryId;
	const originals = prev && previousBoundary ? userTextBefore(branch, previousBoundary, parseSummary(prev).users) : null;
	const sk = skeleton(prefix.filter((b) => b.kind !== "summary"), prev, table ?? "", file, originals ?? undefined);
	const nb = clamp(p.summaryTokensPlanned - tok4(sk.text), 300, NARRATIVE_MAX);
	const prevAt = prefix[0]?.kind === "summary" ? Number(prefix[0].msg.timestamp) || 0 : 0;
	const prevNarr = previousNarrative(prev, prevAt, narrativeWords(nb, true) * PREV_CHARS_PER_WORD);
	const nar = await narrative(prefix, ctx, nb, signal, prevNarr);
	const userAt = sk.text.lastIndexOf("\n" + USERS_HEAD_JSON);
	const usersAtEnd = sk.text.slice(userAt);
	let text = sk.text.slice(0, userAt);
	const how = file ? `read an output's file by its handle (${file.dir}/<handle>.txt)` : `${RECALL_TOOL} an output by its handle`;
	// a narrative over its budget keeps its head and its tail (the key facts come last), not just its head
	if (nar.ok && nar.text) text += `\n## Narrative (model-written)\n${excerpt(nar.text, nb * 6, Math.floor((nb * 6) / 3))}`;
	// no new narrative: the previous one is carried whole (up to the narrative's own budget), marked as possibly stale, with its time
	else if (prevNarr) text += `\n${narrCarriedHead(prevNarr.at, clip(nar.error ?? "n/a", 120))}\n${excerpt(prevNarr.text, nb * 6, Math.floor((nb * 6) / 4))}`;
	else text += `\n## Narrative\n(unavailable: ${nar.error ?? "n/a"}; rely on the sections above and ${how} rather than re-running or re-reading)`;
	if (table) text += "\n" + table;
	text += usersAtEnd;
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
