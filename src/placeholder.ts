// Placeholders (F2): tool + args + size + key lines + handle. Handles are deterministic in the session entry id.
import { createHash } from "node:crypto";
import type { Block, Calls } from "./plan.ts";
import { type Any, clip, textOf } from "./util.ts";

export const PH_MARK = "[folded by pi-zip";
export const RECALL_TOOL = "zip_recall";
const MIN_FOLD_CHARS = 1000; // shorter outputs are never worth a placeholder

/** Deterministic recall handle for a session entry id: 10-char base36 of sha256("pi-zip:"+id)[0..12). */
export function handleFor(entryId: string): string {
	const hex = createHash("sha256").update(`pi-zip:${entryId}`).digest("hex").slice(0, 12);
	return BigInt("0x" + hex).toString(36).padStart(Math.ceil(48 / Math.log2(36)), "0").slice(-10);
}

export interface KeyLine {
	no: number;
	text: string;
	why: "error" | "id" | "first" | "last";
}

const ERROR_LINE_RE = /error|fail|exception|warning/i;
const ID_LINE_RE = /\b[A-Z]{2,}-[A-Z0-9-]{3,}\b/;
const KEYVAL_LINE_RE = /\b[A-Za-z_][A-Za-z0-9_.-]*=(?:"[^"]*"|\S+)/;
const LABEL_NUM_RE = /\b[A-Za-z][A-Za-z0-9_. \/-]{0,30}:\s*-?\d|\b-?\d[\d.,]*\s+(?:ms|s|kb|mb|gb|tokens?|bytes|lines)\b/i;
const HEXISH_RE = /\b[0-9a-f]{8,}\b/gi;

const hexLike = (line: string): boolean => {
	for (const m of line.matchAll(HEXISH_RE)) if (/[a-f]/i.test(m[0]) && /\d/.test(m[0])) return true; // letters+digits reads as an id/hash
	return false;
};

/** Deterministic key lines: first line, error/warning lines, id-like lines (tickets, hashes, key=value, labelled numbers), last line; sorted by line number. */
export function pickKeyLines(text: string, keep = 8): KeyLine[] {
	const lines = text.split("\n");
	if (keep <= 0 || !lines.length) return [];
	const picked = new Map<number, KeyLine>();
	const add = (no: number, why: KeyLine["why"]) => {
		if (picked.size >= keep || picked.has(no)) return;
		const t = lines[no - 1] ?? "";
		if (t.trim()) picked.set(no, { no, text: t, why });
	};
	const room = () => picked.size < keep - (picked.has(lines.length) ? 0 : 1); // always leave room for the last line
	add(1, "first");
	for (let i = 0; i < lines.length && room(); i++) if (i > 0 && i < lines.length - 1 && ERROR_LINE_RE.test(lines[i])) add(i + 1, "error");
	for (let i = 0; i < lines.length && room(); i++) {
		const no = i + 1;
		if (no === 1 || no === lines.length || picked.has(no)) continue;
		if (ID_LINE_RE.test(lines[i]) || hexLike(lines[i]) || KEYVAL_LINE_RE.test(lines[i]) || LABEL_NUM_RE.test(lines[i])) add(no, "id");
	}
	add(lines.length, "last");
	return [...picked.values()].sort((a, b) => a.no - b.no);
}

export function shortArgs(args: Any): string {
	if (!args || typeof args !== "object") return "";
	if (typeof args.command === "string") return clip(args.command, 80);
	if (typeof args.path === "string") return clip(args.path, 80);
	if (typeof args.file_path === "string") return clip(args.file_path, 80);
	if (typeof args.pattern === "string") return clip(args.pattern + (args.path ? " " + args.path : ""), 80);
	try {
		return clip(JSON.stringify(args), 80);
	} catch {
		return "";
	}
}

/** Placeholder text, or null when the output is too short to be worth folding. */
export function makePlaceholder(text: string, tool: string, args: string, handle: string, keep = 8): string | null {
	if (text.length <= MIN_FOLD_CHARS) return null;
	const lines = text.split("\n").length;
	const keys = pickKeyLines(text, keep);
	const body = keys.map((k) => `${k.no}: ${clip(k.text, 160)}`).join("\n");
	return (
		`${PH_MARK} · ${tool}${args ? " " + args : ""} · ${text.length} chars, ${lines} lines · handle ${handle}]\n` +
		(keys.length ? `key lines kept (original line numbers; up to ${keep}):\n${body}\n` : "") +
		`Full original is saved and stays recallable even after later summaries or compaction: call ${RECALL_TOOL}("${handle}") to get it back exactly (optionally with grep or range). Do not guess its content.`
	);
}

/** Placeholder for a toolResult block (null for image results, entries without an id, or short outputs). */
export function makePlaceholderFor(b: Block, calls: Calls, keep = 8): string | null {
	const content = b.msg.content;
	if (Array.isArray(content) && content.some((c: Any) => c?.type !== "text")) return null;
	if (!b.entryId) return null;
	const call = calls.get(b.msg.toolCallId);
	return makePlaceholder(textOf(content), call?.name ?? b.msg.toolName ?? "tool", call ? shortArgs(call.args) : "", handleFor(b.entryId), keep);
}
