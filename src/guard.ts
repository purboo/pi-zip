// Guard (F13, I5): validate an edit set before committing it, and repair orphan tool results in the outgoing payload.
import { RELAX_PREV_TURN, type Block } from "./plan.ts";
import type { Any } from "./util.ts";

const PROTECT_USER_TURNS = 2;

export interface EditSet {
	folds: Map<number, string>; // block idx -> placeholder text
	cut: number | null; // summarise blocks[0..cut-1]; blocks[cut] becomes firstKeptEntryId
	recover?: Map<number, string | undefined>; // block idx -> "rereadable" | "nonrereadable" (needed for folds in the previous user turn)
	relax?: boolean; // default RELAX_PREV_TURN
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
	const limit = blocks.findIndex((b) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1);
	for (const [i, text] of plan.folds) {
		const b = blocks[i];
		if (!b || b.kind !== "toolResult") return `fold target ${i} is not a toolResult`;
		if (b.edited) return `fold target ${i} already edited`;
		if (b.userTurn >= userTurns) return `fold target ${i} is inside the latest user turn`;
		if (b.userTurn === userTurns - 1 && (!relax || plan.recover?.get(i) !== "rereadable")) return `fold target ${i} is in the previous user turn and not re-readable`;
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

const toText = (c: Any) => (typeof c === "string" ? c : (c ?? []).map((x: Any) => x.text ?? "").join("\n"));

/** Turn tool results that no longer follow their tool call (Anthropic and OpenAI shapes) into plain text. Returns the repaired payload, or null if nothing was wrong. */
export function repairPayload(p: Any): { payload: Any; repaired: number } | null {
	if (!p || !Array.isArray(p.messages)) return null;
	let repaired = 0;
	let q: Any = null;
	const edit = () => (q ??= structuredClone(p));
	for (let i = 0; i < p.messages.length; i++) {
		const m = p.messages[i];
		if (m.role === "user" && Array.isArray(m.content) && m.content.some((b: Any) => b?.type === "tool_result")) {
			let j = i - 1;
			while (j >= 0 && p.messages[j].role === "system") j--;
			const prev = p.messages[j];
			const ids = new Set((prev?.role === "assistant" && Array.isArray(prev.content) ? prev.content : []).filter((b: Any) => b?.type === "tool_use").map((b: Any) => b.id));
			const content = m.content.map((b: Any) => {
				if (b?.type !== "tool_result" || ids.has(b.tool_use_id)) return b;
				repaired++;
				return { type: "text", text: `[tool result, call folded]\n${toText(b.content)}` };
			});
			if (content.some((b: Any, k: number) => b !== m.content[k])) edit().messages[i].content = content;
		} else if (m.role === "tool" && m.tool_call_id !== undefined) {
			let j = i - 1;
			while (j >= 0 && p.messages[j].role === "tool") j--;
			const prev = p.messages[j];
			if (!(prev?.role === "assistant" && (prev.tool_calls ?? []).some((c: Any) => c.id === m.tool_call_id))) {
				repaired++;
				edit().messages[i] = { role: "user", content: `[tool result, call folded]\n${toText(m.content)}` };
			}
		}
	}
	return repaired ? { payload: q, repaired } : null;
}
