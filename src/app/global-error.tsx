"use client";

import type { CSSProperties } from "react";

/**
 * Этап 5 (восстановление): корневой error fallback App Router. Ловит ошибки,
 * дошедшие до корневого layout, — вместо пустой страницы пользователь получает
 * спокойный русский экран с действием. По правилам Next.js global-error
 * определяет собственные <html> и <body>. Boundary НЕ заменяет исправление
 * причины — он только исключает blank page без понятного действия.
 */

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f4f4f1",
  color: "#202522",
  fontFamily:
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

const cardStyle: CSSProperties = {
  maxWidth: 420,
  padding: "32px 28px",
  borderRadius: 16,
  background: "#fff",
  border: "1px solid #e3e6e2",
  textAlign: "center",
};

const buttonStyle: CSSProperties = {
  marginTop: 20,
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

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ru">
      <body style={pageStyle}>
        <div style={cardStyle} role="alert">
          <h1 style={{ margin: 0, fontSize: 22 }}>Не удалось открыть Direct</h1>
          <p style={{ marginTop: 12, lineHeight: 1.5, color: "#59625c" }}>
            Обновите страницу. Если ошибка повторится, перезапустите локальный
            сервер.
          </p>
          <button type="button" style={buttonStyle} onClick={() => reset()}>
            Попробовать снова
          </button>
          {error?.digest ? (
            <p style={{ marginTop: 16, fontSize: 12, color: "#8a938d" }}>
              Технический идентификатор ошибки: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
