// Test helpers: projected-entry builders (the shape Pi hands to handlers) and a tiny session projector (context_edit + compaction).
import { buildBlocks } from "../src/plan.ts";
export type Any = any;

export const U = (id: string, t: string) => ({ sourceEntry: { id, type: "message", message: { role: "user", content: t } }, messages: [{ role: "user", content: t }] });
export const A = (id: string, calls: string[] = [], think = false) => {
	const m = { role: "assistant", content: [...(think ? [{ type: "thinking", thinking: "hmm" }] : []), { type: "text", text: "x" }, ...calls.map((c) => ({ type: "toolCall", id: c, name: "bash", arguments: { command: "ls" } }))] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
export const R = (id: string, call: string, chars = 9000, text?: string) => {
	const m = { role: "toolResult", toolCallId: call, toolName: "bash", isError: false, content: [{ type: "text", text: text ?? "y".repeat(chars) }] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
/** Long assistant prose: bulk that folds cannot remove, so a summary becomes necessary. */
export const AX = (id: string, chars: number) => {
	const m = { role: "assistant", content: [{ type: "text", text: "z ".repeat(chars / 2) }] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};

/** What Pi projects for a branch: edits replace toolResult content, a compaction replaces everything before firstKeptEntryId. */
export function project(entries: Any[], edits: Any[]): Any[] {
	const byTarget = new Map<string, Any>();
	let comp: Any = null;
	for (const e of edits) {
		if (e.type === "context_edit") byTarget.set(e.targetId, e.replacement);
		if (e.type === "compaction") comp = e;
	}
	let list = entries;
	let head: Any[] = [];
	if (comp) {
		const k = entries.findIndex((x) => x.sourceEntry.id === comp.firstKeptEntryId);
		list = entries.slice(k);
		head = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: comp.summary, tokensBefore: 0, timestamp: 0 }] }];
	}
	const out = list.map((pe) => {
		const rep = byTarget.get(pe.sourceEntry.id);
		if (!rep) return pe;
		const m = { ...pe.messages[0], content: rep.content };
		return { sourceEntry: pe.sourceEntry, messages: [m] };
	});
	return [...head, ...out];
}
export const flat = (entries: Any[]) => entries.flatMap((x) => x.messages);

/** Fake Pi: records registrations and lets tests fire events. */
export function fakePi(extra: Any = {}) {
	const handlers = new Map<string, Any>();
	const calls: string[] = [];
	const appended: Any[] = [];
	const pi: Any = {
		on: (n: string, h: Any) => (calls.push(`on:${n}`), handlers.set(n, h)),
		registerTool: (t: Any) => (calls.push(`tool:${t.name}`), handlers.set(`tool:${t.name}`, t)),
		registerCommand: (n: string, c: Any) => (calls.push(`cmd:${n}`), handlers.set(`cmd:${n}`, c)),
		appendEntry: (t: string, d: Any) => appended.push({ type: "custom", customType: t, data: d }),
		getAllTools: () => [],
		getCommands: () => [],
		...extra,
	};
	return { pi, handlers, calls, appended };
}

export function fakeCtx(entries: Any[], over: Any = {}) {
	const notes: string[] = [];
	const ctx: Any = {
		mode: "tui", hasUI: true, cwd: process.cwd(), model: { provider: "p", id: "m", contextWindow: 1_000_000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300 } },
		ui: { notify: (t: string) => notes.push(t) },
		getSystemPrompt: () => "sys",
		sessionManager: { getBranch: () => over.branch ?? [], buildSessionProjection: () => ({ entries }) },
		...over,
	};
	return { ctx, notes };
}

/**
 * Stamp usage on the newest assistant message so the extension calibrates to `k` real tokens per estimated token: real = k x
 * (system prompt "sys" = 1 + the view before that message). Messages are shared with `messages`, so the entry is updated in place.
 */
export function withK(entries: Any[], k: number, over: Any = {}) {
	const blocks = buildBlocks(entries);
	let i = blocks.length - 1;
	while (i >= 0 && blocks[i].kind !== "assistant") i--;
	const est = 1 + blocks.slice(0, i).reduce((a, b) => a + b.tokens, 0);
	Object.assign(blocks[i].raw, { stopReason: "stop", usage: { input: Math.round(est * k), cacheRead: 0, cacheWrite: 0, output: 50 }, ...over });
	return entries;
}
