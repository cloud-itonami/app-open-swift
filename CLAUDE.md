# open-swift.etzhayyim.com — Interbank Messaging (ISO 20022 / pacs.008-style) (OSS)

**Status**: MVP scaffold (2026-04-20). Reference implementation for
DID-addressed interbank wire-transfer messaging — companion to
`open-banking`. Apache-2.0.

## Scope (MVP)

| NSID | Type | Description |
|---|---|---|
| `com.etzhayyim.apps.openSwift.registerInstitution` | procedure | register a participant institution (BIC + DID) |
| `com.etzhayyim.apps.openSwift.listInstitutions` | query | participant directory |
| `com.etzhayyim.apps.openSwift.sendCustomerCreditTransfer` | procedure | submit a pacs.008-equivalent FI→FI customer credit transfer |
| `com.etzhayyim.apps.openSwift.acknowledgeMessage` | procedure | beneficiary FI ACK / NACK (pacs.002 / camt.029-equivalent) |
| `com.etzhayyim.apps.openSwift.getMessage` | query | message detail (status + audit trail) |
| `com.etzhayyim.apps.openSwift.listMessages` | query | messages by institution / direction / status / since |

## Architecture

- **Runtime**: Single CF Worker (`src/app.ts`)
- **Storage**: D1. Tables: `institutions`, `messages`, `acknowledgements`
- **Identity**: institution = path-based DID
  `did:web:open-swift.etzhayyim.com:institution:{bic}`
- **Message UETR**: each message gets a UUIDv4 (Unique End-to-End Transaction
  Reference) — same idea as ISO 20022 `UETR`
- **Settlement screening** by DMN (`openSwift.screening`):
  amount + sanctioned-jurisdiction flag + cover-payment indicator → `{decision, reason, requireManualReview}`
- **Audit**: every `sendCustomerCreditTransfer` emits `app.bsky.feed.post`
  to the participant feed (large-tx public marker, amount-redacted)

## Not in MVP

- gpi tracker, real-time payment confirmations
- pacs.009 FI-to-FI direct, camt.054 credit notification
- liquidity / settlement netting (handled by external clearing)
- HSM / key custody for message signing

## Local Dev / Deploy

```bash
cd 60-apps/etzhayyim-project-open-swift/worker
wrangler d1 create etzhayyim-open-swift
e7m actor deploy .
```
