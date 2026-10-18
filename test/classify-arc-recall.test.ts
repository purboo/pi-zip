import { expect, test } from "bun:test";
import { classifyRecoverability, isReadOnlyBash } from "../src/classify.ts";
import { planContext, type PlanOpts } from "../src/plan.ts";
import { A, R, U } from "./helpers.ts";

const opts = (over: Partial<PlanOpts>): PlanOpts => ({ coldCap: 1000, cwd: process.cwd(), promptPending: false, pause: true, foldsOnly: true, ...over });
const session = (command: string) => {
	const call = A("a1", ["c1"]);
	(call.messages[0].content[1] as { arguments: { command: string } }).arguments.command = command;
	return [U("u1", "inspect change"), call, R("r1", "c1", 9000), A("a2"), U("u2", "report result")];
};

test("Arc previous-turn outputs fold with exact recall, not with reread-only fallback", () => {
	for (const command of ["arc diff --stat", "cd /repo/project && arc diff --stat", "arc status --short", "arc log --oneline", "arc show --stat HEAD"]) {
		const entries = session(command);
		expect(planContext(entries, opts({}))?.folds.map((f) => f.entryId)).toEqual(["r1"]);
		expect(planContext(entries, opts({ rereadOnly: true }))?.folds.map((f) => f.entryId) ?? []).toEqual([]);
		expect(planContext(entries, opts({ rereadOnly: true, fileRecall: { dir: "/tmp/recall", read: true, grep: false, bash: false } }))?.folds.map((f) => f.entryId)).toEqual(["r1"]);
	}
});

test("explicit no-recall classifier policy rejects only Arc", () => {
	const policy = { exactRecall: false };
	for (const command of ["arc diff --stat", "cd /repo/project && arc diff --stat", "arc status --short | head"]) {
		expect(isReadOnlyBash(command, policy)).toBe(false);
		expect(classifyRecoverability("bash", { command }, "output", process.cwd(), policy)).toBe("nonrereadable");
	}
	expect(isReadOnlyBash("git diff --stat", policy)).toBe(true);
	expect(classifyRecoverability("bash", { command: "git diff --stat" }, "output", process.cwd(), policy)).toBe("rereadable");
});

test("existing non-Arc reread-only behavior is unchanged", () => {
	expect(planContext(session("git diff --stat"), opts({ rereadOnly: true }))?.folds.map((f) => f.entryId)).toEqual(["r1"]);
	expect(planContext(session("npm test"), opts({ rereadOnly: true }))?.folds.map((f) => f.entryId) ?? []).toEqual([]);
	expect(isReadOnlyBash("arc diff --stat")).toBe(true);
	expect(classifyRecoverability("bash", { command: "arc diff --stat" }, "output", process.cwd())).toBe("rereadable");
});
