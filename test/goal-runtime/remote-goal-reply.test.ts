import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeHarness } from '../support/runtime-harness.js';

const waiting = { action: 'publish', status: 'awaiting_user', phase: 'Выбор', summary: 'Нужно решение.', needUser: 'Выберите вариант.', nextStep: 'Получить ответ.' };
const working = { action: 'publish', status: 'working', phase: 'Продолжение', summary: 'Решение получено.', changed: 'Выбран вариант.', nextStep: 'Продолжить.' };

for (const scenario of ['matching', 'wrong-goal', 'wrong-text', 'cancelled', 'unmarked'] as const) {
  test(`remote reply receipt: ${scenario}`, async () => {
    const h = createRuntimeHarness();
    await h.runCommand('Проверить продолжение');
    await h.runTool('report_goal_progress', waiting);
    const goalId = h.snapshot().goal!.goalId;
    if (scenario !== 'unmarked') h.emitBusEvent('pi-recall:goal-reply', { goalId: scenario === 'wrong-goal' ? 'other' : goalId, text: 'Да', commandId: 'command-1' });
    if (scenario === 'cancelled') h.emitBusEvent('pi-recall:goal-reply', { commandId: 'command-1', cancel: true });
    await h.emit('input', { type: 'input', source: 'extension', text: scenario === 'wrong-text' ? 'Нет' : 'Да', images: [] });
    const result = await h.runTool('report_goal_progress', working) as { details: { state: { awaitingUser: boolean } } };
    assert.equal(result.details.state.awaitingUser, scenario !== 'matching');
  });
}
