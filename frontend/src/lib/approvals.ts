import { isRecord, type Approval, type JsonRecord } from './types';

function unwrapKnownEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isRecord(current)) return current;
    if (current.ok === false) return current;
    if (current.ok === true && 'data' in current) {
      current = current.data;
      continue;
    }
    // Support SDK/version wrappers without mistaking business-level `data`
    // fields for transport wrappers unless they are explicitly named as such.
    if (isRecord(current.structuredContent)) {
      current = current.structuredContent;
      continue;
    }
    if (isRecord(current.result) && !('id' in current) && !('approval_id' in current)) {
      current = current.result;
      continue;
    }
    if (isRecord(current.approval) && !('id' in current) && !('approval_id' in current)) {
      current = current.approval;
      continue;
    }
    return current;
  }
  return current;
}

function parsedActionPayload(record: JsonRecord): JsonRecord | undefined {
  if (isRecord(record.action_payload)) return record.action_payload;
  if (isRecord(record.proposal)) return record.proposal;
  if (typeof record.action_payload_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(record.action_payload_json);
      if (isRecord(parsed)) return parsed;
    } catch { /* invalid persisted JSON is not actionable */ }
  }
  return undefined;
}

export function approvalIdentifier(value: Approval | null | undefined): string | undefined {
  if (!value) return undefined;
  const candidates = [
    (value as Approval & { approval_id?: unknown }).approval_id,
    (value as Approval & { id?: unknown }).id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function normalizeApprovalRecord(value: unknown): Approval | null {
  let candidate = unwrapKnownEnvelope(value);
  if (!isRecord(candidate)) return null;
  if (!('id' in candidate) && !('approval_id' in candidate) && isRecord(candidate.approval)) {
    candidate = candidate.approval;
  }
  if (!isRecord(candidate)) return null;
  const rawId = (typeof candidate.approval_id === 'string' && candidate.approval_id.trim())
    ? candidate.approval_id : (typeof candidate.id === 'string' && candidate.id.trim()) ? candidate.id : candidate.proposal_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  const payload = parsedActionPayload(candidate);
  const status = typeof candidate.status === 'string' ? candidate.status.toUpperCase() : '';
  if (!['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(status)) return null;
  return {
    ...(candidate as unknown as Approval),
    id: rawId.trim(),
    approval_id: rawId.trim(),
    status,
    action_payload: payload as Approval['action_payload'],
  };
}

export function normalizeProposalApproval(value: unknown, incidentId: string): Approval | null {
  let unwrapped = unwrapKnownEnvelope(value);
  if (!isRecord(unwrapped)) return null;
  if (isRecord(unwrapped.data) && !('id' in unwrapped) && !('approval_id' in unwrapped)) {
    unwrapped = unwrapKnownEnvelope(unwrapped.data);
  }
  if (!isRecord(unwrapped)) return null;
  const nested = isRecord(unwrapped.approval) ? unwrapped.approval : unwrapped;
  const payloadContainer = isRecord(unwrapped.proposal) ? unwrapped.proposal
    : isRecord(nested.proposal) ? nested.proposal
    : parsedActionPayload(nested);
  const rawId = [
    unwrapped.approval_id, unwrapped.id, unwrapped.proposal_id,
    nested.approval_id, nested.id, nested.proposal_id,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  const actionType = typeof unwrapped.action_type === 'string' ? unwrapped.action_type
    : typeof nested.action_type === 'string' ? nested.action_type : 'RESCHEDULE_APPOINTMENT';
  const status = typeof unwrapped.status === 'string' ? unwrapped.status
    : typeof nested.status === 'string' ? nested.status : 'PENDING';
  return {
    ...(nested as unknown as Approval),
    id: rawId.trim(),
    approval_id: rawId.trim(),
    incident_id: typeof unwrapped.incident_id === 'string' ? unwrapped.incident_id
      : typeof nested.incident_id === 'string' ? nested.incident_id : incidentId,
    action_type: actionType,
    status: status.toUpperCase(),
    action_payload: payloadContainer as Approval['action_payload'],
  };
}
