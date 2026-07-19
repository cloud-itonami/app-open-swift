// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 etzhayyim Japan株式会社 / etzhayyim. All rights reserved.
// Licensed under the Apache License, Version 2.0 — see LICENSE at repo root.

// etzhayyim-project-open-swift — interbank messaging (ISO 20022 pacs.008-style)
//
// 6 XRPC under com.etzhayyim.apps.openSwift.*:
//   registerInstitution            (proc)   participant directory entry
//   listInstitutions               (query)  participant directory
//   sendCustomerCreditTransfer     (proc)   FI → FI customer credit transfer (pacs.008-equivalent)
//   acknowledgeMessage             (proc)   pacs.002 ACK / camt.029 NACK
//   getMessage                     (query)  message detail + ack history
//   listMessages                   (query)  messages by institution / direction / status / since
//
// Storage: D1. UETR uuidv4 keyed messages. Settlement screening DMN
// (openSwift.screening) mirrored; APPROVE → PENDING; REVIEW → HOLD; REJECT
// returned synchronously without persistence.

import AV1 from "../../dodaf/AV-1.json";
import OV1 from "../../dodaf/OV-1.json";
import OV5b from "../../dodaf/OV-5b.json";
import OV6a from "../../dodaf/OV-6a.json";
import CV2 from "../../dodaf/CV-2.json";
import SV1 from "../../dodaf/SV-1.json";
import registerInstitutionForm from "../../forms/registerInstitution.form.json";
import customerCreditTransferForm from "../../forms/customerCreditTransfer.form.json";
import { bootstrapDodaf } from "./dodaf-bootstrap";

const DODAF_VIEWS: Record<string, any> = {
  "open-swift.AV-1": AV1, "open-swift.OV-1": OV1, "open-swift.OV-5b": OV5b,
  "open-swift.OV-6a": OV6a, "open-swift.CV-2": CV2, "open-swift.SV-1": SV1,
};
const FORMS: Record<string, any> = {
  "openSwift.registerInstitution.v1": registerInstitutionForm,
  "openSwift.customerCreditTransfer.v1": customerCreditTransferForm,
};

export interface Env {
  SWIFT_DB: D1Database;
  PDS?: Fetcher;
  AUTH_SERVICE?: Fetcher;
  APP_HANDLE: string;
  PRIMARY_DID: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS institutions (
    institution_did TEXT PRIMARY KEY,
    bic TEXT NOT NULL UNIQUE,
    legal_name TEXT NOT NULL,
    country TEXT NOT NULL,
    currencies_csv TEXT NOT NULL,
    registered_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    uetr TEXT PRIMARY KEY,
    msg_type TEXT NOT NULL,
    debtor_agent_bic TEXT NOT NULL,
    creditor_agent_bic TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    value_date TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','HOLD','SETTLED','REJECTED')),
    screening_decision TEXT NOT NULL,
    screening_reason TEXT NOT NULL,
    require_manual_review INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    settled_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_dr_time ON messages(debtor_agent_bic, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_cr_time ON messages(creditor_agent_bic, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status)`,
  `CREATE TABLE IF NOT EXISTS acknowledgements (
    ack_id TEXT PRIMARY KEY,
    uetr TEXT NOT NULL,
    ack_type TEXT NOT NULL CHECK (ack_type IN ('ACK','NACK')),
    by_bic TEXT NOT NULL,
    reason_code TEXT,
    reason_text TEXT,
    received_at TEXT NOT NULL,
    FOREIGN KEY (uetr) REFERENCES messages(uetr)
  )`,
];

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  for (const s of SCHEMA) await db.exec(s.replace(/\s+/g, " "));
  schemaReady = true;
}

function uuid4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function nanoid(len = 14): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(len));
  let o = ""; for (let i = 0; i < len; i++) o += a[b[i] % a.length]; return o;
}
const now = () => new Date().toISOString();

type XrpcError = "InvalidRequest" | "InstitutionNotFound" | "MessageNotFound"
              | "DuplicateUetr" | "InvalidStatus" | "Unauthorized" | "InternalError";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const err = (e: XrpcError, m: string, s = 400) => json({ error: e, message: m }, s);

function screen(input: { sanctionedJurisdiction: boolean; amount: number; coverPayment: boolean })
  : { decision: "APPROVE" | "REVIEW" | "REJECT"; reason: string; requireManualReview: boolean } {
  if (input.sanctionedJurisdiction)
    return { decision: "REJECT", reason: "SanctionedJurisdiction", requireManualReview: true };
  if (input.amount >= 10_000_000)
    return { decision: "REVIEW", reason: "LargeAmount", requireManualReview: true };
  if (input.coverPayment)
    return { decision: "REVIEW", reason: "CoverPayment", requireManualReview: true };
  return { decision: "APPROVE", reason: "OK", requireManualReview: false };
}

async function registerInstitution(env: Env, input: any): Promise<Response> {
  const { bic, institutionDid, legalName, country, currencies } = input ?? {};
  if (typeof bic !== "string" || !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic))
    return err("InvalidRequest", "bic must match ISO 9362 (8 or 11 alnum)");
  if (typeof institutionDid !== "string" || !institutionDid.startsWith("did:"))
    return err("InvalidRequest", "institutionDid must be a DID");
  if (typeof legalName !== "string" || !legalName.length)
    return err("InvalidRequest", "legalName required");
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))
    return err("InvalidRequest", "country must be ISO-3166 alpha-2");
  const csv = Array.isArray(currencies) ? currencies.join(",")
            : typeof currencies === "string" ? currencies : "";
  if (!csv.length) return err("InvalidRequest", "currencies required");
  const registeredAt = now();
  try {
    await env.SWIFT_DB.prepare(
      `INSERT INTO institutions (institution_did, bic, legal_name, country, currencies_csv, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(institutionDid, bic, legalName, country, csv, registeredAt).run();
  } catch (e: any) {
    if (String(e?.message ?? e).includes("UNIQUE"))
      return err("InvalidRequest", "bic or institutionDid already registered", 409);
    throw e;
  }
  return json({ institutionDid, bic, legalName, country, currencies: csv.split(","), registeredAt });
}

async function listInstitutions(env: Env, params: URLSearchParams): Promise<Response> {
  const country = params.get("country");
  const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 100)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  const where = country ? `WHERE country = ?` : "";
  const binds = country ? [country] : [];
  const total = await env.SWIFT_DB.prepare(`SELECT COUNT(*) AS c FROM institutions ${where}`)
    .bind(...binds).first<{ c: number }>();
  const rows = await env.SWIFT_DB.prepare(
    `SELECT * FROM institutions ${where} ORDER BY registered_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all<any>();
  return json({
    institutions: (rows.results ?? []).map((r) => ({
      institutionDid: r.institution_did, bic: r.bic, legalName: r.legal_name,
      country: r.country, currencies: r.currencies_csv.split(","), registeredAt: r.registered_at,
    })),
    total: Number(total?.c ?? 0), offset, limit,
  });
}

async function sendCustomerCreditTransfer(env: Env, input: any): Promise<Response> {
  const { uetr: providedUetr, debtorAgentBic, creditorAgentBic, debtorName, debtorAccount,
          creditorName, creditorAccount, amount, currency, valueDate, remittanceInfo,
          coverPayment, sanctionedJurisdiction } = input ?? {};
  if (typeof debtorAgentBic !== "string" || typeof creditorAgentBic !== "string")
    return err("InvalidRequest", "debtorAgentBic + creditorAgentBic required");
  if (debtorAgentBic === creditorAgentBic)
    return err("InvalidRequest", "debtor and creditor agents must differ");
  if (typeof amount !== "number" || !(amount > 0)) return err("InvalidRequest", "amount > 0");
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    return err("InvalidRequest", "currency must be ISO 4217");
  if (typeof valueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valueDate))
    return err("InvalidRequest", "valueDate must be YYYY-MM-DD");

  const [da, ca] = await Promise.all([
    env.SWIFT_DB.prepare(`SELECT bic FROM institutions WHERE bic = ?`).bind(debtorAgentBic).first<any>(),
    env.SWIFT_DB.prepare(`SELECT bic FROM institutions WHERE bic = ?`).bind(creditorAgentBic).first<any>(),
  ]);
  if (!da || !ca) return err("InstitutionNotFound", "agent BIC not registered", 404);

  const { decision, reason, requireManualReview } = screen({
    sanctionedJurisdiction: !!sanctionedJurisdiction, amount: Number(amount),
    coverPayment: !!coverPayment,
  });

  // Idempotency on uetr
  let uetr: string;
  if (typeof providedUetr === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(providedUetr)) {
    const prior = await env.SWIFT_DB.prepare(
      `SELECT uetr, status, screening_decision, screening_reason FROM messages WHERE uetr = ?`
    ).bind(providedUetr).first<any>();
    if (prior) return json({
      uetr: prior.uetr, status: prior.status,
      screening: { decision: prior.screening_decision, reason: prior.screening_reason },
      replay: true,
    });
    uetr = providedUetr;
  } else uetr = uuid4();

  if (decision === "REJECT") {
    return json({
      uetr, status: "REJECTED", screening: { decision, reason, requireManualReview },
    }, 200);
  }

  const status = decision === "APPROVE" ? "PENDING" : "HOLD";
  const createdAt = now();
  const payload = {
    debtorName, debtorAccount, creditorName, creditorAccount,
    amount, currency, valueDate, remittanceInfo: remittanceInfo ?? null,
    coverPayment: !!coverPayment, sanctionedJurisdiction: !!sanctionedJurisdiction,
  };
  await env.SWIFT_DB.prepare(
    `INSERT INTO messages (uetr, msg_type, debtor_agent_bic, creditor_agent_bic, amount, currency, value_date,
                           payload_json, status, screening_decision, screening_reason, require_manual_review, created_at)
     VALUES (?, 'pacs.008', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uetr, debtorAgentBic, creditorAgentBic, amount, currency, valueDate,
         JSON.stringify(payload), status, decision, reason,
         requireManualReview ? 1 : 0, createdAt).run();

  if (env.PDS) {
    try {
      await env.PDS.fetch(`https://atproto.etzhayyim.com/xrpc/com.atproto.repo.createRecord`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: env.PRIMARY_DID, collection: "app.bsky.feed.post",
          record: { $type: "app.bsky.feed.post",
            text: `[pacs.008 / ${status}] ${debtorAgentBic}→${creditorAgentBic} ${currency} (uetr ${uetr.slice(0,8)}…)`,
            createdAt },
        }),
      });
    } catch {}
  }
  return json({ uetr, status, screening: { decision, reason, requireManualReview }, createdAt });
}

async function acknowledgeMessage(env: Env, input: any): Promise<Response> {
  const { uetr, ackType, byBic, reasonCode, reasonText } = input ?? {};
  if (typeof uetr !== "string") return err("InvalidRequest", "uetr required");
  if (ackType !== "ACK" && ackType !== "NACK") return err("InvalidRequest", "ackType must be ACK|NACK");
  if (typeof byBic !== "string") return err("InvalidRequest", "byBic required");
  const m = await env.SWIFT_DB.prepare(`SELECT * FROM messages WHERE uetr = ?`).bind(uetr).first<any>();
  if (!m) return err("MessageNotFound", "no such uetr", 404);
  if (m.status !== "PENDING" && m.status !== "HOLD")
    return err("InvalidStatus", `cannot ack message in status ${m.status}`, 409);
  if (byBic !== m.creditor_agent_bic)
    return err("Unauthorized", "only creditor agent may acknowledge", 403);

  const ackId = `ack_${nanoid(14)}`;
  const receivedAt = now();
  const newStatus = ackType === "ACK" ? "SETTLED" : "REJECTED";
  await env.SWIFT_DB.batch([
    env.SWIFT_DB.prepare(
      `INSERT INTO acknowledgements (ack_id, uetr, ack_type, by_bic, reason_code, reason_text, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(ackId, uetr, ackType, byBic, reasonCode ?? null, reasonText ?? null, receivedAt),
    env.SWIFT_DB.prepare(
      `UPDATE messages SET status = ?, settled_at = ? WHERE uetr = ?`
    ).bind(newStatus, ackType === "ACK" ? receivedAt : null, uetr),
  ]);
  return json({ ackId, uetr, ackType, byBic, status: newStatus, receivedAt });
}

async function getMessage(env: Env, params: URLSearchParams): Promise<Response> {
  const uetr = params.get("uetr");
  if (!uetr) return err("InvalidRequest", "uetr required");
  const m = await env.SWIFT_DB.prepare(`SELECT * FROM messages WHERE uetr = ?`).bind(uetr).first<any>();
  if (!m) return err("MessageNotFound", "no such uetr", 404);
  const acks = await env.SWIFT_DB.prepare(
    `SELECT * FROM acknowledgements WHERE uetr = ? ORDER BY received_at ASC`
  ).bind(uetr).all<any>();
  return json({
    uetr: m.uetr, msgType: m.msg_type,
    debtorAgentBic: m.debtor_agent_bic, creditorAgentBic: m.creditor_agent_bic,
    amount: m.amount, currency: m.currency, valueDate: m.value_date,
    payload: JSON.parse(m.payload_json), status: m.status,
    screening: {
      decision: m.screening_decision, reason: m.screening_reason,
      requireManualReview: !!m.require_manual_review,
    },
    createdAt: m.created_at, settledAt: m.settled_at ?? undefined,
    acknowledgements: (acks.results ?? []).map((a) => ({
      ackId: a.ack_id, ackType: a.ack_type, byBic: a.by_bic,
      reasonCode: a.reason_code ?? undefined, reasonText: a.reason_text ?? undefined,
      receivedAt: a.received_at,
    })),
  });
}

async function listMessages(env: Env, params: URLSearchParams): Promise<Response> {
  const bic = params.get("bic");
  const direction = params.get("direction"); // outbound|inbound
  const status = params.get("status");
  const since = params.get("since");
  const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 100)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  const clauses: string[] = []; const binds: any[] = [];
  if (bic) {
    if (direction === "outbound")      { clauses.push(`debtor_agent_bic = ?`);   binds.push(bic); }
    else if (direction === "inbound")  { clauses.push(`creditor_agent_bic = ?`); binds.push(bic); }
    else { clauses.push(`(debtor_agent_bic = ? OR creditor_agent_bic = ?)`); binds.push(bic, bic); }
  }
  if (status) { clauses.push(`status = ?`); binds.push(status); }
  if (since)  { clauses.push(`created_at >= ?`); binds.push(since); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = await env.SWIFT_DB.prepare(`SELECT COUNT(*) AS c FROM messages ${where}`)
    .bind(...binds).first<{ c: number }>();
  const rows = await env.SWIFT_DB.prepare(
    `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all<any>();
  return json({
    messages: (rows.results ?? []).map((r) => ({
      uetr: r.uetr, msgType: r.msg_type,
      debtorAgentBic: r.debtor_agent_bic, creditorAgentBic: r.creditor_agent_bic,
      amount: r.amount, currency: r.currency, valueDate: r.value_date,
      status: r.status,
      screening: { decision: r.screening_decision, reason: r.screening_reason },
      createdAt: r.created_at, settledAt: r.settled_at ?? undefined,
    })),
    total: Number(total?.c ?? 0), offset, limit,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      await ensureSchema(env.SWIFT_DB);
      const url = new URL(req.url);
      if (url.pathname === "/health" || url.pathname === "/_worker/health")
        return json({ ok: true, did: env.PRIMARY_DID, ts: now() });
      if (url.pathname === "/_app/meta") {
        if (env.PDS) { try { await bootstrapDodaf(env as any); } catch {} }
        return json({
          did: env.PRIMARY_DID, handle: env.APP_HANDLE,
          xrpc: [
            "com.etzhayyim.apps.openSwift.registerInstitution",
            "com.etzhayyim.apps.openSwift.listInstitutions",
            "com.etzhayyim.apps.openSwift.sendCustomerCreditTransfer",
            "com.etzhayyim.apps.openSwift.acknowledgeMessage",
            "com.etzhayyim.apps.openSwift.getMessage",
            "com.etzhayyim.apps.openSwift.listMessages",
          ],
          dodaf: Object.keys(DODAF_VIEWS), forms: Object.keys(FORMS),
          bpmn: ["registerInstitution", "customerCreditTransfer"],
          dmn:  ["openSwift.screening"],
        });
      }
      if (url.pathname === "/dodaf")
        return json({ views: Object.entries(DODAF_VIEWS).map(([id, v]: any) => ({
          viewId: id, viewType: v.viewType, title: v.title, version: v.version })) });
      if (url.pathname.startsWith("/dodaf/")) {
        const id = decodeURIComponent(url.pathname.slice("/dodaf/".length));
        const v = DODAF_VIEWS[id];
        return v ? json(v) : err("InvalidRequest", `no such view: ${id}`, 404);
      }
      if (url.pathname === "/forms")
        return json({ forms: Object.values(FORMS).map((f: any) => ({ formKey: f.formKey, name: f.name, version: f.version })) });
      if (url.pathname.startsWith("/forms/")) {
        const k = decodeURIComponent(url.pathname.slice("/forms/".length));
        const f = FORMS[k];
        return f ? json(f) : err("InvalidRequest", `no such form: ${k}`, 404);
      }
      if (!url.pathname.startsWith("/xrpc/"))
        return err("InvalidRequest", "only /xrpc/* is served", 404);
      const nsid = url.pathname.slice("/xrpc/".length);
      if (req.method === "GET") {
        switch (nsid) {
          case "com.etzhayyim.apps.openSwift.listInstitutions": return await listInstitutions(env, url.searchParams);
          case "com.etzhayyim.apps.openSwift.getMessage":       return await getMessage(env, url.searchParams);
          case "com.etzhayyim.apps.openSwift.listMessages":     return await listMessages(env, url.searchParams);
          default: return err("InvalidRequest", `unknown query NSID: ${nsid}`, 404);
        }
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        switch (nsid) {
          case "com.etzhayyim.apps.openSwift.registerInstitution":         return await registerInstitution(env, body);
          case "com.etzhayyim.apps.openSwift.sendCustomerCreditTransfer":  return await sendCustomerCreditTransfer(env, body);
          case "com.etzhayyim.apps.openSwift.acknowledgeMessage":          return await acknowledgeMessage(env, body);
          default: return err("InvalidRequest", `unknown procedure NSID: ${nsid}`, 404);
        }
      }
      return err("InvalidRequest", "method not allowed", 405);
    } catch (e: any) {
      return err("InternalError", e?.message ?? String(e), 500);
    }
  },
};
