#include <cassert>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include "../SQPedal/PedalState.h"
#include "../SQPedal/Settings.h"

using namespace sqpedal;

void acknowledge(PedalState& p, Command c, bool ok = true) {
  assert(p.next() == c);
  p.starting(c);
  p.completed(c, ok);
}

int main() {
  {
    Debouncer d;
    assert(!d.update(false, 0));
    assert(!d.update(false, 19));
    assert(d.update(false, 20));
    assert(!d.pressed());
    assert(!d.update(true, 21));
    assert(!d.update(false, 28));
    assert(!d.update(true, 35));
    assert(!d.update(true, 54));
    assert(d.update(true, 55));
    assert(d.pressed());
    assert(!d.update(true, 5000));
    assert(!d.update(false, 5001));
    assert(d.update(false, 5021));
    assert(!d.pressed());
  }
  {
    Debouncer d;
    assert(!d.update(true, UINT32_MAX - 10));
    assert(!d.update(true, 8));
    assert(d.update(true, 9));
    assert(d.pressed());
  }
  {
    PedalState p;
    assert(p.next() == Command::Up);
    p.input(false);
    assert(!p.armed);
    acknowledge(p, Command::Up);
    assert(p.armed);
    p.input(true);
    acknowledge(p, Command::Down);
    assert(p.possiblyDown && !p.armed);
    p.input(true);
    assert(p.next() == Command::None);
    p.input(false);
    acknowledge(p, Command::Up);
    assert(p.armed && !p.possiblyDown);
  }
  {
    PedalState p;
    acknowledge(p, Command::Up);
    assert(!p.armed);
    p.input(true);
    assert(p.next() == Command::None);
    p.input(false);
    assert(p.armed);
    p.input(true);
    assert(p.next() == Command::Down);
    p.input(false);
    assert(p.next() == Command::None);
  }
  {
    PedalState p;
    p.input(false);
    acknowledge(p, Command::Up);
    p.input(true);
    p.starting(Command::Down);
    p.input(false);
    p.completed(Command::Down, true);
    assert(p.next() == Command::Up);
    acknowledge(p, Command::Up);
    assert(p.armed);
  }
  {
    PedalState p;
    p.input(false);
    acknowledge(p, Command::Up);
    p.input(true);
    acknowledge(p, Command::Down, false);
    assert(p.possiblyDown && !p.armed);
    assert(p.next() == Command::Up);
    acknowledge(p, Command::Up, false);
    assert(p.next() == Command::Up);
    acknowledge(p, Command::Up);
    assert(!p.armed && !p.possiblyDown);
    p.input(true);
    assert(p.next() == Command::None);
    p.input(false);
    assert(p.armed);
    p.input(true);
    assert(p.next() == Command::Down);
  }
  {
    PedalState p;
    p.input(false);
    acknowledge(p, Command::Up);
    p.input(true);
    acknowledge(p, Command::Down);
    p.lostConnection();
    p.input(false);
    p.input(true);
    assert(p.next() == Command::Up);
    acknowledge(p, Command::Up);
    assert(!p.armed);
    p.input(false);
    assert(p.armed);
  }
  {
    Settings s;
    assert(s.ssid[0] == 0 && s.wifiPassword[0] == 0);
    assert(s.redBrightness == 75 && s.greenBrightness == 50 && s.blueBrightness == 100);
    assert(validSettings(s, true));
    assert(!validSettings(s));
    strcpy(s.ssid, "test-network");
    strcpy(s.wifiPassword, "test-password");
    strcpy(s.host, "companion.example.org");
    assert(validSettings(s));
    char path[64];
    buttonPath(path, sizeof(path), s, true);
    assert(strcmp(path, "/api/location/3/2/1/down") == 0);
    s.column = 2;
    buttonPath(path, sizeof(path), s, false);
    assert(strcmp(path, "/api/location/3/2/2/up") == 0);
    s.page = 9999; s.row = 255; s.column = 255;
    buttonPath(path, sizeof(path), s, true);
    assert(strcmp(path, "/api/location/9999/255/255/down") == 0);
    assert(validSettings(s));
    s.port = 0; assert(!validSettings(s)); s.port = 8000;
    s.page = 0; assert(!validSettings(s)); s.page = 3;
    s.row = 256; assert(!validSettings(s)); s.row = 2;
    s.activeLow = 2; assert(!validSettings(s)); s.activeLow = 1;
    s.redBrightness = 101; assert(!validSettings(s)); s.redBrightness = 75;
    s.greenBrightness = 101; assert(!validSettings(s)); s.greenBrightness = 50;
    s.blueBrightness = 101; assert(!validSettings(s)); s.blueBrightness = 100;
    s.redBrightness = 0; s.greenBrightness = 0; s.blueBrightness = 0;
    assert(validSettings(s));
    s.redBrightness = 75; s.greenBrightness = 50; s.blueBrightness = 100;
    strcpy(s.wifiPassword, "short"); assert(!validSettings(s));
    s.wifiPassword[0] = 0; assert(validSettings(s));
    s.version = 99; assert(!validSettings(s)); s.version = 1;
    memset(s.host, 'x', sizeof(s.host)); assert(!validSettings(s));
  }
  {
    SettingsV1 old{};
    old.version = 1;
    strcpy(old.ssid, "previous-network");
    strcpy(old.wifiPassword, "previous-password");
    strcpy(old.host, "companion.example.org");
    old.port = 8000;
    old.page = 3;
    old.row = 2;
    old.column = 1;
    old.activeLow = 1;
    const Settings migrated = migrateSettings(old);
    assert(validSettings(migrated));
    assert(strcmp(migrated.ssid, old.ssid) == 0);
        assert(strcmp(migrated.wifiPassword, old.wifiPassword) == 0);
    assert(strcmp(migrated.host, old.host) == 0);
        assert(migrated.page == old.page && migrated.row == old.row &&
          migrated.column == old.column && migrated.activeLow == old.activeLow);
    assert(migrated.redBrightness == 75 && migrated.greenBrightness == 50 &&
           migrated.blueBrightness == 100);
    assert(sizeof(Settings) != sizeof(SettingsV1));
        old.version = 99;
        assert(!validSettings(migrateSettings(old)));
  }
  {
    for (const char* host : {"192.168.1.50", "foh-pc", "foh-pc.local", "Companion.example.org"})
      assert(validHost(host));
    for (const char* host : {"", "http://foh-pc", "foh-pc:8000", "foo/bar", " foo", "-foo",
                            "foo-", "foo..bar", ".foo", "foo.", "foo-.bar", "foo._bar", "foo\nbar"})
      assert(!validHost(host));
  }
  puts("PASS: debounce timing, wraparound, press/release, failure recovery, no Down replay, settings and HTTP paths");
}
