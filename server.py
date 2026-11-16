"""
本地靜態網頁伺服器 — 用於執行 Google 雲端硬碟與 Gmail 空間清理中心。
Google OAuth 2.0 規定必須透過 http://localhost:<port> 提供服務，不可直接以 file:// 開啟。
"""

import argparse
import functools
import http.server
import os
import socketserver
import threading
import webbrowser


class CleanerHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    """提供 UTF-8 編碼支援與關閉快取的本地 HTTP 處理器。"""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description='啟動 Google 雲端硬碟與 Gmail 空間清理網頁伺服器')
    parser.add_argument('--port', type=int, default=8080, help='伺服器監聽連接埠（預設：8080）')
    parser.add_argument('--no-browser', action='store_true', help='啟動時不要自動開啟瀏覽器')
    args = parser.parse_args()

    web_root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(CleanerHttpRequestHandler, directory=web_root)

    try:
        with ReusableTCPServer(('127.0.0.1', args.port), handler) as httpd:
            url = f'http://localhost:{args.port}'
            print('==========================================================')
            print('  Google 雲端硬碟與 Gmail 空間清理中心 已啟動')
            print(f'  請使用瀏覽器開啟：{url}')
            print('  按下 Ctrl + C 可停止伺服器')
            print('==========================================================')

            if not args.no_browser:
                threading.Timer(0.8, lambda: webbrowser.open(url)).start()

            httpd.serve_forever()
    except OSError as exc:
        print(f'[錯誤] 無法綁定連接埠 {args.port}：{exc}')
        print(f'請檢查是否已有其他程式佔用 {args.port}，或改用 --port 指定其他連接埠。')
    except KeyboardInterrupt:
        print('\n已停止本地伺服器。')


if __name__ == '__main__':
    main()
