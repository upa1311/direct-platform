"use client";

import { CheckCircle2, X } from "lucide-react";

interface ToastProps {
  message: string;
  onClose: () => void;
}

export function Toast({ message, onClose }: ToastProps) {
  return (
    <div className="demo-toast" role="status">
      <CheckCircle2 size={19} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Закрыть уведомление">
        <X size={17} />
      </button>
    </div>
  );
}
