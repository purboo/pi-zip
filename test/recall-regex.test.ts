import { describe, expect, test } from "bun:test";
import { grepMatcher, searchOutputs, sliceRecall } from "../src/recall.ts";

async function bounded(patterns: string[]) {
	const code = `import { sliceRecall, searchOutputs } from "./src/recall.ts";
const patterns = ${JSON.stringify(patterns)};
for (const pattern of patterns) for (const size of [3000, 100000]) {
  const line = "a".repeat(size) + "!";
  const one = sliceRecall(line, { grep: pattern });
  const all = searchOutputs([{handle:"abcdefghij",tool:"bash",text:line}], pattern);
  if (one.matched !== 0 || all.hits !== 0) throw new Error(pattern + size);
}
console.log("done");`;
	const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", cwd: import.meta.dir + "/.." });
	const timer = setTimeout(() => child.kill(), 3000);
	try {
		const exit = await child.exited;
		const output = await new Response(child.stdout).text();
		const errors = await new Response(child.stderr).text();
		expect(exit, errors || output).toBe(0);
		expect(output.trim()).toBe("done");
	} finally {
		clearTimeout(timer);
		if (!child.killed) child.kill();
	}
}

describe("recall grep regular-expression safety", () => {
	test("overlapping and nested repetition finishes in both grep paths in a killable subprocess", async () => {
		await bounded(["a+a+$", "(a+)+$", "(a|aa)+$", "a?".repeat(24) + "a".repeat(24) + "$", "[a-z]+[a-z]+$"]);
	});

	test("simple regex stays regex and unsupported constructs explicitly fall back to literal", () => {
		for (const [pattern, input] of [
			["error|fail", "FAIL 7"], ["^ERROR\\s\\d$", "error 2"],
			["[a-z][0-9]", "code7"], ["colou\\?r", "colou?r"],
		]) {
			expect(grepMatcher(pattern).literal, pattern).toBe(false);
			expect(sliceRecall(input, { grep: pattern }).matched, pattern).toBe(1);
		}
		for (const pattern of ["a+a+$", "(?:ab|a)+!", "colou?r", "[a-z]+[0-9]", "a?".repeat(24) + "a".repeat(24) + "$", "(?=a)a", "a\\1"]) {
			expect(grepMatcher(pattern).literal, pattern).toBe(true);
			expect(sliceRecall("unrelated output", { grep: pattern }).text, pattern).toContain("searched as literal text");
		}
		expect(sliceRecall("a+a+$", { grep: "a+a+$" }).matched).toBe(1);
		expect(searchOutputs([{ handle: "abcdefghij", tool: "bash", text: "a+a+$" }], "a+a+$").hits).toBe(1);
		const long = "a".repeat(100_000) + " ERROR 2";
		expect(sliceRecall(long, { grep: "ERROR\\s\\d$" }).matched).toBe(1);
		expect(searchOutputs([{ handle: "abcdefghij", tool: "bash", text: long }], "ERROR\\s\\d$").hits).toBe(1);
	});
});
