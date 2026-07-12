"use client";

import { RotateCcw, ShieldCheck, ShoppingBag, Store } from "lucide-react";
import { DirectBrand } from "@/components/brand/direct-brand";
import type { AppMode } from "@/types/prototype";

interface DemoHeaderProps {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  onReset: () => void;
}

export function DemoHeader({ mode, onModeChange, onReset }: DemoHeaderProps) {
  return (
    <header className="demo-header">
      <div className="demo-header-inner">
        <div className="demo-brand">
          <DirectBrand compact inverted />
          <div>
            <span>кликабельный прототип</span>
          </div>
        </div>

        <nav className="mode-switch" aria-label="Выбор интерфейса">
          <button
            type="button"
            className={mode === "customer" ? "is-active" : ""}
            onClick={() => onModeChange("customer")}
          >
            <ShoppingBag size={17} />
            Клиент
          </button>
          <button
            type="button"
            className={mode === "admin" ? "is-active" : ""}
            onClick={() => onModeChange("admin")}
          >
            <ShieldCheck size={17} />
            Админка
          </button>
        </nav>

        <div className="demo-header-actions">
          <span className="demo-pill"><Store size={15} /> Тестовые данные</span>
          <button className="ghost-button compact-button" type="button" onClick={onReset}>
            <RotateCcw size={16} />
            Сбросить демо
          </button>
        </div>
      </div>
    </header>
  );
}
