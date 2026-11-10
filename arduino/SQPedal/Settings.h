#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>

namespace sqpedal {
struct SettingsV1 {
  uint32_t version;
  char ssid[33];
  char wifiPassword[65];
  char host[254];
  uint16_t port;
  uint16_t page;
  uint16_t row;
  uint16_t column;
  uint8_t activeLow;
};

struct Settings {
  uint32_t version = 2;
  char ssid[33] = "";
  char wifiPassword[65] = "";
  char host[254] = "";
  uint16_t port = 8000;
  uint16_t page = 3;
  uint16_t row = 2;
  uint16_t column = 1;
  uint8_t activeLow = 1;
  uint8_t redBrightness = 75;
  uint8_t greenBrightness = 50;
  uint8_t blueBrightness = 100;
  uint8_t reserved = 0;
};

inline Settings migrateSettings(const SettingsV1& old) {
  Settings migrated;
  migrated.version = old.version == 1 ? 2 : old.version;
  memcpy(migrated.ssid, old.ssid, sizeof(migrated.ssid));
  memcpy(migrated.wifiPassword, old.wifiPassword, sizeof(migrated.wifiPassword));
  memcpy(migrated.host, old.host, sizeof(migrated.host));
  migrated.port = old.port;
  migrated.page = old.page;
  migrated.row = old.row;
  migrated.column = old.column;
  migrated.activeLow = old.activeLow;
  return migrated;
}

inline bool validHost(const char* host) {
  const size_t size = strlen(host);
  if (size == 0 || size > 253 || host[0] == '.' || host[size - 1] == '.') return false;
  size_t labelLength = 0;
  for (size_t i = 0; i < size; ++i) {
    const char c = host[i];
    if (c == '.') {
      if (!labelLength || host[i - 1] == '-') return false;
      labelLength = 0;
      continue;
    }
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-')) return false;
    if (labelLength == 0 && c == '-') return false;
    if (++labelLength > 63) return false;
  }
  return labelLength != 0 && host[size - 1] != '-';
}

inline bool validSettings(const Settings& s, bool allowEmpty = false) {
  if (s.version != 2 || s.redBrightness > 100 || s.greenBrightness > 100 ||
      s.blueBrightness > 100 || !memchr(s.ssid, 0, sizeof(s.ssid)) ||
      !memchr(s.wifiPassword, 0, sizeof(s.wifiPassword)) ||
      !memchr(s.host, 0, sizeof(s.host))) return false;
  const size_t passwordLength = strlen(s.wifiPassword);
  if (passwordLength && (passwordLength < 8 || passwordLength > 63)) return false;
  return (allowEmpty && !s.host[0] ? true : validHost(s.host)) &&
         (allowEmpty || s.ssid[0]) && s.port != 0 && s.page >= 1 &&
         s.page <= 9999 && s.row <= 255 && s.column <= 255 && s.activeLow <= 1;
}

inline void buttonPath(char* buffer, size_t size, const Settings& s, bool down) {
  snprintf(buffer, size, "/api/location/%u/%u/%u/%s",
           unsigned(s.page), unsigned(s.row), unsigned(s.column), down ? "down" : "up");
}
}
