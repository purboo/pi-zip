import { expect, test } from "bun:test";
import { classifyRecoverability, isReadOnlyBash } from "../src/classify.ts";

test("arc status/diff/log/show with documented read-only flags and literal cd are rereadable", () => {
	for (const cmd of [
		"arc status", "arc status --short --json", "arc diff --cached --stat", "arc diff --name-only src/file.ts",
		"arc log --oneline -p", "arc show --stat HEAD", "cd /repo/project && arc diff --stat",
	]) {
		expect([cmd, isReadOnlyBash(cmd)]).toEqual([cmd, true]);
		expect(classifyRecoverability("bash", { command: cmd }, "output", "/tmp")).toBe("rereadable");
	}
});

test("mutating or unverified arc forms and unsafe shell syntax remain nonrereadable", () => {
	for (const cmd of [
		"arc add file", "arc commit", "arc push", "arc submit", "arc checkout branch", "arc sync",
		"arc status --unknown", "arc diff --output=patch", "arc log -n 20", "arc show --color=always",
		"arc diff -- --unknown", "arc diff > patch", "arc status $(arc add file)", "arc diff `arc add file`",
		"arc diff && arc add file", "arc diff &", "cd $HOME/project && arc diff", "cd /repo; arc diff",
		"cd '/repo/project' && arc diff", "cd /repo/project && arc add file",
	]) {
		expect([cmd, isReadOnlyBash(cmd)]).toEqual([cmd, false]);
		expect(classifyRecoverability("bash", { command: cmd }, "output", "/tmp")).toBe("nonrereadable");
	}
});
