// Summary (F11, F12): deterministic skeleton (user words verbatim + files/commands) + model-written narrative + handle table.
// Thinking is never quoted or paraphrased: it is stripped before the model sees the prefix.
import { randomUUID } from "node:crypto";
import { handleFor, pickKeyLines, shortArgs } from "./placeholder.ts";
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
}

/** Compact table appended to every summary so handles survive it. */
export function handleTable(rows: HandleRow[]): string | null {
	if (!rows.length) return null;
	const lines = rows.slice(-40).map((r) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""} · ${clip(r.hint, 90)}`);
	return "## Folded outputs (originals recallable with zip_recall; handles stay valid after later summaries or compaction)\n" + lines.join("\n");
}

export function skeleton(prefix: Block[], previous: string | null): { text: string; users: number } {
	const calls = toolCallIndex(prefix);
	const results = new Map<string, Block>();
	for (const b of prefix) if (b.kind === "toolResult") results.set(b.msg.toolCallId, b);
	const users: string[] = [];
	const files = new Map<string, Set<string>>();
	const cmds: string[] = [];
	const errors: string[] = [];
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
				cmds.push(`\`${clip(String(a.command ?? ""), 160)}\` -> ${status}`);
			} else if (typeof a.path === "string" || typeof a.file_path === "string") {
				const p = String(a.path ?? a.file_path);
				if (!files.has(p)) files.set(p, new Set());
				files.get(p)!.add(c.name);
			}
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
	const fileLines = [...files.entries()].slice(-60).map(([p, ops]) => `- ${p} (${[...ops].join(", ")})`);
	const out: string[] = [SUMMARY_MARK];
	out.push(`Covers ${prefix.length} earlier messages. Tool outputs in the kept part of the conversation may have been folded; call zip_recall with a handle to get one back exactly.`);
	if (previous) {
		out.push("## Earlier summary (carried forward)");
		out.push(previous.split("\n").filter((l) => l.trim() !== SUMMARY_MARK && !l.startsWith("Covers ")).join("\n").trim().slice(0, 12000));
	}
	out.push("## User requests (verbatim, oldest first)", userLines.length ? userLines.join("\n") : "(none)");
	out.push("## Files touched", fileLines.length ? fileLines.join("\n") : "(none)");
	out.push("## Commands run (with exit status)", cmds.length ? cmds.slice(-60).join("\n") : "(none)");
	out.push("## Errors", errors.length ? errors.slice(-15).map((e) => "- " + e).join("\n") : "(none)");
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
			`requests, files touched, commands with exit codes and errors, so do NOT repeat those. Output only these markdown sections:\n` +
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
			return { handle: handleFor(b.entryId!), tool: call?.name ?? b.msg.toolName ?? "tool", args: call ? shortArgs(call.args) : "", hint: (keys.find((k) => k.why === "error" || k.why === "id") ?? keys[0])?.text ?? "" };
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
