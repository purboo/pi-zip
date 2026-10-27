import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { pressure, zipMode } from "../src/speed.ts";
import type { Any } from "./helpers.ts";
const model: Any = { provider: "synthetic", id: "physical", api: "openai-responses", contextWindow: 200000 };
beforeEach(() => { process.env.PI_ZIP_MODE = "speed"; });
afterEach(() => { process.env.PI_ZIP_MODE = "early"; });

describe("speed pressure and settings", () => {
	test("unset and invalid modes select speed; early is explicit", () => { delete process.env.PI_ZIP_MODE; expect(zipMode()).toBe("speed"); process.env.PI_ZIP_MODE = "typo"; expect(zipMode()).toBe("speed"); process.env.PI_ZIP_MODE = "early"; expect(zipMode()).toBe("early"); });
	test.each([[200000,183616,175424,154174], [1000000,983616,975424,954174], [65536,49152,46695,25445], [32768,16384,15565,8192]])("window %i has exact pressure/preparation thresholds", (w,n,t,p) => { expect(pressure({ ...model, contextWindow: w }, {})).toMatchObject({ N:n,T:t,P:p }); });
	test("valid settings use the same overrides as Pi", () => { const s: Any = { compaction: { reserveTokens: 100, keepRecentTokens: 200, modelOverrides: { "synthetic/physical": { reserveTokens: 300, keepRecentTokens: 400 } } } }; expect(pressure(model,s)).toMatchObject({ reserve: SettingsManager.inMemory(s).getCompactionReserveTokens(model), keep: SettingsManager.inMemory(s).getCompactionKeepRecentTokens(model) }); });
	test.each([-.1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER+1, "4", null])("invalid token setting %p fails closed even when shadowed", v => { for (const field of ["reserveTokens", "keepRecentTokens"]) { const s: Any = {compaction:{[field]:v, modelOverrides:{"synthetic/physical":{[field]:5}}}}; expect(pressure(model,s)).toBeNull(); expect(() => SettingsManager.inMemory(s).getCompactionSettings(model)).toThrow(); } });
	test.each([null, [], "bad", 1].map(v=>[v]))("invalid selected override shape %p", entry => { const s: Any = { compaction: { modelOverrides: { "synthetic/physical": entry } } }; expect(pressure(model,s)).toBeNull(); expect(() => SettingsManager.inMemory(s).getCompactionSettings(model)).toThrow(); });
	test("invalid overrides, disabled and unknown windows never enable adoption", () => { for (const s of [{compaction: []}, {compaction:{modelOverrides:[]}}, {compaction:{enabled:false}}]) expect(pressure(model,s)).toBeNull(); for (const w of [0,NaN,16384]) expect(pressure({...model,contextWindow:w},{})).toBeNull(); });
});
