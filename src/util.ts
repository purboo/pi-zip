// Small shared helpers (no Pi imports, so every pure module stays testable without Pi installed).
export type Any = any;

export const PRODUCT = "pi-zip";

export const textOf = (c: Any): string =>
	typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: Any) => b?.type === "text").map((b: Any) => b.text ?? "").join("\n") : "";

export const tok4 = (s: string) => Math.ceil(s.length / 4);
export const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

export function clip(s: string, n: number): string {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
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

/** chars/4 estimate, same rules as Pi's estimateTokens (kept local so plan.ts has no runtime Pi dependency). */
export function tokensOf(m: Any): number {
	let chars = 0;
	switch (m?.role) {
		case "assistant":
			for (const b of m.content ?? []) {
				if (b?.type === "text") chars += b.text?.length ?? 0;
				else if (b?.type === "thinking") chars += b.thinking?.length ?? 0;
				else if (b?.type === "toolCall") chars += (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length;
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
			chars = contentChars(m?.content);
	}
	return Math.ceil(chars / 4);
}
