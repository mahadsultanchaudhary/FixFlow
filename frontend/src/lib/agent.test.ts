import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSafeIntentWithFireworks, routeDeterministicCommand } from './agent';
import type { Approval, Repair } from './types';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./mcp', () => ({ fixflowMcp: { call: mocks.call } }));

const repair: Repair = {
  id: 'repair-washer-2026-001', household_id: 'home-main', asset_id: 'asset-washer-01',
  title: 'Washing machine leak', description: 'Water under washer', original_report: 'It is leaking',
  status: 'BOOKED', priority: 'HIGH', next_action: 'Wait for the scheduled visit',
  current_appointment_id: 'appointment-washer-booked', created_at: '2026-10-17T12:00:00Z', updated_at: '2026-10-17T12:00:00Z',
};
const pending: Approval = {
  id: 'approval-1', approval_id: 'approval-1', incident_id: repair.id,
  action_type: 'RESCHEDULE_APPOINTMENT', status: 'PENDING',
  action_payload: { appointment_id: 'appointment-alt', slot_id: 'slot-alt' },
};
const context = {
  repair,
  activeRepairs: [repair],
  currentAppointment: null,
  approval: pending,
  budgetLimit: 250,
  requireBrandAuthorized: true,
  vendors: [],
};

afterEach(() => {
  mocks.call.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('deterministic-first agent intent routing', () => {
  it.each([
    'Vendor did not show up',
    'Vendor missed the visit',
    'No show',
    "The vendor didn't show up",
    'Book appointment',
    'Confirm booking',
    'Approve',
    'Select BrightFix Appliance Care as vendor',
    'Choose BrightFix Appliance Care at Thu, Oct 22, 10:00 AM',
    'What am I waiting for?',
  ])('does not call Fireworks for deterministic command: %s', async (command) => {
    vi.stubEnv('VITE_ENABLE_LLM_ROUTER', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const normalized = await normalizeSafeIntentWithFireworks(command, {
      repairTitle: repair.title, repairStatus: repair.status, hasPendingApproval: true, hasCurrentAppointment: false,
    });
    expect(normalized.mode).toBe('deterministic');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records a no-show against the server-verified active booking even without it in chat context', async () => {
    mocks.call.mockImplementation(async (name: string) => {
      if (name === 'get_repair') return { repair, timeline: [] };
      if (name === 'get_current_appointment') return { appointment: {
        id: 'appointment-washer-booked', status: 'BOOKED', vendor_id: 'vendor-brightfix',
        vendor_name: 'BrightFix Appliance Care', starts_at: '2026-10-19T10:00:00Z',
        ends_at: '2026-10-19T12:00:00Z', price_estimate: 25,
      } };
      if (name === 'record_vendor_no_show') return { status: 'NO_SHOW', case_open: true, appointment_id: 'appointment-washer-booked' };
      if (name === 'find_alternatives') return { options: [] };
      throw new Error(`Unexpected tool: ${name}`);
    });
    const outcome = await routeDeterministicCommand('Vendor did not show up', context);
    expect(mocks.call).toHaveBeenCalledWith('record_vendor_no_show', expect.objectContaining({
      incident_id: repair.id, appointment_id: 'appointment-washer-booked',
    }));
    expect(mocks.call).toHaveBeenCalledWith('find_alternatives', expect.objectContaining({ incident_id: repair.id, budget_limit: 250, require_brand_authorized: true }));
    expect(outcome.refresh).toBe(true);
  });

  it('refuses a no-show report when the repair has no current booked appointment', async () => {
    mocks.call.mockImplementation(async (name: string) => {
      if (name === 'get_repair') return { repair: { ...repair, current_appointment_id: null }, timeline: [] };
      if (name === 'get_current_appointment') return null;
      throw new Error(`Unexpected tool: ${name}`);
    });
    const outcome = await routeDeterministicCommand('Repair partner did not show up', context);
    expect(outcome.reply).toBe('No scheduled visit found to mark as a no-show.');
    expect(mocks.call).not.toHaveBeenCalledWith('record_vendor_no_show', expect.anything());
  });

  it('completes only the server-verified current booked appointment', async () => {
    mocks.call.mockImplementation(async (name: string) => {
      if (name === 'get_repair') return { repair, timeline: [] };
      if (name === 'get_current_appointment') return { appointment: {
        id: 'appointment-washer-booked', status: 'BOOKED', vendor_id: 'vendor-brightfix',
        vendor_name: 'BrightFix Appliance Care', starts_at: '2026-10-19T10:00:00Z',
        ends_at: '2026-10-19T12:00:00Z', price_estimate: 25,
      } };
      if (name === 'mark_repair_completed') return { status: 'AWAITING_CONFIRMATION' };
      throw new Error(`Unexpected tool: ${name}`);
    });
    const outcome = await routeDeterministicCommand('Mark the repair as completed', context);
    expect(mocks.call).toHaveBeenCalledWith('mark_repair_completed', expect.objectContaining({
      incident_id: repair.id, appointment_id: 'appointment-washer-booked',
    }));
    expect(outcome.refresh).toBe(true);
  });

  it('routes “select vendor as vendor” to MCP and checks availability locally', async () => {
    vi.stubEnv('VITE_ENABLE_LLM_ROUTER', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mocks.call.mockImplementation(async (name: string) => {
      if (name === 'select_vendor') {
        return {
          eligible: true,
          selected: true,
          vendor: {
            id: 'vendor-brightfix', name: 'BrightFix Appliance Care', reliability_score: 92,
            previous_household_jobs: 3, estimated_visit_fee: 25, estimated_repair_cost: 220,
            estimated_total_cost: 245, brand_authorized: 1, warranty_supported: 1,
            is_preferred: 1, rating: 4.8,
          },
          exclusion_reasons: [], estimated_total_cost: 245,
        };
      }
      if (name === 'get_vendor_availability') return { slots: [{
        id: 'slot-alt', slot_id: 'slot-alt', vendor_id: 'vendor-brightfix',
        starts_at: '2026-10-22T10:00:00', ends_at: '2026-10-22T11:00:00',
        label: 'Thu, Oct 22, 10:00 AM', status: 'AVAILABLE', price_estimate: 25,
      }] };
      if (name === 'check_calendar') return { available: true, conflicts: [] };
      throw new Error(`Unexpected tool: ${name}`);
    });

    const command = 'Select BrightFix Appliance Care as vendor';
    const normalized = await normalizeSafeIntentWithFireworks(command, {
      repairTitle: repair.title, repairStatus: repair.status, hasPendingApproval: false, hasCurrentAppointment: true,
    });
    const outcome = await routeDeterministicCommand(command, context);

    expect(normalized.mode).toBe('deterministic');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenNthCalledWith(1, 'select_vendor', expect.objectContaining({
      incident_id: repair.id, vendor_name: 'BrightFix Appliance Care', budget_limit: 250, require_brand_authorized: true,
    }));
    expect(mocks.call).toHaveBeenCalledWith('get_vendor_availability', { vendor_id: 'vendor-brightfix' });
    expect(mocks.call).toHaveBeenCalledWith('check_calendar', expect.objectContaining({ starts_at: '2026-10-22T10:00:00' }));
    expect(outcome.showAlternatives).toHaveLength(1);
  });

  it('sends only unfamiliar conversational questions to the backend Fireworks responder', async () => {
    vi.stubEnv('VITE_ENABLE_LLM_ROUTER', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      mode: 'fireworks-answer', provider: 'fireworks', reply: 'FixFlow keeps repair incidents open until the household confirms resolution.',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const normalized = await normalizeSafeIntentWithFireworks('What is FixFlow?', {
      repairTitle: repair.title, repairStatus: repair.status, hasPendingApproval: false, hasCurrentAppointment: true,
    });
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/api/agent/interpret'), expect.objectContaining({ method: 'POST' }));
    expect(normalized.mode).toBe('fireworks-answer');
    expect(normalized.reply).toMatch(/keeps repair incidents open/i);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('prepares the exact displayed slot for “choose vendor at time” without invoking Fireworks', async () => {
    vi.stubEnv('VITE_ENABLE_LLM_ROUTER', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const option = {
      id: 'slot-alt', slot_id: 'slot-alt', vendor_id: 'vendor-brightfix',
      vendor_name: 'BrightFix Appliance Care', starts_at: '2026-10-22T10:00:00',
      ends_at: '2026-10-22T11:00:00', price_estimate: 25,
      estimated_repair_cost: 220, estimated_visit_fee: 25, estimated_total_cost: 245,
      brand_authorized: true, reliability_score: 92, previous_household_jobs: 3, is_preferred: true,
    };
    mocks.call.mockImplementation(async (name: string) => {
      if (name === 'prepare_proposal') return { id: 'approval-prepared', approval_id: 'approval-prepared', incident_id: repair.id, action_type: 'RESCHEDULE_APPOINTMENT', status: 'PENDING' };
      throw new Error(`Unexpected tool: ${name}`);
    });
    const normalized = await normalizeSafeIntentWithFireworks('Choose BrightFix Appliance Care at 10:00 AM', {
      repairTitle: repair.title, repairStatus: repair.status, hasPendingApproval: false, hasCurrentAppointment: false,
    });
    expect(normalized.mode).toBe('deterministic');
    const outcome = await routeDeterministicCommand('Choose BrightFix Appliance Care at 10:00 AM', {
      ...context, appointmentOptions: [option],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenCalledWith('prepare_proposal', expect.objectContaining({
      incident_id: repair.id, vendor_id: 'vendor-brightfix', slot_id: 'slot-alt', budget_limit: 250, require_brand_authorized: true,
    }));
    expect(outcome.refresh).toBe(true);
  });

  it('uses approve_proposal and then book_appointment for a deterministic booking command', async () => {
    mocks.call.mockImplementation(async (name: string) => {
      if (name === 'get_pending_approval') return pending;
      if (name === 'approve_proposal') return { approval_id: 'approval-1', status: 'APPROVED' };
      if (name === 'book_appointment') return { status: 'BOOKED', appointment_id: 'appointment-alt' };
      throw new Error(`Unexpected tool: ${name}`);
    });
    const outcome = await routeDeterministicCommand('Confirm booking', context);
    expect(mocks.call).toHaveBeenCalledWith('approve_proposal', expect.objectContaining({ incident_id: repair.id, approval_id: 'approval-1' }));
    expect(mocks.call).toHaveBeenCalledWith('book_appointment', expect.objectContaining({ incident_id: repair.id, approval_id: 'approval-1' }));
    expect(outcome.toolName).toBe('book_appointment');
  });
});
