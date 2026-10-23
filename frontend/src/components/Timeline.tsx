import type { TimelineEvent } from '../lib/types';

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PK', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function symbolFor(event: TimelineEvent): string {
  const kind = `${event.event_type} ${event.title}`.toLowerCase();
  if (kind.includes('no-show') || kind.includes('missed')) return '↗';
  if (kind.includes('warranty')) return '◈';
  if (kind.includes('history')) return '↺';
  if (kind.includes('book') || kind.includes('appointment')) return '◷';
  if (kind.includes('confirm') || kind.includes('close') || kind.includes('resolved')) return '✓';
  return '✦';
}

export function Timeline({ events, compact = false }: { events: TimelineEvent[]; compact?: boolean }) {
  if (!events.length) {
    return <div className="empty-state small-empty">The timeline will appear here as FixFlow records each step.</div>;
  }
  const visible = compact ? [...events].slice(-4).reverse() : [...events].reverse();
  return (
    <div className={`timeline ${compact ? 'timeline-compact' : ''}`}>
      {visible.map((event) => (
        <article className="timeline-event" key={event.id}>
          <div className={`timeline-marker marker-${event.event_type.toLowerCase()}`}>{symbolFor(event)}</div>
          <div className="timeline-copy">
            <div className="timeline-event-head">
              <strong>{event.title}</strong>
              <time>{dateLabel(event.created_at)}</time>
            </div>
            <p>{event.description}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
