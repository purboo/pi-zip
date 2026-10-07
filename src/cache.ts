// Cache temperature (F7): "cold" is a fact about real time, never a guess.
import { type Any, envInt } from "./util.ts";

export const DEFAULT_TTL_MS = 300_000;

export type CacheRetention = "none" | "short" | "long";

/**
 * Lifetime of the prompt cache entry a request writes, mirroring Pi's getPromptCacheTtlMs (core/cache-warmer.js): the tier is the
 * request's cacheRetention, else "long" when PI_CACHE_RETENTION=long, else "short"; the model's promptCache holds SECONDS for
 * that tier only. Pi sends no explicit cacheRetention, so in practice the environment decides. "none" = no cache at all = 0.
 * A model that declares no lifetime for the tier gets fallbackMs. An explicit PI_ZIP_TTL_SECS (tests) wins in ttlFor.
 */
export function cacheTtlMs(
	pc: { short?: number; long?: number } | undefined,
	fallbackMs: number = DEFAULT_TTL_MS,
	opts: { cacheRetention?: CacheRetention; env?: Record<string, string | undefined> } = {},
): number {
	const env = opts.env ?? process.env;
	const retention: CacheRetention = opts.cacheRetention ?? (env.PI_CACHE_RETENTION === "long" ? "long" : "short");
	if (retention === "none") return 0;
	const secs = pc?.[retention];
	return typeof secs === "number" && secs > 0 ? secs * 1000 : fallbackMs;
}

export const ttlFor = (model: Any): number => (process.env.PI_ZIP_TTL_SECS ? envInt("TTL_SECS", 300) * 1000 : cacheTtlMs(model?.promptCache));

/** Cold = a prior request exists and nothing touched the cache for longer than the TTL. No prior request counts as warm. */
export const isColdByTtl = (lastActivityMs: number, nowMs: number, ttlMs: number): boolean => lastActivityMs > 0 && nowMs - lastActivityMs > ttlMs;

export const modelKey = (m: Any): string => (m ? `${m.provider ?? ""}/${m.id ?? m.model ?? ""}` : "");

const tsOf = (en: Any, inner?: Any): number => {
	const t = typeof inner?.timestamp === "number" ? inner.timestamp : Date.parse(en?.timestamp ?? "");
	return Number.isFinite(t) ? t : 0;
};

/**
 * Last time anything touched the cache, according to the branch: the newest message, or the newest cache-warm usage entry
 * (Pi's own idle refresh persists `{ type: "usage", kind: "cache_warm" }`, and a refresh keeps the entry alive for another TTL).
 * Fresh process: err on the warm side (0 = unknown).
 */
export function lastMessageMs(branch: Any[]): number {
	let last = 0;
	for (const en of branch) {
		if (en?.type === "message" && en.message) last = Math.max(last, tsOf(en, en.message));
		else if (en?.type === "usage" && en.kind === "cache_warm") last = Math.max(last, tsOf(en));
	}
	return last;
}

/** Provider/model of the newest assistant message that really ran (errors and aborts may never have reached a cache). */
export function lastModelInBranch(branch: Any[]): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.provider) return `${m.provider}/${m.model ?? ""}`;
	}
	return "";
}

/** Cold by time, or because the model changed: a cache entry belongs to one provider and model. */
export function detectCold(model: Any, lastReqMs: number, branch: Any[], nowMs = Date.now(), lastModel = ""): { cold: boolean; reason: string } {
	const ttl = ttlFor(model);
	const last = Math.max(lastReqMs, lastMessageMs(branch));
	const prev = lastModel || lastModelInBranch(branch);
	if (last && prev && modelKey(model) && prev !== modelKey(model)) return { cold: true, reason: `model switch ${prev} -> ${modelKey(model)}` };
	const cold = isColdByTtl(last, nowMs, ttl);
	const reason = last ? `ttl gap ${Math.round((nowMs - last) / 1000)}s ${cold ? ">" : "<="} ${Math.round(ttl / 1000)}s` : "no prior request";
	return { cold, reason };
}
