// Cache temperature (F7): "cold" is a fact about real time, never a guess.
import { type Any, envInt } from "./util.ts";

export const DEFAULT_TTL_MS = 300_000;

/** pi-ai ModelPromptCache values are SECONDS. An explicit PI_ZIP_TTL_SECS (tests) wins; else the model's declared lifetime; else 300 s. */
export function cacheTtlMs(pc: { short?: number; long?: number } | undefined, fallbackMs: number = DEFAULT_TTL_MS): number {
	const secs = pc?.short ?? pc?.long;
	return typeof secs === "number" && secs > 0 ? secs * 1000 : fallbackMs;
}

export const ttlFor = (model: Any): number => (process.env.PI_ZIP_TTL_SECS ? envInt("TTL_SECS", 300) * 1000 : cacheTtlMs(model?.promptCache));

/** Cold = a prior request exists and nothing touched the cache for longer than the TTL. No prior request counts as warm. */
export const isColdByTtl = (lastActivityMs: number, nowMs: number, ttlMs: number): boolean => lastActivityMs > 0 && nowMs - lastActivityMs > ttlMs;

/** End time of the newest message in the branch (fresh process: err on the warm side). */
export function lastMessageMs(branch: Any[]): number {
	let last = 0;
	for (const en of branch) {
		if (en?.type !== "message" || !en.message) continue;
		const t = typeof en.message.timestamp === "number" ? en.message.timestamp : Date.parse(en.timestamp ?? "");
		if (Number.isFinite(t)) last = Math.max(last, t);
	}
	return last;
}

export function detectCold(model: Any, lastReqMs: number, branch: Any[], nowMs = Date.now()): { cold: boolean; reason: string } {
	const ttl = ttlFor(model);
	const last = lastReqMs || lastMessageMs(branch);
	const cold = isColdByTtl(last, nowMs, ttl);
	const reason = last ? `ttl gap ${Math.round((nowMs - last) / 1000)}s ${cold ? ">" : "<="} ${Math.round(ttl / 1000)}s` : "no prior request";
	return { cold, reason };
}
