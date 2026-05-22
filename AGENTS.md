# AGENTS.md — luckrig

このファイルは、Codex / Claude などのAI agentがこのリポジトリで作業するときに最初に読む文書です。
プロジェクトの全体像と、暗黙の設計判断を踏み外さないためのガードレールをまとめています。

## 0. 正典 (Source of Truth)

**[`CONCEPT.md`](./CONCEPT.md) がこのプロジェクトの正典です。**

- 設計・実装の判断はすべてCONCEPT.mdに照らして行うこと
- CONCEPT.mdと矛盾する変更を入れたいときは、まずCONCEPT.mdの更新提案から始める
- 「コンセプトに書かれていないが筋が良さそう」な変更は、必ずユーザーに確認する
- AGENTS.mdが古い場合はCONCEPT.mdを優先する

## 1. プロジェクトの一行説明

オンプレミスLLM推論APIシェアリングプラットフォーム。Hotline Connectの貢献ベース構造を、OpenAI互換APIを喋るローカルLLMノードに移植する。

## 2. 必ず尊重すべき設計判断 (Non-Negotiable)

CONCEPT.mdで明示的に「採用しない」「実装しない」と決めた選択がいくつかある。これらを善意で実装し直さないこと。

- **検証は実装しない**: Canary prompt / attestation / 出力検証は実装しない。「検証しないことを設計で正当化する」ことが選択されている (§虚偽リスティングへの設計的対処)
- **ステータスモデル**: 貢献スコアはステータス制（しきい値超えで永続権）。クレジット制や転売可能トークンにしない (§スコアモデル)
- **subtext方式**: プロンプト/レスポンスの隠蔽はUnicode variation selectorによるsubtext + AES-GCM。SSEはノード側でバッファして一括隠蔽、利用者には擬似SSEで返す。逐次隠蔽を実装しない (§SSEとの両立)
- **キューUX**: 待ち時間はGeForce Now風の「ノード利用権待ち」として表現する。「生成が遅い」と見えないUIにする
- **tok/sは利用者側計測**: ノード側自己申告ではなく、chunk_timestampsから利用者側で算出する。リプレイデータが一次ソース
- **TTFTはリプレイ側を一次ソース**: ネットワーク変数を排除したノード側プロキシ計測値が正
- **リプレイはローカルのみ**: `~/.luckrig/history/` に保存。サーバーには送らない。schema_versionを必ず持たせる
- **スコープはテキスト生成のみ (v1)**: 画像/音声/認識は触らない。subtext方式との整合性設計が先
- **フィルタリング**: NSFWと重い創作は通さない。「luckrigはその場ではない」というスタンスを最初から明示する
- **デフォルト並び順は希少性スコア順**: 上位スペック順ではない。思想をUIで表現する

## 3. trust modelの言語化

実装やドキュメントを書く際、以下のtrust modelを正直に明示すること：

- トラッカー（luckrig運営）単独では平文を読めない
- ノード単独でも利用者の秘密鍵がないため復号できない
- **トラッカー + ノードの共謀**で公開鍵をすり替えれば読める構造
- ノード提供者がプロセス内側（メモリダンプ等）に踏み込めば、必ず平文が見える（推論エンジンは平文を必要とする）
- 「頑張らなければ見えない」= tcpdumpでは見えないが、プロセスに踏み込めば見える、の意味

これを隠して「end-to-end暗号化です」のように書かないこと。

## 4. 構成要素 (まだ実装なし)

```
luckrig/
├── CONCEPT.md          # 正典
├── README.md           # 人間向け概要
├── AGENTS.md           # このファイル
└── (未実装)
    ├── tracker/        # 中央トラッカー (ノード登録/死活監視/トークン発行)
    ├── proxy/          # ノード側プロキシ層 (subtext + バッファ + 擬似SSE)
    ├── cli/            # ノード登録CLI
    ├── web/            # 試食UI
    └── subtext/        # subtextライブラリ (Unicode variation selector実装)
```

技術スタックは未確定。最初の実装タスクの前にユーザーと合意すること。

## 5. 実装の順序

CONCEPT.md §「最小実装の順序」に従う。順序を入れ替えない（初期ノード提供者への価値を先に立てる設計判断のため）：

1. ノード公開リスト + 死活監視
2. ベンチマーク自動収集
3. ノード登録CLI + プロキシ層
4. トークン発行
5. 試食UI (キューUX + 擬似SSE)
6. リプレイ機能
7. 貢献スコア + 権限管理

## 6. 用語のゆれを統一する

| 採用語 | 使わない |
| --- | --- |
| 試食 (tasting) | trial / demo |
| ノード (node) | server / host / instance |
| トラッカー (tracker) | hub / coordinator / registry |
| ノート (チューニングノート) | tip / memo |
| Showcase | leaderboard / ranking |
| 貢献スコア | reputation / karma |

「Showcase」は順位ではなく多様性の見える化として一貫して使う。「Leaderboard」と訳し戻さない。

## 7. 作業時のチェックリスト

新しい実装やドキュメント変更を入れる前に：

- [ ] CONCEPT.mdの該当セクションを読み直したか
- [ ] §2の Non-Negotiable に抵触しないか
- [ ] trust modelを誤って強く宣伝していないか
- [ ] 用語がブレていないか
- [ ] 仕様変更ならCONCEPT.mdの更新提案を先に出したか

## 8. リポジトリの状態

- `.git/` `.agents/` `.codex/` はread-only tmpfsとしてマウントされている（サンドボックス都合）。書き込みは通常のファイルツリーに対して行うこと
- 現状ファイルは `CONCEPT.md` / `README.md` / `AGENTS.md` のみ


## 9. Git の使い方（サンドボックス回避策）

Codexサンドボックスが `.git/` `.agents/` `.codex/` をread-only tmpfsでマスクしているため、通常の `git init` はできません。
このプロジェクトでは **gitdirを `~/.codex/memories/luckrig-git` に分離** しています。

セッション開始時に一度だけ：

```bash
source .tools/git-env.sh
```

これで `GIT_DIR` / `GIT_WORK_TREE` が export され、以降は普通に `git status` `git add` `git commit` `git log` が使えます。

注意点：
- リモート追加 (`git remote add ...`) もこのenv下で実行すれば問題なし
- `.git/` ディレクトリは存在しているように見えるが空のtmpfs。`ls .git` は空。本物は `~/.codex/memories/luckrig-git/`
- バックアップ／リポジトリ移動時は `~/.codex/memories/luckrig-git/` も忘れずに

恒久対処（ユーザー側）：`~/.codex/config.toml` の sandbox masking 設定で `.git` を除外できれば、このシムは不要になる。
