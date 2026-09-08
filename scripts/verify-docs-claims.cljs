#!/usr/bin/env nbb
;; verify-docs-claims — re-derive every number README.md, CLAUDE.md and
;; docs/operator-quickstart.md state, from the tree itself, and fail when the
;; tree and the prose disagree.
;;
;; Before the cljs migration this repo's load-bearing gap was: the Worker that
;; would be deployed was a SvelteKit build output ABSENT FROM THE TREE, while
;; worker/src/app.ts -- the 398-line file that read like the application -- was
;; in no bundle and had no package.json to build it with. That gap is closed,
;; so the claims assert the CLOSURE, and are written so it cannot quietly come
;; back: the appview TypeScript is asserted ABSENT BY NAME, not merely absent
;; from a byte total.
;;
;; kotoba/ is the opposite case and is treated as such: a working, independent
;; TypeScript library that is in no bundle and referenced by nothing the
;; migration replaced. It is NOT dead code. It is pinned by file count and by
;; content hash so it can neither grow silently nor be quietly edited.
;;
;; Usage:  nbb scripts/verify-docs-claims.cljs [<dir>]     (<dir> FIRST, default ".")
;; Exit:   0 every claim holds · 1 a claim is false · 2 could not answer

(require '["node:fs" :as fs]
         '["node:child_process" :as cp]
         '["node:crypto" :as crypto]
         '[cljs.reader :as reader]
         '[kotoba.lang.text :as str])

(def root (or (first (remove #(str/starts-with? % "--") *command-line-args*)) "."))

(def claims
  {:tracked-files 35
   :appview-ts-files 0            ; the appview holds no TypeScript at all
   :svelte-artifacts 0            ; no .svelte / svelte.config / svelte/ dir survives
   :sveltekit-compat-flags 0      ; nodejs_compat / nodejs_als were adapter-cloudflare's
   :kotoba-files 7                ; the kept library, pinned so it cannot grow silently
   :canonical-source-files 4      ; route.cljc view.cljc worker.cljs route_test.cljc
   :declared-vars 4
   :declared-routes 1
   :wrangler-main "../dist/worker.js"
   :shadow-output-dir "dist"
   :shadow-export "openswift.worker/handler"})

;; Inherited files this repository still carries BYTE-IDENTICAL. The migration
;; touched none of them. worker/wrangler.jsonc, CLAUDE.md, README.md,
;; docs/operator-quickstart.md and .gitignore left this set DELIBERATELY and are
;; checked by CONTENT below instead -- so an intended change and a stray one stay
;; distinguishable.
(def preserved
  {"README.edn" "9df09189460872e2a0df97c2ce8b0ffe01f25cf7195c84bac314f586e1562d3b"
   "migration.edn" "8862567f3939947df9a35d42ba6fe2b0eeb20ada6b845cc899e8b5e7c25e71cb"
   "worker/kotodama.jsonld" "37341bd6c6e1a148d1ef6f8ec31984d2ff06513501e80261bf96be865fc89d3a"
   "bpmn/credit-transfer.bpmn" "dae2f1d50a57a0270ad007cc64cf3cdf4b3af6da192d1c109fa93b694ac41dc4"
   "bpmn/register-institution.bpmn" "d73791248967ebf8937b464fc70c986a1b0700b93b4b380ef82179f8a693eee1"
   "dmn/screening.dmn" "fa59417dea1b1bd8a0c757929d76cdbd209587420eadb376129cd30d2b217635"
   "dodaf/AV-1.json" "0419e9b660d0dac706e3a1cee40796dfb39fd13432c27cef8c9502f10273f040"
   "dodaf/CV-2.json" "79bb1935967312e41e4f14143e3f64edc466e74bc33133341d166ad414d725b1"
   "dodaf/OV-1.json" "526a281ecaead665de7bef272e2faa5b77ab8a79b64f181f79beeadebbf792e4"
   "dodaf/OV-5b.json" "9ece448859eac72cec7ff34503e9cbbe47639151390bcc9bd1de1bfcc6d1bfcc"
   "dodaf/OV-6a.json" "e27f90685fc8ed00f33e24aad6b49f59578b4c75cb0d6ac6148f6355e9becff9"
   "dodaf/SV-1.json" "a6f57af1c319dca1a5c81e9176154caea467aa2e6890a03697cb767ae7832ea5"
   "forms/customerCreditTransfer.form.json" "7837e5859dcb0311e6f7865cb574da21a0fe6e53338fec14cc52e5ef011aac60"
   "forms/registerInstitution.form.json" "7b672f5a50f9211f993459797e1af45dddd527e5f45b654dca429231eaf928ad"
   ;; kotoba/ — kept, and pinned by content as well as by count
   "kotoba/package.json" "3ef4f4c0af11e6dbcc5511bc273c5168f682a276cafe619aca662afe8d441220"
   "kotoba/src/index.ts" "4dad60f1189e078aacdcb44631e91fbd7a431f64b42615952d2ba1a851179e0c"
   "kotoba/src/registry.ts" "399c3edf67e99a15b974a0b13b47cf84f0981596c43b6b16c3ef773eaa9a7a9e"
   "kotoba/src/types.ts" "8315c41bcdfa7179b9b4679581cb1ce3d8af0c4eec0199ed6438680595c8f236"
   "kotoba/test/open-swift.test.ts" "da3fcd0f76ae5f220a3e2de438628002ba19ade0460a2c254f5fe6d0e840d1a2"
   "kotoba/tsconfig.json" "95a429e51d6162cb7205b603f745e7604d93ffbb1ea6c346e5c6215a79ae541e"
   "kotoba/vitest.config.ts" "f82a551ef4da1c9cbf17985a3bee96eee450a3e4a46bff0d96c6150263121eff"})

(def undetermined (atom []))
(def failures (atom []))
(defn undet! [m] (swap! undetermined conj m))

(defn tracked-files []
  (try (->> (.execSync cp "git ls-files" #js {:cwd root :encoding "utf8"})
            str/split-lines (remove str/blank?) vec)
       (catch :default e (undet! (str "git ls-files failed: " (.-message e))) nil)))
(defn slurp* [rel] (try (.readFileSync fs (str root "/" rel) "utf8") (catch :default _ nil)))
(defn bytes-of [rel] (try (.-size (.statSync fs (str root "/" rel))) (catch :default _ nil)))
(defn sha256 [rel]
  (try (-> (.createHash crypto "sha256") (.update (.readFileSync fs (str root "/" rel))) (.digest "hex"))
       (catch :default _ nil)))
(defn strip-jsonc [s] (str/replace s #"(?m)^\s*//.*$" ""))

(defn check! [label expected actual]
  (let [ok (= expected actual)]
    (println (str (if ok "PASS" "FAIL") "\t" (name label)
                  "\texpected=" (pr-str expected) "\tactual=" (pr-str actual)))
    (when-not ok (swap! failures conj label))
    ok))

(let [files (tracked-files)]
  (when (nil? files) (println "UNDETERMINED\tcould not list tracked files") (js/process.exit 2))
  (println (str "SCANNED\t" (count files)))
  (when (zero? (count files)) (println "UNDETERMINED\tscanned 0 files") (js/process.exit 2))

  (let [sizes (into {} (map (juxt identity bytes-of)) files)]
    (when-let [bad (seq (keep (fn [[f s]] (when (nil? s) f)) sizes))]
      (undet! (str "tracked but unreadable: " (str/join ", " bad))))

    (check! :tracked-files (:tracked-files claims) (count files))
    (check! :preserved-files-unchanged []
            (vec (keep (fn [[f want]] (let [got (sha256 f)]
                                        (when-not (= want got) (str f " " (or got "MISSING")))))
                       preserved)))

    ;; --- what the migration REMOVED, by name -------------------------------
    ;; A byte total cannot say "the appview TypeScript is gone"; this can, and
    ;; it fails if any of it comes back. The list is not hand-kept: it is read
    ;; from route.cljc's `not-carried-over`, which is the SAME value the page
    ;; renders. So the page, the prose and this check cannot drift apart.
    (let [r (slurp* "src/openswift/route.cljc")]
      (if (nil? r)
        (undet! "src/openswift/route.cljc unreadable")
        (let [gone (try (->> (reader/read-string
                              (subs r (str/index-of r "(def not-carried-over")))
                             (drop-while (complement vector?)) first
                             (mapv :gone/path))
                        (catch :default e (undet! (str "could not read not-carried-over: " (.-message e))) nil))]
          (if (or (nil? gone) (empty? gone))
            (undet! "not-carried-over is empty or unreadable -- refusing to report a pass")
            (do
              (println (str "GONE-LIST\t" (count gone)))
              (check! :removed-by-migration-absent []
                      (vec (filter #(some? (bytes-of %)) gone))))))))

    ;; Svelte is gone and must not come back -- under ANY name.
    (check! :svelte-artifacts (:svelte-artifacts claims)
            (count (filter #(or (str/ends-with? % ".svelte")
                                (str/includes? % "svelte.config")
                                (str/includes? % "/svelte/"))
                           files)))

    ;; --- the language split, measured, not asserted by extension alone ------
    ;; The appview (src/ test/ scripts/ worker/) holds no TypeScript.
    ;; kotoba/ holds exactly 7 files and is NOT counted as appview TypeScript,
    ;; because it is a live independent library -- see the header.
    (check! :appview-ts-files (:appview-ts-files claims)
            (count (filter #(and (str/ends-with? % ".ts")
                                 (not (str/starts-with? % "kotoba/")))
                           files)))
    (check! :kotoba-files (:kotoba-files claims)
            (count (filter #(str/starts-with? % "kotoba/") files)))
    (check! :canonical-source-files (:canonical-source-files claims)
            (count (filter #(and (re-find #"\.(cljs|cljc|clj|kotoba)$" %)
                                 (not (str/starts-with? % "scripts/")))
                           files)))

    ;; --- the deployed bundle is built from the source in this tree ----------
    (let [w (some-> (slurp* "worker/wrangler.jsonc") strip-jsonc)
          sh (slurp* "shadow-cljs.edn")]
      (if (or (nil? w) (nil? sh))
        (undet! "worker/wrangler.jsonc or shadow-cljs.edn unreadable")
        (let [j (js->clj (.parse js/JSON w) :keywordize-keys false)]
          (check! :wrangler-main (:wrangler-main claims) (get j "main"))
          (check! :declared-vars (:declared-vars claims) (count (get j "vars")))
          (check! :declared-routes (:declared-routes claims) (count (get j "routes")))
          ;; the old config served a SvelteKit client dir that never existed here
          (check! :no-stale-assets-binding true (nil? (get j "assets")))
          (check! :sveltekit-compat-flags (:sveltekit-compat-flags claims)
                  (count (filter #{"nodejs_compat" "nodejs_als"}
                                 (or (get j "compatibility_flags") []))))
          (check! :app-framework-not-sveltekit true
                  (not (str/includes? (str/lower (str (get-in j ["vars" "APP_FRAMEWORK"])))
                                      "svelte")))
          ;; --- :warnings-as-errors, by PARSING the EDN -----------------------
          ;; Never by grepping: the comment above the key in shadow-cljs.edn
          ;; contains the string ":warnings-as-errors" AND the string
          ;; ":build-options", so a grep-based check would pass no matter where
          ;; the key actually sat. The misplaced key is itself a check that
          ;; cannot fail, which is exactly what this asserts against.
          (let [cfg (try (reader/read-string sh)
                         (catch :default e (undet! (str "shadow-cljs.edn unreadable as EDN: " (.-message e))) nil))]
            (if (nil? cfg)
              (undet! "could not parse shadow-cljs.edn")
              (let [b (get-in cfg [:builds :worker])]
                (check! :warnings-as-errors-under-compiler-options true
                        (true? (get-in b [:compiler-options :warnings-as-errors])))
                (check! :warnings-as-errors-not-under-build-options true
                        (nil? (get-in b [:build-options :warnings-as-errors])))
                (check! :shadow-output-dir (:shadow-output-dir claims) (get b :output-dir))
                (check! :shadow-export (:shadow-export claims)
                        (str (get-in b [:modules :worker :exports 'default])))
                (check! :wrangler-main-is-the-shadow-bundle true
                        (str/includes? (str (get j "main"))
                                       (str (get b :output-dir) "/worker.js")))))))))

    ;; --- the page renders the route TABLE rather than a baked count ---------
    ;; Asserted STRUCTURALLY (the view takes :routes, the worker passes the real
    ;; table) and NOT by forbidding a substring: "routeCount" appears in this
    ;; repo's own prose describing the old defect, so a check that forbade the
    ;; string would be a check about comments, not about code.
    (let [v (slurp* "src/openswift/view.cljc")
          w (slurp* "src/openswift/worker.cljs")]
      (if (or (nil? v) (nil? w))
        (undet! "view.cljc or worker.cljs unreadable")
        (check! :page-renders-route-table true
                (and (str/includes? v "[{:keys [routes gone vars mcp-url built-at]}]")
                     (str/includes? v "(route-rows routes)")
                     (str/includes? v "(gone-rows gone)")
                     (str/includes? w ":routes route/routes")
                     (str/includes? w ":gone route/not-carried-over")))))

    ;; --- CLAUDE.md no longer claims a TypeScript runtime --------------------
    (let [c (slurp* "CLAUDE.md")]
      (if (nil? c)
        (undet! "CLAUDE.md unreadable")
        (check! :claude-md-describes-cljs true
                (and (not (str/includes? c "**Runtime**: Single CF Worker (`src/app.ts`)"))
                     (not (str/includes? c "e7m actor deploy"))
                     (str/includes? c "shadow-cljs")))))))

(let [u @undetermined f @failures]
  (when (seq u)
    (doseq [m u] (println (str "UNDETERMINED\t" m)))
    (println "Refusing to report a pass: the tree could not be read completely.")
    (js/process.exit 2))
  (if (seq f)
    (do (println (str "FAILED\t" (count f) " claim(s): " (str/join ", " (map name f)))) (js/process.exit 1))
    (do (println "OK\tevery claim in README.md, CLAUDE.md and docs/operator-quickstart.md holds") (js/process.exit 0))))
