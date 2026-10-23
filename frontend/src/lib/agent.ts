import { fixflowMcp } from './mcp';
import { isRecord } from './types';
import { approvalIdentifier, normalizeApprovalRecord } from './approvals';
import type {
  AppointmentOption,
  Approval,
  CurrentAppointment,
  HistoricalRepair,
  Repair,
  Vendor,
  Warranty,
} from './types';

export interface AgentContext {
  repair: Repair | null;
  activeRepairs: Repair[];
  currentAppointment: CurrentAppointment | null;
  approval: Approval | null;
  budgetLimit?: number;
  requireBrandAuthorized?: boolean;
  vendors?: Vendor[];
  appointmentOptions?: AppointmentOption[];
}

export interface AgentOutcome {
  reply: string;
  toolName?: string;
  toolPayload?: Record<string, unknown>;
  refresh?: boolean;
  navigate?: 'home' | 'repair' | 'history';
  showAlternatives?: AppointmentOption[];
  repairList?: Repair[];
  repairHistory?: HistoricalRepair[];
  vendors?: Vendor[];
  warranty?: Warranty;
  resetDemo?: boolean;
  selectedVendorName?: string;
  clearAlternatives?: boolean;
}

function result(reply: string, toolName?: string, toolPayload?: Record<string, unknown>): AgentOutcome {
  return { reply, toolName, toolPayload };
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function repairName(repair: Repair): string {
  return repair.asset_name || repair.title || 'this repair';
}



/**
 * Optionally use the backend-hosted Fireworks model to normalize safe,
 * read-only/support intents. Consequential actions deliberately remain on the
 * deterministic path so a model cannot approve, book, reject, complete, or
 * close a repair on the user's behalf. The API key never enters the browser.
 */
export type RoutingMode = 'deterministic' | 'fireworks' | 'fireworks-answer' | 'fireworks-unclassified' | 'fallback';
export interface NormalizedCommand {
  command: string;
  mode: RoutingMode;
  /** Present only for a read-only conversational answer returned by Fireworks or a safe local fallback. */
  reply?: string;
}

const LOCAL_STATE_MACHINE_PATTERNS: RegExp[] = [
  /vendor\s+did not show|vendor\s+missed|repair partner\s+(?:did not show|didn['’]t show|missed)|service provider\s+(?:did not show|didn['’]t show|missed)|\bno[ -]?show\b|didn['’]t show up|did not show up/i,
  /\bbook appointment\b|\bconfirm booking\b|\bapprove\b/i,
  /\bselect\s+.+?\s+as\s+(?:the\s+)?(?:vendor|repair partner|service provider)\b/i,
  /\bchoose\s+.+?\s+at\s+.+/i,
  /\bwhat am i waiting for\?/i,
];

function isDeterministicallySupported(command: string): boolean {
  const text = command.trim();
  if (LOCAL_STATE_MACHINE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // The remaining patterns are explicitly supported local repair queries and
  // actions. Anything outside this allowlist is conversational and may go to
  // Fireworks; the model is never asked to carry out a state transition.
  return /\b(reset demo|start demo over|restart demo|what'?s still broken|what is still broken|show (my )?active repairs|list active repairs|what needs attention|history|previous repair|what happened|what did you do|warranty|covered|coverage|compare vendors|compare repair partners|show (me )?(?:vendors|repair partners)|repair partner options|who can fix|select .{1,100}(?:as (?:the )?)?(?:vendor|repair partner|service provider)|choose .{1,100}(?:as (?:the )?)?(?:vendor|repair partner|service provider)|pick .{1,100}(?:as (?:the )?)?(?:vendor|repair partner|service provider)|what am i waiting for|next step|what happens next|status update|where are we|vendor (didn'?t|did not) show|vendor missed|repair partner (didn'?t|did not) show|repair partner missed|service provider (didn'?t|did not) show|service provider missed|no[- ]show|missed (the )?(visit|appointment)|never arrived|didn'?t arrive|did not show up|didn'?t show up|find another appointment|find alternatives|another time|reschedule|replacement appointment|reject|decline|approve|book( an| the)? appointment|confirm booking|yes,? book|go ahead and book|confirm (the )?appointment|mark (the )?(repair|visit) as completed|repair is completed|technician finished|simulate (the )?visit completed|still leaking|not fixed|problem persists|still broken|confirm the washing machine is fixed|it'?s fixed|close repair case|leaking again|washer is leaking|washing machine is leaking|new repair|report (a )?repair)\b/i.test(text);
}

/**
 * Deterministic-first intent routing. Consequential commands never go to the
 * model: they are handled by explicit local patterns and the approval state.
 * Fireworks is an optional classifier for unfamiliar, read-only queries only.
 */
export async function normalizeSafeIntentWithFireworks(
  rawCommand: string,
  context: {
    repairTitle?: string;
    repairStatus?: string;
    hasPendingApproval: boolean;
    hasCurrentAppointment: boolean;
  },
): Promise<NormalizedCommand> {
  // Critical state-machine actions are always classified locally before any
  // network request. This guard deliberately runs before checking the feature flag.
  if (isDeterministicallySupported(rawCommand)) return { command: rawCommand, mode: 'deterministic' };
  const actionLikeCommand = /^\s*(?:please\s+)?(?:book|schedule|reschedule|cancel|select|choose|pick|approve|reject|decline|mark|confirm|close|reset|find|report)\b/i.test(rawCommand)
    || /\b(?:can|could|would) you\s+(?:please\s+)?(?:book|schedule|reschedule|cancel|select|choose|pick|approve|reject|decline|mark|confirm|close|find|report)\b/i.test(rawCommand);
  if (actionLikeCommand) {
    return {
      command: rawCommand,
      mode: 'deterministic',
      reply: 'I won’t guess at a repair action. Try “Repair partner missed visit,” “Select BrightFix Appliance Care as repair partner,” “Choose BrightFix Appliance Care at [time],” or use the visible approval card.',
    };
  }
  if (import.meta.env.VITE_ENABLE_LLM_ROUTER !== 'true') {
    return {
      command: rawCommand,
      mode: 'fallback',
      reply: 'I can manage repair status, repair-partner choices, appointments, and approval locally. Conversational answers are unavailable because the optional Fireworks router is disabled.',
    };
  }
  try {
    const host = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
    const apiBase = import.meta.env.VITE_API_URL?.trim() || `http://${host || '127.0.0.1'}:8000`;
    const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/agent/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: rawCommand,
        repair_title: context.repairTitle ?? null,
        repair_status: context.repairStatus ?? null,
        has_pending_approval: context.hasPendingApproval,
        has_current_appointment: context.hasCurrentAppointment,
      }),
    });
    if (!response.ok) return { command: rawCommand, mode: 'fallback', reply: 'I couldn’t reach Fireworks for a conversational answer. Your saved repairs and deterministic repair actions remain available locally.' };
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return { command: rawCommand, mode: 'fallback', reply: 'I couldn’t interpret that conversational response. Your saved repairs and deterministic repair actions remain available locally.' };
    if (typeof payload.reply === 'string' && payload.reply.trim()) {
      if (payload.mode === 'fireworks-answer') {
        return { command: rawCommand, mode: 'fireworks-answer', reply: payload.reply.trim() };
      }
      if (payload.mode === 'fallback' || payload.mode === 'deterministic') {
        return { command: rawCommand, mode: 'fallback', reply: payload.reply.trim() };
      }
    }
    if (payload.mode === 'deterministic') {
      if (payload.reason === 'provider_unavailable' || payload.reason === 'no_api_key') {
        return {
          command: rawCommand,
          mode: 'fallback',
          reply: 'I couldn’t get a conversational answer from Fireworks just now. Your saved repairs remain available, and repair decisions still follow FixFlow’s safety checks.',
        };
      }
      if (payload.reason === 'unrecognized_intent') return {
        command: rawCommand,
        mode: 'fireworks-unclassified',
        reply: 'I’m here to help with household repair questions. I can explain FixFlow or its workflow, but I won’t take a repair action unless your command clearly requests one.',
      };
      return { command: rawCommand, mode: 'deterministic' };
    }
    // Backwards compatibility with an older backend that returned a safe intent
    // label instead of a plain conversational answer.
    if (payload.mode === 'fireworks' && typeof payload.intent === 'string') {
      const safeCommands: Record<string, string> = {
        active_repairs: "What's still broken?",
        repair_history: 'Show me my repair history',
        check_warranty: 'Check the warranty',
        compare_vendors: 'Compare repair partners',
        what_waiting: 'What am I waiting for?',
      };
      if (safeCommands[payload.intent]) return { command: safeCommands[payload.intent], mode: 'fireworks' };
    }
    return {
      command: rawCommand,
      mode: 'fallback',
      reply: 'I couldn’t interpret that conversational question. Try asking what FixFlow does or what happens during a repair.',
    };
  } catch {
    return { command: rawCommand, mode: 'fallback', reply: 'I couldn’t reach Fireworks for a conversational answer. Your saved repairs and deterministic workflow actions remain available locally.' };
  }
}



async function findCurrentApproval(incidentId: string, approval: Approval | null): Promise<Approval | null> {
  const statusIsActionable = (item: Approval | null) => Boolean(
    item && item.incident_id === incidentId && approvalIdentifier(item)
      && ['PENDING', 'APPROVED'].includes(String(item.status).toUpperCase()),
  );
  // SQLite/MCP is authoritative. Always re-read first so a voice command can't
  // act on a stale React snapshot after a reload, retry, or another decision.
  try {
    const fresh = normalizeApprovalRecord(await fixflowMcp.call<unknown>('get_pending_approval', { incident_id: incidentId }));
    if (statusIsActionable(fresh)) return fresh;
  } catch {
    // If transport failed, a user may still approve the exact visible card. The
    // backend's incident-scoped approval checks remain authoritative.
  }
  const current = normalizeApprovalRecord(approval);
  return statusIsActionable(current) ? current : null;
}

async function findActiveBookedAppointment(incidentId: string): Promise<{
  repair: Repair;
  appointment: NonNullable<CurrentAppointment['appointment']>;
} | null> {
  const [detail, current] = await Promise.all([
    fixflowMcp.call<{ repair: Repair }>('get_repair', { incident_id: incidentId }),
    fixflowMcp.call<CurrentAppointment | null>('get_current_appointment', { incident_id: incidentId }),
  ]);
  const appointment = current?.appointment;
  const activeAppointmentId = detail.repair.current_appointment_id;
  if (
    !activeAppointmentId
    || appointment?.id !== activeAppointmentId
    || appointment.status !== 'BOOKED'
    || !['BOOKED', 'VISIT_SCHEDULED', 'EXPECTED_VISIT'].includes(detail.repair.status)
  ) {
    return null;
  }
  return { repair: detail.repair, appointment };
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function optionMatchesRequestedTime(option: AppointmentOption, request: string): boolean {
  const wanted = normalizePhrase(request);
  const date = new Date(option.starts_at);
  if (Number.isNaN(date.getTime())) return false;
  const formatted = [
    option.label ?? '',
    new Intl.DateTimeFormat('en-PK', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date),
    new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date),
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date),
    date.toISOString(),
  ].map(normalizePhrase);
  if (formatted.some((candidate) => candidate.includes(wanted) || wanted.includes(candidate))) return true;

  // Natural speech often omits the date and says only “at 10 AM”. Compare that
  // against the browser-local time for the option, then verify any stated day.
  const time = request.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!time) return false;
  let hour = Number(time[1]) % 12;
  if (time[3].toLowerCase().startsWith('p')) hour += 12;
  if (date.getHours() !== hour) return false;
  if (time[2] !== undefined && date.getMinutes() !== Number(time[2])) return false;
  const dayMatch = request.match(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/i);
  if (dayMatch) {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date).toLowerCase();
    if (day !== dayMatch[1].slice(0, 3).toLowerCase()) return false;
  }
  const monthMatch = request.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i);
  if (monthMatch) {
    const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date).toLowerCase();
    if (month !== monthMatch[1].slice(0, 3).toLowerCase() || date.getDate() !== Number(monthMatch[2])) return false;
  }
  return true;
}

export async function routeDeterministicCommand(
  rawCommand: string,
  context: AgentContext,
): Promise<AgentOutcome> {
  const command = rawCommand.trim();
  const text = command.toLowerCase();
  const repair = context.repair;
  if (!command) return result('Tell me what needs attention, and I’ll use the repair tools to help.');

  if (has(text, /\b(reset demo|start demo over|restart demo)\b/)) {
    const reset = await fixflowMcp.call<Record<string, unknown>>('reset_demo_scenario');
    return {
      reply: 'Demo reset. I restored the original washing-machine leak, the previous repair, warranty record, calendar conflict, and booked visit. Nothing has been contacted or paid for in the real world.',
      toolName: 'reset_demo_scenario',
      toolPayload: reset,
      resetDemo: true,
      navigate: 'home',
    };
  }

  if (has(text, /\b(what'?s still broken|what is still broken|show (my )?active repairs|list active repairs|what needs attention)\b/)) {
    const active = await fixflowMcp.call<Repair[]>('list_active_repairs');
    const unresolved = active.filter((item) => item.status !== 'CLOSED');
    const message = unresolved.length
      ? `There ${unresolved.length === 1 ? 'is' : 'are'} ${unresolved.length} open repair ${unresolved.length === 1 ? 'case' : 'cases'}. ${unresolved.map((item) => `${item.title} (${friendlyStatus(item.status)})`).join('; ')}. I’ll keep each one open until it’s confirmed fixed.`
      : 'There are no open repair cases right now. The repair history is still available.';
    return { reply: message, toolName: 'list_active_repairs', repairList: active, navigate: 'home' };
  }

  if (has(text, /\b(history|previous repair|what happened|show (my )?repair history|what did you do)\b/)) {
    if (!repair) return result('I don’t have a repair selected yet. Reset the demo or report the appliance issue first.');
    const history = await fixflowMcp.call<HistoricalRepair[]>('get_repair_history', { incident_id: repair.id });
    return {
      reply: `I found ${history.length} saved repair record${history.length === 1 ? '' : 's'} for ${repairName(repair).toLowerCase()}. The older visits stay in the history while this current case remains separate.`,
      toolName: 'get_repair_history',
      repairHistory: history,
      navigate: 'history',
    };
  }

  if (has(text, /\b(warranty|covered|coverage)\b/)) {
    if (!repair) return result('Choose a repair before I check the relevant warranty.');
    const warranty = await fixflowMcp.call<Warranty>('check_warranty', { asset_id: repair.asset_id });
    const plan = warranty.warranty?.plan_name || 'the recorded warranty';
    const answer = warranty.covered
      ? `The local demo record shows active coverage under ${plan}. It may cover leak diagnosis and eligible hose or seal parts, subject to a simulated claim review. This is not a real warranty claim.`
      : 'I could not confirm active coverage in the simulated warranty record. I have not submitted a claim.';
    return { reply: answer, toolName: 'check_warranty', warranty, navigate: 'repair' };
  }

  const chooseAtMatch = command.match(/\bchoose\s+(.+?)\s+at\s+(.+?)\s*$/i);
  if (chooseAtMatch) {
    if (!repair) return result('Choose a repair before selecting an appointment time.');
    const vendorQuery = normalizePhrase(chooseAtMatch[1]);
    const timeQuery = chooseAtMatch[2].trim();
    const options = context.appointmentOptions ?? [];
    const vendorMatches = options.filter((option) => {
      const name = normalizePhrase(option.vendor_name);
      return name === vendorQuery || name.includes(vendorQuery) || vendorQuery.includes(name)
        || name.split(' ').some((part) => part.length > 3 && part === vendorQuery);
    });
    const match = vendorMatches.filter((option) => optionMatchesRequestedTime(option, timeQuery));
    if (match.length !== 1) {
      return result(match.length > 1
        ? 'That repair partner has more than one matching appointment time. Please include the day and time shown on the slot card.'
        : 'I couldn’t match that repair partner and time to a displayed slot. Select a repair partner and use “Choose time” first, or say the exact name and time shown on the card. No proposal was created.');
    }
    const option = match[0];
    const slotId = option.slot_id || option.id;
    if (!slotId) return result('That time option has no valid slot ID. Refresh the options before proposing it.');
    const proposal = await fixflowMcp.call<Record<string, unknown>>('prepare_proposal', {
      incident_id: repair.id,
      vendor_id: option.vendor_id,
      slot_id: slotId,
      budget_limit: context.budgetLimit ?? 250,
      require_brand_authorized: context.requireBrandAuthorized ?? true,
    });
    return {
      reply: `I prepared an approval proposal for ${option.vendor_name} at the selected time. The estimate is simulated; nothing is booked until you approve this exact proposal.`,
      toolName: 'prepare_proposal',
      toolPayload: proposal,
      refresh: true,
      navigate: 'repair',
    };
  }

  const selectVendorMatch = command.match(/\b(?:select|choose|pick)\s+(.+?)\s+as\s+(?:the\s+)?(?:vendor|repair partner|service provider)\b/i);
  if (selectVendorMatch) {
    if (!repair) return result('Choose a repair before selecting a repair partner.');
    const selected = await fixflowMcp.call<{
      eligible?: boolean;
      selected?: boolean;
      vendor?: Vendor;
      exclusion_reasons?: string[];
      estimated_total_cost?: number;
    }>('select_vendor', {
      incident_id: repair.id,
      vendor_name: selectVendorMatch[1].trim(),
      budget_limit: context.budgetLimit ?? 250,
      require_brand_authorized: context.requireBrandAuthorized ?? true,
    });
    const selectedVendor = selected.vendor;
    if (!selectedVendor) return result('I couldn’t identify a unique repair partner with that name. No appointment proposal was created.');
    const exclusions = selected.exclusion_reasons ?? [];
    if (selected.eligible === false || selected.selected === false || exclusions.length) {
      return {
        reply: `${selectedVendor.name} can’t be selected under the current preferences: ${exclusions.join('; ') || 'the repair partner is not eligible under the current filters'}. Adjust your budget or authorization filter and try again.`,
        clearAlternatives: true,
      };
    }
    const availability = await fixflowMcp.call<{ slots?: Array<Record<string, unknown>> }>('get_vendor_availability', { vendor_id: selectedVendor.id });
    const options: AppointmentOption[] = [];
    for (const slot of availability.slots ?? []) {
      if (typeof slot.starts_at !== 'string' || typeof slot.ends_at !== 'string' || typeof slot.id !== 'string') continue;
      const calendar = await fixflowMcp.call<{ available?: boolean }>('check_calendar', {
        starts_at: slot.starts_at,
        ends_at: slot.ends_at,
        household_id: repair.household_id || 'home-main',
      });
      if (!calendar.available) continue;
      const visitFee = typeof slot.price_estimate === 'number' ? slot.price_estimate : selectedVendor.estimated_visit_fee;
      const repairCost = selectedVendor.estimated_repair_cost;
      options.push({
        id: slot.id,
        slot_id: typeof slot.slot_id === 'string' ? slot.slot_id : slot.id,
        vendor_id: selectedVendor.id,
        vendor_name: selectedVendor.name,
        starts_at: slot.starts_at,
        ends_at: slot.ends_at,
        label: typeof slot.label === 'string' ? slot.label : undefined,
        status: typeof slot.status === 'string' ? slot.status : 'AVAILABLE',
        price_estimate: visitFee,
        estimated_repair_cost: repairCost,
        estimated_visit_fee: visitFee,
        estimated_total_cost: repairCost + visitFee,
        brand_authorized: selectedVendor.brand_authorized,
        reliability_score: selectedVendor.reliability_score,
        previous_household_jobs: selectedVendor.previous_household_jobs,
        is_preferred: selectedVendor.is_preferred,
        details: typeof slot.details === 'string' ? slot.details : undefined,
      });
    }
    return {
      reply: options.length
        ? `I selected ${selectedVendor.name} and checked its available slots against the household calendar. Choose a time below. This only prepares a proposal; nothing is booked until you approve it.`
        : `I found no calendar-compatible available times for ${selectedVendor.name}. Try another partner or refresh the repair partner options. No booking was made.`,
      toolName: 'select_vendor',
      toolPayload: { vendor_id: selectedVendor.id, eligible_slots: options.length, simulated: true },
      showAlternatives: options,
      selectedVendorName: selectedVendor.name,
      clearAlternatives: options.length === 0,
      navigate: 'repair',
    };
  }

  // Legacy wording remains supported for familiar commands.
  if (has(text, /\b(select|choose|pick)\b.*\b(vendor|repair partner|service provider)\b/)) {
    return result('Choose a repair partner from the list, then select an available time. I will show a proposal for your approval before anything is booked.');
  }

  if (has(text, /\b(compare vendors|compare repair partners|show (me )?(?:vendors|repair partners)|repair partner options|who can fix)\b/)) {
    if (!repair) return result('Choose a repair first so I can compare repair partners who fit that appliance.');
    const comparison = await fixflowMcp.call<{ vendors: Vendor[]; warranty?: Warranty; simulated?: boolean }>(
      'compare_vendors', { asset_id: repair.asset_id },
    );
    return {
      reply: 'I compared the simulated repair partners by reliability, previous household jobs, estimate, and warranty support. These are demo records, not live service-provider quotes.',
      toolName: 'compare_vendors',
      vendors: comparison.vendors,
      warranty: comparison.warranty,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(what am i waiting for|next step|what happens next|status update|where are we)\b/)) {
    if (!repair) return result('I don’t have a repair in focus yet.');
    const detail = await fixflowMcp.call<{ repair: Repair }>('get_repair', { incident_id: repair.id });
    return {
      reply: `${detail.repair.title} is ${friendlyStatus(detail.repair.status).toLowerCase()}. ${detail.repair.next_action || 'I’ll check the next safe step.'}`,
      toolName: 'get_repair',
      toolPayload: { status: detail.repair.status },
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /vendor\s+did not show|vendor\s+missed|repair partner\s+(?:did not show|didn['’]t show|missed)|service provider\s+(?:did not show|didn['’]t show|missed)|\bno[ -]?show\b|didn['’]t show up|did not show up|missed (the )?(visit|appointment)|never arrived|didn'?t arrive/i)) {
    if (!repair) return result('Select the repair whose appointment was missed.');
    const activeBooking = await findActiveBookedAppointment(repair.id);
    if (!activeBooking) return result('No scheduled visit found to mark as a no-show.');
    const recorded = await fixflowMcp.call<Record<string, unknown>>('record_vendor_no_show', {
      incident_id: repair.id,
      appointment_id: activeBooking.appointment.id,
      note: 'User reported that the simulated repair partner did not arrive.',
    });
    const found = await fixflowMcp.call<{ options: AppointmentOption[] }>('find_alternatives', {
      incident_id: repair.id,
      budget_limit: context.budgetLimit ?? 250,
      require_brand_authorized: context.requireBrandAuthorized ?? true,
    });
    return {
      reply: `I recorded the missed visit and kept the case open. The failed appointment remains in the timeline. I found ${found.options.length} calendar-compatible simulated alternatives; choose one below and I’ll request your approval before booking.`,
      toolName: 'find_alternatives',
      toolPayload: { no_show: recorded, option_count: found.options.length },
      showAlternatives: found.options,
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(find another appointment|find alternatives|another time|reschedule|replacement appointment)\b/)) {
    if (!repair) return result('Select a repair before looking for another appointment.');
    if (!['NO_SHOW', 'RESCHEDULING', 'OPTIONS_READY', 'WAITING_APPROVAL'].includes(repair.status)) {
      return result('The current visit is still marked as booked. Before I replace it, please confirm that the repair partner missed the visit.');
    }
    const found = await fixflowMcp.call<{ options: AppointmentOption[] }>('find_alternatives', {
      incident_id: repair.id,
      budget_limit: context.budgetLimit ?? 250,
      require_brand_authorized: context.requireBrandAuthorized ?? true,
    });
    return {
      reply: `I found ${found.options.length} available simulated time slots that avoid the household calendar conflict. Selecting one creates a proposal only; it will not book until you approve it.`,
      toolName: 'find_alternatives',
      showAlternatives: found.options,
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(reject|decline) (that )?(quote|proposal|appointment)\b/)) {
    if (!repair) return result('Choose a repair before rejecting a proposal.');
    const pending = await findCurrentApproval(repair.id, context.approval);
    const approvalId = approvalIdentifier(pending);
    if (!pending || !approvalId) {
      return result('There is no actionable appointment proposal for this repair to reject. I checked the server; no approval was changed.');
    }
    if (/quote/i.test(text) && !pending.action_type.includes('QUOTE')) {
      return result('There isn’t a repair quote awaiting approval. The outstanding request is an appointment proposal. Use “Reject appointment” if you want me to decline that proposal.');
    }
    const rejected = await fixflowMcp.call<Record<string, unknown>>('reject_action', {
      incident_id: repair.id,
      approval_id: approvalId,
      note: 'Explicitly rejected by the user in FixFlow.',
    });
    return {
      reply: 'I rejected that specific proposal. The appointment has not been booked, and no spending is authorized.',
      toolName: 'reject_action',
      toolPayload: rejected,
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(approve|book appointment|confirm booking|book( the| this| an)? appointment|yes,? book|go ahead and book|confirm (the )?appointment)\b/i)) {
    if (!repair) return result('Choose the repair before booking an appointment.');
    const pending = await findCurrentApproval(repair.id, context.approval);
    const approvalId = approvalIdentifier(pending);
    if (!pending || !approvalId || !['PENDING', 'APPROVED'].includes(String(pending.status).toUpperCase())) {
      return result('I could not find a valid pending appointment proposal for this repair. Choose a repair partner and time first; I will never invent an approval ID or book an unreviewed slot.');
    }
    const decision = String(pending.status).toUpperCase() === 'APPROVED'
      ? { approval_id: approvalId, status: 'APPROVED', idempotent: true }
      : await fixflowMcp.call<Record<string, unknown>>('approve_proposal', {
          incident_id: repair.id,
          approval_id: approvalId,
          note: 'Explicit user approval received through the conversational panel.',
        });
    const booked = await fixflowMcp.call<Record<string, unknown>>('book_appointment', {
      incident_id: repair.id,
      approval_id: approvalId,
    });
    return {
      reply: 'Your approval is recorded against that exact repair proposal, and the simulated appointment is now booked. The case stays open until the visit is completed and you confirm the appliance is fixed.',
      toolName: 'book_appointment',
      toolPayload: { decision, booking: booked },
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(mark (the )?(repair|visit) as completed|repair is completed|technician finished|simulate (the )?visit completed)\b/)) {
    if (!repair) {
      return result('There isn’t a current booked appointment to mark complete. I won’t invent a completed visit.');
    }
    const activeBooking = await findActiveBookedAppointment(repair.id);
    if (!activeBooking) return result('There isn’t a current booked appointment to mark complete. I won’t invent a completed visit.');
    const completion = await fixflowMcp.call<Record<string, unknown>>('mark_repair_completed', {
      incident_id: repair.id,
      appointment_id: activeBooking.appointment.id,
      technician_note: 'Simulated technician reports the visit is complete; awaiting household confirmation.',
    });
    return {
      reply: 'The simulated technician reported the visit complete. I moved the case to “Awaiting your confirmation” — it is not resolved or closed yet. Is the washing machine actually fixed?',
      toolName: 'mark_repair_completed',
      toolPayload: completion,
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(still leaking|not fixed|isn'?t fixed|problem persists|still broken)\b/)) {
    if (!repair || repair.status !== 'AWAITING_CONFIRMATION') {
      return result('I don’t have a completed visit waiting for confirmation yet. A booking alone is not proof that the repair is done.');
    }
    const updated = await fixflowMcp.call<Record<string, unknown>>('confirm_resolution', {
      incident_id: repair.id,
      confirmed: false,
      note: 'The user reports that the issue persists.',
    });
    return {
      reply: 'Thanks for checking. I recorded that the leak is still present and reopened the work path. The case remains open; we can arrange a follow-up rather than calling it fixed.',
      toolName: 'confirm_resolution',
      toolPayload: updated,
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(confirm|yes,? it'?s) (that )?(the )?(washer|washing machine|appliance )?(is )?fixed\b|\bconfirm the washing machine is fixed\b|\bit'?s fixed\b/)) {
    if (!repair || repair.status !== 'AWAITING_CONFIRMATION') {
      return result('I can only record that confirmation after a visit has been marked complete. The current case stays open for now.');
    }
    const confirmed = await fixflowMcp.call<Record<string, unknown>>('confirm_resolution', {
      incident_id: repair.id,
      confirmed: true,
      note: 'The user explicitly confirmed that the appliance is fixed.',
    });
    return {
      reply: 'Great — I’ve recorded your confirmation and marked the repair resolved. The history is retained, and the case is still not closed until you choose “Close repair case.”',
      toolName: 'confirm_resolution',
      toolPayload: confirmed,
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(close (the )?(repair|case|incident)|close it)\b/)) {
    if (!repair || repair.status !== 'RESOLVED') {
      return result('I can’t close this case yet. First, the visit must be marked complete and you must explicitly confirm that the appliance is fixed.');
    }
    const closed = await fixflowMcp.call<Record<string, unknown>>('close_repair', {
      incident_id: repair.id,
      confirmed: true,
    });
    return {
      reply: 'The repair case is now closed, and the timeline and previous repair history remain saved for later.',
      toolName: 'close_repair',
      toolPayload: closed,
      refresh: true,
      navigate: 'history',
    };
  }

  if (has(text, /\b(leaking again|washer is leaking|washing machine is leaking|new repair|report (a )?repair)\b/)) {
    const activeWasher = context.activeRepairs.find((item) =>
      `${item.title} ${item.asset_name ?? ''}`.toLowerCase().includes('wash'),
    );
    if (activeWasher) {
      const [detail, history, warranty] = await Promise.all([
        fixflowMcp.call<{ repair: Repair }>('get_repair', { incident_id: activeWasher.id }),
        fixflowMcp.call<HistoricalRepair[]>('get_repair_history', { incident_id: activeWasher.id }),
        fixflowMcp.call<Warranty>('check_warranty', { asset_id: activeWasher.asset_id }),
      ]);
      return {
        reply: `I found the existing washing-machine case, so I didn’t create a duplicate. Its status is ${friendlyStatus(detail.repair.status).toLowerCase()}; there are ${Math.max(0, history.length - 1)} previous repair record(s) and the simulated warranty is ${warranty.covered ? 'active' : 'not confirmed active'}. I’ll keep this incident moving until you confirm the leak is fixed.`,
        toolName: 'get_repair',
        toolPayload: { history_records: history.length, warranty_active: Boolean(warranty.covered) },
        refresh: true,
        navigate: 'repair',
      };
    }
    const created = await fixflowMcp.call<Repair>('create_repair', {
      asset_id: 'asset-washer-01',
      title: 'Washing machine leak',
      description: 'Water is collecting under the washer after a cycle.',
      original_report: command,
      priority: 'HIGH',
    });
    return {
      reply: `I created and saved a new washing-machine repair case (${created.id}). I’ll first check history and warranty before suggesting a repair partner or appointment.`,
      toolName: 'create_repair',
      toolPayload: { incident_id: created.id },
      refresh: true,
      navigate: 'repair',
    };
  }

  if (has(text, /\b(hi|hello|hey|good morning|good evening)\b/)) {
    return result('Hello! I’m the local FixFlow demo assistant. Tell me about a broken appliance, ask for the repair history, or try “Repair partner missed visit” to see the recovery workflow.');
  }

  if (repair) {
    const current = await fixflowMcp.call<{ repair: Repair }>('get_repair', { incident_id: repair.id });
    return {
      reply: `${current.repair.title} is ${friendlyStatus(current.repair.status).toLowerCase()}. I’ll keep the repair moving with its saved timeline and next safe step. Try “What am I waiting for?”, “Repair partner missed visit”, or “Show my repair history.”`,
      toolName: 'get_repair',
      toolPayload: { status: current.repair.status },
      refresh: true,
    };
  }
  return result('I’m not sure which repair you mean. Tell me the appliance, for example “What happened with the washing machine?”, so I don’t change the wrong case.');
}

export function friendlyStatus(status: string): string {
  const labels: Record<string, string> = {
    CREATED: 'New case',
    INVESTIGATING: 'Being investigated',
    VENDOR_SEARCH: 'Finding a repair partner',
    WAITING_VENDOR: 'Waiting for a repair partner',
    OPTIONS_READY: 'Options ready',
    WAITING_APPROVAL: 'Waiting for your approval',
    BOOKED: 'Visit scheduled',
    EXPECTED_VISIT: 'Visit expected',
    NO_SHOW: 'Repair partner missed the visit',
    RESCHEDULING: 'Finding a new time',
    WAITING_PART: 'Waiting for parts',
    IN_PROGRESS: 'Work in progress',
    AWAITING_CONFIRMATION: 'Awaiting your confirmation',
    RESOLVED: 'Confirmed fixed',
    CLOSED: 'Case closed',
  };
  return labels[status] || status.replaceAll('_', ' ').toLowerCase();
}
