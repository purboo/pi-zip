import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRecoverability } from "../src/classify.ts";

test("read classification verifies an unchanged unbounded small file, not a bounded slice", () => {
	const dir = mkdtempSync(join(tmpdir(), "zip-read-"));
	try {
		const path = "sample.txt";
		const content = "first\nsecond\nthird\n";
		writeFileSync(join(dir, path), content);
		expect(classifyRecoverability("read", { path }, content, dir)).toBe("rereadable");
		expect(classifyRecoverability("read", { path, offset: null, limit: null }, content, dir)).toBe("rereadable");
		expect(classifyRecoverability("read", { path, offset: 1, limit: 2 }, "first\nsecond\n", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("read", { path, offset: 1 }, content, dir)).toBe("nonrereadable");
		expect(classifyRecoverability("read", { path, limit: 10 }, content, dir)).toBe("nonrereadable");
		writeFileSync(join(dir, path), "other\nsecond\nthird\n");
		expect(classifyRecoverability("read", { path }, content, dir)).toBe("nonrereadable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("read classification does not infer unchanged content from an oversized file's existence", () => {
	const dir = mkdtempSync(join(tmpdir(), "zip-read-"));
	try {
		const path = "large.txt";
		const original = "x".repeat(2_000_001);
		writeFileSync(join(dir, path), original);
		expect(classifyRecoverability("read", { path }, original, dir)).toBe("nonrereadable");
		writeFileSync(join(dir, path), "y" + original.slice(1));
		expect(classifyRecoverability("read", { path }, original, dir)).toBe("nonrereadable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
