/**
 * open-swift kotoba — barrel.
 *
 * Per ADR-2605203000 Option B. ISO 20022 / pacs.008 interbank messaging
 * registry on the etzhayyim substrate (AT PDS records; no RW/D1).
 *
 *   institution : registerInstitution / getInstitution / listInstitutions
 *   message     : sendCustomerCreditTransfer / acknowledgeMessage / getMessage / listMessages
 *   coverage
 *
 * Account-level PII stays off-substrate (Custody axis); only routing fields
 * (BIC, UETR, amount, currency, status) are persisted.
 */

export * from "./types.js";
export {
  registerInstitution,
  getInstitution,
  listInstitutions,
  sendCustomerCreditTransfer,
  acknowledgeMessage,
  getMessage,
  listMessages,
  coverage,
} from "./registry.js";
