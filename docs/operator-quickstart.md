# operator quickstart — app-open-swift

**2026-08-19 に実際に走らせたコマンドと、そのとき出た出力だけ**を書く。
踏めない手順は書かない。実測値（exit code・件数・バイト数・HTTP status）は
そのとき出たものである。

前提: superproject は `/Users/junkawasaki/github/com-junkawasaki`、この repo は
`orgs/cloud-itonami/app-open-swift`。以下は repo root からの相対で書く。

## 0. この端末の前提（repo の欠陥ではない）

§5 の `kotoba/` だけは `npm install` が要る。このマシンではそれが
`EALLOWSCRIPTS` で落ちる:

```
npm error code EALLOWSCRIPTS
npm error --allow-scripts is not allowed in project-scoped installs.
```

`~/.npmrc` の `allow-scripts[]=` が git 依存の準備 install に漏れて渡り、
npm がそれを拒否する。**空の userconfig で隔離すると通る**:

```bash
: > /tmp/empty-npmrc
export npm_config_userconfig=/tmp/empty-npmrc
```

**この症状を repo 側で直さないこと** —— `package.json` にも `.npmrc` にも
この repo は関与していない。§1〜§4 は npm install 不要（`npx --yes` が
その場で取ってくる）。

## 1. テスト（ビルド不要、いちばん速い）

```bash
K=/Users/junkawasaki/github/com-junkawasaki/orgs/kotoba-lang
CP="src:test:$K/jp-go-digital-design-system/src:$K/html/src:$K/css/src"
cat > /tmp/run-tests.cljs <<'EOF'
(require '[cljs.test :refer [run-tests]] 'openswift.route-test)
(run-tests 'openswift.route-test)
EOF
npx --yes nbb --classpath "$CP" /tmp/run-tests.cljs
```

実測:

```
Testing openswift.route-test

Ran 6 tests containing 33 assertions.
0 failures, 0 errors.
```

## 2. ビルド（**必ず resource-guard 経由**）

superproject の規約で高負荷 build は同時 1 本。**exit 2 は「並んでいる」で
あって失敗ではない**ので、待つのではなく再試行する。

```bash
for i in $(seq 1 60); do
  node /Users/junkawasaki/github/com-junkawasaki/scripts/resource-guard.mjs \
    run build -- npx --yes shadow-cljs release worker > /tmp/b.log 2>&1
  rc=$?
  [ $rc -eq 0 ] && { echo "BUILD OK"; tail -1 /tmp/b.log; break; }
  [ $rc -ne 2 ] && { echo "BUILD FAILED rc=$rc"; tail -20 /tmp/b.log; break; }
  sleep 45
done
```

実測: `[:worker] Build completed. (55 files, 12 compiled, 0 warnings, 7.84s)` /
`dist/worker.js` = **247,829 B** / sha256 `3d33f33ac0aa8d31…`

**cold cache からは byte 再現する。** `:esm` の出力は増分ビルドだと byte が
変わる（安定して変わる）ので、sha を比べるときは必ず先に消す:

```bash
rm -rf .shadow-cljs dist    # これをやらないと sha 比較が偽の警報を出す
```

## 3. smoke — ビルド済み bundle を実際に叩く

```bash
npx --yes nbb scripts/smoke-worker.cljk dist/worker.js ; echo "exit=$?"
```

実測: **20 項目すべて PASS**、`OK  the built bundle answers as the route table says`、
exit **0**。

exit の意味は 3 つに分かれている:

| exit | 意味 | 確認方法 |
|---|---|---|
| 0 | 全部期待どおり | 上 |
| 1 | 期待と違う | §6 の M3 |
| **2** | **判定できなかった**（bundle が無い / import が落ちた） | `npx --yes nbb scripts/smoke-worker.cljk /tmp/nope.js` → exit 2 |

**2 を 0 とも 1 とも別にしてあるのが要点。** 「検査できなかった」が
「検査して問題なかった」と同じ値を返すと、沈黙が緑として積み上がる。

## 4. 検証器 — 散文の数字を木から引き直す

```bash
npx --yes nbb scripts/verify-docs-claims.cljk . ; echo "exit=$?"
```

実測: `SCANNED 35` / `GONE-LIST 5` / 20 claim すべて PASS / exit **0**。

読めなかったものが在れば **exit 2** で終わり、`Refusing to report a pass` と
言う（0 件を clean と数えない）。

## 5. `kotoba/` — 移行対象ではない TypeScript ライブラリ

```bash
export npm_config_userconfig=/tmp/empty-npmrc   # §0
cd kotoba
npm install          # 実測 exit 0 / node_modules 75 entries
npm run typecheck    # 実測 exit 0（tsc --noEmit、出力なし）
npm test             # 実測 exit 0 → "Test Files 1 passed (1)" / "Tests 7 passed (7)"
```

テストは `MockEtzhayyim` に対して走るので**外部 PDS も D1 も要らない**。
`npm warn allow-scripts` が数行出るが `prepare: tsc` の告知であって失敗ではない。

## 6. 実 workerd で動かす（deploy はしない）

```bash
npx --yes wrangler@latest dev --local --config worker/wrangler.jsonc --port 8799
```

実測（`compatibility_flags` を**外した**状態で。§7）:

```
GET     /            -> 200   text/html
GET     /health      -> 200   {"ok":true,"app":"open-swift","runtime":"cljs","routes":["/","/health","/xrpc/:nsid"]}
POST    /xrpc/       -> 400
POST    /xrpc/a/b    -> 502   {"error":"MCP router unreachable","url":"https://mcp.etzhayyim.com/…"}
OPTIONS /xrpc/x      -> 204
GET     /xrpc/x      -> 405   (allow: POST, OPTIONS)
GET     /nope        -> 404
POST    /health      -> 405   (allow: GET)
GET     /dodaf       -> 404
```

`GET /` が返した HTML は、§1 の描画で採点したページと **sha256 が一致する**
（`e5ea57fe…`、84,739 B）。

## 7. `compatibility_flags` を外した根拠

`nodejs_compat` は SvelteKit の `adapter-cloudflare` が要求していたもので、
cljs の `:esm` bundle には要らない。**憶測で消さず**、flag 無しの設定のまま
§6 を通してから撤去した。`assets`（消えた `svelte/.svelte-kit/cloudflare/client`
を指していた）も同様に撤去し、`APP_FRAMEWORK` は `sveltekit-edge-bff` →
`cljs-shadow-esm-worker` に直した。

## 8. 検査が「落ちない」ものになっていないことを、壊して確かめる

**変異は 1 つずつ当てる。** 2 つ同時だと互いを隠す。以下は全部実測。

### M1 — 存在しない var を参照する（`:warnings-as-errors` が効いているか）

```bash
perl -0pi -e 's{\(route/dispatch \(\.-method req\) path\)}{(route/dispatch-NO-SUCH-VAR (.-method req) path)}' src/openswift/worker.cljk
# 再ビルド → 実測 rc=1、"ERROR ... Use of undeclared Var openswift.route/dispatch-NO-SUCH-VAR"
```

### M2 — `:warnings-as-errors` を `:build-options` へ移す

これが**この移行でいちばん重要な実演**である。

- 検証器: `warnings-as-errors-under-compiler-options` と
  `warnings-as-errors-not-under-build-options` の **2 つが FAIL**、exit 1。
- **その状態で M1 をもう一度当てると、ビルドは `rc=0` で通る**
  （`55 files, 1 compiled, 1 warnings` —— warning のまま bundle を書き出す）。
- **その bundle を smoke に掛けると
  `UNDETERMINED could not exercise the bundle: Cannot read properties of undefined
  (reading 'h')` で exit 2。**

つまり「ビルドが通った」は検査ではなかった。**しかも grep 系の検査では捕まらない**
—— `shadow-cljs.edn` の該当箇所のコメント自体が `:warnings-as-errors` と
`:build-options` の両方の文字列を含むので、**壊れた設定に対しても grep は緑になる**
（実測）。だから検証器は **EDN として parse** している。

### M3 — 焼いた CSS を空文字にする（design system の検査が 2 本要る理由）

```bash
perl -0pi -e 's{\(rc/inline "jp_go_dds/dds\.css"\)}{""}' src/openswift/worker.cljk
```

実測（このページで、CSS 有 / 無）:

| token | 有 | 無 |
|---|---|---|
| `class="dads-table"` | 2 | **2** ← **変わらない。この検査は落ちない** |
| `dads-table`（部分一致） | 79 | **11** ← 0 にならない |
| `--color-primitive-blue` | 45 | **0** ← これだけが判別する |

smoke の結果: `page uses the design system components` は **PASS のまま**、
`page carries the stylesheet itself` **だけ FAIL**、exit 1。
「view がライブラリを呼んだ」と「stylesheet が実際に bundle に入った」は
**別の主張**なので、検査を 2 本に割ってある。

### M4 — ページが route 表でなく固定値を描く

unit test が 2 件 FAIL（`/health` と `/xrpc/:nsid` がページに出ていない）、
検証器の `page-renders-route-table` が FAIL。

### M5 — `wrangler.jsonc` の `main` をビルド出力以外へ

検証器の `wrangler-main` と `wrangler-main-is-the-shadow-bundle` が FAIL。

### M6 — 撤去した `worker/src/app.ts` が戻ってくる

検証器の `removed-by-migration-absent` が FAIL し、**path を名指しする**。
（`appview-ts-files` は untracked なので緑のまま —— 名指しの検査と件数の検査は
別のものを見ている。）

### M7 — `kotoba/` が黙って増える

検証器の `kotoba-files`（7→8）と `tracked-files` が FAIL。
`appview-ts-files` は緑のまま（`kotoba/` の増加を appview の TypeScript として
数えない）。

### 復元の確認

各変異のあと、pristine から戻して `git diff --exit-code` が exit 0 になること、
**`rm -rf .shadow-cljs dist` してから**再ビルドした `dist/worker.js` の sha256 が
`3d33f33ac0aa8d31…` に一致することを毎回確認した。**cold start を省くと
この比較は偽の警報を出す**（§2）。
