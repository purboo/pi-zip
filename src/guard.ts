// Guard (F13, I5): validate an edit set before committing it, and repair orphan tool results in the outgoing payload.
import type { Block } from "./plan.ts";
import type { Any } from "./util.ts";

const PROTECT_USER_TURNS = 2;

export interface EditSet {
	folds: Map<number, string>; // block idx -> placeholder text
	cut: number | null; // summarise blocks[0..cut-1]; blocks[cut] becomes firstKeptEntryId
}

/** null = legal. Otherwise the reason: bad targets, edits inside the last 2 user turns, or a broken tool_use/tool_result pairing. */
export function validateEdits(blocks: Block[], plan: EditSet, userTurns: number): string | null {
	const limit = blocks.findIndex((b) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1);
	for (const [i, text] of plan.folds) {
		const b = blocks[i];
		if (!b || b.kind !== "toolResult") return `fold target ${i} is not a toolResult`;
		if (b.edited) return `fold target ${i} already edited`;
		if (b.userTurn >= userTurns) return `fold target ${i} is inside the latest user turn`; // the previous turn may be folded (relax); the current one never
		if (!b.entryId) return `fold target ${i} has no entry id`;
		if (typeof text !== "string" || !text.trim()) return `empty placeholder for ${i}`;
	}
	if (plan.cut !== null) {
		if (plan.cut < 1 || plan.cut >= blocks.length) return `bad cut ${plan.cut}`;
		if (limit >= 0 && plan.cut > limit) return `cut ${plan.cut} inside the last ${PROTECT_USER_TURNS} user turns`;
		const kb = blocks[plan.cut];
		if (!kb.entryId || (kb.kind !== "user" && kb.kind !== "assistant")) return `cut ${plan.cut} is not at a user/assistant message`;
	}
	let pending: Set<string> | null = null;
	let n = 0;
	for (let i = plan.cut ?? 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.kind === "summary" && plan.cut !== null) continue; // replaced by our summary
		n++;
		const role = b.msg.role;
		if (role === "toolResult") {
			const id = b.msg.toolCallId;
			if (!pending || !pending.has(id)) return `orphan toolResult ${id} at block ${i}`;
			pending.delete(id);
			continue;
		}
		if (pending && pending.size) return `assistant tool calls without results before block ${i}: ${[...pending].join(",")}`;
		pending = null;
		if (role === "assistant") {
			const ids = (b.msg.content ?? []).filter((c: Any) => c?.type === "toolCall").map((c: Any) => c.id);
			if (ids.length) pending = new Set(ids);
		}
	}
	if (pending && pending.size) return `trailing tool calls without results: ${[...pending].join(",")}`;
	return n === 0 ? "empty context after edits" : null;
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
