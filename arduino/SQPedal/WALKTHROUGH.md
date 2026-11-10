# SQPedal.ino walkthrough

This guide starts at line 30 of [SQPedal.ino](SQPedal.ino), where the sketch's shared objects and state are declared. The first 29 lines set up Arduino/library imports, enforce the ESP32-C5 target, and define hardware pins and timing constants. This walkthrough follows the file from top to bottom and explains how the pieces work together.

## The overall job

The ESP32 reads a passive pedal switch, waits for its state to be stable, and sends a Companion HTTP `DOWN` or `UP` event for a configured button. A small web server configures Wi-Fi, the Companion target, button location, pedal polarity, and LED brightness. The sketch uses separate FreeRTOS tasks for sampling the pedal and performing network requests so a slow network operation does not block pedal sampling.

The key safety rule is in [PedalState.h](PedalState.h): a DOWN is sent at most once for an accepted press, while UP is required to synchronize or recover. An uncertain DOWN is not retried, because a duplicate could trigger a Companion action twice.

## Shared objects and locking

At line 30, `settings`, `pedal`, `preferences`, and `server` are global objects:

- `settings` is the current configuration; fresh devices start without configured Wi-Fi credentials.
- `pedal` tracks the debounced input and whether a press may have reached Companion.
- `preferences` reads and writes settings in ESP32 nonvolatile storage (NVS).
- `server` listens for browser requests on port 80.
- `revision` increases when settings change. Network code uses it to discard old connection state and work from a fresh settings snapshot.
- `busy`, `companionConnected`, and the `last...` fields summarize network activity and status for the settings page.

`SharedLock` takes `sharedMutex` in its constructor and releases it in its destructor. This is an example of RAII (resource acquisition is initialization): leaving the scope releases the mutex, including when a function returns early. The input task, HTTP task, and main Arduino loop all touch some of the same state, so they use the lock when reading or changing it. The lock protects shared data; it does not make an HTTP request itself safe to run while holding the lock.

## LEDs and status messages

`ledDuty()` converts a percentage to the PWM range. With 8-bit PWM, the range is 0 through 255; adding 50 before dividing rounds the result rather than always truncating it downward.

`setLed()` selects PWM output when that pin's PWM setup succeeded, otherwise it falls back to simple on/off output. `updateStatusLed()` chooses the status color:

- Blue when Companion is unreachable. It blinks while station Wi-Fi is down and stays solid when station Wi-Fi is up.
- Green when Companion is reachable and the pedal is released.
- Red when Companion is reachable and the pedal is closed.

It also prints a message only when the chosen color changes. The LEDs are independent GPIO outputs; the onboard RGB LED is turned off during setup.

`report()` updates the last-event text and HTTP result while holding the mutex, then writes the message to Serial. The HTTP code and elapsed duration are also shown on the status page.

## Browser settings and status

`randomSecret()` combines two ESP32 hardware random values into a 16-character hexadecimal string. The sketch uses this for the admin password when one has not yet been saved and for a per-boot form token.

`escapeHtml()` replaces HTML-special characters before settings values are inserted into the page. This prevents a configured name or network value from being interpreted as page markup.

`authorized()` sets response-hardening headers and asks the web server to authenticate the browser as `admin` using `adminPassword`. If authentication fails, the server sends a Basic Authentication challenge. This is HTTP, not HTTPS, so the project documentation recommends using a trusted network.

`inputField()` is a small HTML helper. It builds a labeled input element and escapes its current value. `showSettings()` uses it to assemble the configuration page, including a one-second status refresh script. It first copies `settings` under the mutex, then builds HTML from that snapshot. The form carries the `csrf` token so a settings POST must originate from a page served during this boot.

`showStatus()` assembles plain-text diagnostics: Wi-Fi state and signal, pedal state, Companion reachability, armed/synchronized state, whether an UP is still required, the target button, and the last HTTP event. Pedal-related fields are read while holding the mutex so the page does not observe a partially updated state.

## Validating and saving settings

`readNumber()` parses a form value one character at a time. It accepts only decimal digits and checks a caller-supplied minimum and maximum before converting to `uint16_t`. This avoids permissive conversions that might silently accept trailing text or a negative number.

`saveSettings()` handles the settings form in a deliberate sequence:

1. Authenticate the request and compare its form token with `csrf`.
2. Refuse the save if flash storage is unavailable.
3. Copy the current settings to a temporary `next` value. Changes are validated before replacing the live settings.
4. Read the SSID and Companion host, normalize the host to lowercase, and apply the password rules. A blank password preserves the saved password for the same SSID; an open network must be explicitly selected.
5. Parse and range-check port, button coordinates, polarity, and LED brightness. `sqpedal::validSettings()` performs the final whole-configuration validation.
6. Under the mutex, refuse changes while the pedal is pressed, a DOWN might still be held, or a network operation is in progress. Persist the new settings before making them active.
7. Increase `revision`, mark Companion disconnected, and call `pedal.lostConnection()`. This makes the network task reconnect and send a fresh UP before it can arm again.

Each failure returns an HTTP status and message without replacing the active settings. Persisting before assigning `settings = next` means a flash-write failure leaves the old live configuration in place.

## Sampling and debouncing the pedal

`samplePedal()` is a FreeRTOS task that runs about every 2 ms. It reads the pedal pin, applies the configured polarity, and passes the logical pressed state to `sqpedal::Debouncer` in `PedalState.h`. A transition must remain unchanged for `DebounceMs` (20 ms) before the debouncer reports it as stable.

When polarity changes, the task resets its debouncer and marks the connection unsynchronized. On each stable transition it calls `pedal.input(...)`, which updates the pedal state and decides whether a DOWN can be queued. The task holds the mutex only while inspecting/updating this shared state; it never performs network work.

## Resolving Companion and making HTTP requests

`resolveHost()` first checks whether the configured host is already an IP address. For a `.local` name it asks mDNS for the host (after removing the suffix); otherwise it uses the Wi-Fi DNS resolver. It returns `false` if no address can be found.

`request()` makes one HTTP operation. `Command::None` means a reachability/API probe: it sends `HEAD /api/connections`. DOWN and UP use `sqpedal::buttonPath()` from `Settings.h` and send an empty-body `POST` to the corresponding `/down` or `/up` route. The client enables connection reuse, sets connect/read timeouts, disables redirects, and closes the connection after any non-200 result.

For button POSTs, success requires both HTTP status 200 and the response body `ok`. A malformed or unexpectedly large response is treated as a failure. A 200 only means Companion accepted the HTTP event; it does not confirm that the console carried out an audio action.

## The Companion worker task

`sendPedal()` owns the reusable Wi-Fi and HTTP client objects and is the only task that sends requests. Each pass through its loop:

1. Copies the settings and revision under the mutex. A changed revision closes the old connection, clears DNS/online state, and restarts the retry timers.
2. Waits if Wi-Fi is unavailable or the Companion target is not configured. If Wi-Fi has just been lost, it marks the pedal unsynchronized and requires UP recovery.
3. Asks `pedal.next()` whether the next operation should be UP, DOWN, or no button event. An idle probe is scheduled about once per second. UP failures are retried after `RetryMs` (500 ms); DOWN is not retried.
4. Resolves the Companion host when needed. A DNS failure marks the pedal unsynchronized, records the error, and waits before trying again.
5. Rechecks `pedal.next()` after name resolution. DNS can take time, and the pedal might have been released while it was happening; this check prevents sending a stale DOWN. `pedal.starting()` records that a DOWN might now be in flight.
6. Sends the request without holding the shared-state mutex, then locks briefly to update the pedal state, connection status, and `busy` flag.

On a failed request, the cached address is discarded and the event is logged with method, URL, status/reason, and duration. Failures require UP recovery; the code explicitly does not replay DOWN. On success, the worker logs whether Companion accepted DOWN or UP. The exact transition rules live in `PedalState.h`, whose `next()`, `starting()`, and `completed()` methods are called here.

## Startup in `setup()`

`setup()` runs once after boot and prepares the hardware and services:

1. Starts Serial, configures the pedal as `INPUT_PULLUP`, and initializes the external LED pins and PWM. It turns off the onboard RGB LED.
2. Creates the shared mutex. If allocation fails, the sketch cannot safely coordinate its tasks, so it logs a fatal error and stops.
3. Configures Wi-Fi for setup access point plus station mode, disables automatic reconnect and power saving, and enables automatic band selection.
4. Builds the device's `sqpedal-...` name from the MAC address and opens the NVS preferences namespace.
5. Loads saved settings. If the stored structure has the older V1 size, `migrateSettings()` copies the old fields and supplies defaults for newer fields. Invalid or unsupported saved data is reported.
6. Keeps valid settings already stored in NVS; fresh devices retain the empty Wi-Fi defaults and can be configured through the setup access point.
7. Loads or generates the setup/admin password, generates the form token, starts the setup access point, and advertises the device through mDNS.
8. Registers the browser routes (`/`, `/status`, and POST `/settings`), starts the web server, and creates the pedal-sampling and Companion-network tasks.

The access point provides a way to configure the device even before it can join the normal Wi-Fi network. Serial prints the initial setup details and the station IP after a connection succeeds.

## The Arduino `loop()` and Wi-Fi reconnects

The Arduino framework calls `loop()` repeatedly. Here it manages the station Wi-Fi connection while the two FreeRTOS tasks handle pedal sampling and Companion HTTP:

- A changed settings `revision` disconnects the old station and resets the reconnect state. A settings save can therefore trigger a fresh Wi-Fi connection attempt.
- On connection, it logs the SSID and assigned IP and resets the retry delay.
- On a disconnect after a previous connection, it schedules a retry. Later failures use exponential backoff, capped at five minutes.
- If the first station connection attempt fails for 20 seconds, it stops retrying until settings are saved or the device restarts. The setup access point remains available.
- It avoids starting a station attempt while a client is connected to the setup access point, except when a settings change explicitly requests an attempt.
- Each pass updates the status LED, services an incoming web request with `server.handleClient()`, and delays briefly so the loop yields time to other work.

## Following a pedal press

The main event path is:

```text
GPIO read
  -> Debouncer confirms a stable transition
  -> PedalState decides whether DOWN or UP is required
  -> sendPedal resolves the host and sends HTTP
  -> PedalState records success/failure and controls re-arming
  -> loop updates the status LED and serves browser requests
```

After boot, a settings change, or a connection loss, the pedal is not immediately armed. A successful UP must synchronize the Companion button, and the pedal must be released before a new press can send DOWN. If a request may have left the remote button down, recovery sends UP; a new press is never substituted for that recovery.

## C++ details worth recognizing

- `const sqpedal::Settings&` is a read-only reference, avoiding a copy when a helper only needs to inspect settings.
- `static` variables inside a function keep their value between calls. For example, `updateStatusLed()` remembers its previous color so it only logs changes.
- `enum class Command` gives named command values (`None`, `Down`, `Up`) without placing generic names in the global namespace.
- `uint32_t(now - then)` is wraparound-safe elapsed-time arithmetic for the millisecond counter.
- `xTaskCreate()` starts FreeRTOS tasks; `vTaskDelay()` yields a task for a number of ticks. `loop()` is a separate Arduino-managed execution path.
- `String` is Arduino's dynamically sized string type. Fixed-size C character arrays are used for persisted settings and the last-event buffer.

For the configuration fields, validation, migration, and button URL format, see [Settings.h](Settings.h). For debounce timing and the press/recovery state machine, see [PedalState.h](PedalState.h). For wiring, flashing, and operational guidance, see the [Arduino project guide](../README.md).