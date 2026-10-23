import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import type { Approval, AppointmentOption, ConversationMessage, CurrentAppointment, Repair, TimelineEvent } from './lib/types';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  call: vi.fn(),
}));

vi.mock('./lib/mcp', () => ({ fixflowMcp: mocks }));

const baseRepair: Repair = {
  id: 'repair-washer-2026-001',
  household_id: 'home-main',
  asset_id: 'asset-washer-01',
  title: 'Washing machine leak',
  description: 'Water is collecting under the washer after a cycle.',
  original_report: 'My washing machine is leaking again.',
  status: 'BOOKED',
  priority: 'HIGH',
  next_action: 'Wait for the scheduled visit; if the vendor misses it, record the no-show and recover with alternatives.',
  current_vendor_id: 'vendor-brightfix',
  current_vendor_name: 'BrightFix Appliance Care',
  current_appointment_id: 'appointment-washer-booked',
  asset_name: 'Washing machine',
  asset_location: 'Laundry room',
  asset_brand: 'WhirlPro',
  asset_model: 'WashMate 800',
  created_at: '2026-10-17T12:00:00+00:00',
  updated_at: '2026-10-17T12:00:00+00:00',
};

const seededTimeline: TimelineEvent[] = [{
  id: 'event-1', event_type: 'APPOINTMENT_BOOKED', title: 'Visit approved and booked',
  description: 'The user approved a BrightFix visit. Booking is not proof the repair is complete.',
  created_at: '2026-10-17T12:00:00+00:00',
}];

const vendor = { id: 'vendor-brightfix', name: 'BrightFix Appliance Care', reliability_score: 92, previous_household_jobs: 3, estimated_visit_fee: 25, estimated_repair_cost: 220, estimated_total_cost: 245, brand_authorized: 1, warranty_supported: 1, warranty_relevant: true, is_preferred: 1, rating: 4.8, notes: 'Preferred simulated vendor.' };
const option: AppointmentOption = {
  slot_id: 'slot-brightfix-alt', vendor_id: 'vendor-brightfix', vendor_name: 'BrightFix Appliance Care',
  starts_at: '2026-10-20T14:00:00+05:00', ends_at: '2026-10-20T16:00:00+05:00',
  price_estimate: 25, estimated_repair_cost: 220, estimated_total_cost: 245, brand_authorized: 1, reliability_score: 92, previous_household_jobs: 3, is_preferred: 1,
};

let state: {
  repair: Repair;
  timeline: TimelineEvent[];
  appointment: CurrentAppointment | null;
  approval: Approval | null;
  messages: ConversationMessage[];
  options: AppointmentOption[];
};

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    repair: { ...baseRepair },
    timeline: [...seededTimeline],
    appointment: { appointment: {
      id: 'appointment-washer-booked', status: 'BOOKED', starts_at: '2026-10-19T10:00:00+05:00',
      ends_at: '2026-10-19T12:00:00+05:00', price_estimate: 25, vendor_id: 'vendor-brightfix', vendor_name: 'BrightFix Appliance Care',
      slot_id: 'slot-brightfix-booked', user_approved: 1,
    }, simulated: true },
    approval: null,
    options: [option],
    messages: [
      { id: 'seed-user', role: 'user', content: 'My washing machine is leaking again.', created_at: '2026-10-17T12:00:00+00:00' },
      { id: 'seed-assistant', role: 'assistant', content: 'I’ll keep this case open until you confirm the leak is fixed.', created_at: '2026-10-17T12:01:00+00:00' },
    ],
  };
  mocks.connect.mockResolvedValue({ endpoint: 'http://127.0.0.1:8000/mcp', tools: Array.from({ length: 30 }, (_, index) => `tool_${index}`) });
  mocks.call.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
    switch (name) {
      case 'list_active_repairs':
        return state.repair.status === 'CLOSED' ? [] : [{ ...state.repair }];
      case 'get_repair':
        return { repair: { ...state.repair }, timeline: [...state.timeline] };
      case 'get_repair_history':
        return [{ id: state.repair.id, title: state.repair.title, status: state.repair.status, created_at: state.repair.created_at, original_report: state.repair.original_report }, { id: 'old-washer', title: 'Washer drain hose leak', status: 'CLOSED', created_at: '2026-02-01T08:00:00Z', original_report: 'There was a small puddle behind the washer.' }];
      case 'check_warranty':
        return { asset_id: state.repair.asset_id, covered: true, status: 'ACTIVE', warranty: { plan_name: 'Appliance Care Plus', status: 'ACTIVE', ends_on: '2027-12-31', service_fee: 25, coverage_summary: 'Leak diagnosis and eligible hose/seal parts.' } };
      case 'compare_vendors':
        return { simulated: true, warranty: { covered: true }, vendors: [vendor, { id: 'vendor-rapidhome', name: 'RapidHome Repairs', reliability_score: 86, previous_household_jobs: 1, estimated_visit_fee: 35, estimated_repair_cost: 325, estimated_total_cost: 360, brand_authorized: 1, warranty_supported: 0, is_preferred: 0, rating: 4.5 }, { id: 'vendor-northstar', name: 'Northstar Appliance Service', reliability_score: 89, previous_household_jobs: 2, estimated_visit_fee: 30, estimated_repair_cost: 180, estimated_total_cost: 210, brand_authorized: 0, warranty_supported: 1, is_preferred: 0, rating: 4.7 }] };
      case 'select_vendor': {
        const vendorName = String(args.vendor_name || '').toLowerCase();
        const candidate = [vendor, { id: 'vendor-rapidhome', name: 'RapidHome Repairs', reliability_score: 86, previous_household_jobs: 1, estimated_visit_fee: 35, estimated_repair_cost: 325, estimated_total_cost: 360, brand_authorized: 1, warranty_supported: 0, is_preferred: 0, rating: 4.5 }, { id: 'vendor-northstar', name: 'Northstar Appliance Service', reliability_score: 89, previous_household_jobs: 2, estimated_visit_fee: 30, estimated_repair_cost: 180, estimated_total_cost: 210, brand_authorized: 0, warranty_supported: 1, is_preferred: 0, rating: 4.7 }].find((item) => item.name.toLowerCase().includes(vendorName));
        return { eligible: Boolean(candidate), selected: Boolean(candidate), vendor: candidate, exclusion_reasons: [], estimated_total_cost: candidate?.estimated_total_cost };
      }
      case 'get_vendor_availability':
        return { vendor, slots: [{ id: 'slot-brightfix-alt', slot_id: 'slot-brightfix-alt', vendor_id: vendor.id, starts_at: option.starts_at, ends_at: option.ends_at, label: 'Replacement appointment', status: 'AVAILABLE', price_estimate: 25, details: 'Simulated availability' }], simulated: true };
      case 'check_calendar':
        return { available: true, conflicts: [], simulated: true };
      case 'get_current_appointment':
        return state.appointment;
      case 'get_pending_approval':
        return state.approval;
      case 'get_conversation_history':
        return { session_id: 'session-demo-main', messages: [...state.messages] };
      case 'append_conversation_turn': {
        const now = new Date().toISOString();
        state.messages.push({ id: `m${state.messages.length + 1}`, role: 'user', content: String(args.user_message), created_at: now });
        state.messages.push({ id: `m${state.messages.length + 1}`, role: 'assistant', content: String(args.assistant_message), created_at: now, tool_name: String(args.tool_name || '') });
        return { session_id: 'session-demo-main', messages: [...state.messages] };
      }
      case 'record_vendor_no_show':
      case 'record_no_show':
        state.repair.status = 'NO_SHOW';
        if (state.appointment) state.appointment.appointment.status = 'NO_SHOW';
        state.timeline.push({ id: 'event-no-show', event_type: 'VENDOR_NO_SHOW', title: 'Vendor no-show recorded', description: 'The simulated vendor missed the visit. The case remains open.', created_at: new Date().toISOString() });
        return { status: 'NO_SHOW', case_open: true };
      case 'find_alternatives':
        state.repair.status = 'RESCHEDULING';
        return { incident_id: state.repair.id, options: state.options, simulated: true, approval_required: true };
      case 'prepare_proposal':
      case 'reschedule_appointment':
        state.repair.status = 'WAITING_APPROVAL';
        state.approval = { id: 'approval-alt', approval_id: 'approval-alt', incident_id: state.repair.id, action_type: 'RESCHEDULE_APPOINTMENT', status: 'PENDING', action_payload: { appointment_id: 'appointment-alt', vendor_id: option.vendor_id, vendor_name: option.vendor_name, slot_id: option.slot_id, starts_at: option.starts_at, ends_at: option.ends_at, price_estimate: option.price_estimate, estimated_visit_fee: option.price_estimate, estimated_repair_cost: option.estimated_repair_cost, estimated_total_cost: 245, brand_authorized: true } };
        state.appointment = { appointment: { id: 'appointment-alt', status: 'PROPOSED', starts_at: option.starts_at, ends_at: option.ends_at, price_estimate: option.price_estimate, vendor_id: option.vendor_id, vendor_name: option.vendor_name, slot_id: option.slot_id } };
        state.timeline.push({ id: 'event-proposal', event_type: 'APPOINTMENT_PROPOSED', title: 'Appointment proposed', description: 'The replacement appointment is awaiting explicit approval.', created_at: new Date().toISOString() });
        return { approval_id: 'approval-alt', id: 'approval-alt', incident_id: state.repair.id, action_type: 'RESCHEDULE_APPOINTMENT', appointment_id: 'appointment-alt', status: 'PENDING', proposal: state.approval.action_payload };
      case 'approve_proposal':
      case 'approve_action':
        if (state.approval) state.approval.status = 'APPROVED';
        if (state.appointment) state.appointment.appointment.status = 'APPROVED';
        return { approval_id: args.approval_id, status: 'APPROVED', ready_to_book: true };
      case 'book_appointment':
        state.repair.status = 'BOOKED';
        state.repair.current_appointment_id = 'appointment-alt';
        state.repair.current_vendor_name = option.vendor_name;
        if (state.appointment) {
          state.appointment.appointment.id = 'appointment-alt';
          state.appointment.appointment.status = 'BOOKED';
          state.appointment.appointment.vendor_name = option.vendor_name;
        }
        state.approval = null;
        state.timeline.push({ id: 'event-booked', event_type: 'APPOINTMENT_BOOKED', title: 'Replacement appointment booked', description: 'The user approved the replacement appointment.', created_at: new Date().toISOString() });
        return { appointment_id: 'appointment-alt', status: 'BOOKED', user_approved: true };
      case 'mark_repair_completed':
        state.repair.status = 'AWAITING_CONFIRMATION';
        if (state.appointment) state.appointment.appointment.status = 'COMPLETED';
        return { status: 'AWAITING_CONFIRMATION', user_confirmation_required: true };
      case 'confirm_resolution':
        state.repair.status = args.confirmed ? 'RESOLVED' : 'IN_PROGRESS';
        return { status: state.repair.status, closed: false };
      case 'close_repair':
        state.repair.status = 'CLOSED';
        return { status: 'CLOSED', history_retained: true };
      default:
        if (name === 'reset_demo_scenario') return { reset: true, active_incident_id: state.repair.id };
        throw new Error(`Unexpected MCP tool in test: ${name}`);
    }
  });
});

describe('FixFlow local prototype shell', () => {
  it('connects through the MCP service and renders the saved open repair', async () => {
    render(<App />);
    expect(await screen.findByText('Washing machine leak')).toBeInTheDocument();
    expect(screen.getByText('FixFlow is ready')).toBeInTheDocument();
    expect(screen.getByText('A visit is on the calendar.')).toBeInTheDocument();
    expect(mocks.call).toHaveBeenCalledWith('get_repair', { incident_id: 'repair-washer-2026-001' });
  });

  it('records a no-show, shows replacement slots, and requires approval before booking', async () => {
    render(<App />);
    await screen.findByText('Washing machine leak');
    fireEvent.click(screen.getByRole('button', { name: 'Simulate Partner No-Show' }));

    expect(await screen.findByText('Let’s find a better time.')).toBeInTheDocument();
    expect(mocks.call).toHaveBeenCalledWith('record_vendor_no_show', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', appointment_id: 'appointment-washer-booked',
    }));
    expect(mocks.call).toHaveBeenCalledWith('find_alternatives', expect.objectContaining({ incident_id: 'repair-washer-2026-001', budget_limit: 250, require_brand_authorized: true }));

    const chooseInitialTime = await screen.findByRole('button', { name: /Choose time/i });
    await waitFor(() => expect(chooseInitialTime).toBeEnabled());
    fireEvent.click(chooseInitialTime);
    expect(await screen.findByRole('heading', { name: /Approve the new visit/i })).toBeInTheDocument();
    const approvalCard = screen.getByRole('region', { name: 'Appointment approval' });
    expect(within(approvalCard).getByText(/Nothing is booked until you approve/i)).toBeInTheDocument();
    expect(within(approvalCard).getByText('BrightFix Appliance Care')).toBeInTheDocument();
    expect(within(approvalCard).getByText('$245')).toBeInTheDocument();
    expect(within(approvalCard).queryByText('Time pending')).not.toBeInTheDocument();

    const approveButton = screen.getByRole('button', { name: /Approve & book/i });
    await waitFor(() => expect(approveButton).toBeEnabled());
    fireEvent.click(approveButton);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('approve_action', expect.objectContaining({ approval_id: 'approval-alt', decision: 'APPROVED' })));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('book_appointment', expect.objectContaining({ approval_id: 'approval-alt' })));
    await waitFor(() => expect(screen.getAllByText(/Visit scheduled/i).length).toBeGreaterThan(0));
    expect(state.repair.status).toBe('BOOKED');
    expect(state.timeline.some((event) => event.event_type === 'VENDOR_NO_SHOW')).toBe(true);
    expect(await screen.findByText('Visit Scheduled with BrightFix Appliance Care')).toBeInTheDocument();
    expect(screen.getByText('Current Booked Partner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select RapidHome Repairs as repair partner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Simulate Partner No-Show' })).toBeEnabled();
    const completeVisit = screen.getByRole('button', { name: 'Simulate Visit Completed' });
    await waitFor(() => expect(completeVisit).toBeEnabled());
    fireEvent.click(completeVisit);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('mark_repair_completed', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', appointment_id: 'appointment-alt',
    })));
    expect(await screen.findByText('Is the washing machine actually fixed?')).toBeInTheDocument();
    expect(state.repair.status).toBe('AWAITING_CONFIRMATION');
  }, 15000);

  it('disables visit outcome actions when the repair has no active booked appointment', async () => {
    state.repair.current_appointment_id = null;
    state.appointment = null;
    render(<App />);
    await screen.findByText('Washing machine leak');
    const noShow = screen.getByRole('button', { name: 'Simulate Partner No-Show' });
    expect(noShow).toBeDisabled();
    expect(screen.getByText('No scheduled visit found to mark as a no-show.')).toBeInTheDocument();
    fireEvent.click(noShow);
    expect(mocks.call).not.toHaveBeenCalledWith('record_vendor_no_show', expect.anything());
  });

  it('lets the user select an eligible vendor, choose a time, and approve that exact proposal', async () => {
    render(<App />);
    await screen.findByText('Washing machine leak');

    fireEvent.click(screen.getByRole('button', { name: 'Simulate Partner No-Show' }));
    await screen.findByRole('heading', { name: /Let’s find a better time/i });
    await waitFor(() => expect(screen.getByRole('button', { name: /Select BrightFix Appliance Care as repair partner/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Select BrightFix Appliance Care as repair partner/i }));
    expect(await screen.findByRole('heading', { name: /Choose a time with BrightFix Appliance Care/i })).toBeInTheDocument();
    expect(mocks.call).toHaveBeenCalledWith('get_vendor_availability', { vendor_id: 'vendor-brightfix' });
    expect(mocks.call).toHaveBeenCalledWith('check_calendar', expect.objectContaining({
      starts_at: option.starts_at, ends_at: option.ends_at, household_id: 'home-main',
    }));

    const chooseTime = await screen.findByRole('button', { name: /Choose time/i });
    await waitFor(() => expect(chooseTime).toBeEnabled());
    fireEvent.click(chooseTime);
    expect(await screen.findByRole('heading', { name: /Approve the new visit/i })).toBeInTheDocument();
    const approveButton = screen.getByRole('button', { name: /Approve & book/i });
    await waitFor(() => expect(approveButton).toBeEnabled());
    fireEvent.click(approveButton);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('approve_action', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', approval_id: 'approval-alt', decision: 'APPROVED',
    })));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('book_appointment', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', approval_id: 'approval-alt',
    })));
  }, 15000);

  it('shows a $250 budget and clearly explains mock-vendor exclusions', async () => {
    render(<App />);
    await screen.findByText('Washing machine leak');
    expect((screen.getByLabelText('Repair budget slider') as HTMLInputElement).value).toBe('250');
    expect(screen.getByLabelText(/Official brand-authorized only/)).toBeChecked();
    expect(screen.getByText(/Over budget by \$110/i)).toBeInTheDocument();
    expect(screen.getByText(/Not marked brand-authorized/i)).toBeInTheDocument();
  });

  it('routes “book appointment” through the exact pending approval ID', async () => {
    render(<App />);
    await screen.findByText('Washing machine leak');
    fireEvent.click(screen.getByRole('button', { name: 'Simulate Partner No-Show' }));
    const firstChooseTime = await screen.findByRole('button', { name: /Choose time/i });
    await waitFor(() => expect(firstChooseTime).toBeEnabled());
    fireEvent.click(firstChooseTime);
    await screen.findByRole('heading', { name: /Approve the new visit/i });
    const input = screen.getByRole('textbox', { name: /Tell FixFlow what happened/i });
    fireEvent.change(input, { target: { value: 'Book appointment' } });
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('approve_proposal', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', approval_id: 'approval-alt',
    })));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('book_appointment', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', approval_id: 'approval-alt',
    })));
    expect(screen.queryByText(/no valid pending proposal ID/i)).not.toBeInTheDocument();
  });

  it('keeps the proposal ID from the selected card if the pending-approval read-back is temporarily empty', async () => {
    render(<App />);
    await screen.findByText('Washing machine leak');
    fireEvent.click(screen.getByRole('button', { name: 'Simulate Partner No-Show' }));
    const firstChooseTime = await screen.findByRole('button', { name: /Choose time/i });
    await waitFor(() => expect(firstChooseTime).toBeEnabled());
    fireEvent.click(firstChooseTime);
    await screen.findByRole('heading', { name: /Approve the new visit/i });

    const currentImplementation = mocks.call.getMockImplementation();
    mocks.call.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === 'get_pending_approval') return null;
      if (currentImplementation) return currentImplementation(name, args);
      throw new Error(`Unexpected MCP tool in test: ${name}`);
    });

    const approveButton = screen.getByRole('button', { name: /Approve & book/i });
    await waitFor(() => expect(approveButton).toBeEnabled());
    fireEvent.click(approveButton);
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('approve_action', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', approval_id: 'approval-alt', decision: 'APPROVED',
    })));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('book_appointment', expect.objectContaining({
      incident_id: 'repair-washer-2026-001', approval_id: 'approval-alt',
    })));
  }, 15000);

});
