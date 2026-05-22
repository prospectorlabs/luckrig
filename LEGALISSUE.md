# luckrig — 法的論点リスト (LEGAL ISSUES)

最終更新: 2026-05-22 / 対応バージョン: CONCEPT v5.6 / POC v1

---

## 0. このドキュメントは何ではないか

**これは法的助言ではありません。** 法人化、利用規約、コンプライアンス、刑事責任の評価は弁護士の領域です。このドキュメントは、コードを書く agent / 開発者 / 運営者が「luckrigを公開する前に、コードでは決して解けないこと」を見落とさないためのチェックリストです。

書かれているのは「luckrigを公開しようとした人が、最低限調べる/相談する必要がある論点」であり、結論ではありません。

ソース・オブ・トゥルース: [`CONCEPT.md`](./CONCEPT.md) §フィルタリング方針 / §プライバシー設計 / §免責の設計 / §v6以降の宿題。

---

## 1. プラットフォームの法的位置づけ（最重要・未解決）

luckrigはノード提供者と利用者の双方を仲介する **媒介者（intermediary）** である。これは技術的には正確だが、法的にはそれだけでは済まない。

### 1.1 媒介者責任のフレームワークごとの違い

| 管轄 | 想定される枠組み | luckrigに当てはめたときの未解決事項 |
| --- | --- | --- |
| **日本** | プロバイダ責任制限法（プロ責法）／特定電気通信役務提供者 | luckrigトラッカーが「特定電気通信役務提供者」に該当するかは構造解釈の余地あり。発信者情報開示請求への対応体制が要求される可能性。 |
| **米国** | 47 U.S.C. §230（CDA Section 230）／DMCA §512 セーフハーバー | LLM出力が「ユーザー生成コンテンツ」に該当するかは現時点で争いがある。Section 230保護は「自動的に得られる」ものではなく、運用がそれに沿っている必要がある。DMCA agent designation（指定代理人）が登録されていない場合、§512の保護を受けられない。 |
| **EU** | DSA (Digital Services Act) / hosting service provider | trusted flaggers、annual transparency report、point of contact の指定が法定。luckrigの規模ではvery small online platform扱いになり得るが、それでも義務は完全には消えない。 |

**コードで対処済みの下回り（参照: SPEC §7.1c, docs/tracker-api.md §POST /api/abuse/report）:**
- `GET /api/abuse-contact` で連絡先公開
- `POST /api/abuse/report` で通報受付（IP rate-limit、reporter IPはHMAC化）
- `POST /api/bans`（dev-only）で運営者の手動 takedown
- ノード提供者保護のための moderation hook (`LUCKRIG_MODERATION_ENDPOINT`)

**コードでは絶対に解けないこと:**
- 法人化（誰の名前でtrackerを運営するか／個人か法人か）
- 利用規約（Terms of Service）と「同意の取り方」
- プライバシーポリシー（特に GDPR / CCPA / 改正個人情報保護法）
- DMCA designated agent の登録（米国向けに展開する場合）
- 発信者情報開示請求への対応窓口とSLA（日本向け）
- 管轄選択条項（どこの裁判所で争うか）

---

## 2. 違法コンテンツに関する具体的な高リスクカテゴリ

luckrigは「素朴な検知 + 第三者モデレータ + Notice-and-Takedown」の3段で技術的下回りを置いている（CONCEPT §フィルタリング方針）。しかし**カテゴリによっては reactive takedown では免責されない**。

### 2.1 児童性的搾取（CSAM）

最も重い区分。多くの管轄で **「知った後の迅速な削除」では足りず、「能動的な通報義務」がある**。

- **米国**: 18 U.S.C. §2258A により、provider は NCMEC（National Center for Missing & Exploited Children）への通報が義務。luckrigが provider 該当の場合、通報インフラを持っていないこと自体が違法行為になり得る。
- **日本**: 児童ポルノ法（児童買春・児童ポルノに係る行為等の規制及び処罰並びに児童の保護等に関する法律）。プロバイダによる削除義務、警察庁への通報導線。
- **EU**: 2022年提案のCSAM Regulation、DSA下のtrusted flagger 制度。

**コード側の下回り（限定的）:**
- `LUCKRIG_MODERATION_ENDPOINT` を `sexual/minors` を判定できる classifier に接続することは可能（OpenAI Moderation API、Llama-Guard等）。
- `LUCKRIG_MODERATE_OUTPUT=block` で「ユーザーに一度も見せない」運用を強制可能。
- `data/moderation-flags.jsonl` に classifier フラグが残るが、**NCMEC等への通報フォーマットへの自動変換は実装していない**。

**コードでは解けないこと:**
- どの管轄で通報義務が発生するかの判定
- 通報先機関への登録と運用
- 通報義務違反時の刑事責任の評価

### 2.2 武器製造・テロ支援

- 米国: 18 U.S.C. §842(p)（爆発物製造情報の頒布）など。
- 日本: 公務員職権濫用罪等の幇助理論、業務妨害。

`LUCKRIG_MODERATION_ENDPOINT` が `illicit/violent` や `illicit/weapons` を判定できれば技術的にはブロック可能だが、運用上の判断は弁護士領域。

### 2.3 著作権・商標

LLMが学習データに含まれていた著作物を出力する可能性。luckrigは「ノードで動いているモデルが何で訓練されたか」を保証しない（CONCEPT §虚偽リスティングへの設計的対処）が、その立場が法的に通用するかは別問題。

**DMCA Section 512 セーフハーバーを米国で取りに行く場合の最低条件（一般論）:**
1. designated agent の登録（米国著作権局への登録、年次費用あり）
2. takedown notice 受領後の expeditious removal
3. counter-notice 手続き
4. repeat infringer policy

luckrigの ban メカニズム（`POST /api/bans` + `data/bans.jsonl`）は repeat infringer policy の技術的下回りとしては機能するが、**「policy として明文化されているか」「実際に運用されているか」がセーフハーバーの要件**。

### 2.4 個人情報・名誉毀損

LLM出力に実在人物の情報が含まれる可能性。luckrigは prompt も response も local-first（ローカルにしか残らない）でログを保存しないため、削除請求が来てもサーバ側に対象データが存在しない。これは technical defense としては筋が良いが、**「削除請求が来た事実そのもの」への対応義務**は残る。

---

## 3. ノード提供者の保護（コードで踏み込んだ範囲）

ノード提供者（GPU提供側）は **他人のプロンプトで自分のマシン上で推論を走らせる立場** であり、違法な入力を処理させられるリスクの最前線にいる。luckrigはこの保護を v1 で本気で扱った。

| リスク | コード上の防衛線 | 限界 |
| --- | --- | --- |
| 違法プロンプトを処理させられる | `src/shared/filter.js`（regex）→ `src/shared/moderation.js`（外部モデレーション、入力は送信前ブロック、fail-closed） | classifier をすり抜ける高度な隠語 / context attack には限界がある |
| 自分のIPが晒される | CONCEPT §ノード提供側の参入障壁とその解消（Tailscale 等のオーバーレイ推奨） | luckrigが直接配るVPN等は提供していない |
| 自分のリグでCSAMが生成される | `LUCKRIG_MODERATE_OUTPUT=block`、`LUCKRIG_MODERATION_FLAGS_PATH` で証跡保存 | 1) classifier が完璧でない 2) record モードでは1回はユーザーに渡る 3) 通報義務までは自動化していない |
| 自分のリグで生成された出力で訴えられる | response envelope の `moderation` フィールド + replay 永続化 | luckrigは prompt/response 本文をtrackerに残さないため、訴訟になっても証拠提出はノード提供者単独 |

**ノード提供者向けに弁護士相談が必要な論点:**
1. 自分の管轄でluckrigノード運営がどの法律枠に入るか（個人事業／趣味／業）
2. 賠償責任保険の必要性
3. ノード提供時に「何を見ない」よう設定すべきか（プロセス内側の自主規制）

---

## 4. データ保護とプライバシー

luckrigは「local-first（プロンプト/レスポンスはローカルのみ）」を中核設計にしているため、**個人データの保有量が極小**で、これは強い defense になる。ただし以下は残る:

### 4.1 trackerが保有するデータ

| データ | 保存場所 | 個人データ性 |
| --- | --- | --- |
| ノード registry | `data/luckrig.sqlite`, `data/nodes.seed.json` | ノード提供者のpseudonym + endpoint URL（IP含む場合は個人データ） |
| token usage | `data/token-usage.jsonl` | user_id（pseudonym）+ 利用ノード + 時刻 |
| metrics | `data/metrics.jsonl` | ノードの health probe 結果（個人データではない） |
| timing aggregates | `data/timing.jsonl` | opt-in upload、本文なし、user_id含む |
| bans | `data/bans.jsonl` | user_id / IP / node_id |
| abuse reports | `data/abuse-reports.jsonl` | reporter IP は HMAC truncated hash、subject_id は対象の識別子 |

**GDPR / 改正個情報保護法的に注意すべき点:**
- IPアドレスは多くの管轄で個人データに該当する。ban list で raw IP を保存している場合は purpose limitation / retention policy が必要。
- abuse-report の reporter IP hash は personal data ではないと主張可能だが、salt（tracker secret）と合わせれば re-identifiable と見られる可能性。
- データ主体（user_id / node_id 提供者）からのアクセス権／削除権の要求への対応窓口。

### 4.2 ノード側で残るデータ

CONCEPT §プライバシー設計の通り、ノード提供者がプロセス内側に踏み込めば平文を見られる。これは **luckrig側がいくら頑張っても消せない事実** であり、利用者には UI / docs で明示している。ただし:

- ノード提供者が「自分は何を見られる立場にあるか」を understand している必要がある（運営者の責任ではないが、規約で同意を取る価値がある）。
- ノード提供者が悪意でメモリダンプ→販売した場合、luckrigはその経路を防げない。これは規約と運用上の信頼に依存する。

---

## 5. 通信の傍受・暗号化に関する法規制

luckrig は subtext mode で AES-256-GCM を使う（X25519 + HKDF）。これは:

- 日本: 規制なし
- 米国: EAR (Export Administration Regulations) 上、open source の公開暗号は概ね TSU exception の範囲。ただし embargo 国向け配布は別。
- フランス: 一般用途の暗号は完全自由化されたが、特定機能向けは届出が残る場合あり
- ロシア・中国: 商用暗号には規制がある（個人の使用は事実上規制外であることが多いが、保証は薄い）
- 一部の国では VPN 自体が違法

trackerやプロキシをホストする物理的所在地 / 利用者の所在地によって、暗号輸出規制が問題になり得る。luckrig単体では small fish だが、**「どこから配布しているか」を明らかにする必要が生じる場合がある**。

---

## 6. v1 公開前のチェックリスト（コードで完結しない項目のみ）

**コード側はv1で十分。以下は弁護士 / 運営者の領域。**

- [ ] 法人化の要否決定（個人 / 任意団体 / 法人）
- [ ] 管轄選定（どこから運営するか、どの国の利用者を主対象にするか）
- [ ] Terms of Service の作成
  - [ ] ノード提供者向け（責任の所在、運営者からの保証は無いこと、ban条件）
  - [ ] 利用者向け（送信内容に関する禁止事項、ban条件、復活手続き、Acceptable Use Policy）
- [ ] Privacy Policy の作成（保有データ、保存期間、削除請求窓口）
- [ ] DMCA designated agent 登録（米国向け展開する場合）
- [ ] CSAM通報体制の整備（NCMEC等への通報窓口、ログ保全）
- [ ] 通報対応 SLA の宣言（24時間以内に一次対応、等）
- [ ] abuse コンタクト先の確保（個人メールではなく専用エイリアス推奨、`LUCKRIG_ABUSE_CONTACT` に設定）
- [ ] 賠償責任保険の検討
- [ ] 利用者の同意取得フロー（クリックスルー、Privacy Policy / ToS / 違法コンテンツ禁止）の実装方針合意
- [ ] ノード提供者の同意取得フロー（プロセス内側で平文が見える事実の理解確認）
- [ ] 退会・データ削除手続きの定義
- [ ] 監査・トランスペアレンシーレポート方針（DSA対応で必要になり得る）

---

## 7. luckrigが「絶対に言ってはいけないこと」

利用者・ノード提供者・第三者に対して、以下の主張を**してはいけない**。コードでも UI でもドキュメントでも。

| 言ってはいけない | 理由 |
| --- | --- |
| 「end-to-end 暗号化です」 | trust model 上、tracker+node 共謀で読める。ノード提供者は常にプロセス内側で見られる。 |
| 「安全です」「filtered です」 | classifier は完璧ではない。luckrigは "checked" 止まりを誇る。 |
| 「違法コンテンツは通りません」 | record mode では1回は通り得る。block mode でも classifier 限界はある。 |
| 「個人情報は完全に保護されます」 | 通信経路上のメタデータ、ノード側の平文アクセス、tracker側のIP記録は残る。 |
| 「SLA を保証します」 | CONCEPT の根本設計と矛盾。ラッキーなら速いリグに当たる、が luckrig の立て付け。 |

許される表現:
- 「luckrigはセキュリティ製品ではありません」
- 「機密情報は送らないでください」
- 「すべての入力は local pattern filter と（設定されていれば）外部 moderation を通ります」
- 「ノード提供者から完全には隠せません」

---

## 8. 参照

- CONCEPT.md §フィルタリング方針 / §プライバシー設計 / §鍵配布のtrust model / §免責の設計 / §v6以降の宿題
- SPEC.md §7.1b Content moderation (proxy) / §7.1c Tracker ban / takedown
- USERSTORY.md US-9.3 / US-9.4
- docs/tracker-api.md §POST /api/abuse/report / §POST /api/bans
- BACKLOG.md §法務人格

---

## 9. 改訂履歴

- 2026-05-22: 初版。v5.6 / POC v1 の状態を反映。3段構えモデレーション、ban / abuse-report、moderation-flags.jsonl が技術側で揃ったタイミングで、残る論点を列挙。
