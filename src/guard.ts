// Guard (F13, I5): validate an edit set before committing it, and repair orphan tool results in the outgoing payload.
import { RELAX_PREV_TURN, settings, type Block } from "./plan.ts";
import type { Any } from "./util.ts";

const PROTECT_USER_TURNS = 2;

export interface EditSet {
	folds: Map<number, string>; // block idx -> placeholder text
	cut: number | null; // summarise blocks[0..cut-1]; blocks[cut] becomes firstKeptEntryId
	recover?: Map<number, string | undefined>; // block idx -> "rereadable" | "nonrereadable" (needed for folds in the previous user turn)
	relax?: boolean; // default RELAX_PREV_TURN
	inturnAge?: number; // default settings().inturnAge: an output (any class) at least this many assistant requests old may fold in a protected turn (0 = never)
}

/**
 * Tool-call pairing problems of a block list, the way the provider layer sees it (pi-ai transform-messages): errored or
 * aborted assistant messages are dropped, so their calls never count; a toolResult must follow a call of the nearest
 * assistant message; calls without results are synthesised by the provider but still reported (the caller decides).
 */
function pairingIssues(blocks: Block[], from: number): Set<string> {
	const issues = new Set<string>();
	let pending: Set<string> | null = null;
	const closePending = (at: number) => {
		if (pending) for (const id of pending) issues.add(`noResult:${id}@${at}`);
		pending = null;
	};
	for (let i = from; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.kind === "summary" && from > 0) continue; // replaced by our summary
		const m = b.msg;
		if (m.role === "toolResult") {
			if (!pending || !pending.has(m.toolCallId)) issues.add(`orphanResult:${m.toolCallId}@${b.entryId ?? i}`);
			else pending.delete(m.toolCallId);
			continue;
		}
		if (m.role === "system") continue; // transparent: the provider layer holds it back
		closePending(i);
		if (m.role === "assistant") {
			if (m.stopReason === "error" || m.stopReason === "aborted") continue; // dropped by the provider layer
			const ids = (m.content ?? []).filter((c: Any) => c?.type === "toolCall").map((c: Any) => c.id);
			if (ids.length) pending = new Set(ids);
		}
	}
	closePending(blocks.length);
	return issues;
}

/** null = legal. Otherwise the reason: bad targets, edits inside the protected user turns, or a tool_use/tool_result pairing the edits themselves would break. */
export function validateEdits(blocks: Block[], plan: EditSet, userTurns: number): string | null {
	const relax = plan.relax ?? RELAX_PREV_TURN;
	const inturnAge = plan.inturnAge ?? settings().inturnAge;
	const limit = blocks.findIndex((b) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1);
	for (const [i, text] of plan.folds) {
		const b = blocks[i];
		if (!b || b.kind !== "toolResult") return `fold target ${i} is not a toolResult`;
		if (b.edited) return `fold target ${i} already edited`;
		const rereadable = plan.recover?.get(i) === "rereadable";
		const aged = inturnAge > 0 && b.age >= inturnAge; // old enough: allowed anywhere, any class (same rule as the planner)
		if (b.userTurn >= userTurns && !aged) return `fold target ${i} is inside the latest user turn`;
		if (b.userTurn === userTurns - 1 && !aged && (!relax || !rereadable)) return `fold target ${i} is in the previous user turn and not re-readable`;
		if (!b.entryId) return `fold target ${i} has no entry id`;
		if (typeof text !== "string" || !text.trim()) return `empty placeholder for ${i}`;
	}
	if (plan.cut !== null) {
		if (plan.cut < 1 || plan.cut >= blocks.length) return `bad cut ${plan.cut}`;
		if (limit >= 0 && plan.cut > limit) return `cut ${plan.cut} inside the last ${PROTECT_USER_TURNS} user turns`;
		const kb = blocks[plan.cut];
		if (!kb.entryId || (kb.kind !== "user" && kb.kind !== "assistant")) return `cut ${plan.cut} is not at a user/assistant message`;
		// only what the cut itself would create is our problem; a session that was already odd stays as odd as it was
		const before = pairingIssues(blocks, 0);
		for (const issue of pairingIssues(blocks, plan.cut)) if (!before.has(issue) && issue.startsWith("orphanResult")) return `the cut would orphan a tool result: ${issue}`;
		for (const issue of pairingIssues(blocks, plan.cut)) if (!before.has(issue)) return `the cut would break tool-call pairing: ${issue}`;
	}
	const kept = plan.cut ?? 0;
	return blocks.slice(kept).some((b) => b.kind !== "summary") ? null : "empty context after edits";
}

const toText = (c: Any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Any) => (typeof x === "string" ? x : (x?.text ?? ""))).join("\n") : c === undefined || c === null ? "" : JSON.stringify(c));
const FOLDED = "[tool result, call folded]\n";
const hasType = (b: Any, t: string) => b?.type === t;

/** Index of the nearest earlier message that is not one of `skip` roles. */
function prevIndex(list: Any[], i: number, skip: (m: Any) => boolean): number {
	let j = i - 1;
	while (j >= 0 && skip(list[j])) j--;
	return j;
}

/** Anthropic messages: tool_result blocks inside a user message must answer tool_use blocks of the assistant message right before it. */
function repairAnthropic(list: Any[], edit: () => Any): number {
	let repaired = 0;
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (m?.role !== "user" || !Array.isArray(m.content) || !m.content.some((b: Any) => hasType(b, "tool_result"))) continue;
		const prev = list[prevIndex(list, i, (x) => x?.role === "system")];
		const ids = new Set((prev?.role === "assistant" && Array.isArray(prev.content) ? prev.content : []).filter((b: Any) => hasType(b, "tool_use")).map((b: Any) => b.id));
		const content = m.content.map((b: Any) => {
			if (!hasType(b, "tool_result") || ids.has(b.tool_use_id)) return b;
			repaired++;
			return { type: "text", text: FOLDED + toText(b.content) };
		});
		if (content.some((b: Any, k: number) => b !== m.content[k])) edit().messages[i].content = content;
	}
	return repaired;
}

/** Bedrock Converse: { toolResult: { toolUseId } } blocks answer { toolUse: { toolUseId } } blocks of the assistant message before. */
function repairBedrock(list: Any[], edit: () => Any): number {
	let repaired = 0;
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (m?.role !== "user" || !Array.isArray(m.content) || !m.content.some((b: Any) => b?.toolResult)) continue;
		const prev = list[i - 1];
		const ids = new Set((prev?.role === "assistant" && Array.isArray(prev.content) ? prev.content : []).filter((b: Any) => b?.toolUse).map((b: Any) => b.toolUse.toolUseId));
		const content = m.content.map((b: Any) => {
			if (!b?.toolResult || ids.has(b.toolResult.toolUseId)) return b;
			repaired++;
			return { text: FOLDED + toText(b.toolResult.content) };
		});
		if (content.some((b: Any, k: number) => b !== m.content[k])) edit().messages[i].content = content;
	}
	return repaired;
}

/** OpenAI chat completions and Mistral: a `tool` message must follow the assistant message whose tool_calls it answers. */
function repairChat(list: Any[], edit: () => Any): number {
	let repaired = 0;
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		if (m?.role !== "tool" || m.tool_call_id === undefined) continue;
		const prev = list[prevIndex(list, i, (x) => x?.role === "tool")];
		if (!(prev?.role === "assistant" && (prev.tool_calls ?? []).some((c: Any) => c.id === m.tool_call_id))) {
			repaired++;
			edit().messages[i] = { role: "user", content: FOLDED + toText(m.content) };
		}
	}
	return repaired;
}

/** OpenAI Responses (also Azure and Codex): a function_call_output needs a function_call with the same call_id earlier in the input. */
function repairResponses(list: Any[], edit: () => Any): number {
	let repaired = 0;
	const calls = new Set<string>();
	for (let i = 0; i < list.length; i++) {
		const it = list[i];
		if (it?.type === "function_call" || it?.type === "custom_tool_call") calls.add(it.call_id);
		else if ((it?.type === "function_call_output" || it?.type === "custom_tool_call_output") && !calls.has(it.call_id)) {
			repaired++;
			edit().input[i] = { role: "user", content: [{ type: "input_text", text: FOLDED + toText(it.output) }] };
		}
	}
	return repaired;
}

/** Gemini / Vertex: a functionResponse part answers a functionCall part of the model turn right before (by id when present, else by name). */
function repairGoogle(list: Any[], edit: () => Any, path: (q: Any) => Any[]): number {
	let repaired = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c?.role !== "user" || !Array.isArray(c.parts) || !c.parts.some((x: Any) => x?.functionResponse)) continue;
		const prev = list[i - 1];
		const open: Any[] = prev?.role === "model" && Array.isArray(prev.parts) ? prev.parts.filter((x: Any) => x?.functionCall).map((x: Any) => x.functionCall) : [];
		const parts = c.parts.map((x: Any) => {
			const r = x?.functionResponse;
			if (!r) return x;
			const k = open.findIndex((f) => (r.id !== undefined && f.id !== undefined ? f.id === r.id : f.name === r.name));
			if (k >= 0) { open.splice(k, 1); return x; }
			repaired++;
			const out = r.response?.output ?? r.response?.error ?? r.response;
			return { text: FOLDED + toText(out) };
		});
		if (parts.some((x: Any, k: number) => x !== c.parts[k])) path(edit())[i].parts = parts;
	}
	return repaired;
}

/**
 * Turn tool results that no longer follow their tool call into plain text, in the request shapes Pi's providers produce:
 * Anthropic messages, OpenAI chat completions (and Mistral), OpenAI Responses (Azure, Codex), Google Gemini/Vertex and
 * Bedrock Converse. Any other shape is left alone. Returns the repaired payload, or null if nothing was wrong.
 */
export function repairPayload(p: Any): { payload: Any; repaired: number } | null {
	if (!p || typeof p !== "object") return null;
	let q: Any = null;
	const edit = () => (q ??= structuredClone(p));
	let repaired = 0;
	if (Array.isArray(p.messages)) repaired += repairAnthropic(p.messages, edit) + repairBedrock(p.messages, edit) + repairChat(p.messages, edit);
	if (Array.isArray(p.input)) repaired += repairResponses(p.input, edit);
	if (Array.isArray(p.contents)) repaired += repairGoogle(p.contents, edit, (x) => x.contents);
	else if (Array.isArray(p.request?.contents)) repaired += repairGoogle(p.request.contents, edit, (x) => x.request.contents);
	return repaired ? { payload: q, repaired } : null;
}
