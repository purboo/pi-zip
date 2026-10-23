// Small shared helpers (no Pi imports, so every pure module stays testable without Pi installed).
export type Any = any;

export const PRODUCT = "pi-zip";

/** Custom session entry pi-zip appends after the edits (context_edit / compaction) it persists at a turn_end: `{ carried }` says whether
 *  the request(s) of the run had already sent them (a run plan: persisted after the response that first carried it) or whether the next
 *  request is the first to carry them (a warm-valve plan). The edits alone do not say which, and the planner's state (growth, "the
 *  newest response carried an edit", the size scale) is read from the branch, so a restart plans like a process that never left.
 *  Custom entries never reach the model. */
export const COMMIT_CUSTOM = "pi-zip/commit";

export const textOf = (c: Any): string =>
	typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: Any) => b?.type === "text").map((b: Any) => b.text ?? "").join("\n") : "";

export const tok4 = (s: string) => Math.ceil(s.length / 4);
export const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
/** f(), or `fallback` when it throws (a host API that may be missing or fail). */
export const attempt = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

export function clip(s: string, n: number): string {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** UTC time of a persisted timestamp (ms) as MM-DD HH:MM UTC. Placeholders and summaries must keep the same bytes
 *  across process time zones and locales; a turn count restarts at every compaction. */
export function fmtWhen(ms: number): string {
	const d = new Date(ms);
	const p2 = (n: number) => String(n).padStart(2, "0");
	return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

/** Test-only numeric override: PI_ZIP_<NAME>. */
export function envInt(name: string, fallback: number): number {
	const raw = process.env[`PI_ZIP_${name}`];
	const v = Number(raw);
	return raw !== undefined && raw !== "" && Number.isFinite(v) ? v : fallback;
}

const IMAGE_CHARS = 4800;
const contentChars = (c: Any): number =>
	typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((a: number, b: Any) => a + (b?.type === "text" ? (b.text?.length ?? 0) : b?.type === "image" ? IMAGE_CHARS : 0), 0) : 0;

/** Pi's own estimateTokens (core/compaction/compaction.js), rule for rule: no tool framing, system messages counted. Used only to predict
 *  what Pi's compaction will decide (plan.ts piCanCompact); every pi-zip size uses tokensOf. */
export function piTokensOf(m: Any): number {
	let chars = 0;
	switch (m?.role) {
		case "system":
			chars = contentChars(m.content);
			for (const s of Object.values(m.sections ?? {})) if (typeof s === "string" && s) chars += s.length;
			if (m.toolsAdded) chars += JSON.stringify(m.toolsAdded).length;
			break;
		case "user":
		case "custom":
		case "toolResult":
			chars = contentChars(m.content);
			break;
		case "assistant":
			for (const b of m.content ?? []) {
				if (b?.type === "text") chars += b.text?.length ?? 0;
				else if (b?.type === "thinking") chars += b.thinking?.length ?? 0;
				else if (b?.type === "toolCall") chars += (b.name?.length ?? 0) + (JSON.stringify(b.arguments ?? {}) ?? "").length;
			}
			break;
		case "bashExecution":
			chars = (m.command?.length ?? 0) + (m.output?.length ?? 0);
			break;
		case "branchSummary":
		case "compactionSummary":
			chars = m.summary?.length ?? 0;
			break;
		default:
			return 0;
	}
	return Math.ceil(chars / 4);
}

/** What every tool call puts on the wire that Pi's chars/4 rule does not see, in chars: the call id (in the call and again in its
 *  result) and this much framing per block (the provider's tool-use / tool-result markup). It does not shrink when the output is
 *  folded, so without it the size after a deep fold came out low: Tier1 fold plans that removed over half the content, median
 *  -9.5% / -7.0% / -10.9% (Claude / GLM / GPT) -> -0.2% / -2.7% / -2.0% with 120 (research round5/affine.md section 8). */
export const TOOL_FRAME_CHARS = 120;

/** chars/4 estimate of a message's CONTENT as the wire carries it: Pi's estimateTokens rules (kept local so plan.ts has no runtime
 *  Pi dependency) plus each tool block's id and framing (TOOL_FRAME_CHARS). A system message counts 0: the system prompt and the tools
 *  are the fixed prefix O of plan.ts, never content. */
export function tokensOf(m: Any): number {
	let chars = 0;
	switch (m?.role) {
		case "system":
			return 0;
		case "assistant":
			for (const b of m.content ?? []) {
				if (b?.type === "text") chars += b.text?.length ?? 0;
				else if (b?.type === "thinking") chars += b.thinking?.length ?? 0;
				else if (b?.type === "toolCall") chars += (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length + String(b.id ?? "").length + TOOL_FRAME_CHARS;
			}
			break;
		case "toolResult":
			chars = contentChars(m.content) + String(m.toolCallId ?? "").length + TOOL_FRAME_CHARS;
			break;
		case "bashExecution":
			chars = (m.command?.length ?? 0) + (m.output?.length ?? 0);
			break;
		case "branchSummary":
		case "compactionSummary":
			chars = m.summary?.length ?? 0;
			break;
		default:
			chars = contentChars(m?.content);
	}
	return Math.ceil(chars / 4);
}
