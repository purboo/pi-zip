import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/tz-render.ts", import.meta.url));

test.each([["Bun", process.execPath], ["Node", "node"]])("%s model text is byte-identical across process time zones and locales, including summary failure and carry-forward", (runtime, executable) => {
	const render = (TZ: string, locale: string) => {
		const child = Bun.spawnSync([executable, fixture], {
			env: { ...process.env, TZ, LANG: locale, LC_ALL: locale }, stdout: "pipe", stderr: "pipe",
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		return JSON.parse(child.stdout.toString());
	};
	const utc = render("UTC", "en_US.UTF-8");
	for (const [tz, locale] of [["Asia/Shanghai", "tr_TR.UTF-8"], ["America/New_York", "de_DE.UTF-8"]]) {
		const other = render(tz, locale);
		expect(other.zoneOffset).not.toBe(utc.zoneOffset); // the processes really use different local clocks
		// Bun currently fixes its default Intl locale to en-US; Node exercises the locale changes.
		if (runtime === "Node") expect(other.locale).not.toBe(utc.locale);
		expect(JSON.stringify(other.rendered)).toBe(JSON.stringify(utc.rendered));
	}
	expect(utc.rendered.formatted).toEqual(["12-31 23:58 UTC", "02-29 00:05 UTC", "03-08 06:59 UTC", "03-08 07:01 UTC"]);
	expect(utc.rendered.placeholders[0]).toContain(" · 12-31 23:58 UTC · ");
	expect(utc.rendered.first).toContain("## Commands run");
	expect(utc.rendered.first).toContain("## Other tool calls");
	expect(utc.rendered.first).toContain("## Folded outputs");
	expect(utc.rendered.first).toContain("## Handle index");
	expect(utc.rendered.failed).toContain("carried forward from the summary of 12-31 23:58 UTC;");
	expect(utc.rendered.carried.at).toBe("12-31 23:58 UTC");
	expect(utc.rendered.prompts.some((p: string) => p.includes('<previous-narrative written="12-31 23:58 UTC">'))).toBe(true);
});
