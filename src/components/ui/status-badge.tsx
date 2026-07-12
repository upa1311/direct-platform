import type { PublicationStatus } from "@/types/prototype";
import { publicationStatusLabels } from "@/data/demo-data";

interface StatusBadgeProps {
  status: PublicationStatus;
  compact?: boolean;
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  return (
    <span
      className={`status-badge status-${status.toLowerCase()} ${compact ? "status-compact" : ""}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {publicationStatusLabels[status]}
    </span>
  );
}

