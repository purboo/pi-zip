import { textOf, tok4, type Any } from "./util.ts";

export interface KnownUsers { items: string[]; omitted: number; nums?: number[] }

/** Recover only users on the active branch before the cut; never search the full session file or the kept tail. If the branch does not cover every earlier request, keep the previous summary's available text instead. */
export function userTextBefore(branch: Any[] | undefined, firstKeptEntryId: string, previous: KnownUsers): string[] | null {
	if (!Array.isArray(branch)) return null;
	const at = branch.findIndex((e) => e?.id === firstKeptEntryId);
	if (at < 0) return null;
	const users = branch.slice(0, at).filter((e) => e?.type === "message" && e.message?.role === "user").map((e) => textOf(e.message.content));
	const known = Math.max(previous.omitted + previous.items.length, previous.nums?.at(-1) ?? 0);
	return users.length >= known ? users : null;
}

/** The unbounded user portion of a planned summary, including JSON encoding and earlier requests carried in the head. */
export function mandatoryUserTokens(previous: KnownUsers, current: string[]): number {
	return tok4(`\n## User requests (available originals, oldest first; JSON strings decode to exact user messages)\n${JSON.stringify({ messages: [...previous.items, ...current], unavailableEarlier: previous.omitted })}`);
}
