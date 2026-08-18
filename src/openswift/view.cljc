(ns openswift.view
  "この appview の説明ページ。純 hiccup。

  基盤は `jp-go-dds`(デジタル庁デザインシステム) —— superproject の
  skill `kotoba-uiux` が定める新規 UI の base。色・寸法は `--hig-*` トークン
  契約で書き、raw hex も px フォントサイズも置かない。

  **表示する事実は引数で受け取る。ページの中に焼かない。**
  これは装飾の都合ではなく、docs/adr/0001 が記録した欠陥そのものへの答えで
  ある —— 移行前の `+page.svelte` は `\"routeCount\": 0` と `\"vars\": []` を
  literal で持っていて、隣の wrangler.jsonc が route 1・var 4 を宣言している
  ことに気づけなかった。さらに `relativePath` は切り出し前の
  `60-apps/etzhayyim-project-open-swift/…` を指したままだった。ここでは
  route 表と設定を渡す側が持ち、ページは描くだけなので、両者がずれる余地が
  無い。"
  (:require [jp-go-dds.core :as dds]
            [jp-go-dds.page :as page]
            [jp-go-dds.tokens :as tokens]
            [clojure.string :as str]))

(def app-css
  "app 固有の最小 CSS。`--hig-*` 契約だけを使う(bridge が DADS の上に再定義する)。
  DADS を base にした app の下には `shitsuke.hig` が居ないので、bridge が運んで
  いないトークンは何にも解決しない —— 使うのは運ばれている中だけ。"
  (str/join
   "\n"
   [".osw-lede { color: var(--hig-color-secondary-label); max-width: 42rem; }"
    ".osw-note { color: var(--hig-color-secondary-label); font-size: var(--hig-text-footnote-font-size); }"
    ".osw-mono { font-family: var(--hig-font-mono); overflow-wrap: anywhere; }"]))

(defn- route-rows [routes]
  (mapv (fn [r]
          [(str/upper-case (name (:route/method r)))
           [:span {:class "osw-mono"} (:route/path r)]
           (:route/doc r)
           (dds/chip-label (if (= :added (:route/origin r)) "追加" "移植")
                           {:color (if (= :added (:route/origin r)) "gray" "blue")})])
        routes))

(defn- gone-rows [gone]
  (mapv (fn [g] [[:span {:class "osw-mono"} (:gone/path g)] (:gone/why g)]) gone))

(defn body
  "opts:
   :routes    openswift.route/routes（この Worker が実際に答えるもの）
   :gone      openswift.route/not-carried-over（移植しなかったもの）
   :vars      wrangler が渡した env のキー（**キー名だけ**。値は出さない）
   :mcp-url   XRPC の中継先（route/mcp-router-url の戻り値）
   :built-at  bundle のビルド時刻（不明なら nil）"
  [{:keys [routes gone vars mcp-url built-at]}]
  (dds/container
   (dds/section
    {}
    (dds/heading 1 "open-swift — 銀行間送金メッセージング")
    [:p {:class "osw-lede"}
     "ISO 20022 / pacs.008 相当（参加金融機関の BIC 名簿と顧客送金メッセージ、"
     "その ACK/NACK）を扱う appview の公開面。この面が持つのは中継と説明だけで、"
     "レジストリの実装はここには無い。"])

   (dds/section
    {:title "この面が答えるもの"}
    (dds/table {:caption "公開ルート"
                :headers ["METHOD" "PATH" "何をするか" "出自"]
                :rows (route-rows routes)})
    [:p {:class "osw-note"}
     "この表は Worker の route 表そのものから描いている。ページに焼いた値では"
     "ないので、実際に答えるものと表示がずれない。「移植」は移行前の SvelteKit が"
     "実際に答えていたもの、「追加」はこの移行で足したもの。"])

   (dds/section
    {:title "実行時の設定"}
    (if (seq vars)
      [:div (into [:p] (interpose " " (map (fn [k] (dds/chip-label (name k))) vars)))
       [:p {:class "osw-note"}
        "キー名のみ。**ただし下の中継先だけは値そのもの**（"
        [:span {:class "osw-mono"} "AGENTGATEWAY_MCP_ROUTER_URL"]
        "）—— どこへ中継するかは運用者が見る必要があるので意図的に出している。"
        "それ以外の値は出さない。"]]
      [:p {:class "osw-note"} "env が渡されていない（ローカル描画）。"])
    [:p {:class "osw-note"} "XRPC の中継先: "
     [:span {:class "osw-mono"} mcp-url]])

   (dds/section
    {:title "移植しなかったもの"}
    (dds/table {:caption "この bundle に入っていないファイル（撤去済み、理由つき）"
                :headers ["PATH" "なぜ移していないか"]
                :rows (gone-rows gone)})
    [:p {:class "osw-note"}
     "動かない経路を移植して「移行済み」と言わないため。この表の path は"
     "検証器が tree から不在であることを検査するので、戻ってきたら落ちる。"])

   (dds/section
    {:title "現在地"}
    [:p {:class "osw-lede"}
     "この appview は TypeScript/Svelte から ClojureScript へ移行済み。"
     "deploy される bundle は、いま読んでいるソースからコンパイルされたもので"
     "ある（docs/adr/0001）。中継先ホストは移行時点で DNS を解決しない —— "
     "移行はそれを直さない。"]
    (when built-at
      [:p {:class "osw-note"} "bundle build: " built-at]))))

(defn render
  "完全な HTML 文書。`css` は呼び出し側が渡す(ライブラリは I/O を持たない)。"
  [{:keys [css] :as opts}]
  (page/->page
   {:title "open-swift — 銀行間送金メッセージング"
    :description "ISO 20022 / pacs.008 相当の銀行間送金メッセージングを扱う appview の公開面。"
    :lang "ja"
    :css css
    :app-css (str tokens/bridge-css "\n" app-css)}
   (body opts)))
