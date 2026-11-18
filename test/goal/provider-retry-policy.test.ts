import assert from "node:assert/strict";
import { test } from "node:test";

import { decideProviderRetry, type ProviderRetryInput } from "../../src/goal/provider-retry-policy.js";

const ASTRA = "openai/gpt-6.2-astra";
const SOL = "openai/gpt-6.2-sol";

function failure(overrides: Partial<ProviderRetryInput> = {}): ProviderRetryInput {
  return {
    chain: { startedAtMs: 1_000, model: ASTRA, attemptsIssued: 0, switched: false },
    nowMs: 1_000,
    failedAtMs: 1_000,
    errorClass: "model-temporary",
    notBeforeMs: 1_000,
    windowMs: 900_000,
    allowSwitch: true,
    ...overrides,
  };
}

test("повторы отсчитывают растущую задержку от сбоя, но не переносят общий срок", () => {
  let failedAtMs = 1_000;
  const delays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
  for (const [attemptsIssued, delayMs] of delays.entries()) {
    const input = failure({ failedAtMs, nowMs: failedAtMs, notBeforeMs: failedAtMs });
    input.chain.attemptsIssued = attemptsIssued;
    const untilMs = failedAtMs + delayMs;
    assert.deepEqual(decideProviderRetry(input), { type: "wait", untilMs });
    assert.deepEqual(decideProviderRetry({ ...input, nowMs: untilMs - 1 }), { type: "wait", untilMs });
    assert.deepEqual(decideProviderRetry({ ...input, nowMs: untilMs }), { type: "retry" });
    failedAtMs = untilMs + 1_000;
  }

  const last = failure({ failedAtMs: 895_000, nowMs: 895_000, notBeforeMs: 895_000 });
  last.chain.attemptsIssued = delays.length;
  assert.deepEqual(decideProviderRetry(last), { type: "wait", untilMs: 901_000 });
  assert.deepEqual(decideProviderRetry({ ...last, nowMs: 901_000 }), { type: "switch", model: SOL });
});

test("если таймер повторной попытки опоздал до конца окна, Astra больше не повторяется", () => {
  const input = failure({ windowMs: 10_000 });
  assert.deepEqual(decideProviderRetry(input), { type: "wait", untilMs: 6_000 });
  assert.deepEqual(decideProviderRetry({ ...input, nowMs: 11_001 }), { type: "switch", model: SOL });
});

test("выключатель смены модели сохраняет повторы до срока и не оставляет бессрочного ожидания", () => {
  const input = failure({ windowMs: 10_000, allowSwitch: false });
  assert.deepEqual(decideProviderRetry(input), { type: "wait", untilMs: 6_000 });
  assert.deepEqual(decideProviderRetry({ ...input, nowMs: 6_000 }), { type: "retry" });
  const next = { ...input, chain: { ...input.chain, attemptsIssued: 1 }, failedAtMs: 6_001, nowMs: 6_001 };
  assert.deepEqual(decideProviderRetry(next), { type: "stop", reason: "window-exhausted" });
});

test("Retry-After сдвигает повтор, но не продлевает цепочку и не разрешает перейти раньше", () => {
  const input = failure({ windowMs: 10_000, notBeforeMs: 9_000 });
  assert.deepEqual(decideProviderRetry(input), { type: "wait", untilMs: 9_000 });
  assert.deepEqual(decideProviderRetry({ ...input, nowMs: 9_000 }), { type: "retry" });
  const boundary = { ...input, notBeforeMs: 11_000 };
  assert.deepEqual(decideProviderRetry(boundary), { type: "wait", untilMs: 11_000 });
  assert.deepEqual(decideProviderRetry({ ...boundary, nowMs: 11_000 }), { type: "switch", model: SOL });
  assert.deepEqual(decideProviderRetry({ ...boundary, nowMs: 11_000, allowSwitch: false }), {
    type: "stop", reason: "window-exhausted",
  });
  for (const nowMs of [1_000, 11_001]) {
    assert.deepEqual(decideProviderRetry({ ...input, nowMs, notBeforeMs: 11_001 }), {
      type: "stop", reason: "retry-after-outside-window",
    });
  }
});

test("временный сбой без локализации допускает повтор, но не переход", () => {
  const input = failure({ windowMs: 10_000, errorClass: "unlocalized-temporary" });
  assert.deepEqual(decideProviderRetry({ ...input, nowMs: 6_000 }), { type: "retry" });
  assert.deepEqual(decideProviderRetry({ ...input, nowMs: 11_000 }), { type: "stop", reason: "window-exhausted" });
});

test("отложенное решение не даёт разрешения при повторной проверке недопущенного сбоя", () => {
  const input = failure({ windowMs: 5_000 });
  assert.deepEqual(decideProviderRetry(input), { type: "wait", untilMs: 6_000 });
  assert.deepEqual(decideProviderRetry({ ...input, nowMs: 6_000, errorClass: "not-admitted" }), {
    type: "stop", reason: "error-not-admitted",
  });
});

test("переход существует только для точной Astra и не открывает новое окно на Sol", () => {
  const input = failure({ windowMs: 10_000, nowMs: 11_000 });
  assert.deepEqual(decideProviderRetry(input), { type: "switch", model: SOL });
  assert.deepEqual(decideProviderRetry({ ...input, chain: { ...input.chain, model: SOL, switched: true } }), {
    type: "stop", reason: "already-switched",
  });
  for (const model of ["openai/gpt-6.2-astra-preview", "other/gpt-6.2-astra", SOL]) {
    const sameModel = { ...input, chain: { ...input.chain, model } };
    assert.deepEqual(decideProviderRetry({ ...sameModel, nowMs: 6_000 }), { type: "retry" });
    assert.deepEqual(decideProviderRetry(sameModel), { type: "stop", reason: "window-exhausted" });
  }
});

test("ошибка штатной попытки после срока не считается новым Retry-After", () => {
  const failedAtMs = 903_000;
  assert.deepEqual(decideProviderRetry(failure({ nowMs: failedAtMs, failedAtMs, notBeforeMs: failedAtMs })), { type: "switch", model: SOL });
});
