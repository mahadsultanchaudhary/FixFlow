import { StatusBadge } from './StatusBadge';
import type { Repair } from '../lib/types';

function statusHeadline(status: string): string {
  const headlines: Record<string, string> = {
    BOOKED: 'A visit is on the calendar.',
    NO_SHOW: 'The visit was missed. We’re recovering.',
    RESCHEDULING: 'We’re finding a better time.',
    WAITING_APPROVAL: 'One decision needs you.',
    AWAITING_CONFIRMATION: 'The technician is done. Are you?',
    RESOLVED: 'You confirmed it’s fixed.',
    CLOSED: 'This repair is in the history books.',
    IN_PROGRESS: 'The repair is moving forward.',
    WAITING_PART: 'We’re waiting on a part.',
  };
  return headlines[status] || 'We’re keeping this repair moving.';
}

export function RepairFocusCard({ repair, onOpen, openLabel = 'Open repair details' }: { repair: Repair; onOpen: () => void; openLabel?: string }) {
  return (
    <section className="focus-card">
      <div className="focus-ornament ornament-one" />
      <div className="focus-ornament ornament-two" />
      <div className="focus-card-top">
        <span className="eyebrow">YOUR OPEN REPAIR</span>
        <StatusBadge status={repair.status} />
      </div>
      <div className="focus-card-body">
        <div className="washer-illustration" aria-label="Washing machine illustration" role="img">
          <div className="washer-top"><span /><span /><span /></div>
          <div className="washer-screen">AUTO</div>
          <div className="washer-door"><div /></div>
          <div className="washer-foot washer-foot-left" /><div className="washer-foot washer-foot-right" />
        </div>
        <div className="focus-copy">
          <div className="asset-label">{repair.asset_brand || 'WhirlPro'} · {repair.asset_model || 'WashMate 800'}</div>
          <h2>{repair.title}</h2>
          <p>{repair.description}</p>
          <div className="focus-meta">
            <span>⌂ {repair.asset_location || 'Laundry room'}</span>
            <span>◷ {repair.priority || 'NORMAL'} priority</span>
          </div>
          <div className="focus-next">
            <span className="next-icon">✦</span>
            <span><b>Next step</b>{repair.next_action || 'Keep checking the repair until it’s resolved.'}</span>
          </div>
          <button className="button button-primary focus-open" onClick={onOpen} type="button">
            {openLabel} <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
      <div className="focus-card-bottom">
        <span className="small-lock">⌁</span>
        <span>{statusHeadline(repair.status)}</span>
        <span className="focus-promise">The repair stays on our list.</span>
      </div>
    </section>
  );
}
