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

/** Compact table appended to every summary so handles survive it. */
export function handleTable(rows: HandleRow[]): string | null {
	if (!rows.length) return null;
	const omitted = Math.max(0, rows.length - 40);
	const lines = rows.slice(-40).map((r) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${r.turn ? ` · turn ${r.turn}` : ""}${r.outcome ? ` · ${r.outcome}` : ""} · ${clip(r.hint, 90)}`);
	if (omitted) lines.unshift(`[… ${omitted} older folded outputs omitted from this table …]`);
	return "## Folded outputs (originals recallable with zip_recall; handles stay valid after later summaries or compaction)\n" + lines.join("\n");
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

export function skeleton(prefix: Block[], previous: string | null): { text: string; users: number } {
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
			if (res?.msg.isError) errors.push(`${c.name} ${shortArgs(a)}: ${clip(resText, 200)}`);
		}
	}
	let userLines = users.map((u, i) => `${i + 1}. ${u}`);
	const budget = 16000;
	if (userLines.join("\n").length > budget) {
		const head = userLines.slice(0, 3);
		const tail: string[] = [];
		let used = head.join("\n").length;
		for (let i = userLines.length - 1; i >= 3 && used < budget; i--) {
			tail.unshift(userLines[i]);
			used += userLines[i].length;
		}
		userLines = [...head, `[… ${userLines.length - head.length - tail.length} requests omitted …]`, ...tail];
	}
	const fileLines = newest([...files.entries()].map(([p, ops]) => `- ${p} (${[...ops].map(([t, h]) => (h ? `${t}: ${h}` : t)).join(", ")})`), 60);
	const out: string[] = [SUMMARY_MARK];
	out.push(`Covers ${prefix.length} earlier messages. Tool outputs in the kept part of the conversation may have been folded; call zip_recall with a handle to get one back exactly.`);
	if (previous) {
		out.push("## Earlier summary (carried forward)");
		out.push(previous.split("\n").filter((l) => l.trim() !== SUMMARY_MARK && !l.startsWith("Covers ")).join("\n").trim().slice(0, 12000));
	}
	out.push("## User requests (verbatim, oldest first)", userLines.length ? userLines.join("\n") : "(none)");
	out.push("## Files touched", fileLines.length ? fileLines.join("\n") : "(none)");
	out.push("## Commands run (with exit status)", cmds.length ? newest(cmds, 60).join("\n") : "(none)");
	if (others.length) out.push("## Other tool calls (turn, handle)", newest(others, 60).join("\n"));
	out.push("## Errors", errors.length ? errors.slice(-15).map((e) => "- " + e).join("\n") : "(none)");
	const index = handleIndex(now, previous, out.join("\n"), INDEX_TOKENS);
	if (index) out.push(index);
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
	const sk = skeleton(prefix.filter((b) => b.kind !== "summary"), prev);
	const nb = clamp(p.summaryTokensPlanned - tok4(sk.text), 300, 4000);
	const nar = await narrative(prefix, ctx, nb, signal);
	let text = sk.text;
	text += nar.ok && nar.text ? `\n## Narrative (model-written)\n${nar.text.slice(0, nb * 6)}` : `\n## Narrative\n(unavailable: ${nar.error ?? "n/a"}; rely on the sections above and re-read files as needed)`;
	const table = handleTable(rows);
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
