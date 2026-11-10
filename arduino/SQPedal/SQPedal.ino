#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <esp_system.h>
#include "PedalState.h"
#include "Settings.h"

#if !CONFIG_IDF_TARGET_ESP32C5
#error "Select ESP32C5 Dev Module (ESP32 Arduino core 3.3.12)."
#endif

constexpr uint8_t PedalPin = 4;
constexpr uint8_t OnboardRgbLedPin = 27;
constexpr uint8_t LedRedPin = 6;
constexpr uint8_t LedGreenPin = 7;
constexpr uint8_t LedBluePin = 10;
constexpr uint32_t LedPwmFrequency = 5000;
constexpr uint8_t LedPwmResolution = 8;
constexpr uint32_t LedPwmMaximum = (1U << LedPwmResolution) - 1;
constexpr uint32_t RetryMs = 500;
constexpr uint32_t ProbeMs = 1000;
constexpr uint16_t HttpTimeoutMs = 750;
constexpr uint32_t WifiRetryMs = 15000;
constexpr uint32_t WifiConnectTimeoutMs = 20000;
constexpr uint32_t WifiRetryMaxMs = 300000;

using sqpedal::Command;
sqpedal::Settings settings;
sqpedal::PedalState pedal;
Preferences preferences;
WebServer server(80);
SemaphoreHandle_t sharedMutex;
bool storageReady = false, busy = false;
bool companionConnected = false;
uint32_t revision = 0;
int lastHttpCode = 0;
uint32_t lastHttpMs = 0;
char lastMessage[256] = "Waiting for configuration";
String deviceName, adminPassword, csrf;
bool redPwmReady = false, greenPwmReady = false, bluePwmReady = false;

class SharedLock {
 public:
  SharedLock() { xSemaphoreTake(sharedMutex, portMAX_DELAY); }
  ~SharedLock() { xSemaphoreGive(sharedMutex); }
};

uint32_t ledDuty(uint8_t percent) {
  return (uint32_t(percent) * LedPwmMaximum + 50) / 100;
}

void setLed(uint8_t pin, bool pwmReady, bool active, uint8_t brightness) {
  if (pwmReady) ledcWrite(pin, active ? ledDuty(brightness) : 0);
  else digitalWrite(pin, active ? HIGH : LOW);
}

void updateStatusLed(bool connected, bool pedalClosed, bool stationConnected,
                     uint32_t now, const sqpedal::Settings& currentSettings) {
  static int lastColor = -1;
  const int color = !connected ? 0 : pedalClosed ? 2 : 1;
  const bool redOn = connected && pedalClosed;
  const bool greenOn = connected && !pedalClosed;
  const bool blueOn = !connected && (stationConnected || now % 500 < 250);
  setLed(LedRedPin, redPwmReady, redOn, currentSettings.redBrightness);
  setLed(LedGreenPin, greenPwmReady, greenOn, currentSettings.greenBrightness);
  setLed(LedBluePin, bluePwmReady, blueOn, currentSettings.blueBrightness);
  if (color != lastColor) {
    lastColor = color;
    Serial.printf("Status LED: %s (Companion %s, pedal %s)\n",
                  color == 0 ? "blue" : color == 1 ? "green" : "red",
                  connected ? "reachable" : "unreachable",
                  pedalClosed ? "closed" : "open");
  }
}

void report(const String& message, int code = 0, uint32_t duration = 0) {
  {
    SharedLock lock;
    snprintf(lastMessage, sizeof(lastMessage), "%s", message.c_str());
    lastHttpCode = code;
    lastHttpMs = duration;
  }
  Serial.println(message);
}

String randomSecret() {
  char text[17];
  snprintf(text, sizeof(text), "%08lx%08lx",
           static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  return String(text);
}

String escapeHtml(const String& input) {
  String result;
  result.reserve(input.length() + 16);
  for (size_t i = 0; i < input.length(); ++i) {
    switch (input[i]) {
      case '&': result += F("&amp;"); break;
      case '<': result += F("&lt;"); break;
      case '>': result += F("&gt;"); break;
      case '"': result += F("&quot;"); break;
      case '\'': result += F("&#39;"); break;
      default: result += input[i];
    }
  }
  return result;
}

bool authorized() {
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.sendHeader("X-Frame-Options", "DENY");
  if (server.authenticate("admin", adminPassword.c_str())) return true;
  server.requestAuthentication(BASIC_AUTH, "SQ Pedal");
  return false;
}

String inputField(const char* label, const char* name, const String& value,
                  const char* attributes = "") {
  return "<label>" + String(label) + "<input name=\"" + name + "\" value=\"" +
         escapeHtml(value) + "\" " + attributes + "></label>";
}

void showSettings() {
  if (!authorized()) return;
  sqpedal::Settings snapshot;
  {
    SharedLock lock;
    snapshot = settings;
  }
  String html = F("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
                  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                  "<title>SQ Pedal</title><style>"
                  "body{font:16px system-ui;max-width:650px;margin:2em auto;padding:0 1em}"
                  "label{display:block;margin:1em 0}input{display:block;padding:.5em;width:95%}"
                  "input[type=checkbox]{display:inline;width:auto}button{padding:.8em}"
                  "pre{white-space:pre-wrap;background:#eee;padding:1em}</style><h1>SQ Pedal</h1><p>");
  html += escapeHtml(deviceName);
  html += F("</p><pre id=\"status\">Loading status...</pre>"
            "<p>Settings are saved in the board. Release the pedal before saving. "
            "A changed target requires a new UP synchronization before presses are accepted.</p>"
            "<form method=\"post\" action=\"/settings\"><input type=\"hidden\" name=\"csrf\" value=\"");
  html += csrf;
  html += F("\">");
  html += inputField("Wi-Fi SSID", "ssid", snapshot.ssid, "maxlength=\"32\" required");
  html += inputField("Wi-Fi password (blank preserves saved password)", "password", "",
                     "type=\"password\" maxlength=\"63\" autocomplete=\"new-password\"");
  html += F("<label><input type=\"checkbox\" name=\"open\" value=\"1\">"
            "Use an open Wi-Fi network (clears saved password)</label>");
  html += inputField("Companion computer IP or DNS name (no http:// or port)", "host",
                     snapshot.host, "maxlength=\"253\" required");
  html += inputField("Companion HTTP port", "port", String(snapshot.port),
                     "type=\"number\" min=\"1\" max=\"65535\" required");
  html += inputField("Button page (one-based)", "page", String(snapshot.page),
                     "type=\"number\" min=\"1\" max=\"9999\" required");
  html += inputField("Button row (zero-based)", "row", String(snapshot.row),
                     "type=\"number\" min=\"0\" max=\"255\" required");
  html += inputField("Button column (zero-based)", "column", String(snapshot.column),
                     "type=\"number\" min=\"0\" max=\"255\" required");
  html += inputField("Red LED brightness (%)", "redBrightness", String(snapshot.redBrightness),
                     "type=\"number\" min=\"0\" max=\"100\" required");
  html += inputField("Green LED brightness (%)", "greenBrightness", String(snapshot.greenBrightness),
                     "type=\"number\" min=\"0\" max=\"100\" required");
  html += inputField("Blue LED brightness (%)", "blueBrightness", String(snapshot.blueBrightness),
                     "type=\"number\" min=\"0\" max=\"100\" required");
  html += F("<label><input type=\"checkbox\" name=\"activeLow\" value=\"1\"");
  if (snapshot.activeLow) html += F(" checked");
  html += F(">Pedal pressed closes contact to ground (recommended)</label>"
            "<button>Save settings</button></form><p>"
            "Companion must have HTTP API enabled. HTTP success does not confirm SQ audio state. "
            "After any delivery failure, release the pedal and press again once Armed is shown.</p>"
            "<script>async function refresh(){try{const r=await fetch('/status');"
            "if(!r.ok)throw Error('HTTP '+r.status);document.getElementById('status').textContent=await r.text()}"
            "catch(e){document.getElementById('status').textContent='Status unavailable: '+e.message}}"
            "refresh();setInterval(refresh,1000)</script></html>");
  server.send(200, "text/html; charset=utf-8", html);
}

void showStatus() {
  if (!authorized()) return;
  String text = "Wi-Fi: " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Offline");
  text += "\nLAN IP: " + WiFi.localIP().toString();
  text += "\nWi-Fi gateway: " + WiFi.gatewayIP().toString();
  text += "\nWi-Fi RSSI: " + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + " dBm";
  {
    SharedLock lock;
    text += "\nPedal: " + String(pedal.pressed ? "Pressed" : "Released");
    text += "\nCompanion reachable: " + String(companionConnected ? "Yes" : "No");
    text += "\nArmed: " + String(pedal.armed ? "Yes" : "No");
    text += "\nHTTP synchronized: " + String(pedal.synchronized ? "Yes" : "No");
    text += "\nUP required: " + String(pedal.releasePending ? "Yes" : "No");
    text += "\nTarget: " + String(settings.host) + ":" + String(settings.port);
    text += "\nButton: " + String(settings.page) + "/" + String(settings.row) + "/" + String(settings.column);
    text += "\nLast HTTP: " + String(lastHttpCode) + " (" + String(lastHttpMs) + " ms)";
    text += "\nLast event: " + String(lastMessage);
  }
  server.send(200, "text/plain; charset=utf-8", text);
}

bool readNumber(const char* name, uint32_t minimum, uint32_t maximum, uint16_t& target) {
  String value = server.arg(name);
  if (value.isEmpty() || value.length() > 5) return false;
  uint32_t result = 0;
  for (size_t i = 0; i < value.length(); ++i) {
    if (value[i] < '0' || value[i] > '9') return false;
    result = result * 10 + (value[i] - '0');
  }
  if (result < minimum || result > maximum) return false;
  target = static_cast<uint16_t>(result);
  return true;
}

void saveSettings() {
  if (!authorized()) return;
  if (server.arg("csrf") != csrf) {
    server.send(403, "text/plain", "Invalid form token; reload settings.");
    return;
  }
  if (!storageReady) {
    server.send(503, "text/plain", "Flash settings storage unavailable; inspect Serial log.");
    return;
  }
  sqpedal::Settings next;
  {
    SharedLock lock;
    next = settings;
  }
  const String previousSsid(next.ssid);
  String ssid = server.arg("ssid"), host = server.arg("host"), password = server.arg("password");
  host.trim();
  host.toLowerCase();
  if (ssid.length() > 32 || host.length() > 253 || password.length() > 63) {
    server.send(400, "text/plain", "SSID, host or password too long.");
    return;
  }
  snprintf(next.ssid, sizeof(next.ssid), "%s", ssid.c_str());
  snprintf(next.host, sizeof(next.host), "%s", host.c_str());
  if (server.arg("open") == "1") next.wifiPassword[0] = 0;
  else if (!password.isEmpty()) snprintf(next.wifiPassword, sizeof(next.wifiPassword), "%s", password.c_str());
  else if (ssid != previousSsid || !next.wifiPassword[0]) {
    server.send(400, "text/plain", "Supply a Wi-Fi password or explicitly select open network.");
    return;
  }
  next.activeLow = server.arg("activeLow") == "1";
  uint16_t redBrightness, greenBrightness, blueBrightness;
  if (!readNumber("port", 1, 65535, next.port) || !readNumber("page", 1, 9999, next.page) ||
      !readNumber("row", 0, 255, next.row) || !readNumber("column", 0, 255, next.column) ||
      !readNumber("redBrightness", 0, 100, redBrightness) ||
      !readNumber("greenBrightness", 0, 100, greenBrightness) ||
      !readNumber("blueBrightness", 0, 100, blueBrightness)) {
    server.send(400, "text/plain", "Invalid numeric settings. Check port, button coordinates and LED brightness values.");
    return;
  }
  next.redBrightness = static_cast<uint8_t>(redBrightness);
  next.greenBrightness = static_cast<uint8_t>(greenBrightness);
  next.blueBrightness = static_cast<uint8_t>(blueBrightness);
  if (!sqpedal::validSettings(next)) {
    server.send(400, "text/plain", "Invalid settings. Check the DNS name/IP and Wi-Fi password (8-63 characters).");
    return;
  }
  {
    SharedLock lock;
    if (busy || pedal.pressed || pedal.possiblyDown) {
      server.send(409, "text/plain", "Release pedal and wait for pending UP/network operation to finish before saving.");
      return;
    }
    if (preferences.putBytes("settings", &next, sizeof(next)) != sizeof(next)) {
      server.send(500, "text/plain", "Settings could not be persisted; old configuration remains active.");
      return;
    }
    settings = next;
    ++revision;
    companionConnected = false;
    pedal.lostConnection();
  }
  report("Settings saved; reconnecting and synchronizing UP");
  server.send(200, "text/html", "Settings saved. Wi-Fi will reconnect. <a href=\"/\">Return</a>");
}

void samplePedal(void*) {
  sqpedal::Debouncer debounce;
  uint8_t previousPolarity = 1;
  for (;;) {
    {
      SharedLock lock;
      if (settings.activeLow != previousPolarity) {
        debounce = sqpedal::Debouncer();
        previousPolarity = settings.activeLow;
        pedal.lostConnection();
      }
      const bool down = (digitalRead(PedalPin) == LOW) == bool(settings.activeLow);
      if (debounce.update(down, millis())) {
        pedal.input(debounce.pressed());
      }
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

bool resolveHost(const char* host, IPAddress& address) {
  if (address.fromString(host)) return true;
  String name(host);
  if (name.endsWith(".local")) {
    name.remove(name.length() - 6);
    address = MDNS.queryHost(name.c_str(), HttpTimeoutMs);
    return address != IPAddress();
  }
  return WiFi.hostByName(host, address) == 1;
}

int request(HTTPClient& http, WiFiClient& client, const sqpedal::Settings& target,
            const IPAddress& address, Command command) {
  const bool probe = command == Command::None;
  char button[64];
  sqpedal::buttonPath(button, sizeof(button), target, command == Command::Down);
  String path = probe ? "/api/connections" : button;
  if (!http.begin(client, address.toString(), target.port, path, false)) return -100;
  http.setReuse(true);
  http.setConnectTimeout(HttpTimeoutMs);
  http.setTimeout(HttpTimeoutMs);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Content-Length", "0");
  int code = http.sendRequest(probe ? "HEAD" : "POST");
  if (!probe && code > 0) {
    if (http.getSize() < 0 || http.getSize() > 4096) {
      code = -101;
    } else {
      const String body = http.getString();
      if (code == 200 && body != "ok") code = -102;
    }
  }
  http.end();
  if (code != 200) client.stop();
  return code;
}

void sendPedal(void*) {
  WiFiClient client;
  HTTPClient http;
  IPAddress address;
  uint32_t seenRevision = UINT32_MAX, lastAttempt = 0, lastProbe = 0;
  bool resolved = false, wasOnline = false, retryRequired = false;
  for (;;) {
    sqpedal::Settings target;
    uint32_t currentRevision;
    {
      SharedLock lock;
      target = settings;
      currentRevision = revision;
    }
    if (currentRevision != seenRevision) {
      http.end();
      client.stop();
      resolved = false;
      wasOnline = false;
      { SharedLock lock; companionConnected = false; }
      seenRevision = currentRevision;
      lastAttempt = millis() - RetryMs;
      retryRequired = false;
    }
    const bool online = WiFi.status() == WL_CONNECTED;
    if (!online || !target.host[0] || !target.ssid[0]) {
      if (wasOnline) {
        client.stop();
        resolved = false;
        { SharedLock lock; pedal.lostConnection(); companionConnected = false; }
        report("Wi-Fi lost; UP required on reconnect. Release pedal before rearming.");
      }
      wasOnline = false;
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    wasOnline = true;
    Command command;
    bool work = false;
    {
      SharedLock lock;
      if (currentRevision == revision) {
        command = pedal.next();
        const uint32_t now = millis();
        work = command == Command::Down ||
               (command == Command::Up && (!retryRequired || uint32_t(now - lastAttempt) >= RetryMs)) ||
               (command == Command::None && uint32_t(now - lastProbe) >= ProbeMs);
        if (work) busy = true;
      }
    }
    if (!work) {
      vTaskDelay(pdMS_TO_TICKS(2));
      continue;
    }
    if (!resolved) {
      resolved = resolveHost(target.host, address);
      if (!resolved) {
        { SharedLock lock; pedal.lostConnection(); companionConnected = false; busy = false; }
        lastAttempt = millis();
        lastProbe = millis();
        retryRequired = true;
        report("DNS lookup failed for " + String(target.host) + "; verify the Companion host is a reachable LAN IP/DNS name.");
        vTaskDelay(pdMS_TO_TICKS(20));
        continue;
      }
    }
    {
      SharedLock lock;
      // The contact may have released during DNS lookup. Never replay that Down.
      command = pedal.next();
      pedal.starting(command);
    }
    const uint32_t started = millis();
    const int code = request(http, client, target, address, command);
    const uint32_t duration = millis() - started;
    {
      SharedLock lock;
      if (command == Command::None) {
        if (code != 200) pedal.lostConnection();
      } else {
        pedal.completed(command, code == 200);
      }
      companionConnected = code == 200;
      busy = false;
    }
    lastProbe = millis();
    lastAttempt = millis();
    retryRequired = code != 200;
    if (code != 200) {
      resolved = false;
      const bool probe = command == Command::None;
      char button[64];
      sqpedal::buttonPath(button, sizeof(button), target, command == Command::Down);
      const String path = probe ? "/api/connections" : String(button);
      const String method = probe ? "HEAD" : "POST";
      const String url = "http://" + address.toString() + ":" + String(target.port) + path;
      String reason;
      if (code == -100) reason = "HTTPClient could not initialize the request";
      else if (code == -101) reason = "invalid response size";
      else if (code == -102) reason = "unexpected response body (expected 'ok')";
      else if (code < 0) reason = HTTPClient::errorToString(code);
      else reason = "HTTP status " + String(code);
      report(method + " " + url + " failed: " + reason + "; Wi-Fi IP " +
             WiFi.localIP().toString() + ". UP retry required, no Down replay.", code, duration);
    } else if (command != Command::None) {
      report(command == Command::Down ? "DOWN accepted by Companion HTTP" : "UP accepted by Companion HTTP",
             code, duration);
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PedalPin, INPUT_PULLUP);
  pinMode(LedRedPin, OUTPUT);
  pinMode(LedGreenPin, OUTPUT);
  pinMode(LedBluePin, OUTPUT);
  digitalWrite(LedRedPin, LOW);
  digitalWrite(LedGreenPin, LOW);
  digitalWrite(LedBluePin, LOW);
  redPwmReady = ledcAttach(LedRedPin, LedPwmFrequency, LedPwmResolution);
  greenPwmReady = ledcAttach(LedGreenPin, LedPwmFrequency, LedPwmResolution);
  bluePwmReady = ledcAttach(LedBluePin, LedPwmFrequency, LedPwmResolution);
  if (!redPwmReady || !greenPwmReady || !bluePwmReady)
    Serial.println("WARNING: LED PWM unavailable on one or more pins; affected colors use full brightness.");
  rgbLedWrite(OnboardRgbLedPin, 0, 0, 0);
  sharedMutex = xSemaphoreCreateMutex();
  if (!sharedMutex) {
    Serial.println("FATAL: cannot allocate shared state mutex");
    for (;;) delay(1000);
  }
  if (!WiFi.mode(WIFI_AP_STA)) report("Wi-Fi AP/STA mode initialization failed");
  WiFi.setAutoReconnect(false);
  if (!WiFi.setBandMode(WIFI_BAND_MODE_AUTO)) report("Dual-band Wi-Fi mode initialization failed");
  if (!WiFi.setSleep(false)) report("Could not disable Wi-Fi power saving");
  deviceName = "sqpedal-" + WiFi.macAddress().substring(9);
  deviceName.replace(":", "");
  deviceName.toLowerCase();
  storageReady = preferences.begin("sqpedal", false);
  if (!storageReady) report("Flash settings storage unavailable");
  if (storageReady && preferences.isKey("settings")) {
    const size_t savedSize = preferences.getBytesLength("settings");
    if (savedSize == sizeof(settings)) {
      sqpedal::Settings saved;
      if (preferences.getBytes("settings", &saved, sizeof(saved)) == sizeof(saved) &&
          sqpedal::validSettings(saved)) settings = saved;
      else report("Saved settings invalid; configure again through setup AP.");
    } else if (savedSize == sizeof(sqpedal::SettingsV1)) {
      sqpedal::SettingsV1 oldSettings{};
      if (preferences.getBytes("settings", &oldSettings, sizeof(oldSettings)) == sizeof(oldSettings)) {
        const sqpedal::Settings migrated = sqpedal::migrateSettings(oldSettings);
        if (sqpedal::validSettings(migrated)) {
          settings = migrated;
          if (preferences.putBytes("settings", &settings, sizeof(settings)) != sizeof(settings))
            report("Could not save migrated settings; migration will be retried on restart.");
        } else report("Saved settings invalid; configure again through setup AP.");
      } else report("Saved settings could not be read; configure again through setup AP.");
    } else report("Saved settings have an unsupported size; configure again through setup AP.");
  }
  adminPassword = storageReady ? preferences.getString("admin", "") : "";
  if (adminPassword.length() != 16) {
    adminPassword = randomSecret();
    if (storageReady && preferences.putString("admin", adminPassword) != adminPassword.length())
      report("Could not persist setup password; Serial password changes on restart.");
  }
  csrf = randomSecret();
  if (!WiFi.softAP(deviceName.c_str(), adminPassword.c_str())) report("Setup Wi-Fi AP failed to start");
  if (!MDNS.begin(deviceName.c_str())) report("mDNS service failed to start; use LAN IP");
  else MDNS.addService("http", "tcp", 80);
  Serial.printf("\nSetup Wi-Fi: %s\nSetup/admin password: %s\n"
                "Configured Wi-Fi SSID: %s\nStation DHCP IP: pending connection\n"
                "Settings: http://192.168.4.1/ (username admin)\n"
                "LAN settings: http://%s.local/\n", deviceName.c_str(), adminPassword.c_str(),
                settings.ssid, deviceName.c_str());
  server.on("/", HTTP_GET, showSettings);
  server.on("/status", HTTP_GET, showStatus);
  server.on("/settings", HTTP_POST, saveSettings);
  server.onNotFound([]() {
    if (authorized()) server.send(404, "text/plain", "Not found");
  });
  server.begin();
  if (xTaskCreate(samplePedal, "pedal-input", 3072, nullptr, 2, nullptr) != pdPASS ||
      xTaskCreate(sendPedal, "companion-http", 8192, nullptr, 1, nullptr) != pdPASS) {
    report("FATAL: pedal task allocation failed; restart device");
    for (;;) delay(1000);
  }
}

void loop() {
  static uint32_t wifiRevision = UINT32_MAX;
  static uint32_t attemptStartedAt = 0, nextAttemptAt = 0, retryDelayMs = WifiRetryMs;
  static bool stationConnected = false, stationEverConnected = false;
  static bool attemptInProgress = false, initialFailureLocked = false, forceAttempt = false;
  sqpedal::Settings target;
  uint32_t currentRevision;
  bool connected, pedalClosed;
  {
    SharedLock lock;
    target = settings;
    currentRevision = revision;
    connected = companionConnected;
    pedalClosed = pedal.pressed;
  }
  const uint32_t now = millis();
  if (wifiRevision != currentRevision) {
    const bool firstLoop = wifiRevision == UINT32_MAX;
    WiFi.disconnect(false, false);
    stationConnected = false;
    stationEverConnected = false;
    attemptInProgress = false;
    initialFailureLocked = false;
    forceAttempt = !firstLoop;
    retryDelayMs = WifiRetryMs;
    nextAttemptAt = now;
    wifiRevision = currentRevision;
  }
  const bool connectedToWifi = WiFi.status() == WL_CONNECTED;
  if (connectedToWifi) {
    if (!stationConnected)
      report("Connected to Wi-Fi " + WiFi.SSID() + "; station DHCP IP " + WiFi.localIP().toString());
    stationConnected = true;
    stationEverConnected = true;
    attemptInProgress = false;
    initialFailureLocked = false;
    retryDelayMs = WifiRetryMs;
  } else {
    if (stationConnected) {
      stationConnected = false;
      attemptInProgress = false;
      nextAttemptAt = now + retryDelayMs;
      report("Station Wi-Fi disconnected; reconnect will wait for setup AP to be idle.");
    }
    if (attemptInProgress && uint32_t(now - attemptStartedAt) >= WifiConnectTimeoutMs) {
      WiFi.disconnect(false, false);
      attemptInProgress = false;
      if (!stationEverConnected) {
        initialFailureLocked = true;
        report("Initial station Wi-Fi connection failed; setup AP remains available. Save settings or reboot to retry.");
      } else {
        nextAttemptAt = now + retryDelayMs;
        report("Station Wi-Fi reconnect timed out; retry will use backoff.");
        retryDelayMs = retryDelayMs >= WifiRetryMaxMs / 2 ? WifiRetryMaxMs : retryDelayMs * 2;
      }
    }
    if (target.ssid[0] && !initialFailureLocked && !attemptInProgress &&
        static_cast<int32_t>(now - nextAttemptAt) >= 0 &&
        (forceAttempt || WiFi.softAPgetStationNum() == 0)) {
      WiFi.setHostname(deviceName.c_str());
      WiFi.begin(target.ssid, target.wifiPassword);
      attemptStartedAt = now;
      attemptInProgress = true;
      forceAttempt = false;
      report("Connecting to configured Wi-Fi");
    }
  }
  updateStatusLed(connected, pedalClosed, connectedToWifi, now, target);
  server.handleClient();
  delay(2);
}
