import { describe, expect, test } from "../support/expect.js";
import { appendMode, MODE_ENTRY, restoreMode } from "../../src/compaction/session-mode.js";

describe("режим окна в журнале", () => {
	test("восстанавливает последний именованный режим из append-only записей", () => {
		const entries = [
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "economy" } },
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "long-chat" } },
		];
		expect(restoreMode(entries)).toBe("long-chat");
		const appended: any[] = [];
		appendMode({ appendEntry(type, data) { appended.push({ type, data }); } }, "long-once");
		expect(appended).toEqual([{ type: MODE_ENTRY, data: { mode: "long-once" } }]);
	});

	test("читает режим, записанный прежним расширением сжатия", () => {
		const entries = [
			{ type: "custom", customType: "context-compaction-mode", data: { mode: "long-chat" } },
			{ type: "custom", customType: MODE_ENTRY, data: { mode: "off" } },
		];
		expect(restoreMode(entries)).toBe("off");
		expect(restoreMode(entries.slice(0, 1))).toBe("long-chat");
	});

	test("старый сессионный порог не влияет на режим", () => {
		const entries = [{ type: "custom", customType: "checkpoint-compact-session-threshold", data: { kind: "tokens", value: 700_000 } }];
		expect(restoreMode(entries)).toBe("economy");
	});
});
