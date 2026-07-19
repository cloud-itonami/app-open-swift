import { describe, it, expect, beforeEach } from "vitest";
import { MockEtzhayyim } from "@etzhayyim/sdk-mock";
import {
  registerInstitution,
  getInstitution,
  listInstitutions,
  sendCustomerCreditTransfer,
  acknowledgeMessage,
  getMessage,
  listMessages,
  coverage,
} from "../src/index.js";

const BIC_A = "DEUTDEFF"; // Deutsche Bank, DE
const BIC_B = "CHASUS33"; // JPMorgan Chase, US
const UETR = "f1e2d3c4-b5a6-4789-8abc-def012345678";

describe("open-swift kotoba", () => {
  let e: any;
  beforeEach(() => {
    e = new MockEtzhayyim({ did: "did:web:open-swift.etzhayyim.com" });
  });

  describe("institution directory", () => {
    it("registers + reads back, derives country from BIC, lists by country", async () => {
      const r = await registerInstitution(e, { bic: BIC_A, name: "Deutsche Bank" });
      expect(r.status).toBe("registered");
      const got = await getInstitution(e, { bic: BIC_A });
      expect(got.institution?.name).toBe("Deutsche Bank");
      expect(got.institution?.country).toBe("DE");
      await registerInstitution(e, { bic: BIC_B, name: "JPMorgan Chase" });
      expect((await listInstitutions(e)).total).toBe(2);
      expect((await listInstitutions(e, { country: "US" })).total).toBe(1);
    });
    it("is idempotent + rejects invalid BIC", async () => {
      await registerInstitution(e, { bic: BIC_A, name: "Deutsche Bank" });
      expect((await registerInstitution(e, { bic: BIC_A, name: "x" })).status).toBe("alreadyExists");
      expect((await registerInstitution(e, { bic: "TOO_SHORT", name: "x" })).status).toBe("rejected");
    });
  });

  describe("credit transfer + ack", () => {
    beforeEach(async () => {
      await registerInstitution(e, { bic: BIC_A, name: "Deutsche Bank" });
      await registerInstitution(e, { bic: BIC_B, name: "JPMorgan Chase" });
    });
    it("sends against existing institutions; rejects unknown FI + bad UETR/amount", async () => {
      const r = await sendCustomerCreditTransfer(e, { uetr: UETR, fromBic: BIC_A, toBic: BIC_B, amountMicros: "1500000", currency: "EUR" });
      expect(r.status).toBe("submitted");
      expect((await getMessage(e, { uetr: UETR })).message?.status).toBe("submitted");
      expect((await sendCustomerCreditTransfer(e, { uetr: "11111111-1111-4111-8111-111111111111", fromBic: BIC_A, toBic: "GH0STXX0", amountMicros: "1", currency: "EUR" })).status).toBe("rejected"); // digit in first 6 → invalid BIC
      expect((await sendCustomerCreditTransfer(e, { uetr: "11111111-1111-4111-8111-111111111111", fromBic: BIC_A, toBic: "ANZBAU3M", amountMicros: "1", currency: "EUR" })).status).toBe("institutionNotFound");
      expect((await sendCustomerCreditTransfer(e, { uetr: "not-a-uuid", fromBic: BIC_A, toBic: BIC_B, amountMicros: "1", currency: "EUR" })).status).toBe("rejected");
      expect((await sendCustomerCreditTransfer(e, { uetr: "22222222-2222-4222-8222-222222222222", fromBic: BIC_A, toBic: BIC_B, amountMicros: "12.5", currency: "EUR" })).status).toBe("rejected");
    });
    it("is idempotent on UETR", async () => {
      await sendCustomerCreditTransfer(e, { uetr: UETR, fromBic: BIC_A, toBic: BIC_B, amountMicros: "1", currency: "EUR" });
      expect((await sendCustomerCreditTransfer(e, { uetr: UETR, fromBic: BIC_A, toBic: BIC_B, amountMicros: "1", currency: "EUR" })).status).toBe("alreadyExists");
    });
    it("acks + nacks; guards terminal state", async () => {
      await sendCustomerCreditTransfer(e, { uetr: UETR, fromBic: BIC_A, toBic: BIC_B, amountMicros: "1", currency: "EUR" });
      expect((await acknowledgeMessage(e, { uetr: UETR, ack: "ack" })).newStatus).toBe("acknowledged");
      const nack = await acknowledgeMessage(e, { uetr: "33333333-3333-4333-8333-333333333333", ack: "nack" });
      expect(nack.status).toBe("notFound");
      // nack a fresh message → rejected (terminal), then re-ack guarded
      const U2 = "44444444-4444-4444-8444-444444444444";
      await sendCustomerCreditTransfer(e, { uetr: U2, fromBic: BIC_A, toBic: BIC_B, amountMicros: "1", currency: "EUR" });
      expect((await acknowledgeMessage(e, { uetr: U2, ack: "nack", reason: "insufficient detail" })).newStatus).toBe("rejected");
      expect((await acknowledgeMessage(e, { uetr: U2, ack: "ack" })).status).toBe("rejected");
    });
  });

  describe("list + coverage", () => {
    beforeEach(async () => {
      await registerInstitution(e, { bic: BIC_A, name: "Deutsche Bank" });
      await registerInstitution(e, { bic: BIC_B, name: "JPMorgan Chase" });
      await sendCustomerCreditTransfer(e, { uetr: UETR, fromBic: BIC_A, toBic: BIC_B, amountMicros: "1", currency: "EUR" });
    });
    it("lists by bic + direction", async () => {
      expect((await listMessages(e, { bic: BIC_A, direction: "sent" })).total).toBe(1);
      expect((await listMessages(e, { bic: BIC_A, direction: "received" })).total).toBe(0);
      expect((await listMessages(e, { bic: BIC_B, direction: "received" })).total).toBe(1);
    });
    it("coverage rolls up institutions + messages by status", async () => {
      const cov = await coverage(e);
      expect(cov.institutionCount).toBe(2);
      expect(cov.messageCount).toBe(1);
      expect(cov.messagesByStatus?.submitted).toBe(1);
    });
  });
});
