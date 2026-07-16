import assert from "node:assert/strict";
import { test } from "node:test";

import type { MutationAck } from "../../prototype/prototype-store.ts";
import {
  MUTATION_ALREADY_RUNNING_ERROR,
  createMutationGuardCore,
} from "./mutation-guard-core.ts";
import { MUTATION_FALLBACK_ERROR } from "./mutation-feedback.ts";

/**
 * Этап 11 (восстановление), тесты 7–9, 17–18: семантика mutation guard —
 * то же ядро, что использует hook useMutationGuard и admin doLifecycle-паттерн.
 */

function makeGuard() {
  const pendingLog: boolean[] = [];
  const errorLog: (string | null)[] = [];
  const guard = createMutationGuardCore({
    onPending: (p) => pendingLog.push(p),
    onError: (e) => errorLog.push(e),
  });
  return { guard, pendingLog, errorLog };
}

const okAck: MutationAck = { ok: true, error: null, changed: true };

test("Тест 7: вторая операция при pending не запускается", async () => {
  const { guard } = makeGuard();
  let firstCalls = 0;
  let secondCalls = 0;
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((r) => (releaseFirst = r));

  const first = guard.run(async () => {
    firstCalls += 1;
    await firstDone;
    return okAck;
  });
  // Второй вызов в том же tick: thunk НЕ вызывается, возвращается отказ.
  const second = await guard.run(async () => {
    secondCalls += 1;
    return okAck;
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, MUTATION_ALREADY_RUNNING_ERROR);
  assert.equal(second.changed, false);
  assert.equal(secondCalls, 0);

  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstCalls, 1);

  // После завершения первой guard свободен.
  const third = await guard.run(async () => okAck);
  assert.equal(third.ok, true);
});

test("Тест 8: operation thunk не вызывается до входа в guard", async () => {
  const { guard } = makeGuard();
  const callOrder: string[] = [];
  const operation = () => {
    callOrder.push("operation");
    return Promise.resolve(okAck);
  };
  callOrder.push("before-run");
  const resultPromise = guard.run(operation);
  // Thunk вызывается синхронно ВНУТРИ run (после проверки pending), не раньше.
  assert.deepEqual(callOrder, ["before-run", "operation"]);
  await resultPromise;

  // При занятом guard thunk не вызывается вовсе (см. Тест 7).
  let lateCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const running = guard.run(async () => {
    await gate;
    return okAck;
  });
  await guard.run(() => {
    lateCalls += 1;
    return Promise.resolve(okAck);
  });
  assert.equal(lateCalls, 0);
  release();
  await running;
});

test("Тест 9: rejected Promise превращается в русский MutationAck", async () => {
  const { guard, errorLog } = makeGuard();
  const result = await guard.run(() => Promise.reject(new Error("boom")));
  assert.deepEqual(result, {
    ok: false,
    error: MUTATION_FALLBACK_ERROR,
    changed: false,
  });
  assert.equal(errorLog.at(-1), MUTATION_FALLBACK_ERROR);
  // Guard освобождён после исключения.
  assert.equal(guard.isPending(), false);
  const next = await guard.run(async () => okAck);
  assert.equal(next.ok, true);
});

test("Тест 17: admin lifecycle double-click запускает одну операцию", async () => {
  const { guard } = makeGuard();
  let operations = 0;
  const operation = async () => {
    operations += 1;
    await new Promise((r) => setTimeout(r, 5));
    return okAck;
  };
  // Двойной быстрый клик: оба вызова в одном tick.
  const [a, b] = await Promise.all([guard.run(operation), guard.run(operation)]);
  assert.equal(operations, 1);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(
    [a, b].find((r) => !r.ok)?.error,
    MUTATION_ALREADY_RUNNING_ERROR,
  );
});

test("Тест 18: double-call адресной мутации не создаёт две конкурирующие операции", async () => {
  const { guard, pendingLog } = makeGuard();
  let concurrent = 0;
  let maxConcurrent = 0;
  const operation = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    return okAck;
  };
  await Promise.all([guard.run(operation), guard.run(operation)]);
  assert.equal(maxConcurrent, 1);
  // pending переключался ровно один раз: true → false.
  assert.deepEqual(pendingLog, [true, false]);
});

test("Ошибка операции с собственным текстом сохраняется в ack", async () => {
  const { guard, errorLog } = makeGuard();
  const domainFail: MutationAck = {
    ok: false,
    error: "Заказ уже обработан. Обновите данные.",
    changed: false,
  };
  const result = await guard.run(async () => domainFail);
  assert.equal(result.error, "Заказ уже обработан. Обновите данные.");
  assert.equal(errorLog.at(-1), "Заказ уже обработан. Обновите данные.");
});
