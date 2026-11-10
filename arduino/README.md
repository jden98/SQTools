# SQ Pedal - ESP32-C5 Companion HTTP bridge

One Waveshare ESP32-C5-WIFI6-KIT board and one Alesis ASP-1 MKII sustain pedal per device. Flash the same sketch onto both boards; choose different Companion columns in their settings.

The firmware targets **Espressif Arduino-ESP32 3.3.12**, **ESP32C5 Dev Module**, with **16 MB flash** and **PSRAM disabled**. It uses only libraries supplied with that core: WiFi, HTTPClient, WebServer, Preferences and ESPmDNS. This is a normal Arduino sketch, not a PlatformIO project or a replacement for the Companion module.

## Wiring

Check the markings on your actual board against [Waveshare's pinout](https://www.waveshare.com/wiki/ESP32-C5-WIFI6-KIT-NXRX). The sketch uses **GPIO4**, labeled `4` on the right-hand header of the documented board, not the fourth physical header pin.

With USB power disconnected:

| Jack terminal | ESP32 connection |
| --- | --- |
| Tip | GPIO4 |
| Sleeve | GND |

Wire an external **common-cathode RGB LED** as follows. Put one 330 ohm resistor in series with each color lead:

| LED lead | ESP32 connection |
| --- | --- |
| Common cathode | GND |
| Red anode | GPIO6 (`IO6`) through 330 ohm resistor |
| Green anode | GPIO7 (`IO7`) through 330 ohm resistor |
| Blue anode | GPIO10 (`IO10`) through 330 ohm resistor |

The firmware uses blue while Companion is unreachable, green when Companion is reachable and the pedal is released, and red when Companion is reachable and the pedal is closed. Blue takes priority while Companion is unreachable, regardless of pedal state; it blinks twice per second when station Wi-Fi is disconnected and stays solid when station Wi-Fi is connected. LED brightness is PWM-controlled and adjustable from 0% to 100% in the settings page; defaults are red 75%, green 50%, and blue 100%. A successful Companion HTTP probe or button request marks it connected; a failed request, Wi-Fi loss, or settings change clears that state. The onboard WS2812 on GPIO27 is turned off and is not used for status. The board's PWR and charging indicators remain controlled by the board.

The pedal is a passive switch. Do not connect the jack to 5V, VBAT, a mixer, an amplifier, or any other powered audio equipment. If using a TRS jack, leave its ring and any jack-switch terminals disconnected; identify tip and sleeve with a continuity meter.

`INPUT_PULLUP` is enabled: the open contact reads HIGH, and contact closure to ground reads LOW. Set the Alesis polarity switch so the contact is **open when released and closed when pressed**. Confirm this with a meter before connecting. The settings page also provides an inverse-polarity option, but the recommended hardware polarity is easiest to configure. Do not change the polarity switch during use.

The female Dupont wires require male headers fitted to the board and appropriate connections to the jack. Some board/jack variants need soldering. Secure and insulate the wiring in an enclosure with strain relief; loose breadboard jumpers are not stage-ready. For a noisy installation, a stronger external pull-up, appropriate input protection and better wiring may be needed; test the actual 1.5 m pedal cable before deployment.

Power each board through its USB-C power/programming connector using the charger. Use a **data-capable** USB cable and the board's **UART USB-C port** to program and read Serial output. A charging-only cable cannot upload firmware.

## Arduino IDE setup

1. In Arduino IDE settings, add this Additional Boards Manager URL:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

2. In Boards Manager install **esp32 by Espressif Systems, version 3.3.12**.
3. Open [SQPedal/SQPedal.ino](SQPedal/SQPedal.ino). Keep the accompanying headers in the sketch folder.
   For a guided explanation of the firmware starting at line 30, see the [SQPedal.ino walkthrough](SQPedal/WALKTHROUGH.md).
4. Select **ESP32C5 Dev Module**, **Flash Size: 16MB**, **PSRAM: Disabled**. Keep the default partition scheme; the application fits in it. For the UART USB port, keep **USB CDC On Boot disabled**. Select the corresponding COM port.
5. Verify and upload. If automatic download mode fails, hold BOOT, tap RESET, release BOOT and retry upload according to the board instructions.
6. Open Serial Monitor at **115200 baud**, then tap RESET. It prints the setup Wi-Fi name, a device-specific password and settings URLs. Store the password securely.

You can edit in VS Code and upload in Arduino IDE. VS Code does not itself supply an Arduino compiler/uploader. Arduino CLI is an alternative; no IDE extension is required:

```powershell
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.12 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli compile --fqbn esp32:esp32:esp32c5:FlashSize=16M,PSRAM=disabled .\arduino\SQPedal
arduino-cli board list
# Replace COM7 with the board's actual port.
arduino-cli upload --fqbn esp32:esp32:esp32c5:FlashSize=16M,PSRAM=disabled --port COM7 .\arduino\SQPedal
arduino-cli monitor --port COM7 --config baudrate=115200
```

These commands run from the repository root. [sketch.yaml](SQPedal/sketch.yaml) records the board target; the core version above is the validated version. Newer versions need revalidation.

## Browser configuration

1. Release the pedal. Join the board's `sqpedal-xxxxxx` Wi-Fi using the password printed over USB.
2. Open **http://192.168.4.1/**. Browser login username is **admin**; its password is the same device-specific password.
3. Enter:
   - Your normal Wi-Fi SSID and password.
   - Companion computer's **LAN IP or DNS hostname**, such as `192.168.1.50`, `foh-pc.example.org`, or `foh-pc.local`. Do not enter a scheme, path or port here. `localhost` refers to the ESP32, not the Companion computer.
   - Companion's HTTP port, normally **8000**.
   - Page/row/column from the table below.
4. Save. The board reconnects to Wi-Fi and sends an UP to the selected button before arming. **This UP runs the button's release actions**, so configure a dedicated MD button, not an arbitrary production button.
5. On your normal network, open the LAN IP shown in Serial or **http://sqpedal-xxxxxx.local/**. The password-protected setup AP remains available for recovery; the radio's AP channel/band can follow its station connection.

Dual-band automatic selection is enabled. Test your intended 2.4/5 GHz access point and regulatory/channel configuration with the real C5 board. The setup AP and station share the radio, not two independent Wi-Fi radios. Prefer the normal LAN address for settings after joining your network.

The status page shows debounced contact state, Companion reachability, Wi-Fi gateway/RSSI, whether the pedal is armed, required UP recovery, and the last HTTP result and elapsed request time. Startup Serial output includes the configured Wi-Fi SSID; after station connection, Serial reports the DHCP-assigned IP. If the initial station connection fails for 20 seconds, the station stops retrying and the setup AP remains available until settings are saved or the board reboots. After a successful connection, later reconnect attempts use exponential backoff up to five minutes and wait while a setup-AP client is connected. Serial Monitor also logs LED state changes and failed request details (method, resolved URL/IP, port, HTTP status or client error). A `connection refused` error usually means the host is reachable but nothing is listening on that port; a timeout suggests routing/firewall/client isolation or an incorrect address. The page does **not** show SQ mute state. If hostname resolution fails, use a reserved LAN IP or a real DNS record. Windows/NetBIOS display names do not necessarily resolve via DNS; `.local` requires the computer to actually advertise mDNS.

Configured Wi-Fi credentials, target, polarity and LED brightness are stored in NVS flash. Older settings are migrated while preserving their values and using the new brightness defaults. Firmware no longer contains default Wi-Fi credentials: a fresh device starts with its setup AP available until you configure your network and Companion target. Updating firmware preserves settings already stored on the device. A blank password retains the existing password for the same SSID. For a changed SSID supply its password, or explicitly check **Use an open Wi-Fi network**. Saving is refused while a pedal is pressed, a potentially held button still needs UP, or a network operation is in progress. If temporarily busy, wait and try again.

Each board generates its own setup password on first boot and keeps it across ordinary uploads/reboots. An erase of NVS/all flash resets configuration and generates a new password. Treat the password and device as sensitive: NVS is not encrypted by this sketch. Settings use HTTP Basic authentication plus a form token, **not HTTPS**; use a trusted, isolated LAN and never expose the settings or Companion APIs to the Internet.

## Companion setup

Enable Companion's **HTTP API** in Settings and allow its TCP port through the computer's firewall for your pedal network. Wi-Fi client isolation/guest networks must not block access to the Companion computer.

| Board | Page (one-based) | Row (zero-based) | Column (zero-based) |
| --- | --- | --- | --- |
| MD1 | 3 | 2 | 1 |
| MD2 | 3 | 2 | 2 |

Configure each button with:

- DOWN action: **MD pedal PRESS (activate; release if already active)** for its MD.
- UP action: **MD pedal UP** for its MD.
- No latch, repeat-while-held, or step progression that changes those actions.

The firmware sends empty-body requests to:

```text
POST /api/location/3/2/1/down
POST /api/location/3/2/1/up
```

MD2 uses column 2. **Do not use `/press`: that endpoint immediately runs both DOWN and UP.** A 200 `ok` response means Companion accepted the HTTP button event; it does not acknowledge the module's actions or console commands. Orange offline/red module-active feedback is configured in Companion, not by this firmware.

Import the button page and install the SQ module separately when moving Companion computers. Retain page 3 or update these settings.

## Latency and delivery behavior

- Contact sampling runs in a separate FreeRTOS task every approximately 2 ms. A transition must remain stable for **20 ms** to pass debounce. Settings-page traffic and HTTP waits do not run in that task.
- HTTP/1.1 connection reuse is enabled, Wi-Fi power saving is disabled, and the Arduino HTTP client sets TCP_NODELAY. An idle/held **HEAD /api/connections** probe every second checks HTTP reachability/API enablement and keeps a reusable connection warm. This is read-only, **not a Companion-side release watchdog**.
- Connect and HTTP read timeouts are set to **750 ms**. DNS/mDNS is resolved outside the input task and cached until failure or configuration change. DNS and OS network scheduling can exceed those HTTP timeouts; there is no hard real-time latency guarantee.
- Normal DOWN/UP events are sent immediately when the worker is free, without a retry cooldown. If a network/probe request is already in flight, it must finish first. Actual press-to-action latency requires measurement on your hardware/network; it is not the same as the elapsed HTTP time shown in status.
- DOWN is sent **once** per accepted press transition, never periodically and never retried after an uncertain response. That avoids accidentally invoking the FOH press-to-release override. A press that ends before it can be sent is discarded.
- UP is retried after failures, with a **500 ms** cooldown. Following startup, settings changes or a detected connection failure, the device requires a successful UP response and a released pedal before it can arm again. A pedal held during recovery is not replayed as DOWN; release it, wait for Armed, then press again.
- The FOH operator can end MD talk using the shared Companion button. The Arduino does not reopen talk just because the physical pedal stays held. Its eventual release sends UP again.

**Loss of power, a crashed device, an unplugged pedal, or a network outage cannot guarantee remote release.** The device sends recovery UP after it can reach Companion again, but Companion may retain a pressed/MD state during the outage. An unplugged normally-open pedal usually reads released, but electrical faults and opposite polarity can behave differently. Keep the FOH manual release available. A proper dead-man guarantee needs a Companion-side heartbeat timeout that calls MD UP; that is not implemented here. The API also cannot guarantee exactly-once delivery across a lost reply.

## Validation before stage use

The sketch is build-validated with Arduino-ESP32 3.3.12 for ESP32-C5. Native tests exercise the actual shared C++ debounce/delivery policy and settings/path helpers:

```powershell
.\arduino\tests\run-tests.ps1
```

This script requires Visual Studio C++ Build Tools. With another host compiler, compile and run [tests/pedal.test.cpp](tests/pedal.test.cpp) as C++17 with assertions enabled.

The board, flash persistence, radio/AP behavior, jack wiring, sustained HTTP reuse and end-to-end audio operation **still require hardware validation**:

1. With Companion unreachable, verify the external LED is blue even while the pedal is pressed. After Companion responds, verify green while released and red while pressed.
2. Inspect Serial/status; hold a pedal for several seconds and confirm only one DOWN request, followed by one UP.
3. Disconnect Wi-Fi while held, release, reconnect: confirm recovery UP, no automatic DOWN, and a fresh press is required.
4. While held, use FOH press-to-end: confirm it stays ended until the pedal is released and freshly pressed.
5. Power-cycle while held: confirm no automatic DOWN after boot.
6. Reboot after saving settings; verify the target/credentials persist.
7. Confirm the password-protected settings page works on your intended LAN, hostnames resolve, and latency is acceptable under Wi-Fi load.
8. Finally test a noncritical SQ signal path, including initially FOH-muted vocals.

## References and license

- [Waveshare board documentation and pinout](https://www.waveshare.com/wiki/ESP32-C5-WIFI6-KIT-NXRX)
- [Espressif Arduino core 3.3.12](https://github.com/espressif/arduino-esp32/releases/tag/3.3.12)
- [Companion HTTP remote-control API](https://github.com/bitfocus/companion/blob/v5.1.1/docs/user-guide/5_remote-control/http-remote-control.md)

Original firmware in this folder uses the repository's [MIT license](../LICENSE). Arduino core libraries retain their own licenses.
