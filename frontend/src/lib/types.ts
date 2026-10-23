export type JsonRecord = Record<string, unknown>;

export interface Repair {
  id: string;
  household_id: string;
  asset_id: string;
  title: string;
  description: string;
  original_report: string;
  status: string;
  booking_status?: string;
  priority: string;
  next_action: string;
  unresolved_reason?: string;
  current_vendor_id?: string | null;
  current_vendor_name?: string | null;
  current_service_provider_name?: string | null;
  current_appointment_id?: string | null;
  asset_name?: string;
  asset_location?: string;
  asset_brand?: string;
  asset_model?: string;
  household_name?: string;
  household_location?: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
  closed_at?: string | null;
  version?: number;
  [key: string]: unknown;
}

export interface TimelineEvent {
  id: string;
  event_type: string;
  title: string;
  description: string;
  created_at: string;
  details?: JsonRecord;
  details_json?: string;
}

export interface RepairDetail {
  repair: Repair;
  timeline: TimelineEvent[];
}

export interface HistoricalRepair {
  id: string;
  title: string;
  status: string;
  created_at: string;
  closed_at?: string | null;
  resolved_at?: string | null;
  original_report: string;
  asset_name?: string;
}

export interface Warranty {
  asset_id?: string;
  covered?: boolean;
  status?: string;
  message?: string;
  warranty?: {
    provider?: string;
    plan_name?: string;
    status?: string;
    starts_on?: string;
    ends_on?: string;
    coverage_summary?: string;
    service_fee?: number;
    claim_notes?: string;
  };
}

export interface Vendor {
  id: string;
  name: string;
  reliability_score: number;
  previous_household_jobs: number;
  estimated_visit_fee: number;
  estimated_repair_cost: number;
  estimated_total_cost?: number;
  brand_authorized: number | boolean;
  warranty_supported: number | boolean;
  warranty_relevant?: boolean;
  is_preferred: number | boolean;
  rating?: number;
  notes?: string;
  specialties?: string[];
}

export interface AppointmentOption {
  id?: string;
  slot_id: string;
  vendor_id: string;
  vendor_name: string;
  starts_at: string;
  ends_at: string;
  label?: string;
  status?: string;
  price_estimate: number;
  estimated_repair_cost?: number;
  estimated_visit_fee?: number;
  estimated_total_cost?: number;
  brand_authorized?: number | boolean;
  reliability_score: number;
  previous_household_jobs: number;
  is_preferred: number | boolean;
  details?: string;
}

export interface CurrentAppointment {
  appointment: {
    id: string;
    status: string;
    starts_at: string;
    ends_at: string;
    price_estimate: number;
    vendor_id: string;
    vendor_name: string;
    service_provider_name?: string;
    slot_id?: string | null;
    user_approved?: number | boolean;
  };
  simulated?: boolean;
}

export interface Approval {
  id: string;
  incident_id: string;
  action_type: string;
  status: string;
  action_payload?: {
    appointment_id?: string;
    vendor_id?: string;
    slot_id?: string;
    starts_at?: string;
    ends_at?: string;
    price_estimate?: number;
    [key: string]: unknown;
  };
  action_payload_json?: string;
  [key: string]: unknown;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_name?: string | null;
  tool_payload?: JsonRecord | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export type AppView = 'home' | 'repair' | 'history';

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong while talking to FixFlow. Please retry.';
}
