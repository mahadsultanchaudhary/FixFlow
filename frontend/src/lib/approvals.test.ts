import { describe, expect, it } from 'vitest';
import { approvalIdentifier, normalizeApprovalRecord, normalizeProposalApproval } from './approvals';

const payload = {
  appointment_id: 'appt-proposed',
  vendor_id: 'vendor-brightfix',
  vendor_name: 'BrightFix Appliance Care',
  slot_id: 'slot-brightfix-alt',
  starts_at: '2026-10-22T13:00:00+00:00',
  estimated_repair_cost: 220,
  estimated_visit_fee: 25,
  estimated_total_cost: 245,
};

describe('approval ID normalization', () => {
  it('unwraps MCP and application envelopes without losing the server approval ID', () => {
    const raw = { structuredContent: { ok: true, data: { ok: true, data: {
      id: 'approval-live-123', incident_id: 'repair-washer-2026-001',
      action_type: 'RESCHEDULE_APPOINTMENT', status: 'PENDING', action_payload: payload,
    } } } };
    const approval = normalizeApprovalRecord(raw);
    expect(approval?.id).toBe('approval-live-123');
    expect(approval?.approval_id).toBe('approval-live-123');
    expect(approval?.action_payload?.vendor_name).toBe('BrightFix Appliance Care');
    expect(approvalIdentifier(approval)).toBe('approval-live-123');
  });

  it('normalizes proposal-return shape and never invents an ID', () => {
    const proposal = normalizeProposalApproval({
      ok: true,
      data: { approval_id: 'approval-live-456', id: 'approval-live-456', incident_id: 'repair-washer-2026-001', status: 'PENDING', proposal: payload },
    }, 'repair-washer-2026-001');
    expect(proposal?.id).toBe('approval-live-456');
    expect(proposal?.action_payload?.estimated_total_cost).toBe(245);
    expect(normalizeProposalApproval({ status: 'PENDING', proposal: payload }, 'repair-washer-2026-001')).toBeNull();
  });
});
