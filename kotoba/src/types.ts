/**
 * open-swift kotoba — record types.
 *
 * Per ADR-2605203000 Option B. ISO 20022 / pacs.008-style interbank messaging:
 * institution BIC directory + message envelopes (UETR) + ACK/NACK. Registry on
 * AT PDS records (replaces D1 institutions/messages/acknowledgements).
 * ADR-2605172000 kotoba.
 *
 * CUSTODY NOTE: only routing-level fields (BIC, UETR, amount, currency, status)
 * are stored. Debtor/creditor account-level PII is NOT held on the substrate
 * (would be operator-producible financial PII) — in a compliant deployment it
 * stays E2E / off-substrate. This registry is the messaging-routing layer.
 *
 * Identity hierarchy:
 *   did:web:open-swift.etzhayyim.com                          — controller
 *   did:web:open-swift.etzhayyim.com:institution:{bic}        — a participant FI
 *   did:web:open-swift.etzhayyim.com:message:{uetr}           — a message
 */

export const OSW_DID_PREFIX = "did:web:open-swift.etzhayyim.com:" as const;

export const INSTITUTION_COLLECTION = "com.etzhayyim.apps.openSwift.institution";
export const MESSAGE_COLLECTION = "com.etzhayyim.apps.openSwift.message";

// ─── Institution ────────────────────────────────────────────────────

export interface InstitutionRecord {
  did: string;
  /** BIC (8 or 11 chars, canonical key). */
  bic: string;
  name: string;
  /** ISO 3166-1 alpha-2 (= chars 5–6 of the BIC). */
  country: string;
  /** Optional DID of the participant institution. */
  institutionDid?: string;
  createdAt: string;
}

export interface InstitutionView extends InstitutionRecord {
  institutionUri: string;
}

export interface RegisterInstitutionInput {
  bic: string;
  name: string;
  institutionDid?: string;
}

export interface RegisterInstitutionOutput {
  status: "registered" | "alreadyExists" | "rejected";
  institutionUri?: string;
  did?: string;
  bic?: string;
  error?: string;
}

export interface GetInstitutionInput {
  bic: string;
}

export interface GetInstitutionOutput {
  institution?: InstitutionView;
  error?: string;
}

export interface ListInstitutionsInput {
  country?: string;
  limit?: number;
  cursor?: string;
}

export interface ListInstitutionsOutput {
  items: InstitutionView[];
  cursor?: string;
  total: number;
}

// ─── Message (pacs.008 envelope) ────────────────────────────────────

export type MessageStatus = "submitted" | "acknowledged" | "rejected" | "settled";

export interface MessageRecord {
  did: string;
  /** UETR — Unique End-to-End Transaction Reference (UUID, canonical key). */
  uetr: string;
  fromBic: string;
  toBic: string;
  /** Amount in minor units (micros) as a decimal string. */
  amountMicros: string;
  /** ISO 4217 currency. */
  currency: string;
  status: MessageStatus;
  /** Reason on NACK/rejection. */
  reason?: string;
  createdAt: string;
}

export interface MessageView extends MessageRecord {
  messageUri: string;
}

export interface SendCreditTransferInput {
  uetr: string;
  fromBic: string;
  toBic: string;
  amountMicros: string;
  currency: string;
}

export interface SendCreditTransferOutput {
  status: "submitted" | "alreadyExists" | "rejected" | "institutionNotFound";
  messageUri?: string;
  did?: string;
  uetr?: string;
  error?: string;
}

export interface AcknowledgeMessageInput {
  uetr: string;
  ack: "ack" | "nack";
  reason?: string;
}

export interface AcknowledgeMessageOutput {
  status: "updated" | "notFound" | "rejected";
  uetr?: string;
  newStatus?: MessageStatus;
  error?: string;
}

export interface GetMessageInput {
  uetr: string;
}

export interface GetMessageOutput {
  message?: MessageView;
  error?: string;
}

export interface ListMessagesInput {
  /** Match messages where this BIC is sender or receiver. */
  bic?: string;
  direction?: "sent" | "received";
  status?: MessageStatus;
  limit?: number;
  cursor?: string;
}

export interface ListMessagesOutput {
  items: MessageView[];
  cursor?: string;
  total: number;
}

export interface CoverageInput {
  maxScan?: number;
}

export interface CoverageOutput {
  institutionCount?: number;
  messageCount?: number;
  messagesByStatus?: Record<string, number>;
  truncated?: boolean;
  error?: string;
}

// ─── Validation + helpers ───────────────────────────────────────────

export function isValidBic(s: string): boolean {
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s);
}

/** UUID (any version) — UETR is a UUIDv4 in ISO 20022. */
export function isValidUetr(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function isIntString(s: string): boolean {
  return /^\d+$/.test(s);
}

export function institutionDidFor(bic: string): string {
  return `${OSW_DID_PREFIX}institution:${bic.toLowerCase()}`;
}
export function institutionRkey(bic: string): string {
  return `institution-${bic.toLowerCase()}`;
}
export function messageDid(uetr: string): string {
  return `${OSW_DID_PREFIX}message:${uetr.toLowerCase()}`;
}
export function messageRkey(uetr: string): string {
  return `message-${uetr.toLowerCase()}`;
}
