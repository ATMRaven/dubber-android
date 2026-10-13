#!/usr/bin/env python3
"""
Lightweight development server for Dubber Studio.
Features:
1. Static asset hosting (index.html, style.css, app.js)
2. Local credentials bridge (/api/credentials)
3. Direct digital audio stream speech-to-text bridge (/api/transcribe)
   Allows true digital screen/tab audio transcription with zero microphone blast!
"""

import http.server
import io
import json
import os
import socketserver
import sys
import urllib.parse

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

def get_credentials():
    creds_path = r"C:\Users\acer nitro\.gemini\config\credentials.env"
    result = {}
    if os.path.exists(creds_path):
        try:
            with open(creds_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k == "OPENROUTER_API_KEY":
                            result["openrouter_api_key"] = v
        except Exception as e:
            print(f"[Warning] Could not read credentials: {e}", file=sys.stderr)
    return result

# Lazy load speech recognizer
recognizer = None
def get_recognizer():
    global recognizer
    if recognizer is None:
        try:
            import speech_recognition as sr
            recognizer = sr.Recognizer()
            recognizer.energy_threshold = 280
            recognizer.dynamic_energy_threshold = False
        except ImportError:
            recognizer = False
    return recognizer

class DubberHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def _send_json(self, status_code, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Language')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Language')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/credentials':
            creds = get_credentials()
            return self._send_json(200, creds)
        elif parsed.path == '/api/status':
            return self._send_json(200, {
                "status": "online",
                "stt_available": bool(get_recognizer() is not False)
            })
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/transcribe':
            params = urllib.parse.parse_qs(parsed.query)
            lang = params.get('lang', ['en-US'])[0]
            if not lang:
                lang = 'en-US'

            content_length = int(self.headers.get('Content-Length', 0))
            if content_length <= 0:
                return self._send_json(400, {"error": "Empty audio payload"})

            audio_bytes = self.rfile.read(content_length)
            sr_inst = get_recognizer()

            if sr_inst is False:
                return self._send_json(503, {"error": "SpeechRecognition library not installed on server"})

            try:
                import speech_recognition as sr
                bio = io.BytesIO(audio_bytes)
                with sr.AudioFile(bio) as source:
                    audio_data = sr_inst.record(source)

                # Transcribe using high-accuracy Web Speech engine
                text = sr_inst.recognize_google(audio_data, language=lang)
                return self._send_json(200, {
                    "text": text,
                    "status": "ok",
                    "lang": lang
                })
            except sr.UnknownValueError:
                # Normal case: silence, background noise, or no distinct words
                return self._send_json(200, {
                    "text": "",
                    "status": "no_speech",
                    "lang": lang
                })
            except Exception as e:
                return self._send_json(200, {
                    "text": "",
                    "status": "error",
                    "error": str(e)
                })

        return self._send_json(404, {"error": "Endpoint not found"})

def run_server():
    socketserver.TCPServer.allow_reuse_address = True
    port = PORT
    while port < 8090:
        try:
            with socketserver.TCPServer(("", port), DubberHandler) as httpd:
                print(f"[Dubber] Serving Dubber Studio at http://localhost:{port}/")
                httpd.serve_forever()
                break
        except OSError as e:
            if e.errno == 10048 or "Address already in use" in str(e):
                port += 1
            else:
                raise

if __name__ == '__main__':
    run_server()
