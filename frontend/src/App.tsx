import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApprovalCard } from './components/ApprovalCard';
import { ConversationPanel } from './components/ConversationPanel';
import { RepairFocusCard } from './components/RepairFocusCard';
import { StatusBadge } from './components/StatusBadge';
import { Timeline } from './components/Timeline';
import { AlternativeOptions, VendorComparison } from './components/VendorOptions';
import { normalizeSafeIntentWithFireworks, routeDeterministicCommand, type AgentOutcome } from './lib/agent';
import { normalizeApprovalRecord, normalizeProposalApproval } from './lib/approvals';
import { fixflowMcp } from './lib/mcp';
import type {
  Approval,
  AppView,
  AppointmentOption,
  ChatMessage,
  ConversationMessage,
  CurrentAppointment,
  HistoricalRepair,
  Repair,
  RepairDetail,
  TimelineEvent,
  Vendor,
  Warranty,
} from './lib/types';
import { isRecord, toErrorMessage } from './lib/types';
import './index.css';

const DEMO_REPAIR_ID = 'repair-washer-2026-001';
const initialChat: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: 'I’m keeping an eye on the washing-machine leak. A previous hose repair and a simulated active warranty are on file. I’ll keep this case open until you confirm it’s fixed.',
  },
];

function conversationToChat(items: ConversationMessage[]): ChatMessage[] {
  const messages = items
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .map((item) => ({
      id: item.id,
      role: item.role as 'user' | 'assistant',
      content: item.content,
      timestamp: item.created_at,
    }));
  return messages.length ? messages.slice(-24) : initialChat;
}

function formatDate(value: string | undefined, withTime = false): string {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-PK', withTime
    ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatMoney(value: number | undefined): string {
  if (typeof value !== 'number') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function IconMark({ name }: { name: string }) {
  const shapes: Record<string, string> = {
    home: '⌂',
    repair: '✦',
    history: '↺',
    settings: '⚙',
    arrow: '↗',
  };
  return <span className="nav-glyph" aria-hidden="true">{shapes[name] || '•'}</span>;
}

function WarrantyCard({ warranty }: { warranty: Warranty | null }) {
  const covered = Boolean(warranty?.covered);
  return (
    <section className="surface-card warranty-card">
      <div className="warranty-heading">
        <div className="warranty-icon">◈</div>
        <div><span className="eyebrow">WARRANTY CHECK</span><h3>{covered ? 'Coverage on file' : 'Coverage needs review'}</h3></div>
      </div>
      <p>{warranty?.warranty?.plan_name || warranty?.message || 'Checking the simulated household warranty…'}</p>
      <div className="warranty-footer">
        <span className={`coverage-label ${covered ? 'covered' : 'uncovered'}`}><span />{covered ? 'Active in demo' : 'Not confirmed'}</span>
        <span>{warranty?.warranty?.ends_on ? `Through ${formatDate(warranty.warranty.ends_on)}` : 'Simulated record'}</span>
      </div>
      {covered && <p className="warranty-disclaimer">Eligible leak diagnosis and some hose/seal parts may be covered. This is not a real claim.</p>}
    </section>
  );
}

function ActionCard({ repair, hasActiveBookedAppointment, bookedVendorName, onCommand, busy }: {
  repair: Repair;
  hasActiveBookedAppointment: boolean;
  bookedVendorName: string | null;
  onCommand: (command: string) => void;
  busy: boolean;
}) {
  const actions: Array<{ title: string; description: string; label: string; command: string; tone?: string; disabled?: boolean }> = [];
  if (repair.status === 'BOOKED' || repair.status === 'VISIT_SCHEDULED' || repair.status === 'EXPECTED_VISIT') {
    const description = hasActiveBookedAppointment
      ? 'Record the simulated visit outcome. The case stays open until you confirm the repair is fixed.'
      : 'A current booked appointment could not be verified. Refresh the repair before recording a visit outcome.';
    actions.push({ title: 'Visit completed', description, label: 'Simulate Visit Completed', command: 'Mark the repair as completed', tone: 'green', disabled: !hasActiveBookedAppointment });
    actions.push({ title: 'Repair partner missed the visit', description: hasActiveBookedAppointment ? 'Record the missed visit and find replacement times without closing the repair.' : 'No scheduled visit found to mark as a no-show.', label: 'Simulate Partner No-Show', command: 'Repair partner did not show up', tone: 'amber', disabled: !hasActiveBookedAppointment });
  } else if (repair.status === 'NO_SHOW' || repair.status === 'RESCHEDULING' || repair.status === 'OPTIONS_READY') {
    actions.push({ title: 'Find a replacement time', description: 'Choose a conflict-free simulated slot. Booking still requires your approval.', label: 'Find alternatives', command: 'Find another appointment', tone: 'amber' });
  } else if (repair.status === 'AWAITING_CONFIRMATION') {
    // The dedicated confirmation banner below owns this explicit decision.
  } else if (repair.status === 'RESOLVED') {
    actions.push({ title: 'Ready to close the case?', description: 'You confirmed the repair. Close it only if you’re ready to keep it in history as complete.', label: 'Close repair case', command: 'Close repair case', tone: 'green' });
  } else if (repair.status === 'CLOSED') {
    actions.push({ title: 'Case safely filed', description: 'This repair is closed and retained in household history. Reset the demo to replay it.', label: 'Reset demo', command: 'Reset demo' });
  }

  if (!actions.length) return null;
  return (
    <section className="surface-card action-card">
      <div className="section-heading"><div><span className="eyebrow">SUGGESTED NEXT STEP</span><h3>Keep the repair moving</h3></div><span className="action-spark">✦</span></div>
      {hasActiveBookedAppointment && <div className="booking-status-banner" role="status">
        <strong>{bookedVendorName ? `Visit Scheduled with ${bookedVendorName}` : 'Booking Approved — Waiting for repair visit'}</strong>
        <span>Your appointment is booked. Choose a visit outcome below when it happens.</span>
      </div>}
      {actions.map((action) => (
        <div className="next-action-item" key={action.title}>
          <div className={`action-emblem ${action.tone || ''}`}>{action.tone === 'green' ? '✓' : action.tone === 'amber' ? '↗' : '✦'}</div>
          <div className="next-action-copy"><strong>{action.title}</strong><p>{action.description}</p></div>
          <button className={`button ${action.tone === 'green' ? 'button-primary' : 'button-outline'} action-button`} onClick={() => onCommand(action.command)} disabled={busy || Boolean(action.disabled)} type="button">{action.label}</button>
        </div>
      ))}
    </section>
  );
}

function IncidentDetails({ repair, appointment }: { repair: Repair; appointment: CurrentAppointment | null }) {
  const slot = appointment?.appointment;
  return (
    <section className="surface-card incident-details">
      <div className="section-heading"><div><span className="eyebrow">REPAIR DETAILS</span><h3>Everything in one place.</h3></div><StatusBadge status={repair.status} /></div>
      <div className="detail-grid">
        <div className="detail-item"><span>Appliance</span><strong>{repair.asset_name || 'Household appliance'}</strong><small>{[repair.asset_brand, repair.asset_model].filter(Boolean).join(' · ') || 'Model recorded in household'}</small></div>
        <div className="detail-item"><span>Location</span><strong>{repair.asset_location || 'Household'}</strong><small>Household asset record</small></div>
        <div className="detail-item"><span>Repair partner</span><strong>{repair.booking_status === 'PROPOSED' ? 'Awaiting your approval' : slot?.service_provider_name || slot?.vendor_name || repair.current_service_provider_name || repair.current_vendor_name || 'Not selected'}</strong><small>{repair.booking_status === 'PROPOSED' ? 'Review the proposed provider in the approval card' : slot ? 'Simulated repair partner' : 'Repair partner details pending'}</small></div>
        <div className="detail-item"><span>Appointment</span><strong>{repair.booking_status === 'PROPOSED' ? 'Proposed time · not booked' : slot ? formatDate(slot.starts_at, true) : 'No current appointment'}</strong><small>{repair.booking_status === 'PROPOSED' ? 'Nothing is booked until you approve the proposal' : slot ? `${slot.status.replaceAll('_', ' ').toLowerCase()} · ${formatMoney(slot.price_estimate)} estimate` : 'A proposal requires approval'}</small>{repair.booking_status && <small>Booking record · {repair.booking_status.replaceAll('_', ' ').toLowerCase()}</small>}</div>
      </div>
      <div className="detail-original"><span>ORIGINAL REPORT</span><p>“{repair.original_report}”</p></div>
    </section>
  );
}

function HistoryList({ items }: { items: HistoricalRepair[] }) {
  return (
    <div className="history-list">
      {items.map((item, index) => (
        <article className="history-item" key={item.id}>
          <div className={`history-check ${item.status === 'CLOSED' || item.status === 'RESOLVED' ? 'history-complete' : ''}`}>{item.status === 'CLOSED' || item.status === 'RESOLVED' ? '✓' : index + 1}</div>
          <div className="history-content"><div className="history-item-head"><strong>{item.title}</strong><StatusBadge status={item.status} /></div><p>{item.original_report}</p><span>{formatDate(item.created_at)}{item.closed_at ? ` · closed ${formatDate(item.closed_at)}` : ' · retained in history'}</span></div>
        </article>
      ))}
      {!items.length && <div className="empty-state">No repair history has been found for this appliance yet.</div>}
    </div>
  );
}


export default function App() {
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [activeRepairs, setActiveRepairs] = useState<Repair[]>([]);
  const [repair, setRepair] = useState<Repair | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [history, setHistory] = useState<HistoricalRepair[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [warranty, setWarranty] = useState<Warranty | null>(null);
  const [currentAppointment, setCurrentAppointment] = useState<CurrentAppointment | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [alternatives, setAlternatives] = useState<AppointmentOption[] | null>(null);
  const [alternativesVendorName, setAlternativesVendorName] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialChat);
  const [view, setView] = useState<AppView>('home');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [budgetLimit, setBudgetLimit] = useState(250);
  const [requireBrandAuthorized, setRequireBrandAuthorized] = useState(true);

  const loadRepair = useCallback(async (incidentId: string) => {
    const detail = await fixflowMcp.call<RepairDetail>('get_repair', { incident_id: incidentId });
    const activeListPromise = fixflowMcp.call<Repair[]>('list_active_repairs');
    const historyPromise = fixflowMcp.call<HistoricalRepair[]>('get_repair_history', { incident_id: incidentId });
    const warrantyPromise = fixflowMcp.call<Warranty>('check_warranty', { asset_id: detail.repair.asset_id });
    const comparisonPromise = fixflowMcp.call<{ vendors?: Vendor[] }>('compare_vendors', { asset_id: detail.repair.asset_id });
    const appointmentPromise = fixflowMcp.call<CurrentAppointment | null>('get_current_appointment', { incident_id: incidentId });
    const approvalPromise = fixflowMcp.call<Approval | null>('get_pending_approval', { incident_id: incidentId });
    const conversationPromise = fixflowMcp.call<{ session_id: string | null; messages: ConversationMessage[] }>('get_conversation_history', { incident_id: incidentId });
    const [activeList, repairHistory, warrantyData, comparison, appointment, pendingApprovalRaw, conversation] = await Promise.all([
      activeListPromise, historyPromise, warrantyPromise, comparisonPromise, appointmentPromise, approvalPromise, conversationPromise,
    ]);
    const pendingApproval = normalizeApprovalRecord(pendingApprovalRaw);
    setRepair(detail.repair);
    setTimeline(detail.timeline ?? []);
    setActiveRepairs(activeList);
    setHistory(repairHistory);
    setWarranty(warrantyData);
    setVendors(comparison.vendors ?? []);
    setCurrentAppointment(appointment);
    setApproval(pendingApproval);
    setMessages(conversationToChat(conversation.messages ?? []));
  }, []);

  const refreshSnapshot = useCallback(async (preferredId?: string) => {
    await fixflowMcp.connect();
    setConnectionState('connected');
    const list = await fixflowMcp.call<Repair[]>('list_active_repairs');
    setActiveRepairs(list);
    const requestedId = preferredId || repair?.id;
    const best = requestedId
      ? list.find((item) => item.id === requestedId) || (requestedId === DEMO_REPAIR_ID || requestedId === repair?.id ? { id: requestedId } as Repair : undefined)
      : list.find((item) => `${item.title} ${item.asset_name ?? ''}`.toLowerCase().includes('wash')) || list[0];
    if (!best) {
      setRepair(null);
      setTimeline([]);
      setHistory([]);
      setCurrentAppointment(null);
      setApproval(null);
      setMessages(initialChat);
      return;
    }
    await loadRepair(best.id);
  }, [loadRepair, repair]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await refreshSnapshot(DEMO_REPAIR_ID);
        if (alive) setConnectionState('connected');
      } catch (caught) {
        if (alive) {
          setConnectionState('error');
          setError(toErrorMessage(caught));
        }
      }
    })();
    return () => { alive = false; };
  }, []); // one initial connection; actions refresh explicitly

  const openRepairs = useMemo(() => activeRepairs.filter((item) => item.status !== 'CLOSED'), [activeRepairs]);
  const needsDecision = Boolean(approval);
  const hasActiveBookedAppointment = Boolean(
    repair?.current_appointment_id
    && currentAppointment?.appointment?.id === repair.current_appointment_id
    && currentAppointment.appointment.status === 'BOOKED'
    && ['BOOKED', 'VISIT_SCHEDULED', 'EXPECTED_VISIT'].includes(repair.status),
  );
  const bookedVendor = vendors.find((vendor) => vendor.id === repair?.current_vendor_id);
  const bookedVendorName = currentAppointment?.appointment?.service_provider_name
    || currentAppointment?.appointment?.vendor_name
    || repair?.current_service_provider_name
    || repair?.current_vendor_name
    || bookedVendor?.name
    || null;

  const saveTurn = useCallback(async (incidentId: string, userMessage: string, assistantMessage: string, toolName?: string, toolPayload?: Record<string, unknown>) => {
    const args: Record<string, unknown> = {
      incident_id: incidentId,
      user_message: userMessage,
      assistant_message: assistantMessage,
      tool_name: toolName || '',
    };
    if (toolPayload && isRecord(toolPayload)) args.tool_payload = toolPayload;
    const saved = await fixflowMcp.call<{ messages: ConversationMessage[] }>('append_conversation_turn', args);
    setMessages(conversationToChat(saved.messages ?? []));
  }, []);

  const runCommand = useCallback(async (command: string) => {
    if (!command.trim() || busy) return;
    const selectedId = repair?.id;
    const userBubble: ChatMessage = { id: `local-user-${Date.now()}`, role: 'user', content: command, timestamp: new Date().toISOString() };
    setMessages((old) => [...old, userBubble]);
    setBusy(true);
    setError('');
    try {
      const normalized = await normalizeSafeIntentWithFireworks(command, {
        repairTitle: repair?.title,
        repairStatus: repair?.status,
        hasPendingApproval: Boolean(approval?.id || approval?.approval_id),
        hasCurrentAppointment: Boolean(currentAppointment?.appointment?.id),
      });
      let commandApproval = approval;
      // Spoken/typed booking is an explicit decision only when a saved proposal
      // exists. Read the repair-scoped approval from MCP immediately before the
      // router handles it; the state-machine still validates it again server-side.
      if (repair && /\b(approve|book (?:the )?appointment|confirm booking|yes,? book|go ahead and book|confirm (?:the )?appointment)\b/i.test(command)) {
        try {
          const liveApproval = normalizeApprovalRecord(
            await fixflowMcp.call<unknown>('get_pending_approval', { incident_id: repair.id }),
          );
          if (liveApproval?.incident_id === repair.id && ['PENDING', 'APPROVED'].includes(String(liveApproval.status).toUpperCase())) {
            commandApproval = liveApproval;
            setApproval(liveApproval);
          }
        } catch { /* route will use the visible card only if it has a valid exact ID */ }
      }
      const outcome: AgentOutcome = normalized.reply
        ? { reply: normalized.reply }
        : await routeDeterministicCommand(normalized.command, {
            repair,
            activeRepairs,
            currentAppointment,
            approval: commandApproval,
            budgetLimit,
            requireBrandAuthorized,
            vendors,
            appointmentOptions: alternatives ?? [],
          });
      if (outcome.navigate) setView(outcome.navigate);
      if (outcome.clearAlternatives) {
        setAlternatives(null);
        setAlternativesVendorName(null);
      }
      if (outcome.showAlternatives) {
        setAlternatives(outcome.showAlternatives);
        setAlternativesVendorName(outcome.selectedVendorName ?? null);
      }
      if (outcome.repairList) setActiveRepairs(outcome.repairList);
      if (outcome.repairHistory) setHistory(outcome.repairHistory);
      if (outcome.vendors) setVendors(outcome.vendors);
      if (outcome.warranty) setWarranty(outcome.warranty);
      if (outcome.toolName === 'reject_action' || outcome.toolName === 'book_appointment' || outcome.resetDemo) {
        setAlternatives(null);
        setAlternativesVendorName(null);
      }

      let targetId = selectedId;
      if (outcome.toolName === 'create_repair' && outcome.toolPayload && typeof outcome.toolPayload.incident_id === 'string') {
        targetId = outcome.toolPayload.incident_id;
      }
      if (outcome.resetDemo) targetId = DEMO_REPAIR_ID;

      if (outcome.refresh || outcome.resetDemo || outcome.toolName === 'create_repair') {
        await refreshSnapshot(targetId || DEMO_REPAIR_ID);
      }
      if (outcome.resetDemo) {
        setMessages((old) => [
          ...old.filter((item) => item.id !== userBubble.id),
          { ...userBubble, id: `reset-user-${Date.now()}` },
          { id: `reset-assistant-${Date.now()}`, role: 'assistant', content: outcome.reply },
        ]);
      } else if (targetId) {
        try {
          await saveTurn(targetId, command, outcome.reply, outcome.toolName, outcome.toolPayload);
        } catch (saveError) {
          setMessages((old) => [...old, { id: `local-assistant-${Date.now()}`, role: 'assistant', content: outcome.reply }]);
          setError(`The repair action completed, but the conversation turn could not be saved: ${toErrorMessage(saveError)}`);
        }
      } else {
        setMessages((old) => [...old, { id: `local-assistant-${Date.now()}`, role: 'assistant', content: outcome.reply }]);
      }
    } catch (caught) {
      const message = toErrorMessage(caught);
      setError(message);
      setMessages((old) => [...old, { id: `error-assistant-${Date.now()}`, role: 'assistant', content: `I couldn’t finish that action: ${message}. The repair remains saved; you can retry or use the suggested buttons.` }]);
      try {
        await refreshSnapshot(selectedId);
      } catch {
        // Keep the operation error visible if refresh is not available.
      }
    } finally {
      setBusy(false);
    }
  }, [activeRepairs, alternatives, approval, budgetLimit, busy, currentAppointment, repair, refreshSnapshot, requireBrandAuthorized, saveTurn, vendors]);

  const approveProposal = useCallback(async (visibleProposal?: Approval) => {
    const selectedRepair = repair;
    if (busy) return;
    if (!selectedRepair?.id) {
      setError('Choose a repair before approving a visit.');
      return;
    }
    // Re-read the persisted proposal every time. If the HTTP tool response is
    // temporarily unavailable, the exact ID from the visible card is a safe
    // fallback because approve_action and book_appointment revalidate it server-side.
    let pendingApproval: Approval | null = null;
    try {
      pendingApproval = normalizeApprovalRecord(await fixflowMcp.call<unknown>('get_pending_approval', { incident_id: selectedRepair.id }));
    } catch { /* use a validated visible-card fallback below */ }
    const actionable = (candidate: Approval | null) => Boolean(
      candidate && candidate.incident_id === selectedRepair.id
      && typeof (candidate.approval_id || candidate.id) === 'string'
      && String(candidate.approval_id || candidate.id).trim()
      && ['PENDING', 'APPROVED'].includes(String(candidate.status).toUpperCase()),
    );
    const visible = normalizeApprovalRecord(visibleProposal) || normalizeApprovalRecord(approval);
    if (actionable(pendingApproval) && pendingApproval) {
      const persistedId = String(pendingApproval.approval_id || pendingApproval.id);
      const visibleId = visible ? String(visible.approval_id || visible.id) : '';
      // If the card and server disagree, don't silently book a different proposal.
      if (!visibleId || visibleId === persistedId) {
        setApproval(pendingApproval);
      } else {
        const visibleSlot = visible?.action_payload?.slot_id;
        const persistedSlot = pendingApproval.action_payload?.slot_id;
        if (visibleSlot && persistedSlot && visibleSlot === persistedSlot) {
          setApproval(pendingApproval);
        } else {
          setError('The saved proposal changed while this card was open. Refresh the repair, review the repair partner and time, then approve again. No booking was attempted.');
          return;
        }
      }
    } else if (actionable(visible) && visible) {
      // A temporary read-back failure should not discard the exact, persisted-ID
      // proposal already displayed. The server revalidates its status and slot.
      pendingApproval = visible;
    } else {
      setError('No actionable appointment proposal is available for this repair. Choose an eligible replacement time; no approval or booking was sent. ');
      return;
    }
    if (!pendingApproval) return;
    const pendingId = String(pendingApproval.approval_id || pendingApproval.id || '').trim();
    if (!pendingId || !actionable(pendingApproval)) {
      setError('The proposal identifier is missing or no longer actionable. Refresh the repair and select a current proposal; no booking was sent. ');
      return;
    }

    const userMessage = 'Book appointment';
    const assistantReply = 'Your approval is recorded against this exact proposal, and the simulated appointment is booked. The repair remains open until the visit is completed and you confirm the appliance is fixed.';
    setBusy(true);
    setError('');
    setMessages((old) => [...old, {
      id: `approval-user-${Date.now()}`,
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    }]);

    try {
      // Use the ID from the exact card the user approved; never ask an intent
      // router or LLM to reconstruct the approval identifier.
      const approvalId = pendingId;
      if (typeof approvalId !== 'string' || !approvalId.trim()) throw new Error('The proposal has no approval identifier; no booking was attempted.');
      const decision = String(pendingApproval.status).toUpperCase() === 'APPROVED'
        ? { approval_id: approvalId, status: 'APPROVED', idempotent: true }
        : await fixflowMcp.call<Record<string, unknown>>('approve_action', {
            incident_id: selectedRepair.id,
            approval_id: approvalId,
            decision: 'APPROVED',
            note: 'Explicit user approval received from the appointment approval card.',
          });
      const booking = await fixflowMcp.call<Record<string, unknown>>('book_appointment', {
        incident_id: selectedRepair.id,
        approval_id: approvalId,
      });
      setAlternatives(null);
      setView('repair');
      await refreshSnapshot(selectedRepair.id);
      try {
        await saveTurn(selectedRepair.id, userMessage, assistantReply, 'book_appointment', {
          approval_id: approvalId,
          decision,
          booking,
        });
      } catch (saveError) {
        setError(`The appointment was booked, but this chat turn could not be saved: ${toErrorMessage(saveError)}`);
      }
    } catch (caught) {
      const message = toErrorMessage(caught);
      setError(message);
      setMessages((old) => [...old, {
        id: `approval-error-${Date.now()}`,
        role: 'assistant',
        content: `I couldn’t complete the approved booking: ${message}. The repair remains saved; you can retry this proposal or inspect its status.`,
        timestamp: new Date().toISOString(),
      }]);
      try { await refreshSnapshot(selectedRepair.id); } catch { /* preserve the booking error */ }
    } finally {
      setBusy(false);
    }
  }, [approval, busy, refreshSnapshot, repair, saveTurn]);

  const chooseAppointment = useCallback(async (option: AppointmentOption) => {
    if (!repair || busy) return;
    const userMessage = `Choose ${option.vendor_name} at ${formatDate(option.starts_at, true)}`;
    const localUser: ChatMessage = { id: `choice-user-${Date.now()}`, role: 'user', content: userMessage, timestamp: new Date().toISOString() };
    setMessages((old) => [...old, localUser]);
    setBusy(true);
    setError('');
    try {
      // SQL stores the slot primary key as `id`; current MCP results expose
      // `slot_id` too. Keep this fallback so an older browser/server pair can
      // still submit a valid slot identifier instead of omitting the field.
      const selectedSlotId = option.slot_id || option.id;
      if (!selectedSlotId) throw new Error('This appointment option has no slot ID. Refresh alternatives before choosing it.');
      const proposalRaw = await fixflowMcp.call<unknown>('prepare_proposal', {
        incident_id: repair.id,
        vendor_id: option.vendor_id,
        slot_id: selectedSlotId,
        budget_limit: budgetLimit,
        require_brand_authorized: requireBrandAuthorized,
      });
      // Treat the returned record as a proposal, then re-read canonical persisted
      // approval state. This protects the card from SDK envelope variations and
      // ensures the button has the exact server-generated approval ID.
      let pendingProposal: Approval | null = normalizeProposalApproval(proposalRaw, repair.id);
      const responseProposal = pendingProposal;
      const responseId = responseProposal ? String(responseProposal.approval_id || responseProposal.id || '').trim() : '';
      try {
        const persisted = normalizeApprovalRecord(await fixflowMcp.call<unknown>('get_pending_approval', { incident_id: repair.id }));
        if (persisted && persisted.incident_id === repair.id) {
          const persistedId = String(persisted.approval_id || persisted.id || '').trim();
          const persistedSlot = persisted.action_payload?.slot_id;
          const responseSlot = responseProposal?.action_payload?.slot_id;
          // A read-back is canonical only when it refers to this selected slot.
          // Never overwrite the new response with an unrelated old proposal.
          if (persistedId && persistedSlot === selectedSlotId) {
            pendingProposal = persisted;
          } else if (responseId && responseProposal?.action_payload?.slot_id === selectedSlotId) {
            pendingProposal = responseProposal;
          } else if (persistedSlot && responseSlot && persistedSlot !== responseSlot) {
            throw new Error('The server returned a different pending proposal than the selected slot. Refresh the repair and review the current proposal before approving.');
          }
        }
      } catch (readError) {
        // A semantic mismatch means another proposal is currently authoritative;
        // do not suppress that condition by falling back to the just-returned ID.
        if (readError instanceof Error && /different pending proposal/i.test(readError.message)) throw readError;
        // A transport/read-back failure is different: a direct, server-generated
        // response with the exact ID and selected slot remains usable. The server
        // validates its state again before any approval or booking.
        if (!responseId || responseProposal?.action_payload?.slot_id !== selectedSlotId) throw readError;
        pendingProposal = responseProposal;
      }
      if (!pendingProposal?.id || !String(pendingProposal.approval_id || pendingProposal.id).trim()
          || pendingProposal.incident_id !== repair.id
          || pendingProposal.action_payload?.slot_id !== selectedSlotId
          || !['PENDING', 'APPROVED'].includes(String(pendingProposal.status).toUpperCase())) {
        throw new Error('The server response did not contain a persisted approval ID for this exact slot. Refresh the repair and choose the slot again; no booking was attempted. ');
      }
      const payload = pendingProposal.action_payload || {};
      const vendorName = typeof payload.vendor_name === 'string' ? payload.vendor_name : option.vendor_name;
      const visitFee = typeof payload.price_estimate === 'number' ? payload.price_estimate : option.price_estimate;
      const totalEstimate = typeof payload.estimated_total_cost === 'number' ? payload.estimated_total_cost : (option.estimated_repair_cost ?? 0) + visitFee;
      const reply = `I prepared a proposal for ${vendorName} on ${formatDate(typeof payload.starts_at === 'string' ? payload.starts_at : option.starts_at, true)} with a simulated all-in estimate of ${formatMoney(totalEstimate)}. I have not booked it. Review the exact proposal and explicitly approve or reject it.`;
      setAlternatives(null);
      setAlternativesVendorName(null);
      await refreshSnapshot(repair.id);
      // The selection that was just created wins over any stale UI snapshot.
      setApproval(pendingProposal);
      await saveTurn(repair.id, userMessage, reply, 'prepare_proposal', proposalRaw as Record<string, unknown>);
    } catch (caught) {
      setError(toErrorMessage(caught));
      setMessages((old) => [...old, { id: `choice-error-${Date.now()}`, role: 'assistant', content: `I couldn’t propose that slot: ${toErrorMessage(caught)}` }]);
      try { await refreshSnapshot(repair.id); } catch { /* the primary error remains shown */ }
    } finally {
      setBusy(false);
    }
  }, [budgetLimit, busy, refreshSnapshot, repair, requireBrandAuthorized, saveTurn]);

  const retryConnection = useCallback(async () => {
    setConnectionState('connecting');
    setError('');
    try {
      await refreshSnapshot(repair?.id || DEMO_REPAIR_ID);
      setConnectionState('connected');
    } catch (caught) {
      setConnectionState('error');
      setError(toErrorMessage(caught));
    }
  }, [refreshSnapshot, repair]);

  const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
  const pageTitle = view === 'home' ? 'A little less to worry about.' : view === 'repair' ? 'Your repair, in motion.' : 'Every repair. Remembered.';
  const pageSubtitle = view === 'home'
    ? 'FixFlow keeps the little things from becoming one more thing to manage.'
    : view === 'repair'
      ? 'The history, next step, and every decision stay attached to this case.'
      : 'Past fixes stay on file, so the story never starts from scratch.';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand-lockup" onClick={() => setView('home')} type="button" aria-label="FixFlow home">
          <span className="brand-mark"><span>✦</span></span>
          <span className="brand-name">fixflow<span>HOME, HANDLED.</span></span>
        </button>
        <div className="household-mini">
          <span className="house-icon">⌂</span>
          <span><b>The Chaudhary Household</b><small>2 home assets</small></span>
          <span className="tiny-chevron">⌄</span>
        </div>
        <div className="side-label">YOUR HOME</div>
        <nav className="side-nav" aria-label="Main navigation">
          <button type="button" className={view === 'home' ? 'nav-active' : ''} onClick={() => setView('home')}><IconMark name="home" /><span>Overview</span></button>
          <button type="button" className={view === 'repair' ? 'nav-active' : ''} onClick={() => setView('repair')}><IconMark name="repair" /><span>Active repair</span>{openRepairs.length > 0 && <em>{openRepairs.length}</em>}</button>
          <button type="button" className={view === 'history' ? 'nav-active' : ''} onClick={() => setView('history')}><IconMark name="history" /><span>Repair history</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="promise-note"><span className="promise-icon">✳</span><p><b>Nothing falls through.</b><br />We keep a repair open until you say it’s fixed.</p></div>
          <div className="sidebar-simulation"><span className="simulation-dot" /> Simulated household</div>
          <div className="sidebar-version">LOCAL DEMO · FIXFLOW 1.0</div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><span>✦</span></span><strong>fixflow</strong></div>
          <div className="topbar-house"><span className="topbar-home-icon">⌂</span><span>The Chaudhary Household</span><span className="topbar-separator">/</span><span>{view === 'home' ? 'Overview' : view === 'repair' ? 'Repair details' : 'Repair history'}</span></div>
          <div className="topbar-actions">
            <div className={`mcp-status status-${connectionState}`} title={connectionState === 'connected' ? 'FixFlow is connected to local repair services.' : 'Repair service connection status'}><span className="connection-dot" />{connectionState === 'connected' ? 'Ready' : connectionState === 'connecting' ? 'Connecting…' : 'Unavailable'}</div>
            <button className="reset-button" onClick={() => runCommand('Reset demo')} disabled={busy || connectionState !== 'connected'} type="button"><span>↻</span> Reset demo</button>
          </div>
        </header>

        <main className="page-content">
          <nav className="mobile-nav" aria-label="Mobile navigation">
            <button type="button" className={view === 'home' ? 'mobile-nav-active' : ''} onClick={() => setView('home')}>⌂ Overview</button>
            <button type="button" className={view === 'repair' ? 'mobile-nav-active' : ''} onClick={() => setView('repair')}>✦ Repair</button>
            <button type="button" className={view === 'history' ? 'mobile-nav-active' : ''} onClick={() => setView('history')}>↺ History</button>
          </nav>
          <div className="page-heading">
            <div>
              <div className="heading-eyebrow"><span /> HOUSEHOLD CARE <span className="heading-dot">·</span> {dateLabel}</div>
              <h1>{pageTitle}</h1>
              <p>{pageSubtitle}</p>
            </div>
            <div className="heading-promise"><span>✦</span><div><b>The repair doesn’t disappear</b><small>until it’s fixed.</small></div></div>
          </div>

          {error && <div className="error-banner" role="alert"><span>!</span><div><strong>Something needs attention</strong><p>{error}</p></div>{connectionState === 'error' && <button type="button" onClick={retryConnection}>Reconnect</button>}</div>}
          {connectionState === 'connecting' && !repair && <div className="boot-card"><span className="boot-spinner" /><div><strong>Waking up FixFlow…</strong><p>Connecting to your local repair tools and restoring the saved incident.</p></div></div>}
          {connectionState === 'error' && !repair && <div className="connection-empty"><span>⌁</span><h2>FixFlow can’t reach the repair server.</h2><p>Start FastAPI in another terminal, then reconnect. The demo does not require an external AI service or a real household account.</p><button className="button button-primary" type="button" onClick={retryConnection}>Try again</button></div>}

          {view === 'home' && repair && (
            <div className="dashboard-grid">
              <div className="primary-column">
                <RepairFocusCard repair={repair} onOpen={() => setView('repair')} />
                <ActionCard repair={repair} hasActiveBookedAppointment={hasActiveBookedAppointment} bookedVendorName={bookedVendorName} onCommand={runCommand} busy={busy} />
                {alternatives && repair.status !== 'WAITING_APPROVAL' && <AlternativeOptions options={alternatives} onChoose={chooseAppointment} disabled={busy} budget={budgetLimit} requireBrandAuthorized={requireBrandAuthorized} selectedVendorName={alternativesVendorName} />}
                {needsDecision && approval && <ApprovalCard approval={approval} currentAppointment={currentAppointment} vendors={vendors} onApprove={() => approveProposal(approval)} onReject={() => runCommand('Reject appointment proposal')} disabled={busy} />}
                {repair.status === 'AWAITING_CONFIRMATION' && <div className="confirmation-banner"><div className="confirmation-icon">?</div><div><b>Only you can confirm the fix.</b><p>The technician’s completion report is simulated. Has the leak actually stopped?</p></div><div className="confirmation-actions"><button className="button button-primary" disabled={busy} onClick={() => runCommand('Confirm the washing machine is fixed')} type="button">It’s fixed</button><button className="button button-outline" disabled={busy} onClick={() => runCommand('The washer is still leaking')} type="button">Still leaking</button></div></div>}
                <section className="surface-card timeline-card">
                  <div className="section-heading"><div><span className="eyebrow">THE STORY SO FAR</span><h3>Nothing gets lost along the way.</h3></div><button className="text-button" type="button" onClick={() => setView('repair')}>Full timeline ↗</button></div>
                  <Timeline events={timeline} compact />
                </section>
                <VendorComparison vendors={vendors} onRefresh={() => runCommand('Compare repair partners')} onSelectVendor={(vendor) => { void runCommand(`Select ${vendor.name} as repair partner`); }} disabled={busy || Boolean(approval)} activeBooking={hasActiveBookedAppointment} bookedVendorId={repair.current_vendor_id} budget={budgetLimit} setBudget={setBudgetLimit} requireBrandAuthorized={requireBrandAuthorized} setRequireBrandAuthorized={setRequireBrandAuthorized} />
              </div>
              <aside className="right-column">
                <ConversationPanel messages={messages} onSubmit={runCommand} busy={busy} connectionState={connectionState} />
                <WarrantyCard warranty={warranty} />
                <section className="tiny-history-card surface-card">
                  <div className="section-heading"><div><span className="eyebrow">PREVIOUSLY, AT HOME</span><h3>We remember the last fix.</h3></div><span className="history-ghost">↺</span></div>
                  <p>{history.find((item) => item.id !== repair.id)?.title || 'No previous repair is on file yet.'}</p>
                  <span>{history.filter((item) => item.id !== repair.id).length} earlier repair record{history.filter((item) => item.id !== repair.id).length === 1 ? '' : 's'} retained</span>
                  <button className="text-button" type="button" onClick={() => setView('history')}>Open repair history ↗</button>
                </section>
              </aside>
            </div>
          )}

          {view === 'repair' && repair && (
            <div className="repair-page-grid">
              <div className="primary-column">
                <RepairFocusCard repair={repair} onOpen={() => setView('home')} openLabel="Back to overview" />
                <IncidentDetails repair={repair} appointment={currentAppointment} />
                <ActionCard repair={repair} hasActiveBookedAppointment={hasActiveBookedAppointment} bookedVendorName={bookedVendorName} onCommand={runCommand} busy={busy} />
                {alternatives && repair.status !== 'WAITING_APPROVAL' && <AlternativeOptions options={alternatives} onChoose={chooseAppointment} disabled={busy} budget={budgetLimit} requireBrandAuthorized={requireBrandAuthorized} selectedVendorName={alternativesVendorName} />}
                {needsDecision && approval && <ApprovalCard approval={approval} currentAppointment={currentAppointment} vendors={vendors} onApprove={() => approveProposal(approval)} onReject={() => runCommand('Reject appointment proposal')} disabled={busy} />}
                {repair.status === 'AWAITING_CONFIRMATION' && <div className="confirmation-banner"><div className="confirmation-icon">?</div><div><b>Is the washing machine actually fixed?</b><p>FixFlow won’t resolve or close the case based only on a technician report.</p></div><div className="confirmation-actions"><button className="button button-primary" disabled={busy} onClick={() => runCommand('Confirm the washing machine is fixed')} type="button">Yes, it’s fixed</button><button className="button button-outline" disabled={busy} onClick={() => runCommand('The washer is still leaking')} type="button">Still leaking</button></div></div>}
                <section className="surface-card timeline-card full-timeline-card"><div className="section-heading"><div><span className="eyebrow">AUDIT TRAIL</span><h3>Every step, in order.</h3></div><span className="timeline-count">{timeline.length} events</span></div><Timeline events={timeline} /></section>
              </div>
              <aside className="right-column">
                <ConversationPanel messages={messages} onSubmit={runCommand} busy={busy} connectionState={connectionState} />
                <WarrantyCard warranty={warranty} />
                <VendorComparison vendors={vendors} onRefresh={() => runCommand('Compare repair partners')} onSelectVendor={(vendor) => { void runCommand(`Select ${vendor.name} as repair partner`); }} disabled={busy || Boolean(approval)} activeBooking={hasActiveBookedAppointment} bookedVendorId={repair.current_vendor_id} budget={budgetLimit} setBudget={setBudgetLimit} requireBrandAuthorized={requireBrandAuthorized} setRequireBrandAuthorized={setRequireBrandAuthorized} />
              </aside>
            </div>
          )}

          {view === 'history' && repair && (
            <div className="history-page-grid">
              <div className="primary-column">
                <section className="surface-card history-main-card">
                  <div className="section-heading"><div><span className="eyebrow">HOUSEHOLD MEMORY</span><h3>Every repair has a paper trail.</h3></div><span className="history-count">{history.length} records</span></div>
                  <p className="muted-copy">FixFlow keeps the earlier repair and the current issue connected to the same appliance. Closing a case does not erase it.</p>
                  <HistoryList items={history} />
                </section>
                <section className="surface-card timeline-card"><div className="section-heading"><div><span className="eyebrow">CURRENT CASE TIMELINE</span><h3>What happened this time.</h3></div><button className="text-button" type="button" onClick={() => setView('repair')}>Back to repair ↗</button></div><Timeline events={timeline} /></section>
                <div className="history-reset-nudge"><span>✦</span><div><b>Want to tell the story again?</b><p>Reset restores the original demo records so you can replay the repair journey.</p></div><button className="button button-outline" disabled={busy || connectionState !== 'connected'} onClick={() => runCommand('Reset demo')} type="button">Reset demo</button></div>
              </div>
              <aside className="right-column"><ConversationPanel messages={messages} onSubmit={runCommand} busy={busy} connectionState={connectionState} /><WarrantyCard warranty={warranty} /><section className="surface-card history-note"><span className="history-ghost">↺</span><h3>Memory is part of the fix.</h3><p>Earlier visits, repair-partner outcomes, approvals, and your final confirmation stay saved on this device.</p></section></aside>
            </div>
          )}

          {!repair && connectionState === 'connected' && (
            <div className="connection-empty"><span>✓</span><h2>Your repair list is clear.</h2><p>Tell FixFlow about a repair in the conversation panel or reset the demo to load the washing-machine scenario.</p><button className="button button-primary" onClick={() => runCommand('Reset demo')} type="button">Load demo repair</button></div>
          )}

          <footer className="page-footer"><span>FIXFLOW · SIMULATED ALEXA+ HOUSEHOLD EXPERIENCE</span><span>Local demo only. No real Alexa+ device, service provider, calendar account, payment, or warranty service is connected.</span></footer>
        </main>
      </div>
    </div>
  );
}
