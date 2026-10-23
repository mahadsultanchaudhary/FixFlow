import { friendlyStatus } from '../lib/agent';

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <span className="status-dot" />
      {friendlyStatus(status)}
    </span>
  );
}
