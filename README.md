# app-open-swift

銀行間送金メッセージング（ISO 20022 / pacs.008 相当 — 参加金融機関の BIC 名簿と
顧客送金メッセージ、その ACK/NACK）を扱う repo。

**2026-08-19、appview を TypeScript/Svelte から ClojureScript へ移した**
（[`docs/adr/0001`](docs/adr/0001-migrate-the-appview-from-typescript-to-clojurescript.edn)）。
それ以前は「deploy される handler」と「読み手が開くファイル」が別物で、公開ページは
隣の設定と矛盾していた。この README は、その移行後の**実測した現状**である。

| サブツリー | 何か | 動くか | deploy されるか |
|---|---|---|---|
| **`src/openswift/`** | **ClojureScript**。route 表 + ページ + Worker 入口 | **動く**（6 tests / 33 assertions、実 workerd で 9 route 実測） | **これが deploy される** |
| **`kotoba/`** | TypeScript。`@etzhayyim/sdk` の AT PDS レコードの上の**レジストリ 8 関数** | **動く**（typecheck exit 0、vitest **7 passed**） | **されない**（HTTP 入口が無いライブラリ） |
| 宣言ファイル | BPMN 2 / DMN 1 / DoDAF 6 / Form 2 | — | 配布されない（下記） |

## 1. deploy される面 — `src/openswift/`

```
src/openswift/route.cljk    判断（どの handler が答えるか / 移植しなかったもの）
src/openswift/view.cljk     ページ（jp-go-dds の hiccup）
src/openswift/worker.cljk   Request/Response に触る唯一の層
        ↓ shadow-cljs :target :esm
dist/worker.js              worker/wrangler.jsonc の main が指すもの
```

`wrangler dev --local`（実 workerd）で全 route を実測した。**deploy はしていない。**

| | | |
|---|---|---|
| `GET /` | **200** `text/html` | route 表・撤去一覧・env キーを描いたページ（DADS） |
| `GET /health` | **200** | `{"ok":true,"app":"open-swift","runtime":"cljs","routes":[…]}` |
| `POST /xrpc/<nsid>` | **502** | `{"error":"MCP router unreachable","url":"https://mcp.etzhayyim.com/…"}` |
| `POST /xrpc/a/b` | **502** | 多段パスも単一と同じく**転送する**（§4） |
| `POST /xrpc/` | **400** | 空の nsid だけを拒否 |
| `OPTIONS /xrpc/x` | **204** | CORS preflight |
| `GET /xrpc/x` | **405** | `allow: POST, OPTIONS` |
| `GET /nope` | **404** | |
| `GET /dodaf` | **404** | 未 deploy だった `app.ts` の面を**復活させていない**（§4） |

**描画して採点したページと、bundle が実際に返したページは sha256 が一致する**
（`e5ea57fe…`、84,739 B）。採点した対象と出荷する対象が同じものであることを、
推測ではなく hash で確かめてある。

`/health` は **この移行で足したもの**であって移植ではない。移行前は `app.ts` に
だけ在り、deploy される SvelteKit 側には無く、実測で 404 だった。ページの route 表は
各 route に「移植 / 追加」を表示するので、足したことが隠れない。

## 2. `kotoba/` は TypeScript のまま残した — 移行対象ではないから

**この repo には appview ではない TypeScript が在り、それは消していない。**

- **独立している。** 自分の `package.json` / `tsconfig.json` / `vitest.config.ts` を
  持ち、相対 import は自分の中にしか無い（`test → ../src/index.js` の 1 本だけ）。
- **動く。** 2026-08-19 に clean-room で再実測: `npm install` exit 0
  （node_modules 75 entries）/ `tsc --noEmit` exit 0 / `vitest` **7 passed**。
- **どの bundle にも入らず、移行が置き換えるものから参照されていない。**

つまり dead code ではない。**「TypeScript だから」で消すのは移行ではなく破壊である。**
移すには `@etzhayyim/sdk` の cljs 面が要り、それは別の決定。
`scripts/verify-docs-claims.cljk` が **7 ファイルという件数と 7 件すべての sha256**
を固定しているので、黙って増えることも黙って書き換わることもできない
（変異 M7 で実際に落ちることを確認済み）。

| ファイル | 中身 |
|---|---|
| `src/types.ts` | レコード型 2 種、`MessageStatus` 4 値、BIC・UETR・整数文字列の検証、DID・rkey 生成 |
| `src/registry.ts` | 本体 8 関数。コレクションは `…openSwift.institution` / `.message` |
| `src/index.ts` | barrel |
| `test/open-swift.test.ts` | `MockEtzhayyim` に対する 7 ケース |

## 3. 言語の内訳（移行前 → 移行後、実測）

| | 前 | 後 |
|---|---|---|
| appview の TypeScript | **5**（`app.ts` 19,318 B / `defence-handlers.ts` / `dodaf-bootstrap.ts` / `+server.ts` / `vite.config.ts`） | **0** |
| appview の Svelte | **1**（`+page.svelte`） | **0** |
| appview の JavaScript | **1**（`svelte.config.js`） | **0** |
| 正本言語（cljs/cljc、`scripts/` を除く） | **0** | **4** |
| `kotoba/` の TypeScript | 7 | **7（不変）** |
| tracked files | 36 | **35** |

撤去 10 ファイル / 31,909 B、追加 9 ファイル / 58,935 B。

## 4. 移植しなかったもの（黙って消していない）

正本は `openswift.route/not-carried-over` という**データ**で、**ページがそれを描き、
検証器が tree から不在であることを検査する**。散文ではなく木と突き合わされる主張である。

| path | なぜ |
|---|---|
| `worker/src/app.ts` | どの `package.json` からもビルドされず、`SWIFT_DB` の binding が `wrangler.jsonc` に無い。**deploy されたことが無い** |
| `worker/src/defence-handlers.ts` | どこからも import されず、依存 `@etzhayyim/kotodama-host-sdk` はどの `package.json` にも宣言が無い |
| `worker/src/dodaf-bootstrap.ts` | `app.ts` からのみ読まれる |
| `worker/svelte/src/routes/+page.svelte` | 雛形ページ。`"routeCount": 0` / `"vars": []` を焼いていた（この移行が消す欠陥そのもの） |
| `worker/svelte/src/routes/xrpc/[...path]/+server.ts` | 中継そのものは `worker.cljs` へ移した。SvelteKit の殻だけ落とした |

**DMN の制裁スクリーニング（`app.ts` の `screen()`）も移していない。** この領域で
唯一の「判断」であり移したくなるが、それは `app.ts` の中にあり、`app.ts` は deploy
されたことが無く binding も無い。移せば「動かない経路を移植して移行済みと言う」
ことになる。`dmn/screening.dmn` は宣言として残る（誰も parse しない、移行前から）。

**逆に `/xrpc/` の中継は残した。** 中継先 `mcp.etzhayyim.com` は **DNS を解決しない**
（2026-08-19 実測、`dig +short` が空。対照として apex `etzhayyim.com` は 2 本の A
レコードを返す）。それでも残すのは、**これが deploy されている挙動**であり、
「never deployed かつ binding 未宣言」という撤去条件に当たらないからである。
移行前は `fetch` に catch が無く、名前解決の失敗が SvelteKit の汎用
`500 {"message":"Internal Error"}` に潰れていた。移行後は **502 と、試した URL** を返す。

**多段パス（`/xrpc/a/b`）は移行前と同じく転送する。** 移行前の `+server.ts` は rest
parameter `[...path]` で受け、空のときだけ 400 にしていた。1 セグメントに絞るのは
**移行ではなく方針変更**なので、この commit に入れていない。

## 5. 直していない欠陥（移行の範囲外）

移行前の測定が記録した以下は**まだ在る**。移行はこれらを直さない。

- **`kotoba/` と（撤去した）`app.ts` は custody で正面から矛盾していた。**
  `kotoba/src/types.ts` は "only routing-level fields … account-level PII is NOT
  held on the substrate" と宣言し、`app.ts` は `debtorAccount` / `creditorAccount` を
  D1 に保存していた。`app.ts` を撤去したので**いま口座情報を保存する経路は無い**が、
  どちらが正本かという問いは解いていない。
- **同名 4 関数の契約のずれ**（BIC 正規表現、`country` の導出、金額の型、ACK の権限、
  status 語彙）。`kotoba/` 側だけが残ったので実害は減ったが、CLAUDE.md の設計意図と
  `kotoba/` の実装はまだ完全には一致していない。
- **制裁スクリーニングの入力が送信者の自己申告だった**（`app.ts`）。撤去済み。
- **ホストが NXDOMAIN。** deploy するか retire するかは別の決定。
- **`LICENSE` ファイルがこの repo に無い**（SPDX ヘッダは "see LICENSE at repo root"
  と書くが、その root は切り出し元の `etzhayyim/root`）。

## 6. 使い方

[`docs/operator-quickstart.md`](docs/operator-quickstart.md) —— 実際に走らせた
コマンドと、そのとき出た出力だけを書いてある。

## 7. 最近接の repo との境界

- **`etzhayyim/com-etzhayyim-app-open-swift`** —— 同じ切り出し元から出た兄弟。
- **`cloud-itonami/app-open-power` / `app-open-water`** —— 同じ足場（`kotoba/` +
  SvelteKit BFF + BPMN/DMN/DoDAF）の別領域版。
- **`cloud-itonami/app-ongakuka`** —— この移行の**テンプレート**。同じ
  route.cljc / view.cljc / worker.cljs + smoke + 検証器の形。
- **`cloud-itonami/open-banking`** —— CLAUDE.md が "companion" と書いている相手。
  現在 GitHub で archived。

## 8. ライセンス

Apache-2.0（`kotoba/package.json` の `license` による）。**`LICENSE` ファイルは
この repo に無い**（§5）。
