import argparse
import os
from faster_whisper import WhisperModel

def main():
    # 1. コマンドライン引数の設定
    parser = argparse.ArgumentParser(description="ディレクトリ内の音声ファイルを一括で文字起こしし、テキストに保存します。")
    parser.add_argument("input_dir", type=str, help="音声ファイルが格納されているディレクトリのパス")
    parser.add_argument("--device", type=str, default="cpu", choices=["cpu", "cuda"], help="使用するデバイス (cpu または cuda)")
    
    args = parser.parse_args()

    # 固定設定
    MODEL_PATH = "./model/"
    AUDIO_EXTENSIONS = (".wav", ".mp3", ".m4a", ".flac", ".ogg")

    # 2. ディレクトリの存在確認
    if not os.path.isdir(MODEL_PATH):
        print(f"エラー: モデルフォルダが見つかりません。{MODEL_PATH} を確認してください。")
        return

    if not os.path.isdir(args.input_dir):
        print(f"エラー: ディレクトリが見つかりません: {args.input_dir}")
        return

    # 3. ローカルモデルの読み込み
    print(f"ローカルのモデルを読み込んでいます: {MODEL_PATH}")
    model = WhisperModel(MODEL_PATH, device=args.device, compute_type="float32")

    # 4. ディレクトリ内のファイルをループ処理
    files = sorted(os.listdir(args.input_dir))
    for filename in files:
        if filename.lower().endswith(AUDIO_EXTENSIONS):
            file_path = os.path.join(args.input_dir, filename)
            
            # 出力するファイル名のプレフィックス（拡張子を除いた名前）
            base_name, _ = os.path.splitext(file_path)
            timecoded_txt_path = f"{base_name}_timecoded.txt"
            text_only_txt_path = f"{base_name}_text.txt"

            print("\n" + "="*50)
            print(f"処理中: {filename}")
            print("="*50)

            # 文字起こしの実行
            segments, info = model.transcribe(
                file_path, 
                language="ja", 
                chunk_length=15, 
                condition_on_previous_text=False
            )

            # ファイルをオープンして書き込み
            with open(timecoded_txt_path, "w", encoding="utf-8") as f_time, \
                 open(text_only_txt_path, "w", encoding="utf-8") as f_txt:
                
                for segment in segments:
                    # 1. タイムコードありのフォーマット
                    time_line = "[%.2fs -> %.2fs] %s\n" % (segment.start, segment.end, segment.text)
                    # 2. タイムコードなし（テキストのみ）のフォーマット
                    text_line = "%s\n" % segment.text

                    # 画面に出力
                    print(time_line.strip())

                    # ファイルに保存
                    f_time.write(time_line)
                    f_txt.write(text_line)

            print(f"--- 保存完了 ---")
            print(f"  タイムコードあり: {os.path.basename(timecoded_txt_path)}")
            print(f"  テキストのみ    : {os.path.basename(text_only_txt_path)}")

if __name__ == "__main__":
    main()
