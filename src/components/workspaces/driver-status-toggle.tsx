"use client";

import { useState } from "react";

import styles from "./workspace-shell.module.css";

export function DriverStatusToggle() {
  const [isOnline, setIsOnline] = useState(false);

  return (
    <button
      className={`${styles.statusToggle} ${isOnline ? styles.statusToggleOnline : ""}`}
      type="button"
      aria-pressed={isOnline}
      onClick={() => setIsOnline((current) => !current)}
    >
      <span className={styles.statusDot} aria-hidden="true" />
      {isOnline ? "Онлайн" : "Офлайн"}
    </button>
  );
}
