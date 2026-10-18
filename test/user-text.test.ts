import { describe, expect, test } from "bun:test";
import { mandatoryUserPrefixTokens, mandatoryUserTokens } from "../src/user-text.ts";

describe("mandatoryUserPrefixTokens", () => {
	test("matches literal summary JSON sizes with escapes, Unicode, duplicates and unavailable originals", () => {
		const previous = { items: [" a\n\t", "## User requests\n\"quoted\"", "🧪\\end"], omitted: 7 };
		const current = ["", "same", "same", "\u0000\b\f\r\n", "漢字\u2028emoji 🧪", " trailing  \n"];
		const sizes = mandatoryUserPrefixTokens(previous, current);
		expect(sizes).toEqual(Array.from({ length: current.length + 1 }, (_, k) => mandatoryUserTokens(previous, current.slice(0, k))));
	});

	test("reads each user message once across thousands of candidate prefixes", () => {
		const previous = Array.from({ length: 100 }, (_, i) => `old-${i} 🧪`);
		const current = Array.from({ length: 4000 }, (_, i) => `request-${i} \"\\\n`);
		let previousReads = 0, currentReads = 0;
		const watched = (items: string[], hit: () => void) => new Proxy(items, { get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) hit();
			return Reflect.get(target, property, receiver);
		} });
		const sizes = mandatoryUserPrefixTokens({ items: watched(previous, () => previousReads++), omitted: 2 }, watched(current, () => currentReads++));
		expect(previousReads).toBe(previous.length);
		expect(currentReads).toBe(current.length);
		expect(sizes).toHaveLength(current.length + 1);
		for (const k of [0, 1, 127, current.length]) expect(sizes[k]).toBe(mandatoryUserTokens({ items: previous, omitted: 2 }, current.slice(0, k)));
	});
});
