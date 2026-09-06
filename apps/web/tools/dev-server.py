#!/usr/bin/env python3
"""Development static server with no-store caching for the web client."""
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    directory = sys.argv[1]
    port = int(sys.argv[2])
    server = HTTPServer(("127.0.0.1", port), partial(NoStoreHandler, directory=directory))
    print(f"serving {directory} on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
