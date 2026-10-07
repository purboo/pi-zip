// Retrievability classification (F5): can the model get this output back by simply re-running the call?
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Any } from "./util.ts";

export type Recover = "rereadable" | "nonrereadable";

const READ_ONLY_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "file", "stat", "du", "pwd", "echo"]);
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame", "shortlog"]);

/** Read-only bash whitelist: every pipe/;/&& segment must be a whitelisted command (env prefixes and 2>/dev/null tolerated). */
export function isReadOnlyBash(cmd: string): boolean {
	const c = String(cmd ?? "").replace(/2>(\/dev\/null|&1)/g, " ").trim();
	if (!c || /[<>]/.test(c)) return false; // any remaining redirection can write
	const segments = c.split(/[|;\n]|&&/).map((s) => s.trim()).filter(Boolean);
	if (!segments.length) return false;
	for (const seg of segments) {
		let toks = seg.split(/\s+/).filter(Boolean);
		while (toks.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
		const head = (toks[0] ?? "").toLowerCase();
		if (READ_ONLY_CMDS.has(head)) continue;
		if (head === "git" && READ_ONLY_GIT.has((toks[1] ?? "").toLowerCase())) continue;
		return false;
	}
	return true;
}

/**
 * read: rereadable iff the file still exists and its bytes equal what the tool returned (unchanged since).
 * bash: rereadable iff read-only. grep/find/ls/glob: re-runnable queries. Everything else: not rereadable.
 */
export function classifyRecoverability(tool: string, args: Any, rawText: string, cwd: string): Recover {
	tool = String(tool ?? "").toLowerCase();
	const a: Any = args ?? {};
	if (tool === "read") {
		const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
		if (!p) return "nonrereadable";
		try {
			const full = isAbsolute(p) ? p : join(cwd, p);
			const st = statSync(full);
			if (!st.isFile()) return "nonrereadable";
			if (st.size > 2_000_000) return "rereadable"; // too big to hash cheaply; existence is the test
			const onDisk = readFileSync(full);
			const out = rawText.replace(/\n*\[Showing lines [^\]]*\]\s*$/, ""); // strip the continuation notice before comparing
			const h = (t: string) => createHash("sha1").update(t.trimEnd()).digest("hex"); // trailing whitespace may differ around the notice
			return h(onDisk.toString("utf8")) === h(out) ? "rereadable" : "nonrereadable";
		} catch {
			return "nonrereadable";
		}
	}
	if (tool === "bash") return typeof a.command === "string" && isReadOnlyBash(a.command) ? "rereadable" : "nonrereadable";
	if (tool === "grep" || tool === "find" || tool === "ls" || tool === "glob") return "rereadable";
	return "nonrereadable";
}
