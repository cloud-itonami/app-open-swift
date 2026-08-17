# app-open-swift

銀行間送金メッセージング（ISO 20022 / pacs.008 相当 — 参加金融機関の BIC 名簿と
顧客送金メッセージ、その ACK/NACK）を扱う repo。**ただしこの repo には同じ主題の
実装が 2 つ入っていて、両者は「何を保管するか」で正面から食い違っている**（§3-A）。
そして**デプロイされるのはそのどちらでもない。**

| サブツリー | 何か | 動くか | デプロイされるか |
|---|---|---|---|
| **`kotoba/`** | TypeScript。`@etzhayyim/sdk` の AT PDS レコードの上の**レジストリ 8 関数**（institution / message / ack / coverage） | **動く**（typecheck exit 0、vitest **7 passed**） | **されない**（HTTP 入口が無いライブラリ） |
| **`worker/svelte/`** | SvelteKit + `adapter-cloudflare`。**route は 2 本だけ** —— `/`（雛形ページ）と `POST /xrpc/[...path]`（`mcp.etzhayyim.com` への転送） | **ビルドは通る**（`vite build` exit 0、`svelte-check` 0 errors） | **これがデプロイされる**（`wrangler.jsonc` の `main`） |
| **`worker/src/app.ts`** | D1 を張った本体。**6 つの XRPC + `/health` + DMN 制裁スクリーニング + BPMN/DoDAF/Form の配布** | **ビルドされない**（`package.json` も `tsconfig` も無い） | **されない** |

**この repo の機能は `worker/src/app.ts`（19,318 B、398 行）に書いてあるが、それは
何からも読まれていない。** デプロイされるのは 2 route の薄い proxy で、その転送先
`mcp.etzhayyim.com` は**現在 DNS を解決しない**（§3-C）。

[`CLAUDE.md`](CLAUDE.md) が列挙する 6 つの XRPC は `app.ts` の実装と**正確に一致する**
——設計文書としては正しい。**この repo の現状の説明として読むと必ず間違える** ——
そこに書かれた `Local Dev / Deploy` の 3 行は、いま 1 行も実行できない（§3-F）。

この README が書くのは設計ではなく、**2026-08-18 に実際に測った現状**である。
手順は [`docs/operator-quickstart.md`](docs/operator-quickstart.md)。

## 1. この repo に在るもの（33 ファイル / 80,242 バイト）

`etzhayyim/root` の `60-apps/etzhayyim-project-open-swift`（rev `7a08afb4`、
31 ファイル / 79,775 バイト）から切り出した standalone artifact
（[`migration.edn`](migration.edn)）。追加の 2 件が `README.edn` と `migration.edn`。
**この `README.md` と `docs/operator-quickstart.md` はさらに後から足している** ——
`migration.edn` の `:allowed-additions` はまだこの 2 件を列挙していないので、そこは
切り出し契約の更新漏れである（fleet の他の repo と同じ扱い。同じ
`:allowed-additions ["README.edn" "migration.edn"]` を持つ `app-open-power` /
`app-legal-entity` も既に `README.md` + `docs/operator-quickstart.md` を持っている）。

### `kotoba/` — AT PDS 上のレジストリ（TypeScript、唯一テストが在る面）

| ファイル | 中身 |
|---|---|
| `src/types.ts`（5,354 B） | レコード型 2 種（institution / message）、`MessageStatus` 4 値、BIC・UETR・整数文字列の検証、DID・rkey 生成 |
| `src/registry.ts`（9,540 B） | 本体 8 関数。コレクションは `…openSwift.institution` / `.message` の 2 本 |
| `src/index.ts`（724 B） | barrel |
| `test/open-swift.test.ts`（5,254 B） | `MockEtzhayyim` に対する 7 ケース |

外部キーは実際に検査される: `sendCustomerCreditTransfer` は **sender / receiver
両方の BIC が institution として存在すること**を確認し、無ければ
`institutionNotFound` を返す。`acknowledgeMessage` は `settled` / `rejected` の
メッセージへの再 ACK を拒否する（**この 2 つを含む 4 箇所を外すとテストが赤くなる
ことを実測した** —— §4）。

BIC は `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` で検証され（ISO 9362 のとおり先頭 6 桁は
英字）、`country` は BIC の 5–6 文字目から**導出される**（入力させない）。金額は
`amountMicros` という**整数の 10 進文字列**で、`isIntString` が小数点を弾く。

`coverage()` は 2 コレクションを最大 10,000 件まで走査して
`{institutionCount, messageCount, messagesByStatus, truncated}` を返す。
**打ち切りを黙って起こさない** —— `truncated` を必ず返す。

### `worker/` — デプロイされる面（2 route）と、されない面（6 XRPC）

| ファイル | 中身 | 到達可能か |
|---|---|---|
| `svelte/src/routes/+page.svelte`（3,081 B） | 生成された雛形ページ | **到達する**（`GET /` → 200） |
| `svelte/src/routes/xrpc/[...path]/+server.ts`（2,803 B） | 任意の nsid を MCP router へ転送 | **到達する**（`POST /xrpc/…`） |
| `src/app.ts`（19,318 B） | 6 XRPC + `/health` + `/_worker/health` + `/_app/meta` + `/dodaf` + `/forms` | **到達しない** |
| `src/defence-handlers.ts`（3,422 B） | defence イベント 1 件を Hyperdrive へ書く handler | **到達しない**（§3-E） |
| `src/dodaf-bootstrap.ts`（1,746 B） | DoDAF ビューの bootstrap | `app.ts` からのみ |

`wrangler.jsonc` の `main` は `svelte/.svelte-kit/cloudflare/_worker.js` である。
**`src/` を指してはいない。**

### 宣言ファイル（BPMN / DMN / DoDAF / Form）

`bpmn/`（2: `registerInstitution` / `customerCreditTransfer`）・`dmn/`（1）・
`dodaf/`（6）・`forms/`（2）。**DoDAF と Form は `app.ts` が `import` して配信する。
BPMN と DMN は誰も parse しない** —— `app.ts:354-355` が名前を文字列として列挙する
だけである。

DMN（`openSwift.screening`、hitPolicy FIRST）は 4 ルールの決定表で、**`app.ts:112-121`
の `screen()` と 1 ルールずつ突き合わせて一致することを確認した**:

| # | 条件 | decision / reason / requireManualReview |
|---|---|---|
| r1 | `sanctionedJurisdiction = true` | `REJECT` / `SanctionedJurisdiction` / `true` |
| r2 | `amount >= 10000000` | `REVIEW` / `LargeAmount` / `true` |
| r3 | `coverPayment = true` | `REVIEW` / `CoverPayment` / `true` |
| r4 | それ以外 | `APPROVE` / `OK` / `false` |

乖離は無い。**ただしこの判断は、動く面のどこにも無い。** `kotoba/` には `screen` も
`sanctioned` も `coverPayment` も 1 語も無く、デプロイされる 2 route も判断しない。
**この領域で唯一の「判断」が、実行される経路から届かない場所にある。**

## 2. 表面が 3 つ

| メソッド（`com.etzhayyim.apps.openSwift.*`） | CLAUDE.md | `app.ts`（未デプロイ） | `kotoba/`（テスト有） |
|---|---|---|---|
| `registerInstitution` | ✅ | ✅ | ✅ |
| `listInstitutions` | ✅ | ✅ | ✅ |
| `sendCustomerCreditTransfer` | ✅ | ✅ | ✅ |
| `acknowledgeMessage` | ✅ | ✅ | ✅ |
| `getMessage` | ✅ | ✅ | ✅ |
| `listMessages` | ✅ | ✅ | ✅ |
| `getInstitution` | — | — | ✅ |
| `coverage` | — | — | ✅ |

**名前は揃っている。中身は揃っていない**（§3-A / §3-B）。

デプロイされる `+server.ts` は **nsid を検査しない** —— `POST /xrpc/<何でも>` を
そのまま MCP router の `tools/call` に詰めて投げる（`event.params.path` が空のときだけ
400）。したがって「この Worker が何を受け付けるか」は、この repo の中には書かれて
いない。

## 3. 測って見つけた欠陥（この周では 1 件も直していない）

**A. 2 つの実装が custody で正面から矛盾する。** `kotoba/src/types.ts:9-12` は
"CUSTODY NOTE: only routing-level fields (BIC, UETR, amount, currency, status) are
stored. Debtor/creditor account-level PII is NOT held on the substrate" と宣言し、
実際 `MessageRecord` に口座欄は無い。**一方 `app.ts:218-222` は
`debtorName` / `debtorAccount` / `creditorName` / `creditorAccount` を
`payload_json` に入れて D1 に保存し**、`getMessage` (`app.ts:286`) が
`payload: JSON.parse(m.payload_json)` としてそのまま返す。
**しかも `app.ts` の query 経路に認可は無い** —— `Unauthorized` は
`acknowledgeMessage` の 1 箇所（`byBic !== creditor_agent_bic` → 403）にしか
現れず、`getMessage` / `listMessages` は誰でも呼べる。
CLAUDE.md が「Architecture」として記述しているのは D1 側、つまり口座情報を持つ方で
ある。**どちらが正本かはこの repo の中からは決まらない。**

**B. 同じ名前の 4 つの関数が、違う契約を持つ。**

| | `app.ts`（D1） | `kotoba/`（PDS、テスト有） |
|---|---|---|
| BIC の妥当性 | `^[A-Z0-9]{8}([A-Z0-9]{3})?$` —— コメントは "ISO 9362" と書くが**先頭 6 桁に数字を許す**（ISO 9362 は英字） | `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` |
| `country` | 呼び出し側が渡す（BIC と食い違っても通る） | BIC の 5–6 文字目から導出 |
| 金額 | `amount REAL`（`app.ts:60`）—— **通貨額を二進浮動小数で保管**。`screen()` の `amount >= 10_000_000` もその float で比較する | `amountMicros`（整数の 10 進文字列、小数点は `isIntString` が拒否） |
| ACK の権限 | `byBic !== creditor_agent_bic` なら 403 | **呼び出し元の識別が引数に無い** —— 誰でも任意の UETR を ACK できる |
| status 語彙 | `PENDING` / `HOLD` / `SETTLED` / `REJECTED` | `submitted` / `acknowledged` / `rejected` / `settled` |

**C. 制裁スクリーニングの入力が、送信者の自己申告である。** `app.ts:173` は
`coverPayment` と `sanctionedJurisdiction` を**リクエスト body から**取る。
`sanctionedJurisdiction` を省けば `!!undefined = false` になり、r1 は発火しない。
登録済み institution の `country` を引いて判定しているわけではない
（`institutions` テーブルは `country` を持っているのに参照していない）。

**D. `/health` が 404 になる。** `app.ts` は `/health` と `/_worker/health` を持つが、
デプロイされるのは SvelteKit 側で、そこに `/health` route は無い。`wrangler dev` を
上げて実測:

```
GET  /                                                    -> 200   （雛形ページ、<title>worker</title>）
GET  /health                                              -> 404   （SvelteKit の 404 HTML）
GET  /_app/meta                                           -> 404
GET  /xrpc/com.etzhayyim.apps.openSwift.listInstitutions   -> 405   （POST/OPTIONS のみ）
OPTIONS /xrpc/anything                                     -> 204   （CORS preflight）
POST /xrpc/com.etzhayyim.apps.openSwift.listInstitutions   -> 500   {"message":"Internal Error"}
```

superproject の `scripts/verify-appview-facade.cljs` も独立に同じことを報告している
（`health-only-in-undeployed-facade:orgs/cloud-itonami/app-open-swift`）。

**500 は `+server.ts` が意図した応答ではない。** あのコードは upstream が非 2xx を
返したとき upstream の status を、JSON-RPC error を返したとき `502` を返すよう
書かれている。名前解決の失敗は `fetch` が**投げる**ので、その分岐に入る前に落ちて
SvelteKit の汎用 500 になる。`fetch` に `catch` が無い。

**E. 転送先が解決しない。** `wrangler.jsonc` の `AGENTGATEWAY_MCP_ROUTER_URL` と
`+server.ts` の既定値が指す `mcp.etzhayyim.com`、および route が張られる
`open-swift.etzhayyim.com` の**両方が DNS を解決しない**（`dig +short` が空）。
対照として apex の `etzhayyim.com` は 2 本の A レコードを返し `GET /` が 200 を返すので、
測定側の問題ではない。

**F. `app.ts` は D1 の binding を持たない。** `SWIFT_DB` を 17 箇所で使うが、
`wrangler.jsonc` に `d1_databases` の項目は無い。`worker/` には `package.json` も
`tsconfig.json` も無いので、**このファイルは型検査もビルドもされていない**
（`worker/svelte/tsconfig.json` は `svelte/` 配下しか見ない）。

**G. `defence-handlers.ts` はどこからも import されていない。** ファイル冒頭の
コメント自身が「`app.ts` にこう配線せよ」と書いているが、`app.ts` に `defence` の語は
1 つも無い。さらにこの handler は `@etzhayyim/kotodama-host-sdk` を import するが、
**その依存はこの repo のどの `package.json` にも宣言されていない**。

**H. `CLAUDE.md` の `Local Dev / Deploy` は 3 行とも実行できない。**

| 行 | 実測 |
|---|---|
| `cd 60-apps/etzhayyim-project-open-swift/worker` | そのパスは無い。**この repo 自身がその directory** である（`migration.edn`） |
| `wrangler d1 create etzhayyim-open-swift` | 作れても binding が無いので何にも繋がらない（§3-F） |
| `e7m actor deploy .` | `e7m` は PATH に無い |

**I. 雛形が残っている。** `+page.svelte` に埋め込まれた定数は `"title":"Worker"` /
`"name":"worker"` / `"routeCount":0` / `"routes":[]` で、`relativePath` は切り出し前の
`60-apps/etzhayyim-project-open-swift/worker/svelte/src/routes/+page.svelte` を指した
ままである。ページの `<title>` は `worker` になる（実測）。

**J. 環境側の罠（repo の欠陥ではない）。** このマシンでは `npm install` が
`EALLOWSCRIPTS` で落ちる —— `~/.npmrc` の `allow-scripts[]=` が git 依存の準備 install
（`npm install --force …`）に漏れ、npm 11.16.0 がそれを「project-scoped install では
使えない」と拒否する。**空の userconfig で隔離すると成功する**ので、これは repo では
なくこの端末の設定である（[`docs/operator-quickstart.md`](docs/operator-quickstart.md)
§0 に回避策）。**この理由で repo 側を「直さない」こと。**

## 4. テストが実際に何かを掴んでいることの確認

`kotoba/` の 7 ケースについて、**4 箇所を壊して、壊した不変条件と落ちたテストが
1 対 1 に対応することを実測した**（4 件とも復元後に `git diff --exit-code` が exit 0、
再実行で 7 passed に復帰）:

| 壊した箇所 | 落ちたテスト | 報告 |
|---|---|---|
| `types.ts` の `isValidBic` を `^[A-Z0-9]{8}…` に緩める（先頭 6 桁に数字を許す） | `sends against existing institutions; rejects unknown FI + bad UETR/amount` **のみ** | `expected 'institutionNotFound' to be 'rejected'` |
| `registry.ts` の `acknowledgeMessage` から terminal 状態ガードを削除 | `acks + nacks; guards terminal state` **のみ** | `expected 'updated' to be 'rejected'` |
| `registry.ts` の `listMessages` から `direction` 分岐を削除 | `lists by bic + direction` **のみ** | `expected 1 to be +0` |
| `registry.ts` の `country: bic.slice(4, 6)` を `slice(0, 2)` に変える | `registers + reads back, derives country from BIC, lists by country` **のみ** | `expected +0 to be 1` |

**掴めていない箇所**（この周では足していない）: `listMessages` の `status` フィルタ、
`listInstitutions` の `cursor` / `limit` 上限 200、`coverage` の `truncated`、
`getInstitution` / `getMessage` の `notFound`、`registerInstitution` の
`missingRequiredFields`、`sendCustomerCreditTransfer` の `invalidCurrency`。

## 5. 最近接の repo との境界

- **`etzhayyim/com-etzhayyim-app-open-swift`** —— 同じ切り出し元から出た兄弟で、
  `verify-appview-facade` は**両方に同一の finding** を報告している。どちらが正本かは
  この repo の中からは決まらない。
- **`cloud-itonami/app-open-power` / `app-open-water`** —— 同じ足場（`kotoba/` +
  SvelteKit BFF + BPMN/DMN/DoDAF）の別領域版。`app-open-power` は同じ形の欠陥
  （`/health` 404、DNS 未解決、D1 binding 欠落、未配線の defence handler、雛形 page）を
  **実測済みで README に記録している** —— この repo でも §3-D〜I として同じものが
  当たった。**§3-A〜C（custody の矛盾・契約のずれ・自己申告のスクリーニング）は
  この repo 固有**である。
- **`cloud-itonami/open-banking`** —— CLAUDE.md が "companion to `open-banking`" と
  書いている相手。現在 GitHub で archived。

## 6. ライセンス

Apache-2.0（`worker/src/*.ts` の SPDX ヘッダと `kotoba/package.json` の `license` に
よる）。**ただし `LICENSE` ファイルはこの repo に無い** —— ヘッダは "see LICENSE at
repo root" と書いているが、その repo root は切り出し元の `etzhayyim/root` である。
