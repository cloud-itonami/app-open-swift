# operator quickstart — app-open-swift

**2026-08-18 に、node_modules / lockfile / `.svelte-kit` を全部消した状態から
上から下まで実走した手順**だけを書く。踏めない手順は書かない。実測値（exit code・
件数・バイト数・HTTP status）はそのとき出たものである。

所要: §1 の `npm install` が **実測 189 秒**（git 依存の `tsc` 準備 install が大半）。
残りはいずれも秒単位で、§3 の `wrangler dev` の起動待ちが 25 秒ほど。

## 0. この端末の前提（repo の欠陥ではない）

`npm install` がこのマシンで `EALLOWSCRIPTS` で落ちる:

```
npm error code EALLOWSCRIPTS
npm error --allow-scripts is not allowed in project-scoped installs.
```

`~/.npmrc` の `allow-scripts[]=` が、git 依存の準備 install
（`npm install --force …`）に漏れて渡り、npm 11.16.0 がそれを拒否する。
**空の userconfig で隔離すると通る**:

```bash
: > /tmp/empty-npmrc
export npm_config_userconfig=/tmp/empty-npmrc     # 以降のすべての npm に効かせる
```

以下の手順はこれを export 済みとして書く。**この症状を repo 側で直さないこと** ——
`package.json` にも `.npmrc` にもこの repo は関与していない。

## 1. `kotoba/` — 型検査とテスト（唯一テストが在る面）

```bash
cd kotoba
npm install          # 実測 exit 0 / node_modules 75 entries
npm run typecheck    # 実測 exit 0（tsc --noEmit、出力なし）
npm test             # 実測 exit 0 → "Test Files 1 passed (1)" / "Tests 7 passed (7)"
```

`npm install` は `@etzhayyim/sdk` と `@etzhayyim/sdk-mock` を **git 依存**として
（commit 固定で）取りに行くので、ここだけネットワークと `tsc` の実行が要る。
`npm warn allow-scripts` の警告が数行出るが、`prepare: tsc` の告知であって失敗では
ない。

テストは `MockEtzhayyim` に対して走るので**外部 PDS も D1 も要らない**。

### テストが本当に discriminate することを自分で確かめる

README §4 の 4 変異は、この手順で再現できる（**壊す → 赤 → 復元 → 緑**）:

```bash
cd kotoba
cp src/registry.ts /tmp/registry.bak
perl -0pi -e 's{country: bic\.slice\(4, 6\)}{country: bic.slice(0, 2)}' src/registry.ts
npx vitest run       # 実測 exit 1 — "registers + reads back, derives country from BIC" のみ赤
cp /tmp/registry.bak src/registry.ts
git diff --exit-code -- src/registry.ts   # 実測 exit 0（byte 一致）
npx vitest run       # 実測 exit 0 → 7 passed
```

**落ちたテストが、壊した不変条件と一致していることを確かめる。** 別のテストが
道連れで赤くなるなら、それは実演になっていない。

## 2. `worker/svelte/` — 実際にデプロイされる面のビルド

```bash
cd worker/svelte
npm install          # 実測 exit 0
```

ビルドは**必ず resource-guard 経由**で起動する（superproject の規約: 高負荷 build は
同時 1 本）:

```bash
node <superproject>/scripts/resource-guard.mjs run build -- npm run build
# 実測 exit 0 / "✓ built in 4.23s" / .svelte-kit/cloudflare/_worker.js = 4,335 B
```

`npm_config_userconfig` は **export しておく**こと —— `resource-guard.mjs` は
`spawnSync` で第 1 引数をコマンド名として扱うので、`VAR=… npm run build` の形で
渡すと `ENOENT` になる（実測）。

型検査:

```bash
npm run check        # 実測 exit 0 → "COMPLETED 163 FILES 0 ERRORS 0 WARNINGS"
```

**`worker/src/app.ts` はこの手順に含まれない。** `worker/` に `package.json` も
`tsconfig.json` も無いので、ビルドも型検査もされない（README §3-F）。

## 3. ローカルで route を実測する

`worker/` に降りて `wrangler dev` を上げる。`wrangler.jsonc` の `main` が §2 の
生成物を指しているので、**先に §2 を通しておくこと**（通っていないと起動しない）。

```bash
cd worker
wrangler dev --local --port 8801 --ip 127.0.0.1
```

`Ready on http://127.0.0.1:8801` が出るまで待つ（実測で 25 秒ほど。
`compatibility_date 2026-04-20` に対する fallback 警告と、このマシンの fd 上限に
由来する `EMFILE: too many open files, watch` が出るが、**サーバは起動する**）。

別の shell から:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8801/            # 実測 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8801/health      # 実測 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8801/_app/meta   # 実測 404
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS http://127.0.0.1:8801/xrpc/anything   # 実測 204
curl -s -X POST -H 'content-type: application/json' -d '{}' -w '\nHTTP %{http_code}\n' \
  http://127.0.0.1:8801/xrpc/com.etzhayyim.apps.openSwift.listInstitutions
# 実測 → {"message":"Internal Error"} / HTTP 500
```

**この 500 は期待値である**（§4 の DNS 事情による。README §3-D/E）。**`/health` が
404 なのも期待値**であって、環境の失敗ではない —— `/health` を持つ `app.ts` は
デプロイされていない。

終わったら止める。ポートが解放されることまで確認する:

```bash
pkill -f "wrangler dev --local --port 8801"
lsof -nP -iTCP:8801 -sTCP:LISTEN     # 実測 空
```

## 4. 転送先が実在するかを見る

```bash
for h in open-swift.etzhayyim.com mcp.etzhayyim.com etzhayyim.com; do
  printf '%-30s %s\n' "$h" "$(dig +short "$h" | tr '\n' ' ')"
done
# 実測:
#   open-swift.etzhayyim.com       （空）
#   mcp.etzhayyim.com              （空）
#   etzhayyim.com                  104.21.51.111 172.67.179.128

curl -s -o /dev/null -w '%{http_code}\n' https://etzhayyim.com/    # 実測 200（対照）
```

前 2 つが空で 3 つ目が 200 なら、**測定側は正常で、この repo の route と転送先が
まだ存在しない**ということ。§3 の POST が 500 になるのはこれが原因で、
`+server.ts` の `fetch` に `catch` が無いため 502 ではなく汎用 500 になる。

## 5. デプロイ（この repo からは、まだできない）

`wrangler deploy` を打つ前に、少なくとも次の 3 つが要る。**現状どれも無い**:

1. **`open-swift.etzhayyim.com` の DNS レコード** —— `wrangler.jsonc` の `routes` が
   `open-swift.etzhayyim.com/*` を張るが、いま解決しない（§4）。
2. **転送先 `mcp.etzhayyim.com`** —— 解決しない。デプロイしても `POST /xrpc/…` は
   §3 と同じ 500 を返すだけになる。
3. **何をデプロイするかの決定** —— 今 `main` が指しているのは 2 route の proxy で、
   6 XRPC を持つ `app.ts` ではない（README 冒頭の表）。`app.ts` を出すなら
   `d1_databases` binding・`worker/package.json`・`tsconfig.json` が別途要る
   （README §3-F）。

superproject の規約により、**デプロイは `origin/main` を包含した checkout からのみ**
行う（`wrangler-deploy-main-sync-guard.cljs` が遅れた checkout の `wrangler deploy` を
deny する）。

## 6. 手順どおり動かすと出る生成物

§1〜§3 を実行すると、`git status` に次の 6 種が出る:

```
kotoba/node_modules/          worker/svelte/node_modules/
kotoba/package-lock.json      worker/svelte/package-lock.json
worker/.wrangler/             worker/svelte/.svelte-kit/
```

この 6 種だけを `.gitignore` に入れてある（2026-08-18 に追加。それ以前この repo に
`.gitignore` は無かった）。**これ以外を無視しない** —— 生成物でないものを隠すと、
次に測る人が「無い」と読む。
