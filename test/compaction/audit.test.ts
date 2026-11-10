import { expect, test } from "../support/expect.js";
import { parseAuditRecord } from "../../src/compaction/audit.js";

test("audit parser accepts lifecycle v2 records", () => {
	expect(parseAuditRecord({ version: 2, correlation: "c", origin: "external-unattributed", reason: "threshold", phase: "error", tokens: 1, window: 2, threshold: 3, mode: "economy", source: "exact-registry", willRetry: false })).toMatchObject({ type: "lifecycle" });
});

test("audit parser ignores historical diagnostics and malformed records", () => {
	expect(parseAuditRecord({ version: 1, protocol: "context-compaction-diagnostics-v1", kind: "startup-provenance" })).toEqual({ type: "unknown" });
	expect(parseAuditRecord({ version: 2, correlation: 1, phase: "success" })).toEqual({ type: "unknown" });
	expect(parseAuditRecord(null)).toEqual({ type: "unknown" });
});
