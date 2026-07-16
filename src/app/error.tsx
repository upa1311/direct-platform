"use client";

import type { CSSProperties } from "react";

/**
 * Этап 5 (восстановление): route-level error boundary App Router. Ошибка
 * отдельного маршрута не оставляет пользователя с пустой страницей — экран
 * предлагает повторить попытку. Полный stack trace пользователю не показываем.
 */

const wrapStyle: CSSProperties = {
  minHeight: "60vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const cardStyle: CSSProperties = {
  maxWidth: 420,
  padding: "28px 24px",
  borderRadius: 16,
  background: "#fff",
  border: "1px solid #e3e6e2",
  textAlign: "center",
  color: "#202522",
};

const buttonStyle: CSSProperties = {
  marginTop: 18,
  minHeight: 44,
  padding: "10px 22px",
  borderRadius: 10,
  border: "1px solid #c6662d",
  background: "#c6662d",
  color: "#fff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
};

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={wrapStyle} role="alert">
      <div style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: 20 }}>
          Не удалось открыть этот раздел Direct
        </h1>
        <p style={{ marginTop: 12, lineHeight: 1.5, color: "#59625c" }}>
          Обновите страницу. Если ошибка повторится, перезапустите локальный
          сервер.
        </p>
        <button type="button" style={buttonStyle} onClick={() => reset()}>
          Попробовать снова
        </button>
        {error?.digest ? (
          <p style={{ marginTop: 14, fontSize: 12, color: "#8a938d" }}>
            Технический идентификатор ошибки: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
