// Every test process learns into its own throwaway cache-survival file, never into ~/.pi/agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_ZIP_CACHE_STATS = join(mkdtempSync(join(tmpdir(), "pi-zip-test-")), "cache-survival.json");
// ... and has already seen the one-time welcome line (test/ui.test.ts removes the flag where it tests the welcome).
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
writeFileSync(join(dirname(process.env.PI_ZIP_CACHE_STATS), "welcomed"), "test\n");
