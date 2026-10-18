// Retrievability classification (F5): can the model get this output back by simply re-running the call?
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Any } from "./util.ts";

export type Recover = "rereadable" | "nonrereadable";

const READ_ONLY_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "file", "stat", "du", "pwd", "echo"]);
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame", "shortlog"]);

// Options that make an otherwise read-only command write files or run other programs.
const FIND_UNSAFE = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const GIT_UNSAFE = /^--(output(=.*)?|ext-diff|textconv|open-files-in-pager.*|exec-path.*)$/;
const RG_UNSAFE = /^--(pre|pre-glob)(=.*)?$/;
const ARC_FLAGS: Record<string, Set<string>> = {
	status: new Set(["-s", "--short", "-b", "--branch", "--json", "--no-ahead-behind", "--no-sync-status", "--no-bisect-status"]),
	diff: new Set(["--cached", "--staged", "--stat", "--name-only", "--name-status", "--no-color", "--patience", "--no-patience", "-w", "-b", "--ignore-space-at-eol"]),
	log: new Set(["--oneline", "--stat", "--graph", "--no-walk", "--first-parent", "--full-topo", "--no-decorate", "--name-only", "--name-status", "-p", "--patch", "--no-color"]),
	show: new Set(["--quiet", "-q", "--oneline", "--stat", "--name-only", "--name-status", "--no-color", "--no-decorate"]),
};

/** Read-only bash whitelist: every pipe/;/&& segment must be a whitelisted command with no write or exec option; substitutions, redirections and background jobs are never read-only. */
export function isReadOnlyBash(cmd: string): boolean {
	const c = String(cmd ?? "").replace(/2>(\/dev\/null|&1)/g, " ").trim();
	if (!c || /[<>`]|\$\(/.test(c)) return false; // any remaining redirection can write; $(...) and backticks run arbitrary commands
	if (/&/.test(c.replace(/&&/g, ";"))) return false; // a lone & backgrounds a job (and `&>` redirects)
	const cdArc = /^cd\s+\/[A-Za-z0-9._/-]+\s*&&\s*(arc\s+[^\n;&|]+)$/.exec(c);
	if (cdArc) return isReadOnlyBash(cdArc[1]);
	const segments = c.split(/[|;\n]|&&/).map((s) => s.trim()).filter(Boolean);
	if (!segments.length) return false;
	for (const seg of segments) {
		let toks = seg.split(/\s+/).filter(Boolean);
		while (toks.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
		const head = (toks[0] ?? "").toLowerCase();
		const rest = toks.slice(1);
		if (head === "find") {
			if (rest.some((t) => FIND_UNSAFE.test(t))) return false;
			continue;
		}
		if (head === "rg") {
			if (rest.some((t) => RG_UNSAFE.test(t))) return false;
			continue;
		}
		if (head === "file") {
			if (rest.some((t) => /^-[A-Za-z]*C/.test(t) || t === "--compile")) return false; // file -C writes a magic database
			continue;
		}
		if (head === "arc") {
			const flags = ARC_FLAGS[toks[1] ?? ""];
			if (!flags || !toks.slice(2).every((t) => flags.has(t) || /^[A-Za-z0-9_./:@^~+]+$/.test(t))) return false;
			continue;
		}
		if (READ_ONLY_CMDS.has(head)) continue;
		if (head === "git" && READ_ONLY_GIT.has((toks[1] ?? "").toLowerCase())) {
			if (rest.some((t) => GIT_UNSAFE.test(t))) return false;
			continue;
		}
		return false;
	}
	return true;
}

/**
 * read: rereadable only for a bounded-size full read whose file content still equals the tool result; partial and oversized reads cannot be verified here.
 * bash: rereadable iff read-only, including a narrow Arc history/status whitelist and a literal cd prefix. grep/find/ls/glob: re-runnable queries. Everything else: not rereadable.
 */
export function classifyRecoverability(tool: string, args: Any, rawText: string, cwd: string): Recover {
	tool = String(tool ?? "").toLowerCase();
	const a: Any = args ?? {};
	if (tool === "read") {
		const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
		if (!p || a.offset != null || a.limit != null) return "nonrereadable";
		try {
			const full = isAbsolute(p) ? p : join(cwd, p);
			const st = statSync(full);
			if (!st.isFile() || st.size > 2_000_000) return "nonrereadable";
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
