import { describe, expect, it } from 'vitest';
import { FixFlowMcpClient, unwrapToolEnvelope } from './mcp';

describe('MCP response envelopes', () => {
  it('unwraps SDK structured-content results before application envelopes', () => {
    const appointment = { id: 'appointment-1', status: 'BOOKED' };
    expect(unwrapToolEnvelope({ result: { ok: true, data: { appointment } } })).toEqual({ appointment });
  });

  it('preserves business result fields that are not MCP envelopes', () => {
    const businessResult = { code: 'SUCCESS' };
    expect(unwrapToolEnvelope({ result: businessResult })).toEqual({ result: businessResult });
  });

  it('surfaces errors nested in SDK structured-content results', () => {
    expect(() => unwrapToolEnvelope({ result: { ok: false, error: 'Appointment not found' } }))
      .toThrow('Appointment not found');
  });
});

describe('consequential MCP action safeguards', () => {
  it.each(['approve_action', 'reject_action', 'book_appointment'])('%s refuses to send without an exact approval_id', async (toolName) => {
    const client = new FixFlowMcpClient();
    await expect(client.call(toolName, { incident_id: 'repair-washer-2026-001' })).rejects.toThrow(/approval_id is required/i);
  });

  it('refuses a blank approval_id', async () => {
    const client = new FixFlowMcpClient();
    await expect(client.call('approve_action', { incident_id: 'repair-washer-2026-001', approval_id: '   ', decision: 'APPROVED' })).rejects.toThrow(/approval_id is required/i);
  });
});
