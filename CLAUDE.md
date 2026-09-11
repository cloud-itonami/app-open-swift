# open-swift.etzhayyim.com — Interbank Messaging (ISO 20022 / pacs.008-style) (OSS)

**Status**: appview migrated to ClojureScript (2026-08-19, `docs/adr/0001`).
Reference implementation for DID-addressed interbank wire-transfer messaging —
companion to `open-banking`. Apache-2.0.

## What is actually deployed

The Worker is **ClojureScript**, built by **shadow-cljs** (`:target :esm`) from
`src/openswift/` to `dist/worker.js`, which is what `worker/wrangler.jsonc`'s
`main` points at.

| Route | Origin |
|---|---|
| `GET /` — this appview's description page (jp-go-dds) | ported |
| `POST /xrpc/:nsid` — relay to the MCP router | ported |
| `OPTIONS /xrpc/*` — CORS preflight (204) | ported |
| `GET /health` — liveness | **added by the migration** |

**The relay target `mcp.etzhayyim.com` does not resolve** (measured 2026-08-19,
`dig +short` empty). The route is kept because it is the deployed behaviour; it
answers 502 naming the URL it tried. Deploying or retiring that host is a
separate decision.

## Scope (design intent — NOT what the deployed Worker answers)

These six NSIDs are the domain design. The deployed Worker does **not**
implement them; it relays whatever nsid it is given to the MCP router.
`kotoba/` implements eight of them against an AT PDS, but is a library with no
HTTP entry.

| NSID | Type | Description |
|---|---|---|
| `com.etzhayyim.apps.openSwift.registerInstitution` | procedure | register a participant institution (BIC + DID) |
| `com.etzhayyim.apps.openSwift.listInstitutions` | query | participant directory |
| `com.etzhayyim.apps.openSwift.sendCustomerCreditTransfer` | procedure | submit a pacs.008-equivalent FI→FI customer credit transfer |
| `com.etzhayyim.apps.openSwift.acknowledgeMessage` | procedure | beneficiary FI ACK / NACK (pacs.002 / camt.029-equivalent) |
| `com.etzhayyim.apps.openSwift.getMessage` | query | message detail (status + audit trail) |
| `com.etzhayyim.apps.openSwift.listMessages` | query | messages by institution / direction / status / since |

## `kotoba/` — a separate, working TypeScript library

`kotoba/` is **not** part of the appview and was **not** migrated. It is an
independent library (its own `package.json`, `tsconfig.json`, `vitest.config.ts`)
implementing the registry on an AT PDS via `@etzhayyim/sdk`. Measured
2026-08-19: `npm install` exit 0, `tsc --noEmit` exit 0, **vitest 7 passed**.

It is in no bundle and referenced by nothing the migration replaced, so it is
not dead code and was not deleted. Migrating it is a separate decision that
needs a cljs face for `@etzhayyim/sdk`. See `README.md` §2.

## Not in MVP

- gpi tracker, real-time payment confirmations
- pacs.009 FI-to-FI direct, camt.054 credit notification
- liquidity / settlement netting (handled by external clearing)
- HSM / key custody for message signing

## Local Dev

There is no D1 binding in `worker/wrangler.jsonc` and no `e7m` on PATH; the
previous version of this file gave three commands, none of which could run.
What actually runs is in [`docs/operator-quickstart.md`](docs/operator-quickstart.md):

```bash
amu compile --target wasm32-browser worker          # via the superproject resource guard
kbb --backend sci scripts/smoke-worker.cljk dist/worker.js
npx wrangler dev --local --config worker/wrangler.jsonc
```
