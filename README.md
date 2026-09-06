# transcribe_annotator_whisper

音声インタビューを **文字起こし → 話者ラベル付け・誤字修正 → テキスト書き出し** するためのローカルツール一式です。

2つのスクリプトから成ります。

| スクリプト | 役割 |
| --- | --- |
| `transcribe.py` | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) を使い、ディレクトリ内の音声を一括で文字起こし |
| `annotator.py` | 文字起こしと音声をブラウザ上で並べ、発話者ロールのラベル付け・誤字修正・書き出しを行うGUI |

最終出力は MAXQDA などに読み込める、行頭にロールを括弧書きしたシンプルなテキストです。

```
(インタビュアー) はい、ということでですね
(インタビュイー) よろしくお願いします
```

---

## セットアップ

Python 3.12 で動作確認しています。

```bash
python -m venv .venv
source .venv/bin/activate
pip install faster-whisper
```

- `annotator.py` は **Python標準ライブラリのみ**で動くため、追加インストールは不要です（`faster-whisper` は文字起こし用）。
- Whisperモデルは `./model/` に配置します（CTranslate2形式）。`recordings/` と `model/` は `.gitignore` 済みで、音声・文字起こし・モデルはコミットされません。

---

## 1. 文字起こし（`transcribe.py`）

音声（`.wav .mp3 .m4a .flac .ogg`）を入れたディレクトリを指定して実行します。

```bash
python transcribe.py recordings
# GPUを使う場合:
python transcribe.py recordings --device cuda
```

音声ファイルごとに、同じ名前で2種類のテキストが出力されます。

- `<名前>_timecoded.txt` … `[開始s -> 終了s] テキスト` 形式（アノテーターが読み込む）
- `<名前>_text.txt` … テキストのみ

例: `recordings/P7.m4a` → `recordings/P7_timecoded.txt`, `recordings/P7_text.txt`

---

## 2. アノテーション（`annotator.py`）

```bash
python annotator.py
# → http://127.0.0.1:8000/ をブラウザで開く

# オプション
python annotator.py --port 8001 --dir /path/to/recordings
```

`recordings/` 内の `*_timecoded.txt` を自動で一覧化し、対応する同名の音声を読み込みます。`127.0.0.1` のみにバインドするため、音声がLANに公開されることはありません。

### できること

- **タイムライン連動** — 再生に合わせて該当行がハイライト＆自動スクロール（追従ON/OFF可）。シークバーのクリック／ドラッグ、行の時刻クリックで頭出し。
- **話者ラベル（任意個数）** — 初期は「インタビュアー」「インタビュイー」。ヘッダーの「＋ ロール」で人数追加、名前クリックで改名、×で削除。
- **誤字修正** — 各行のテキストを直接クリックして編集（編集済みは色でマーク）。
- **セグメント分割 / 結合** — 1行が話者をまたぐとき、カーソル位置で分割（時刻は文字位置で按分）、上の行と結合。
- **行削除 / 元に戻す** — 削除・分割・結合は `⌘Z`（Ctrl+Z）または「元に戻す」で取り消し可能（最大100手前まで）。
- **再生速度** — 0.5〜2×。

### キーボード操作

| キー | 動作 |
| --- | --- |
| `Space` | 再生 / 一時停止 |
| `1`〜`9` | 現在行にロールを付与して次の行へ |
| `0` | ロール解除 |
| `J` / `K`（`↑` / `↓`） | 行を移動 |
| `Enter` | 現在行を編集 |
| `D` | 現在行を削除 |
| `R` | 現在行を頭から再生 |
| `←` / `→` | 3秒シーク |
| `⌘Z` / `Ctrl+Z` | 削除・分割・結合を取り消し |

### 書き出し

ヘッダーの「書き出し」で `recordings/<名前>_annotated.txt` を生成します（元の `*_timecoded.txt` は書き換えません）。

- **連続結合** — 同じ話者の連続行を1段落にまとめる。
- **時刻付き** — 各行の先頭に時間を付ける。
- 未ラベルの行は `(未設定)` で出力し、件数を通知します。

### 途中復帰

変更のたびに `recordings/<名前>.annot.json` へ自動保存します（アトミック書き込み＋離脱時の送信）。ブラウザやサーバーが落ちても、再起動して同じ収録を開けば続きから再開できます。

トランスクリプトから作り直したいときは、ヘッダーの「再読込」を使います（付与したラベルと編集は失われます）。

---

## ファイル構成

```
transcribe.py            文字起こしスクリプト
annotator.py             アノテーターのローカルサーバー（標準ライブラリのみ）
webui/                   アノテーターの画面（index.html / app.js / style.css）
model/                   Whisperモデル（.gitignore）
recordings/              音声・文字起こし・アノテーション（.gitignore）
```
