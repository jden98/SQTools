# SQ MD Control — Companion custom module (prototype v0.3.0)

This supersedes the previous *patch-only* prototype. It uses the unofficial native SQ protocol (TCP 51326) via `@allen-heath-sq-tools/api` to patch inputs and control mutes using variable channel numbers. The original Allen & Heath Companion module is not required for MD switching once this module is validated.

**Status: source prototype; tests validate only the pure state machine. It has not been built against an installed Companion, nor tested against an SQ6. DO NOT use in a live service until verified.**

## Module variables

The module publishes `$(sq-md-control:MDInput1)`, `MDOutput1`, `MDInput2`, `MDOutput2`, `MD1Active`, `MD2Active`, `last_action`, and `connection_status` (replace `sq-md-control` with the connection's actual Companion label). These are **module variables**, not Companion's `$(custom:...)` variables. Assignment buttons call the actions below; the module owns the state. Initial values are configurable on the connection: MD1 input 3, talk 47; MD2 input 2, talk 48.

## Actions

**Preferred one-step assignment:** `Assign MD input AND patch LOCAL source` selects the vocal processing channel and sends the LOCAL socket patch to the currently configured talk channel in one Companion action. Its optional LOCAL socket field defaults to the vocal channel number. The assignment is committed only after the patch command has been sent without a local error; the console does not provide patch acknowledgment.


1. **Assign MD input AND patch LOCAL source** — combined assignment and patch (recommended).
2. **Set MD input processing channel** — MD1/MD2 and channel `1..48`, optionally an expression such as `$(custom:SelectedVocal)`.
3. **Set MD talk processing channel** — MD1/MD2 and channel `1..48`.
4. **Patch LOCAL source to assigned MD talk channel** — MD1/MD2, optionally an explicit physical socket. If blank, assumes LOCAL socket number equals selected input channel number. Uses `setInputPatch(0x01, socket-1, talkChannel-1)`.
5. **MD pedal DOWN** — captures actual last-known input mute state, mutes vocal, unmutes talk.
6. **MD pedal UP** — mutes talk first, then unmutes vocal **only if it was unmuted before pedal DOWN**.
7. **Set arbitrary SQ input mute** — variable-capable channel field and absolute Mute/Unmute.

## Example setup

- MD1 V-Lead selection button: `Assign MD input AND patch LOCAL source (MD1, 3, blank)`.
- MD2 V-Piano selection button: `Assign MD input AND patch LOCAL source (MD2, 2, blank)`.
- MD1 footswitch Companion button: **Press** `MD pedal DOWN (MD1)`; **Release** `MD pedal UP (MD1)`.
- MD2 footswitch Companion button: analogous actions for MD2.
- The footswitch Wi-Fi bridge must deliver both DOWN and UP; a watchdog is strongly recommended to synthesize UP if a pedal or network link is lost.

**Ordering:** Companion action execution order matters. The module's own DOWN/UP actions perform the mute commands in the specified order without external If trees. Use the combined assignment action to avoid needing a sequential action group. You can also manually patch using the separate action after assignments.

## Safety and limitations

- Only SQ input processing channels 1..48 are supported. This is intentionally independent of the five current vocal stations.
- `MDInput` is the **SQ input processing channel** that gets muted. The LOCAL source socket is assumed to have the same number unless explicitly specified in the Patch action.
- The library's `.muted` property is null until a state update arrives; DOWN fails closed if unknown. A successful connect alone does not guarantee that the state snapshot has arrived.
- The library's `setMute` optimistically updates its local state; command ordering is guaranteed only within the local action invocation, not by an acknowledgment from the console.
- Input patch commands have **no readback/acknowledgment**; validate on the SQ6 I/O screen and with audio.
- No automatic patch replay on reconnect. Do a patch setup before service.
- Disconnects discard saved pedal states; after reconnect, send UP (talk mute) before using pedals. The module will **not automatically unmute a vocal** whose pre-disconnect state is uncertain.
- FOH mute changes **while the pedal is held** cannot be distinguished from the module's own mute. The previous state is restored, which matches the existing system's semantics; FOH must not rely on changing the vocal mute during a held pedal.
- Do not select the same vocal for both MDs or use the same talk output for both. This is a setup policy, not a fully enforced validation. The controller rejects conflicting *simultaneously active* assignments.
- On errors after DOWN begins, the module attempts to re-mute talk, but cannot guarantee remote delivery after a network failure.

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

The build was not verified in the authoring environment because npm dependency installation timed out. Check that the upstream API package and its constructor/method signatures are compatible before deploying.
