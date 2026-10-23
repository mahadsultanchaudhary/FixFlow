import type { Approval, CurrentAppointment, Vendor } from '../lib/types';

function money(value: number | undefined): string {
  if (typeof value !== 'number') return 'Estimate unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function dateTime(value: string | undefined): string {
  if (!value) return 'Time pending';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PK', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }).format(date);
}

export function ApprovalCard({
  approval,
  currentAppointment,
  vendors,
  onApprove,
  onReject,
  disabled,
}: {
  approval: Approval;
  currentAppointment: CurrentAppointment | null;
  vendors: Vendor[];
  onApprove: () => void;
  onReject: () => void;
  disabled: boolean;
}) {
  const proposal = approval.action_payload || {};
  const repairEstimate = typeof proposal.estimated_repair_cost === 'number' ? proposal.estimated_repair_cost : undefined;
  const visitFee = typeof proposal.estimated_visit_fee === 'number' ? proposal.estimated_visit_fee : (typeof proposal.price_estimate === 'number' ? proposal.price_estimate : currentAppointment?.appointment?.price_estimate);
  const totalEstimate = typeof proposal.estimated_total_cost === 'number' ? proposal.estimated_total_cost : (typeof repairEstimate === 'number' ? repairEstimate + (visitFee ?? 0) : undefined);
  const current = currentAppointment?.appointment;
  const proposalVendor = vendors.find((vendor) => vendor.id === proposal.vendor_id);
  const currentMatchesProposal = !proposal.vendor_id || current?.vendor_id === proposal.vendor_id;
  const vendorName = (typeof proposal.vendor_name === 'string' ? proposal.vendor_name : undefined) || proposalVendor?.name || (currentMatchesProposal ? (current?.service_provider_name || current?.vendor_name) : undefined) || 'Selected repair partner';
  const startsAt = typeof proposal.starts_at === 'string' ? proposal.starts_at : current?.starts_at;
  const amount = typeof proposal.price_estimate === 'number' ? proposal.price_estimate : current?.price_estimate;
  return (
    <section className="approval-card" aria-label="Appointment approval" data-approval-id={approval.approval_id || approval.id} data-incident-id={approval.incident_id}>
      <div className="approval-card-head">
        <span className="approval-symbol">✋</span>
        <div>
          <span className="eyebrow">YOUR DECISION</span>
          <h3>{approval.status === 'APPROVED' ? 'Your approval is saved.' : 'Approve the new visit?'}</h3>
        </div>
        <span className="approval-state">{approval.status === 'APPROVED' ? 'Approved' : 'Pending'}</span>
      </div>
      <p className="approval-intro">{approval.status === 'APPROVED' ? 'Your choice is recorded. Finish the simulated booking below; no payment is taken.' : 'FixFlow found a replacement that fits the household calendar. Nothing is booked until you approve this exact proposal.'}</p>
      <div className="approval-details">
        <div><span>Repair partner</span><strong>{vendorName}</strong></div>
        <div><span>Proposed time</span><strong>{dateTime(startsAt)}</strong></div>
        <div><span>Estimated all-in total</span><strong>{money(totalEstimate)}</strong></div>
        <div><span>Repair work estimate</span><strong>{money(repairEstimate)}</strong></div>
        <div><span>Simulated visit fee</span><strong>{money(visitFee ?? amount)}</strong></div>
      </div>
      <div className="approval-safety">ⓘ Simulated estimate only. Approval is not payment authorization, and FixFlow never processes payments.</div>
      <div className="approval-actions">
        <button className="button button-primary" disabled={disabled} onClick={onApprove} type="button">{approval.status === 'APPROVED' ? 'Finish booking' : 'Approve & book'}</button>
        <button className="button button-quiet" disabled={disabled || approval.status === 'APPROVED'} onClick={onReject} type="button">Reject proposal</button>
      </div>
    </section>
  );
}
