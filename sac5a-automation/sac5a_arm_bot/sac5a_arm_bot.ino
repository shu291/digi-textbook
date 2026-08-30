/*
 * sac5a_arm_bot — SAC-5A 起床予約 自動押しロボット
 *
 * 定刻起床装置 個人簡易型 SAC-5A の［アラーム］ボタンを、毎晩決まった時刻に
 * SG90 サーボで物理的に 1 回押して、起床予約（Alarm ON）を自動化する。
 * スマホのブラウザから http://sac5a.local/ を開くと、曜日ごとの押し時刻の設定・
 * 今すぐ押す・今夜だけスキップ・サーボ角度の調整ができる。
 *
 * 前提（SAC-5A 取扱説明書より）:
 *   - 起床時刻に変更がなければ［アラーム］ボタン 1 回で起床予約が完了する
 *   - 起床時刻・現在時刻・設定は停電や電池交換でも本体側に保持される
 *   - 予約中に［アラーム］を押すと予約解除になる → 手動押しとの二重運用はしない
 *
 * 配線: SG90 信号線 → GPIO13 / 電源 → 5V(VIN) / GND → GND
 * 必要ライブラリ: ESP32Servo（Arduino IDE のライブラリマネージャから）
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ESP32Servo.h>
#include <time.h>

// ---------- 固定設定 ----------
static const int   SERVO_PIN = 13;
static const char* MDNS_NAME = "sac5a";        // http://sac5a.local/
static const char* AP_SSID   = "SAC5A-setup";  // Wi-Fi 未設定時の設定用アクセスポイント
static const char* AP_PASS   = "sac5a-setup";
static const char* NTP1      = "ntp.nict.jp";
static const char* NTP2      = "pool.ntp.org";
static const long  TZ_SEC    = 9 * 3600;       // JST (UTC+9)

static const char* DAY_NAMES[7] = {"日", "月", "火", "水", "木", "金", "土"};

// ---------- 状態 ----------
Preferences prefs;
WebServer   server(80);
Servo       servo;

struct DaySchedule {
  bool    enabled;
  uint8_t hh;
  uint8_t mm;
};
DaySchedule sched[7];          // 添字は tm_wday と同じ（0=日曜)

int      restAngle  = 90;      // 待機角度
int      pressAngle = 130;     // 押し込み角度
int      holdMs     = 400;     // 押し込み保持時間
bool     skipOnce   = false;   // 次の 1 回だけ押さない
uint32_t firedKey   = 0;       // 同じ分に 2 回押さないためのガード（再起動しても保持）
bool     apMode     = false;

String   wifiSsid;
String   wifiPass;

// 直近の動作ログ（RAM のみ・最大 20 件）
static const int LOG_MAX = 20;
String logBuf[LOG_MAX];
int    logCount = 0;

// ---------- ユーティリティ ----------
bool timeValid() {
  return time(nullptr) > 1700000000;  // NTP 同期前の 1970 年時刻を弾く
}

String nowText() {
  if (!timeValid()) return "時刻未同期";
  struct tm t;
  if (!getLocalTime(&t)) return "時刻取得失敗";
  char buf[40];
  snprintf(buf, sizeof(buf), "%d/%02d/%02d(%s) %02d:%02d:%02d",
           t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
           DAY_NAMES[t.tm_wday], t.tm_hour, t.tm_min, t.tm_sec);
  return String(buf);
}

void addLog(const String& msg) {
  String line = nowText() + " " + msg;
  if (logCount < LOG_MAX) {
    logBuf[logCount++] = line;
  } else {
    for (int i = 1; i < LOG_MAX; i++) logBuf[i - 1] = logBuf[i];
    logBuf[LOG_MAX - 1] = line;
  }
  Serial.println(line);
}

String htmlEscape(const String& s) {
  String o;
  o.reserve(s.length());
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '&') o += "&amp;";
    else if (c == '<') o += "&lt;";
    else if (c == '>') o += "&gt;";
    else if (c == '"') o += "&quot;";
    else o += c;
  }
  return o;
}

// ---------- 設定の保存 / 読み込み ----------
void loadConfig() {
  prefs.begin("sac5a", true);
  for (int d = 0; d < 7; d++) {
    char kEn[4], kT[4];
    snprintf(kEn, sizeof(kEn), "en%d", d);
    snprintf(kT, sizeof(kT), "t%d", d);
    sched[d].enabled = prefs.getBool(kEn, d >= 1 && d <= 5);  // 初期値: 平日ON
    uint16_t t = prefs.getUShort(kT, 21 * 60 + 30);           // 初期値: 21:30
    sched[d].hh = t / 60;
    sched[d].mm = t % 60;
  }
  restAngle  = prefs.getInt("rest", 90);
  pressAngle = prefs.getInt("press", 130);
  holdMs     = prefs.getInt("hold", 400);
  skipOnce   = prefs.getBool("skip", false);
  firedKey   = prefs.getUInt("fired", 0);
  wifiSsid   = prefs.getString("ssid", "");
  wifiPass   = prefs.getString("pass", "");
  prefs.end();
}

void saveSchedule() {
  prefs.begin("sac5a", false);
  for (int d = 0; d < 7; d++) {
    char kEn[4], kT[4];
    snprintf(kEn, sizeof(kEn), "en%d", d);
    snprintf(kT, sizeof(kT), "t%d", d);
    prefs.putBool(kEn, sched[d].enabled);
    prefs.putUShort(kT, sched[d].hh * 60 + sched[d].mm);
  }
  prefs.end();
}

void saveCalib() {
  prefs.begin("sac5a", false);
  prefs.putInt("rest", restAngle);
  prefs.putInt("press", pressAngle);
  prefs.putInt("hold", holdMs);
  prefs.end();
}

void saveSkip() {
  prefs.begin("sac5a", false);
  prefs.putBool("skip", skipOnce);
  prefs.end();
}

void saveFired() {
  prefs.begin("sac5a", false);
  prefs.putUInt("fired", firedKey);
  prefs.end();
}

void saveWifi() {
  prefs.begin("sac5a", false);
  prefs.putString("ssid", wifiSsid);
  prefs.putString("pass", wifiPass);
  prefs.end();
}

// ---------- サーボ ----------
void pressButton(const String& why) {
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2400);
  servo.write(restAngle);
  delay(200);
  servo.write(pressAngle);
  delay(holdMs);
  servo.write(restAngle);
  delay(400);
  servo.detach();  // 押し終わったら脱力（ジッター音とサーボの消耗を防ぐ）
  addLog("ボタンを押しました（" + why + "）");
}

void servoToRest() {
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2400);
  servo.write(restAngle);
  delay(600);
  servo.detach();
}

// ---------- スケジュール ----------
void checkSchedule() {
  if (!timeValid()) return;
  struct tm t;
  if (!getLocalTime(&t)) return;

  DaySchedule& d = sched[t.tm_wday];
  if (!d.enabled || t.tm_hour != d.hh || t.tm_min != d.mm) return;

  // 「年内通し日 + 時分」で分単位のキーを作り、同じ分の再実行を防ぐ
  uint32_t key = (uint32_t)(t.tm_yday + 1) * 10000 + t.tm_hour * 100 + t.tm_min;
  if (key == firedKey) return;
  firedKey = key;
  saveFired();

  if (skipOnce) {
    skipOnce = false;
    saveSkip();
    addLog("スキップ設定のため今回は押しませんでした");
    return;
  }
  pressButton("スケジュール " + String(DAY_NAMES[t.tm_wday]) + "曜");
}

String nextPressText() {
  if (apMode)       return "Wi-Fi 未設定（自動押しは停止中）";
  if (!timeValid()) return "時刻未同期（自動押しは停止中）";
  time_t now = time(nullptr);
  struct tm base;
  localtime_r(&now, &base);
  for (int i = 0; i < 8; i++) {
    int wd = (base.tm_wday + i) % 7;
    if (!sched[wd].enabled) continue;
    struct tm cand = base;
    cand.tm_mday += i;
    cand.tm_hour = sched[wd].hh;
    cand.tm_min  = sched[wd].mm;
    cand.tm_sec  = 0;
    time_t ct = mktime(&cand);  // mktime が月末・年末の繰り上がりを正規化してくれる
    if (ct <= now) continue;
    char buf[48];
    snprintf(buf, sizeof(buf), "%02d/%02d(%s) %02d:%02d",
             cand.tm_mon + 1, cand.tm_mday, DAY_NAMES[cand.tm_wday],
             cand.tm_hour, cand.tm_min);
    String s(buf);
    if (skipOnce) s += "（この回はスキップ予定）";
    return s;
  }
  return "有効な曜日がありません";
}

// ---------- Wi-Fi ----------
void startWiFi() {
  if (wifiSsid.length() > 0) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    Serial.print("Wi-Fi 接続中");
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("IP: " + WiFi.localIP().toString());
      configTime(TZ_SEC, 0, NTP1, NTP2);
      if (MDNS.begin(MDNS_NAME)) MDNS.addService("http", "tcp", 80);
      addLog("Wi-Fi 接続 OK: " + WiFi.localIP().toString());
      return;
    }
    addLog("Wi-Fi 接続失敗 → 設定用 AP を起動します");
  }
  apMode = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.println("設定用 AP: " + String(AP_SSID) + " / http://" + WiFi.softAPIP().toString() + "/");
}

void maintainWiFi() {
  static uint32_t lastTry = 0;
  if (apMode) return;
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastTry < 30000) return;
  lastTry = millis();
  WiFi.reconnect();
}

// ---------- Web UI ----------
void sendRedirect() {
  server.sendHeader("Location", "/");
  server.send(303, "text/plain", "");
}

void handleRoot() {
  String h;
  h.reserve(9000);
  h += F("<!DOCTYPE html><html lang='ja'><head><meta charset='utf-8'>"
         "<meta name='viewport' content='width=device-width,initial-scale=1'>"
         "<title>SAC-5A 起床予約オートマ</title><style>"
         "body{font-family:sans-serif;max-width:540px;margin:0 auto;padding:12px;background:#f4f5f7;color:#222}"
         "h1{font-size:1.25rem}h2{font-size:1rem;margin:0 0 8px}"
         ".card{background:#fff;border-radius:10px;padding:14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.12)}"
         "table{border-collapse:collapse;width:100%}td{padding:4px 6px}"
         "input[type=time],input[type=number],input[type=text],input[type=password]{padding:6px;font-size:1rem;width:100%;max-width:160px;box-sizing:border-box}"
         "button{padding:10px 14px;font-size:1rem;border:none;border-radius:8px;background:#1a73e8;color:#fff;margin:4px 4px 0 0}"
         "button.warn{background:#e07b00}button.gray{background:#777}"
         ".status{font-size:1.05rem;line-height:1.7}"
         ".note{font-size:.85rem;color:#666;line-height:1.5}"
         "ul.log{font-size:.8rem;color:#444;padding-left:18px;margin:0}"
         "</style></head><body><h1>⏰ SAC-5A 起床予約オートマ</h1>");

  // 状態
  h += F("<div class='card'><h2>状態</h2><div class='status'>");
  h += "現在時刻: " + nowText() + "<br>次の自動押し: <b>" + nextPressText() + "</b><br>";
  if (apMode) {
    h += F("<span style='color:#c00'>Wi-Fi 未接続（設定用 AP モード）。下の Wi-Fi 設定を入力してください。</span>");
  } else {
    h += "Wi-Fi: " + htmlEscape(wifiSsid) + (WiFi.status() == WL_CONNECTED ? "（接続中 " + WiFi.localIP().toString() + "）" : "（切断中・再接続待ち）");
  }
  h += F("</div></div>");

  // 手動操作
  h += F("<div class='card'><h2>手動操作</h2>"
         "<form method='post' action='/press' style='display:inline'><button>今すぐ押す（テスト）</button></form>");
  if (skipOnce) {
    h += F("<form method='post' action='/unskip' style='display:inline'><button class='gray'>スキップを解除</button></form>");
  } else {
    h += F("<form method='post' action='/skip' style='display:inline'><button class='warn'>次の1回だけスキップ</button></form>");
  }
  h += F("<div class='note'>注意: 本体のアラームLEDが点灯中（予約済み）に押すと予約が<b>解除</b>されます。"
         "予約はこの装置に任せて、本体のアラームボタンは手で押さない運用にしてください。</div></div>");

  // スケジュール
  h += F("<div class='card'><h2>自動押しスケジュール（曜日ごと）</h2>"
         "<form method='post' action='/save'><table>");
  for (int d = 0; d < 7; d++) {
    char row[220];
    snprintf(row, sizeof(row),
             "<tr><td><label><input type='checkbox' name='en%d'%s> %s曜</label></td>"
             "<td><input type='time' name='t%d' value='%02d:%02d'></td></tr>",
             d, sched[d].enabled ? " checked" : "", DAY_NAMES[d],
             d, sched[d].hh, sched[d].mm);
    h += row;
  }
  h += F("</table><button>スケジュールを保存</button>"
         "<div class='note'>ここで設定するのは「予約ボタンを押す時刻」（寝る前の時刻）です。"
         "起きる時刻は SAC-5A 本体に設定済みのものが使われます。</div></form></div>");

  // キャリブレーション
  h += F("<div class='card'><h2>サーボ調整</h2><form method='post' action='/calib'><table>");
  h += "<tr><td>待機角度 (0-180)</td><td><input type='number' name='rest' min='0' max='180' value='" + String(restAngle) + "'></td></tr>";
  h += "<tr><td>押し込み角度 (0-180)</td><td><input type='number' name='press' min='0' max='180' value='" + String(pressAngle) + "'></td></tr>";
  h += "<tr><td>保持時間 (ms)</td><td><input type='number' name='hold' min='100' max='2000' step='50' value='" + String(holdMs) + "'></td></tr>";
  h += F("</table><button name='save' value='1' class='gray'>保存のみ</button>"
         "<button name='test' value='1'>保存して試し押し</button>"
         "<div class='note'>待機角度で腕がボタンに触れず、押し込み角度でしっかり押し切れる位置に調整してください。</div></form></div>");

  // Wi-Fi 設定
  h += F("<div class='card'><h2>Wi-Fi 設定</h2><form method='post' action='/wifi'><table>");
  h += "<tr><td>SSID</td><td><input type='text' name='ssid' value='" + htmlEscape(wifiSsid) + "'></td></tr>";
  h += F("<tr><td>パスワード</td><td><input type='password' name='pass' placeholder='変更時のみ入力'></td></tr>"
         "</table><button class='gray'>保存して再起動</button></form></div>");

  // ログ
  h += F("<div class='card'><h2>ログ</h2><ul class='log'>");
  if (logCount == 0) h += F("<li>まだログはありません</li>");
  for (int i = logCount - 1; i >= 0; i--) h += "<li>" + htmlEscape(logBuf[i]) + "</li>";
  h += F("</ul></div>");

  h += F("<div class='note'>起床時の停止ボタン（停止A+停止B）は自動化しません。あれを自動化すると寝坊装置になります。</div>"
         "</body></html>");
  server.send(200, "text/html; charset=utf-8", h);
}

void handleSave() {
  for (int d = 0; d < 7; d++) {
    char kEn[4], kT[4];
    snprintf(kEn, sizeof(kEn), "en%d", d);
    snprintf(kT, sizeof(kT), "t%d", d);
    sched[d].enabled = server.hasArg(kEn);
    String tv = server.arg(kT);  // "HH:MM"
    if (tv.length() == 5 && tv[2] == ':') {
      int hh = tv.substring(0, 2).toInt();
      int mm = tv.substring(3, 5).toInt();
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        sched[d].hh = hh;
        sched[d].mm = mm;
      }
    }
  }
  saveSchedule();
  addLog("スケジュールを保存しました");
  sendRedirect();
}

void handlePress() {
  pressButton("手動");
  sendRedirect();
}

void handleSkip() {
  skipOnce = true;
  saveSkip();
  addLog("次の1回をスキップに設定しました");
  sendRedirect();
}

void handleUnskip() {
  skipOnce = false;
  saveSkip();
  addLog("スキップを解除しました");
  sendRedirect();
}

void handleCalib() {
  int r = constrain(server.arg("rest").toInt(), 0, 180);
  int p = constrain(server.arg("press").toInt(), 0, 180);
  int hm = constrain(server.arg("hold").toInt(), 100, 2000);
  restAngle = r;
  pressAngle = p;
  holdMs = hm;
  saveCalib();
  if (server.hasArg("test")) {
    pressButton("調整の試し押し");
  } else {
    servoToRest();
    addLog("サーボ設定を保存しました");
  }
  sendRedirect();
}

void handleWifi() {
  String s = server.arg("ssid");
  String p = server.arg("pass");
  if (s.length() > 0) {
    wifiSsid = s;
    if (p.length() > 0) wifiPass = p;  // 空欄なら既存パスワードを維持
    saveWifi();
    server.send(200, "text/html; charset=utf-8",
                F("<meta charset='utf-8'>保存しました。再起動します。接続後は <a href='http://sac5a.local/'>http://sac5a.local/</a> を開いてください。"));
    delay(1500);
    ESP.restart();
  }
  sendRedirect();
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nsac5a_arm_bot 起動");

  ESP32PWM::allocateTimer(0);
  loadConfig();
  servoToRest();
  startWiFi();

  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/press", HTTP_POST, handlePress);
  server.on("/skip", HTTP_POST, handleSkip);
  server.on("/unskip", HTTP_POST, handleUnskip);
  server.on("/calib", HTTP_POST, handleCalib);
  server.on("/wifi", HTTP_POST, handleWifi);
  server.onNotFound([]() { sendRedirect(); });
  server.begin();

  addLog("起動しました");
}

void loop() {
  server.handleClient();
  static uint32_t lastTick = 0;
  if (millis() - lastTick >= 1000) {
    lastTick = millis();
    checkSchedule();
    maintainWiFi();
  }
}
