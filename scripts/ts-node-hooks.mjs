// Резолвер модулей для запуска TypeScript-тестов через `node --test`.
// Node со стриппингом типов не добавляет расширения к относительным импортам,
// а приложение использует импорты без расширения (`./default-state`).
// Хук дописывает `.ts` к таким относительным спецификаторам, чтобы actions/
// selectors/store и их зависимости загружались напрямую.

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.(ts|mts|cts|tsx|js|mjs|cjs|json)$/.test(specifier)
  ) {
    try {
      return await nextResolve(specifier + ".ts", context);
    } catch {
      // Не .ts — падаем в стандартную резолюцию ниже.
    }
  }
  return nextResolve(specifier, context);
}
