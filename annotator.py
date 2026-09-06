#!/usr/bin/env python3
"""
トランスクリプト話者アノテーター

faster-whisper で生成した `[開始s -> 終了s] テキスト` 形式のタイムコード付き
トランスクリプトと音声を並べ、ブラウザ上で
  - 発話者ロールのラベル付け（任意個数のラベル）
  - 誤字の修正・セグメントの分割/結合
を行い、MAXQDA 等に読み込めるテキストへ書き出すためのローカルツール。

追加パッケージ不要（Python 標準ライブラリのみ）。
    python annotator.py            # recordings/ を対象に http://127.0.0.1:8000 で起動
    python annotator.py --dir some_dir --port 8000

状態は各収録ごとに recordings/<name>.annot.json に自動保存されるため、
途中でブラウザやサーバーが落ちても再起動すれば続きから再開できる。
書き出しは <name>_annotated.txt へ（元の *_timecoded.txt は書き換えない）。
"""

import argparse
import json
import os
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEBUI_DIR = os.path.join(BASE_DIR, "webui")

AUDIO_EXTENSIONS = (".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".mp4")
DEFAULT_ROLES = ["インタビュアー", "インタビュイー"]

# "[12.34s -> 56.78s] テキスト" にマッチ
LINE_RE = re.compile(r"^\s*\[\s*([0-9.]+)s\s*->\s*([0-9.]+)s\s*\]\s?(.*)$")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}


def audio_mime(path):
    return MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


class Store:
    """recordings ディレクトリの走査と、アノテーション JSON の読み書き。"""

    def __init__(self, data_dir):
        self.data_dir = os.path.abspath(data_dir)

    # --- 収録一覧 -----------------------------------------------------
    def list_projects(self):
        """(*_timecoded.txt がある収録) の一覧を返す。"""
        projects = []
        try:
            names = sorted(os.listdir(self.data_dir))
        except FileNotFoundError:
            return projects
        for fn in names:
            if not fn.endswith("_timecoded.txt"):
                continue
            name = fn[: -len("_timecoded.txt")]
            audio = self._find_audio(name)
            annot = os.path.exists(self._annot_path(name))
            projects.append({"name": name, "audio": bool(audio), "annotated": annot})
        return projects

    def _find_audio(self, name):
        for ext in AUDIO_EXTENSIONS:
            p = os.path.join(self.data_dir, name + ext)
            if os.path.exists(p):
                return p
        return None

    def _timecoded_path(self, name):
        return os.path.join(self.data_dir, name + "_timecoded.txt")

    def _annot_path(self, name):
        return os.path.join(self.data_dir, name + ".annot.json")

    def _export_path(self, name):
        return os.path.join(self.data_dir, name + "_annotated.txt")

    def _safe(self, name):
        # ディレクトリトラバーサル防止：基本ファイル名以外は拒否
        return name and ("/" not in name) and ("\\" not in name) and (".." not in name)

    # --- トランスクリプト解析 ----------------------------------------
    def parse_timecoded(self, name):
        segments = []
        with open(self._timecoded_path(name), encoding="utf-8") as f:
            for i, raw in enumerate(f):
                line = raw.rstrip("\n")
                if not line.strip():
                    continue
                m = LINE_RE.match(line)
                if m:
                    start, end, text = float(m.group(1)), float(m.group(2)), m.group(3)
                else:
                    # タイムコードの無い行も一応取り込む
                    start = end = 0.0
                    text = line.strip()
                segments.append(
                    {
                        "id": i,
                        "start": start,
                        "end": end,
                        "text": text,
                        "original": text,
                        "role": None,
                    }
                )
        return segments

    # --- プロジェクト状態 --------------------------------------------
    def load_project(self, name):
        if not self._safe(name):
            return None
        annot = self._annot_path(name)
        if os.path.exists(annot):
            with open(annot, encoding="utf-8") as f:
                data = json.load(f)
            data.setdefault("roles", list(DEFAULT_ROLES))
            data.setdefault("options", {"merge": True, "timecodes": False})
        else:
            if not os.path.exists(self._timecoded_path(name)):
                return None
            data = {
                "name": name,
                "roles": list(DEFAULT_ROLES),
                "options": {"merge": True, "timecodes": False},
                "segments": self.parse_timecoded(name),
            }
        audio = self._find_audio(name)
        data["name"] = name
        data["has_audio"] = bool(audio)
        return data

    def reset_project(self, name):
        """トランスクリプトから作り直す（ラベルは失われる）。"""
        if not self._safe(name) or not os.path.exists(self._timecoded_path(name)):
            return None
        data = {
            "name": name,
            "roles": list(DEFAULT_ROLES),
            "options": {"merge": True, "timecodes": False},
            "segments": self.parse_timecoded(name),
        }
        self.save_project(name, data)
        return self.load_project(name)

    def save_project(self, name, data):
        if not self._safe(name):
            return False
        path = self._annot_path(name)
        tmp = path + ".tmp"
        payload = {
            "name": name,
            "roles": data.get("roles", list(DEFAULT_ROLES)),
            "options": data.get("options", {"merge": True, "timecodes": False}),
            "segments": data.get("segments", []),
        }
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)  # アトミック置換
        return True

    # --- 書き出し ----------------------------------------------------
    def export_project(self, name):
        data = self.load_project(name)
        if data is None:
            return None
        opts = data.get("options", {})
        merge = opts.get("merge", True)
        timecodes = opts.get("timecodes", False)
        segs = [s for s in data["segments"] if (s.get("text") or "").strip() != ""]

        def label(role):
            return role if role else "未設定"

        blocks = []  # (role, text, start, end)
        for s in segs:
            role = s.get("role")
            text = s["text"].strip()
            if merge and blocks and blocks[-1][0] == role:
                prev = blocks[-1]
                blocks[-1] = (role, prev[1] + " " + text, prev[2], s["end"])
            else:
                blocks.append((role, text, s["start"], s["end"]))

        lines = []
        for role, text, start, end in blocks:
            prefix = "(%s) " % label(role)
            if timecodes:
                prefix = "[%.1f-%.1f] " % (start, end) + prefix
            lines.append(prefix + text)

        out = self._export_path(name)
        tmp = out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, out)
        unlabeled = sum(1 for s in segs if not s.get("role"))
        return {"path": out, "lines": len(lines), "unlabeled": unlabeled}


class Handler(BaseHTTPRequestHandler):
    store = None  # サーバー起動時に注入
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 静かに

    def handle(self):
        # ブラウザが keep-alive / 音声シークで接続を切るのは正常。ログを汚さない。
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass

    # --- 送信ヘルパ --------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body, content_type, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            return {}

    # --- 静的ファイル ------------------------------------------------
    def _serve_static(self, rel):
        if rel == "" or rel == "/":
            rel = "index.html"
        rel = rel.lstrip("/")
        path = os.path.normpath(os.path.join(WEBUI_DIR, rel))
        if not path.startswith(WEBUI_DIR) or not os.path.isfile(path):
            self._send_bytes(b"Not found", "text/plain; charset=utf-8", 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        ext = os.path.splitext(path)[1].lower()
        self._send_bytes(body, MIME.get(ext, "application/octet-stream"))

    # --- 音声（Range 対応）------------------------------------------
    def _serve_audio(self, name):
        if not self.store._safe(name):
            self._send_bytes(b"Bad name", "text/plain", 400)
            return
        path = self.store._find_audio(name)
        if not path:
            self._send_bytes(b"No audio", "text/plain", 404)
            return
        size = os.path.getsize(path)
        ctype = audio_mime(path)
        range_header = self.headers.get("Range")

        if range_header is None:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            if self.command != "HEAD":
                with open(path, "rb") as f:
                    self._copy(f, size)
            return

        # "bytes=start-end" を解釈（open-ended も許容）
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
        if m:
            g1, g2 = m.group(1), m.group(2)
            if g1 == "" and g2 != "":  # 末尾 N バイト
                length = min(int(g2), size)
                start = size - length
                end = size - 1
            else:
                if g1 != "":
                    start = int(g1)
                if g2 != "":
                    end = int(g2)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return
        end = min(end, size - 1)
        length = end - start + 1

        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if self.command != "HEAD":
            with open(path, "rb") as f:
                f.seek(start)
                self._copy(f, length)

    def _copy(self, f, remaining):
        chunk = 64 * 1024
        try:
            while remaining > 0:
                buf = f.read(min(chunk, remaining))
                if not buf:
                    break
                self.wfile.write(buf)
                remaining -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass  # ブラウザがシークで接続を切るのは正常

    # --- ルーティング ------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/list":
            self._send_json({"projects": self.store.list_projects()})
        elif path == "/api/project":
            name = (qs.get("name") or [""])[0]
            data = self.store.load_project(name)
            if data is None:
                self._send_json({"error": "not found"}, 404)
            else:
                self._send_json(data)
        elif path == "/audio":
            self._serve_audio((qs.get("name") or [""])[0])
        else:
            self._serve_static(path)

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/audio":
            qs = urllib.parse.parse_qs(parsed.query)
            self._serve_audio((qs.get("name") or [""])[0])
        else:
            self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        name = (qs.get("name") or [""])[0]

        if path == "/api/save":
            data = self._read_body()
            ok = self.store.save_project(name, data)
            self._send_json({"ok": ok})
        elif path == "/api/reset":
            data = self.store.reset_project(name)
            if data is None:
                self._send_json({"error": "not found"}, 404)
            else:
                self._send_json(data)
        elif path == "/api/export":
            result = self.store.export_project(name)
            if result is None:
                self._send_json({"error": "not found"}, 404)
            else:
                self._send_json({"ok": True, **result})
        else:
            self._send_json({"error": "unknown"}, 404)


def main():
    parser = argparse.ArgumentParser(description="トランスクリプト話者アノテーター")
    parser.add_argument("--dir", default=os.path.join(BASE_DIR, "recordings"),
                        help="収録（*_timecoded.txt と音声）のディレクトリ")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    Handler.store = Store(args.dir)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d/" % (args.host, args.port)
    print("アノテーターを起動しました:", url)
    print("対象ディレクトリ:", Handler.store.data_dir)
    print("停止するには Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
        server.shutdown()


if __name__ == "__main__":
    main()
