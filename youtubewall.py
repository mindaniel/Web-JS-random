import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
from selenium import webdriver
from selenium.webdriver.edge.options import Options

# Default video ID to start the bridge
current_video_id = "1Cf-DbDrhO0" 
last_url = ""

# ==========================================
# 1. THE LOCAL BRIDGE SERVER
# ==========================================
class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Keeps terminal clean

    def do_GET(self):
        global current_video_id
        
        if self.path == '/current':
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(current_video_id.encode('utf-8'))
            
        else:
            html = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body, html {{ margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: black; }}
                    iframe {{ width: 100vw; height: 100vh; border: none; pointer-events: none; }}
                </style>
            </head>
            <body>
                <iframe id="yt-player" src="https://www.youtube.com/embed/{current_video_id}?autoplay=1&controls=0&mute=1&loop=1&playlist={current_video_id}" allow="autoplay"></iframe>
                
                <script>
                    let currentId = '{current_video_id}';
                    
                    setInterval(async () => {{
                        try {{
                            let res = await fetch('/current');
                            let newId = await res.text();
                            if (newId && newId !== currentId) {{
                                currentId = newId;
                                document.getElementById('yt-player').src = "https://www.youtube.com/embed/" + newId + "?autoplay=1&controls=0&mute=1&loop=1&playlist=" + newId;
                            }}
                        }} catch (e) {{}}
                    }}, 2000); 
                </script>
            </body>
            </html>
            """
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(html.encode('utf-8'))

def run_server():
    server = HTTPServer(('localhost', 8080), BridgeHandler)
    server.serve_forever()

# ==========================================
# 2. EDGE BROWSER CONTROLLER (STEALTH MODE)
# ==========================================
def extract_video_id(url):
    try:
        parsed = urllib.parse.urlparse(url)
        return urllib.parse.parse_qs(parsed.query).get('v', [None])[0]
    except:
        return None

def main():
    global last_url, current_video_id
    
    # Start the bridge server
    threading.Thread(target=run_server, daemon=True).start()
    
    print("\n==================================================")
    print("🌉 BRIDGE SERVER RUNNING!")
    print("👉 1. Open Lively Wallpaper")
    print("👉 2. Click 'Add Wallpaper' (the + button)")
    print("👉 3. Paste this exact link: http://localhost:8080")
    print("==================================================\n")
    
    edge_options = Options()
    user_data_dir = r"C:\Users\qmn1\AppData\Local\Microsoft\Edge\User Data\PythonMusicProfile"
    edge_options.add_argument(f"user-data-dir={user_data_dir}")
    
    # Anti-bot and stealth flags to stop YouTube errors
    edge_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    edge_options.add_experimental_option('useAutomationExtension', False)
    edge_options.add_argument("--disable-blink-features=AutomationControlled")
    
    print("Starting your dedicated Music Browser in stealth mode...")
    try:
        driver = webdriver.Edge(options=edge_options)
        
        # Hide Selenium's webdriver signature so YouTube thinks you are a real human
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        })
    except Exception as e:
        print(f"❌ Failed to start Edge. Error: {e}")
        return

    print("✅ Browser started! Going straight to YouTube...")
    driver.get("https://www.youtube.com")
    
    try:
        while True:
            try:
                if len(driver.window_handles) == 0:
                    print("Browser was closed. Exiting script...")
                    break
            except:
                print("Browser was closed. Exiting script...")
                break

            current_url = driver.current_url
            
            if "youtube.com/watch" in current_url and current_url != last_url:
                vid_id = extract_video_id(current_url)
                
                if vid_id:
                    last_url = current_url
                    current_video_id = vid_id
                    print(f"🎵 Song changed! Lively background updated to video ID: {vid_id}")
                
            time.sleep(2)
            
    except KeyboardInterrupt:
        print("\nStopping script...")
    except Exception as e:
        pass
    finally:
        try:
            driver.quit()
        except:
            pass

if __name__ == "__main__":
    main()
