import assert from "node:assert/strict";
import test from "node:test";
import { fakePi } from "../support/pi-fake.js";

for (const enabled of [false, true]) {
  test(`регистрация checkpoint и независимое сжатие: флаг ${enabled}`, async () => {
    const runtime = fakePi({ checkpointCompactContinue: enabled });
    const tool = "checkpoint_compact_continue";
    assert.equal(runtime.tools.has(tool), enabled);
    assert.equal(runtime.activeTools.has(tool), enabled);
    await runtime.event("session_start", {});
    assert.equal(runtime.activeTools.has(tool), enabled);
    for (const reason of ["threshold", "overflow"]) {
      await runtime.command("long-once");
      assert.equal(runtime.ctx.model.contextWindow, 372_000);
      // Без модели сводки штатный обработчик явно отменяет сжатие, независимо от флага.
      assert.deepEqual(await runtime.event("session_before_compact", {
        reason, willRetry: reason === "overflow", preparation: { tokensBefore: 256_000 },
      }), { cancel: true });
      await runtime.event("session_compact", {
        reason, willRetry: false, compactionEntry: { tokensBefore: 256_000 },
      });
      assert.equal(runtime.ctx.model.contextWindow, 272_000);
    }
  });
}

test("checkpoint не регистрируется без настройки", () => {
  const runtime = fakePi();
  assert.equal(runtime.tools.has("checkpoint_compact_continue"), false);
  assert.equal(runtime.activeTools.has("checkpoint_compact_continue"), false);
});
