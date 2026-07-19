/**
 * open-swift kotoba — institution BIC directory + message (pacs.008) registry
 * + ACK/NACK + coverage. AT PDS records (no RW/D1).
 *
 * A message references existing sender + receiver institutions (FK on BIC).
 * Only routing-level fields are stored; account-level PII stays off-substrate.
 */

import type { Etzhayyim } from "@etzhayyim/sdk";
import {
  INSTITUTION_COLLECTION,
  MESSAGE_COLLECTION,
  institutionDidFor,
  institutionRkey,
  isIntString,
  isValidBic,
  isValidUetr,
  messageDid,
  messageRkey,
  type AcknowledgeMessageInput,
  type AcknowledgeMessageOutput,
  type CoverageInput,
  type CoverageOutput,
  type GetInstitutionInput,
  type GetInstitutionOutput,
  type GetMessageInput,
  type GetMessageOutput,
  type InstitutionRecord,
  type InstitutionView,
  type ListInstitutionsInput,
  type ListInstitutionsOutput,
  type ListMessagesInput,
  type ListMessagesOutput,
  type MessageRecord,
  type MessageStatus,
  type MessageView,
  type RegisterInstitutionInput,
  type RegisterInstitutionOutput,
  type SendCreditTransferInput,
  type SendCreditTransferOutput,
} from "./types.js";

const PAGE_LIMIT = 100;
const DEFAULT_MAX_SCAN = 10_000;

async function exists(e: Etzhayyim, collection: string, rkey: string): Promise<boolean> {
  const resp = await e.read({ collection, rkey }).catch(() => ({ records: [] }));
  return Boolean(resp.records[0]?.value);
}

// ─── Institution ────────────────────────────────────────────────────

export async function registerInstitution(
  e: Etzhayyim,
  input: RegisterInstitutionInput,
): Promise<RegisterInstitutionOutput> {
  if (!input.bic || !input.name) return { status: "rejected", error: "missingRequiredFields" };
  const bic = input.bic.toUpperCase();
  if (!isValidBic(bic)) return { status: "rejected", error: "invalidBic" };
  const rkey = institutionRkey(bic);
  const existing = await e
    .read<InstitutionRecord>({ collection: INSTITUTION_COLLECTION, rkey })
    .catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", institutionUri: existing.records[0].uri, did: existing.records[0].value.did, bic };
  }
  const did = institutionDidFor(bic);
  const record: InstitutionRecord = {
    did,
    bic,
    name: input.name,
    country: bic.slice(4, 6),
    institutionDid: input.institutionDid,
    createdAt: new Date().toISOString(),
  };
  const receipt = await e.write({
    collection: INSTITUTION_COLLECTION,
    record: record as unknown as Record<string, unknown>,
    rkey,
  });
  return { status: "registered", institutionUri: receipt.uri, did, bic };
}

export async function getInstitution(e: Etzhayyim, input: GetInstitutionInput): Promise<GetInstitutionOutput> {
  if (!input.bic) return { error: "invalidBic" };
  const resp = await e
    .read<InstitutionRecord>({ collection: INSTITUTION_COLLECTION, rkey: institutionRkey(input.bic.toUpperCase()) })
    .catch(() => ({ records: [] }));
  const r = resp.records[0];
  if (!r) return { error: "notFound" };
  return { institution: { ...r.value, institutionUri: r.uri } };
}

export async function listInstitutions(
  e: Etzhayyim,
  input: ListInstitutionsInput = {},
): Promise<ListInstitutionsOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<InstitutionRecord>({ collection: INSTITUTION_COLLECTION, cursor: input.cursor, limit });
  const country = input.country?.toUpperCase();
  const items: InstitutionView[] = resp.records
    .filter((r) => (country ? r.value.country === country : true))
    .map((r) => ({ ...r.value, institutionUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Message (pacs.008 credit transfer) ─────────────────────────────

export async function sendCustomerCreditTransfer(
  e: Etzhayyim,
  input: SendCreditTransferInput,
): Promise<SendCreditTransferOutput> {
  if (!input.uetr || !input.fromBic || !input.toBic || !input.amountMicros || !input.currency) {
    return { status: "rejected", error: "missingRequiredFields" };
  }
  if (!isValidUetr(input.uetr)) return { status: "rejected", error: "invalidUetr" };
  const fromBic = input.fromBic.toUpperCase();
  const toBic = input.toBic.toUpperCase();
  if (!isValidBic(fromBic) || !isValidBic(toBic)) return { status: "rejected", error: "invalidBic" };
  if (!isIntString(input.amountMicros)) return { status: "rejected", error: "invalidAmount" };
  if (!/^[A-Z]{3}$/.test(input.currency.toUpperCase())) return { status: "rejected", error: "invalidCurrency" };

  if (!(await exists(e, INSTITUTION_COLLECTION, institutionRkey(fromBic)))) {
    return { status: "institutionNotFound", error: `institutionNotFound:${fromBic}` };
  }
  if (!(await exists(e, INSTITUTION_COLLECTION, institutionRkey(toBic)))) {
    return { status: "institutionNotFound", error: `institutionNotFound:${toBic}` };
  }

  const rkey = messageRkey(input.uetr);
  const existing = await e.read<MessageRecord>({ collection: MESSAGE_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", messageUri: existing.records[0].uri, did: existing.records[0].value.did, uetr: input.uetr };
  }
  const did = messageDid(input.uetr);
  const record: MessageRecord = {
    did,
    uetr: input.uetr.toLowerCase(),
    fromBic,
    toBic,
    amountMicros: input.amountMicros,
    currency: input.currency.toUpperCase(),
    status: "submitted",
    createdAt: new Date().toISOString(),
  };
  const receipt = await e.write({
    collection: MESSAGE_COLLECTION,
    record: record as unknown as Record<string, unknown>,
    rkey,
  });
  return { status: "submitted", messageUri: receipt.uri, did, uetr: input.uetr };
}

export async function acknowledgeMessage(
  e: Etzhayyim,
  input: AcknowledgeMessageInput,
): Promise<AcknowledgeMessageOutput> {
  if (!input.uetr || (input.ack !== "ack" && input.ack !== "nack")) {
    return { status: "rejected", error: "invalidAck" };
  }
  const rkey = messageRkey(input.uetr);
  const resp = await e.read<MessageRecord>({ collection: MESSAGE_COLLECTION, rkey }).catch(() => ({ records: [] }));
  const msg = resp.records[0]?.value;
  if (!msg) return { status: "notFound", error: "messageNotFound" };
  if (msg.status === "settled" || msg.status === "rejected") {
    return { status: "rejected", error: `messageTerminal:${msg.status}` };
  }
  const newStatus: MessageStatus = input.ack === "ack" ? "acknowledged" : "rejected";
  await e.write({
    collection: MESSAGE_COLLECTION,
    record: { ...msg, status: newStatus, reason: input.reason } as unknown as Record<string, unknown>,
    rkey,
  });
  return { status: "updated", uetr: input.uetr, newStatus };
}

export async function getMessage(e: Etzhayyim, input: GetMessageInput): Promise<GetMessageOutput> {
  if (!input.uetr) return { error: "invalidUetr" };
  const resp = await e
    .read<MessageRecord>({ collection: MESSAGE_COLLECTION, rkey: messageRkey(input.uetr) })
    .catch(() => ({ records: [] }));
  const r = resp.records[0];
  if (!r) return { error: "notFound" };
  return { message: { ...r.value, messageUri: r.uri } };
}

export async function listMessages(e: Etzhayyim, input: ListMessagesInput = {}): Promise<ListMessagesOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<MessageRecord>({ collection: MESSAGE_COLLECTION, cursor: input.cursor, limit });
  const bic = input.bic?.toUpperCase();
  const items: MessageView[] = resp.records
    .filter((r) => {
      const v = r.value;
      if (input.status && v.status !== input.status) return false;
      if (bic) {
        if (input.direction === "sent") return v.fromBic === bic;
        if (input.direction === "received") return v.toBic === bic;
        return v.fromBic === bic || v.toBic === bic;
      }
      return true;
    })
    .map((r) => ({ ...r.value, messageUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Coverage ───────────────────────────────────────────────────────

async function countAll<T>(e: Etzhayyim, collection: string, maxScan: number, onRow: (v: T) => void): Promise<number> {
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < maxScan) {
    const page = await e.read<T>({ collection, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      if (scanned >= maxScan) break;
      onRow(r.value);
      scanned += 1;
    }
    if (scanned >= maxScan || !page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  return scanned;
}

export async function coverage(e: Etzhayyim, input: CoverageInput = {}): Promise<CoverageOutput> {
  const maxScan = Math.min(input.maxScan ?? DEFAULT_MAX_SCAN, DEFAULT_MAX_SCAN);
  const institutionCount = await countAll<InstitutionRecord>(e, INSTITUTION_COLLECTION, maxScan, () => {});
  const messagesByStatus: Record<string, number> = {};
  const messageCount = await countAll<MessageRecord>(e, MESSAGE_COLLECTION, maxScan, (v) => {
    messagesByStatus[v.status] = (messagesByStatus[v.status] ?? 0) + 1;
  });
  return {
    institutionCount,
    messageCount,
    messagesByStatus,
    truncated: institutionCount >= maxScan || messageCount >= maxScan,
  };
}
