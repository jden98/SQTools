# SQ MD Control — Companion custom module (prototype v0.3.0)

This supersedes the previous *patch-only* prototype. It uses the unofficial native SQ protocol (TCP 51326) via `@allen-heath-sq-tools/api` to patch inputs and control mutes using variable channel numbers. The original Allen & Heath Companion module is not required for MD switching once this module is validated.

**Status: prototype; tests cover the MD state machine and Companion startup/configuration IPC with a simulated console transport. The build has been verified locally, but operation against an SQ6 has not. DO NOT use in a live service until verified.**

## Companion connection setup

Importing the developer module makes it available to Companion; add an **SQ MD Control** connection in **Connections**, then open that connection's settings. The **SQ console IP** field sets the console address; the four **Initial MDInput/MDOutput** fields set the starting vocal and talk processing channels. The native protocol uses TCP port 51326.

Startup and configuration updates do not wait for the console handshake. If the console is unreachable, the connection reports an error but remains available for editing. Correct the IP address and save the settings to attempt another connection.

The upstream API requests initial console state during its handshake. The module logs when the initial snapshot is decoded; it includes mute states and channel names, **not physical input routing**. Configure the LOCAL socket for each relevant processing channel in connection settings, or use **Set processing channel LOCAL physical input mapping**. These mappings are records of console routing maintained by the operator; setting or clearing one never sends a patch command.

All 48 processing-channel mappings start unknown (blank) and are saved in Companion connection configuration. For example, if CH3 named `V_Lead` uses LOCAL socket 9, set the CH3 mapping to **9**. A blank-source MD patch then uses socket 9, not socket 3. An unknown mapping causes an explicit error without sending a patch.

**The module only patches the configured MD talk processing channels. It never patches a selected vocal channel.** Set the two MD talk channel numbers before using patch actions. Mapping changes and MD channel selections alone do not repatch anything; invoke an MD patch action after a change.

## Board channel labels

When the board sends channel names, mapping settings show labels such as **V_Lead (CH3) LOCAL socket**, and the initial MD channel selectors and action channel selectors offer **V_Lead (CH3)**. Names are display-only: stored selections still identify channels by number, so duplicate names and console renames do not move assignments or mappings.

Action channel selectors allow custom values: existing numeric values and Companion variable expressions remain supported. Enter a number or expression such as `$(custom:SelectedVocal)` as a custom value; raw board-name strings are not channel identifiers.

Without board names, labels and name variables fall back to **CH1** ... **CH48**. Names are read again on each connection attempt and are not saved as routing configuration. While disconnected after a connection loss, the last received names may still be displayed until the next connection attempt. Action choices and name variables refresh when the API reports name changes. Reopen connection settings after the snapshot arrives or after a rename to load updated configuration labels.

## Module variables

The module publishes `$(sq-md-control:MDInput1)`, `MDOutput1`, `MDInput2`, `MDOutput2`, `MD1Active`, `MD2Active`, `last_action`, and `connection_status` (replace `sq-md-control` with the connection's actual Companion label). These are **module variables**, not Companion's `$(custom:...)` variables. Assignment buttons call the actions below; the module owns the state. Initial values are configurable on the connection: MD1 input 3, talk 47; MD2 input 2, talk 48.

Physical-input variables (LOCAL socket numbers, or blank when unknown):

| Variable | Meaning |
| --- | --- |
| `InputPhysical1` ... `InputPhysical48` | Operator-maintained LOCAL source for each logical processing channel. |
| `MDSource1`, `MDSource2` | LOCAL source mapped to the currently selected vocal processing channel. Follows vocal selection and mapping edits. |
| `MDPhysicalInput1`, `MDPhysicalInput2` | LOCAL source recorded for the configured MD talk processing channel. Updated after a patch is sent successfully, or by manually recording that channel's mapping. |

For example, `$(sq-md-control:InputPhysical3)` and `$(sq-md-control:MDSource1)` can both be **9**, while `$(sq-md-control:MDInput1)` remains **3** and `$(sq-md-control:MDOutput1)` remains **47**. After patching MD1, `MDPhysicalInput1` and `InputPhysical47` are **9**.

These are not console readback. Saved MD talk mappings describe operator configuration or the last command sent, not a confirmed patch. Changing a vocal mapping does not change an MD talk mapping until you repatch. Explicit source overrides apply to that MD patch only; they do not rewrite the recorded vocal mapping.

Channel-name variables for button text:

| Variable | Meaning |
| --- | --- |
| `InputName1` ... `InputName48` | Board name of each processing channel, or CH# fallback. |
| `MDInputName1`, `MDInputName2` | Name of the selected vocal processing channel. |
| `MDOutputName1`, `MDOutputName2` | Name of the configured MD talk processing channel. |

For example, use `$(sq-md-control:MDInputName1)` as the text on an MD1 selection/status button. Numeric channel variables retain their existing meaning.

## Actions

**Preferred one-step assignment:** `Assign MD input AND patch LOCAL source` selects the vocal processing channel and sends its mapped LOCAL socket to the currently configured MD talk channel in one Companion action. Leave the optional LOCAL socket field blank to use the stored vocal mapping, or enter an explicit socket/variable to override it. While connected, the selection and MD talk mapping are committed only after the patch command has been sent without a local error; the console does not provide patch acknowledgment.

While disconnected, this action updates the vocal selection (and selection-button feedback) even if its physical mapping is unknown, but logs **PATCH NOT SENT** and leaves the recorded MD talk mapping unchanged. It does not queue a patch or replay it on reconnect. Select the channel again or run **Patch LOCAL source to assigned MD talk channel** after connecting. A highlight indicates selection, not confirmed console routing.


1. **Assign MD input AND patch LOCAL source** — combined assignment and patch (recommended).
2. **Set MD input processing channel** — MD1/MD2 and channel `1..48`, optionally an expression such as `$(custom:SelectedVocal)`.
3. **Set MD talk processing channel** — MD1/MD2 and channel `1..48`.
4. **Patch LOCAL source to assigned MD talk channel** — MD1/MD2, optionally an explicit physical socket. If blank, uses the stored mapping for the selected vocal processing channel. Uses `setInputPatch(0x01, socket-1, talkChannel-1)` and records the MD destination mapping after sending.
5. **MD pedal DOWN** — captures actual last-known input mute state, mutes vocal, unmutes talk.
6. **MD pedal UP** — mutes talk first, then unmutes vocal **only if it was unmuted before pedal DOWN**.
7. **Set arbitrary SQ input mute** — variable-capable channel field and absolute Mute/Unmute.
8. **Set processing channel LOCAL physical input mapping** — channel `1..48` and LOCAL socket number, both variable-capable. Blank socket clears the mapping to unknown. Saves configuration and updates variables; **does not patch the console**. You can configure vocal or MD talk channel mappings this way even while disconnected. Edits affecting a held MD pedal's vocal/talk channel are rejected.
9. **MD pedal PRESS (activate; release if already active)** — runs DOWN when inactive, or UP when active. Use this on a shared pedal/FOH button so the FOH operator can force Release while a pedal is held. Keep **MD pedal UP** on button release. The later pedal UP closes talk again without restoring the vocal a second time.

## Example setup

- Record existing vocal routing: `Set processing channel LOCAL physical input mapping (CH3, LOCAL 9)` for V-Lead, and `(CH2, LOCAL 8)` for V-Piano. These actions do not change console routing.
- Configure MD1 talk CH47 and MD2 talk CH48 using connection defaults or **Set MD talk processing channel**.
- MD1 V-Lead selection button: `Assign MD input AND patch LOCAL source (MD1, 3, blank)` sends LOCAL 9 to CH47 only.
- MD2 V-Piano selection button: `Assign MD input AND patch LOCAL source (MD2, 2, blank)` sends LOCAL 8 to CH48 only.
- MD1 footswitch Companion button: **Press** `MD pedal PRESS (MD1)`; **Release** `MD pedal UP (MD1)`.
- MD2 footswitch Companion button: analogous actions for MD2.
- For persistent red MD-state feedback, use Companion's internal expression feedback `$(SQ_MD:MD1Active) == 1` (MD2 analogously; replace `SQ_MD` with your connection label), not **Button: When pushed**. Display **MD ACTIVE** while true. This follows the module's saved MD state, not physical pedal position or acknowledged console mute state. After an FOH override, talk stays closed until a new press; do not repeatedly send press requests while a pedal remains down. Unlike the original idempotent DOWN action, a duplicate PRESS request releases an active MD.
- The footswitch Wi-Fi bridge must deliver both DOWN and UP; a watchdog is strongly recommended to synthesize UP if a pedal or network link is lost.

**Ordering:** Companion action execution order matters. The module's own DOWN/UP actions perform the mute commands in the specified order without external If trees. Use the combined assignment action to avoid needing a sequential action group. You can also manually patch using the separate action after assignments.

## Safety and limitations

- Only SQ input processing channels 1..48 are supported. This is intentionally independent of the five current vocal stations.
- `MDInput` is the **SQ input processing channel** that gets muted, not a socket number. LOCAL source mappings are operator-maintained; there is no channel-number fallback or automatic routing discovery. Use only LOCAL sockets physically present on your console; SLink, USB, and I/O-port sources are not supported by these mappings.
- The library's `.muted` property is null until a state update arrives; DOWN fails closed if unknown. A successful connect alone does not guarantee that the state snapshot has arrived.
- The library's `setMute` optimistically updates its local state; command ordering is guaranteed only within the local action invocation, not by an acknowledgment from the console.
- Input patch commands have **no readback/acknowledgment**; validate on the SQ6 I/O screen and with audio.
- No automatic patch replay on reconnect. Do a patch setup before service.
- Disconnects discard saved pedal states; after reconnect, send UP (talk mute) before using pedals. The module will **not automatically unmute a vocal** whose pre-disconnect state is uncertain.
- FOH mute changes **while the pedal is held** cannot be distinguished from the module's own mute. The previous state is restored, which matches the existing system's semantics; FOH must not rely on changing the vocal mute during a held pedal.
- Do not select the same vocal for both MDs or use the same talk output for both. This is a setup policy, not a fully enforced validation. The controller rejects conflicting *simultaneously active* assignments.
- On errors after DOWN begins, the module attempts to re-mute talk, but cannot guarantee remote delivery after a network failure.

## Wi-Fi pedal hardware

The [Arduino pedal project](arduino/README.md) contains a standard ESP32-C5 sketch for one Alesis sustain pedal per board, browser-based Wi-Fi/Companion settings, and debounced HTTP DOWN/UP delivery. Its documentation covers Arduino IDE setup, wiring, recovery behavior and hardware validation.

## Build

Requires Node.js >=20 and access to npm. Run `npm install`, `npm test`, `npm run build` from this directory. Configure Companion 5.1's developer module path using its documented local-module workflow. The package's runtime compatibility and publication availability have **not** been verified in this environment. The source is supplied to enable local builds and integration testing, not as an install-ready module.

## Upstream

- https://github.com/hrueger/allen-heath-sq-tools
- `SQMixer.inputs[n].setMute(boolean)` and `.muted`
- `SQMixer.setInputPatch(source, sourceChannel, destB3)`

This module is unofficial and is not endorsed by Allen & Heath or Bitfocus.

## Build on Windows (PowerShell)

1. Install Node.js 22 LTS or later and verify `node --version` and `npm --version`.
2. Extract this ZIP to a local folder, open PowerShell in that folder.
3. Run `npm install`, then `npm test`, then `npm run build`.
4. If the build succeeds, follow the **Companion 5.1 developer/local module** loading instructions for your installation; do not assume copying the source ZIP into Companion is sufficient.
5. Verify the action in Companion and test a noncritical patch while the console is offline from the live mix.

The local build and simulated startup tests do not verify network access, firmware-specific snapshot decoding, or audio routing on a real console. Validate these with the SQ6 before deploying.
