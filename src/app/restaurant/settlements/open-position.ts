/**
 * Чистая интерпретация открытой позиции ресторана в однозначный
 * пользовательский результат. UI только читает уже готовые значения accounting
 * (receivable/payable/net) и НЕ пересчитывает net собственной формулой. Результат
 * никогда не содержит отрицательную сумму: для net < 0 берётся модуль. Никакого
 * взаимозачёта — это только текстовая интерпретация знака net.
 */
export interface OpenPosition {
  receivable: number;
  payable: number;
  net: number;
}

export function describeOpenPosition(
  position: OpenPosition,
  money: (cents: number) => string,
): { label: string; value: string } {
  if (position.net > 0) {
    return { label: "Direct должен ресторану", value: money(position.net) };
  }
  if (position.net < 0) {
    return {
      label: "Ресторан должен Direct",
      value: money(Math.abs(position.net)),
    };
  }
  // net === 0: различаем «нет обязательств» и «стороны должны поровну».
  if (position.receivable === 0 && position.payable === 0) {
    return { label: "Открытых обязательств нет", value: money(0) };
  }
  return { label: "Обязательства сторон равны", value: money(0) };
}
