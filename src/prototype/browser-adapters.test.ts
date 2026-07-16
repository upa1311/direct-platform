import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closePrototypeChannel,
  createPrototypeSourceId,
  getPrototypeLockManager,
  openPrototypeChannel,
} from "./browser-adapters.ts";

/**
 * Этап 11 (восстановление), тесты 1–6, 14–16: безопасные адаптеры browser API.
 * Именно отсутствие защиты crypto.randomUUID роняло гидратацию в небезопасном
 * контексте (страница открыта по LAN-IP): TypeError: crypto.randomUUID is not
 * a function в первом mount-эффекте корневого provider.
 */

type AnyGlobal = Record<string, unknown>;
const g = globalThis as unknown as AnyGlobal;

/** Временная подмена глобального свойства с восстановлением дескриптора. */
function withGlobal<T>(
  name: string,
  value: unknown,
  body: () => T,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  try {
    return body();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete g[name];
    }
  }
}

test("Тест 1: createPrototypeSourceId использует randomUUID, когда он доступен", () => {
  withGlobal("crypto", { randomUUID: () => "uuid-fixed-123" }, () => {
    assert.equal(createPrototypeSourceId(), "uuid-fixed-123");
  });
});

test("Тест 2: fallback работает без randomUUID", () => {
  withGlobal("crypto", {}, () => {
    const id = createPrototypeSourceId();
    assert.match(id, /^direct-\d+-[a-z0-9]+$/);
  });
  // Полное отсутствие crypto — тоже fallback, без исключения.
  withGlobal("crypto", undefined, () => {
    assert.match(createPrototypeSourceId(), /^direct-\d+-[a-z0-9]+$/);
  });
});

test("Тест 3: исключение из randomUUID не падает наружу", () => {
  withGlobal(
    "crypto",
    {
      randomUUID() {
        throw new TypeError("crypto.randomUUID is not a function");
      },
    },
    () => {
      const id = createPrototypeSourceId();
      assert.match(id, /^direct-\d+-[a-z0-9]+$/);
    },
  );
});

test("Тест 4/14: BroadcastChannel недоступен → null (render без канала)", () => {
  withGlobal("BroadcastChannel", undefined, () => {
    assert.equal(openPrototypeChannel("direct-test-channel"), null);
  });
});

test("Тест 5: бросающий конструктор BroadcastChannel → null", () => {
  class ThrowingChannel {
    constructor() {
      throw new Error("denied");
    }
  }
  withGlobal("BroadcastChannel", ThrowingChannel, () => {
    assert.equal(openPrototypeChannel("direct-test-channel"), null);
  });
});

test("Безопасное закрытие: бросающий close и null не роняют cleanup", () => {
  assert.doesNotThrow(() => closePrototypeChannel(null));
  const broken = {
    close() {
      throw new Error("already closed");
    },
  } as unknown as BroadcastChannel;
  assert.doesNotThrow(() => closePrototypeChannel(broken));
});

test("Тест 6/15/16: LockManager отсутствует или бросает → null (fail-closed для мутаций, чтение работает)", () => {
  // navigator отсутствует (node) либо задан без locks.
  withGlobal("navigator", undefined, () => {
    assert.equal(getPrototypeLockManager(), null);
  });
  withGlobal("navigator", {}, () => {
    assert.equal(getPrototypeLockManager(), null);
  });
  // Getter поля locks бросает (SecurityError) — тоже null, без исключения.
  const throwingNavigator = {};
  Object.defineProperty(throwingNavigator, "locks", {
    get() {
      throw new Error("SecurityError");
    },
  });
  withGlobal("navigator", throwingNavigator, () => {
    assert.equal(getPrototypeLockManager(), null);
  });
  // Валидный LockManager возвращается как есть.
  const fakeLocks = { request: async () => undefined };
  withGlobal("navigator", { locks: fakeLocks }, () => {
    assert.equal(getPrototypeLockManager(), fakeLocks as unknown as LockManager);
  });
});
