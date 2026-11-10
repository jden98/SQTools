#pragma once
#include <stdint.h>

namespace sqpedal {
constexpr uint32_t DebounceMs = 20;

class Debouncer {
 public:
  bool update(bool input, uint32_t now) {
    if (!initialized_) {
      initialized_ = true;
      raw_ = input;
      changedAt_ = now;
    }
    if (input != raw_) {
      raw_ = input;
      changedAt_ = now;
    }
    if (uint32_t(now - changedAt_) < DebounceMs) return false;
    if (!settled_ || stable_ != raw_) {
      settled_ = true;
      stable_ = raw_;
      return true;
    }
    return false;
  }
  bool pressed() const { return stable_; }
 private:
  bool initialized_ = false, settled_ = false, raw_ = true, stable_ = true;
  uint32_t changedAt_ = 0;
};

enum class Command { None, Down, Up };

// No Down retries: an uncertain duplicate can invoke the FOH release override.
class PedalState {
 public:
  bool pressed = true;
  bool armed = false;
  bool synchronized = false;
  bool releasePending = true;
  bool possiblyDown = false;

  void input(bool down) {
    if (down == pressed) return;
    pressed = down;
    if (down) {
      if (armed && synchronized && !releasePending) pendingDown_ = true;
      armed = false;
    } else {
      pendingDown_ = false;
      if (possiblyDown) releasePending = true;
      armed = synchronized && !releasePending;
    }
  }
  void lostConnection() {
    synchronized = false;
    releasePending = true;
    pendingDown_ = false;
    armed = false;
  }
  Command next() const {
    if (releasePending) return Command::Up;
    return pendingDown_ && pressed ? Command::Down : Command::None;
  }
  void starting(Command command) {
    if (command == Command::Down) {
      pendingDown_ = false;
      possiblyDown = true;
    }
  }
  void completed(Command command, bool success) {
    if (!success) {
      lostConnection();
    } else if (command == Command::Up) {
      possiblyDown = false;
      releasePending = false;
      synchronized = true;
      armed = !pressed;
    } else if (!pressed) {
      releasePending = true;
    }
  }
 private:
  bool pendingDown_ = false;
};
}
