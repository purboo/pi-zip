// Every test process learns into its own throwaway cache-survival file, never into ~/.pi/agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_ZIP_CACHE_STATS = join(mkdtempSync(join(tmpdir(), "pi-zip-test-")), "cache-survival.json");
