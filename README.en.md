# dsh-ding

**Turn-end chime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** When a conversation turn finishes, play a short sound — so you can look away while a long task runs and still know the moment it's done.

Sounds are synthesised in the browser: seven presets (water drop, stone plop, bell, chime, blip), adjustable volume, a global switch, and a live preview. No audio files, no network, no build step, no runtime dependencies.

> Where it lives: **Settings → General → turn-end chime**.
> After installing, click once anywhere in the window to unlock audio; every turn then rings.

[中文说明](README.md)

---

## Quick start

```bash
# install into the local profile (replace the path with your checkout)
dsh plugin --profile desktop install link:<absolute path to this checkout>

# or use the plugin manager UI with the spec:
link:<absolute path to this checkout>
```

Restart the desktop app once, then send a message. To confirm it is live:

```js
__DSH_DING__.version    // "0.6.2"
__DSH_DING__.ring()     // ring once to verify the audio path
```

Too loud? Switch preset or turn it off in Settings. Nothing audible? See the
[diagnostics](#diagnostics) table.

## Features

- **Rings when a turn ends** — a session going from *running* to *idle* plays one sound.
  - Watches **every** session, so a turn that finishes while you are looking at another conversation still rings.
  - Subagent sessions are excluded: they are short and numerous, and ringing for them is noise.
  - Taking the baseline on entry means opening the page does not fire a spurious ring.
  - The same idle state published twice only rings once.
- **Seven presets**, default `droplet`:

  | id | sound | character |
  |---|---|---|
  | `droplet` | 水滴落水 · 叮咚 | 900→1650 Hz, glide in 40 ms, then a small "dong" on the water surface |
  | `waterdrop` | 水滴 · 清脆 | 620→1500 Hz, glide in 30 ms, clean 90 ms |
  | `waterdrop2` | 水泡 · 圆润 | 300→700 Hz, slower glide, longer tail |
  | `plop` | 石头落水 · 咕咚 | 280→115 Hz, **downward** glide, low body |
  | `ding` | 叮 · 双音铃 | two-note bell |
  | `chime` | 铃 · 三连音 | three-note chime |
  | `blip` | 哒 · 短促 | single short blip |

- **Volume 0–100%**, default 60%.
- **Global switch** — off means no audio path is touched at all.
- **Settings live in Settings → General**: enable, sound, volume, preview.

Each preset is a recipe of *tones* and *noise bursts*. Pitch follows an exponential glide;
amplitude is `(1−e^(−t/attack))·e^(−t/tau)`. WebAudio plays exactly that curve via
`setValueCurveAtTime`; without WebAudio the same recipe is rendered to a WAV data URI and
played through an `<audio>` element, so both paths sound the same.

## Install

Install from the local directory with the plugin manager:

```
link:<absolute path to this directory>
```

or on the command line (from the profile directory):

```
dsh plugin --profile desktop install link:<absolute path to this directory>
```

The plugin manager records `dsh-ding` in the profile's `dependencies` and
`dsh.profile.bundles`, and adds one Loader row to `cordis.patch.yml`.
Restart the desktop app once, or refresh the web page.

## Use

1. Open **Settings** (`Ctrl+Alt+,` or the account menu) → **General**.
2. Find the *turn-end chime* row and set:
   - enable / disable,
   - sound preset,
   - volume,
   - **Preview** to hear it immediately.
3. Send a message; the sound plays when that turn finishes.

Preferences are stored in the browser's `localStorage` under `dsh-ding:settings`:

```json
{ "v": 2, "enabled": true, "sound": "droplet", "volume": 0.6 }
```

Malformed data (truncated JSON, out-of-range volume, unknown preset) silently falls back to
defaults instead of blanking the settings page.

## Why preferences live in `localStorage`

Deliberately not in Host settings. That avoids depending on the `schemastery` schema, so a
DSH upgrade or a profile switch cannot break the plugin through schema drift. The trade-off is
that preferences are per browser rather than per profile — acceptable for a sound toggle.

## Diagnostics

The page exposes a read-only handle:

```js
__DSH_DING__.version      // "0.6.2"
__DSH_DING__.watching     // true when the turn-end watcher is installed
__DSH_DING__.watched      // how many sessions are currently watched
__DSH_DING__.rings        // how many times it has rung
__DSH_DING__.lastSession  // the session whose turn end was rung
__DSH_DING__.lastPath     // "webaudio" | "fallback"
__DSH_DING__.trace        // last 40 detection → playback steps
__DSH_DING__.problems     // degradation log
__DSH_DING__.audio()      // { unlocked, state, hasFallback }
__DSH_DING__.settings()   // current preferences
__DSH_DING__.ring()       // ring once, to verify the audio path
__DSH_DING__.unlock()     // unlock audio without a click
__DSH_DING__.render(id)   // render a preset to a WAV data URI
__DSH_DING__.sounds()     // preset ids
```

If it stays silent:

| symptom | meaning |
|---|---|
| `__DSH_DING__` is `undefined` | plugin not active (`inject` name changed, or not installed) |
| `watched` is `0` | no session list yet — the watcher has nothing to attach to |
| `rings` does not grow | no `running → idle` transition was observed; check `trace` for `turn-end` |
| `rings` grows but no sound | audio blocked; check `trace` for `skip` / timings, and `problems` |

## Hearing two sounds?

First decide whether one ring fired twice, or **two plugins each rang**. If `rings` only
incremented once but you heard two sounds, another plugin is playing too. This probe records
every audio start in a turn together with its call stack:

```bash
node tests/audio_sources_probe.mjs http://127.0.0.1:PORT <secretBase64Url>
```

The output names the file on the stack:

```
+ 4300ms  oscillator   at scheduleScore (...plugins/.../client.js)     ← dsh-ding
+ 4301ms  buffer       at scheduleScore (...)                          ← dsh-ding
+ 4353ms  buffer       at beginWithBuffer (/dsh-whale/widget.js:268)   ← another plugin
```

The known conflict is **`dsh-whale-widget`**. Its main job is checking the official balance;
the per-turn cost notice is a side feature that polls `/dsh-whale/last-turn.json` and plays a
`taskEnd` sound on every new turn — on by default.

The two sounds are **independent, not a bug**. Keep whichever you want:

```bash
# silence whale, keep dsh-ding's water drop
node scripts/whale-usage-settings.mjs http://127.0.0.1:PORT <secretBase64Url> --set-task-end off

# restore whale's sound
node scripts/whale-usage-settings.mjs http://127.0.0.1:PORT <secretBase64Url> --set-task-end on
```

Or change it in its own panel: **whale → global sound settings → per-turn cost notice**.

⚠️ **Reload the page (`F5`) afterwards.** whale reads its settings once, at load time
(`loadUsageSettings()` is wired into the startup chain only). Changing the server value without
reloading leaves it ringing with the old value. Verified in three stages
(`tests/whale_reload_probe.mjs`):

```
① loaded with on  → one turn: whale played 1
② turned off + reload → one turn: whale played 0
③ turned back on, no reload → one turn: whale played 0   ← it does not re-read
```

## How the turn-end detection works

| item | behaviour |
|---|---|
| what is watched | every session in `ctx.sessions.list`; watchers are added/removed as the list changes |
| what is skipped | sessions with `origin === "subagent"` |
| data sources | each session's `SessionBinding.session` subscription **and** the `uiSession.sessionStatus` aggregate map — two independent paths |
| baseline | each path keeps **its own** previous `running` value, so neither overwrites the other |
| de-duplication | same session rings at most once per 700 ms; observing `running: true` again clears the mark |
| `sessionStatus` reshaped | degrades to the binding path only, instead of disabling the watcher |

Two failure modes shaped this design, and both are pinned by tests:

1. The aggregate map alone can skip a `true → false` transition under some orderings.
2. Watching only the *current* session silently drops a turn that finishes while you are
   looking at another conversation.

## Audio and autoplay policy

Browsers only allow `AudioContext.resume()` and a first `play()` inside a real user gesture, and
a turn end is an async callback outside any gesture. So the plugin installs a one-shot
`pointerdown` / `keydown` / `touchstart` listener and unlocks both paths inside the first real
gesture, then removes the listener.

Chrome can leave `AudioContext` suspended after device switches, long idle periods, or sleep
resume, and `resume()` may then return a promise that **never settles**. `ring()` therefore
never waits on it: it gives `resume()` at most `RESUME_TIMEOUT_MS = 120 ms` and falls back to
`<audio>` immediately. Both channels are tried; a rejected playback is logged in `problems`
rather than swallowed.

## When code changes take effect

| change | action |
|---|---|
| `lib/client.js` only | nothing — HMR pushes the new bundle within a second |
| `package.json` `dsh.client` / `exports` | reload the page (`F5` / `Ctrl+R`) |
| install / uninstall, `cordis.patch.yml` | restart the app |

The desktop production build has no *Reload* menu item (`reloadPageMenu` is registered only in
the development branch), but Chromium's keyboard reload still works: `F5`, `Ctrl+R` and
`Ctrl+F5` reload; `Ctrl+Shift+R` is blocked. Reloading only reloads the page document — the
Host process keeps running, so sessions and in-flight tasks survive.

## Releasing

Tag-driven, verified before it publishes (`.github/workflows/release.yml`):

1. Bump `version` in `package.json` and the `version` string on the diagnostics face in
   `lib/client.js` — `tests/manifest_selftest.mjs` fails if the two disagree.
2. Write the release body to `docs/release-notes.md`. Use `<!--ASSETS-->` where the asset list
   goes; the script substitutes the real filename, byte size and SHA-256 into both language
   sections, so no digest is ever hand-copied.
3. `git tag -a v<version> -m "..."` and push the tag.
4. CI runs `manifest`, `client`, `audio_stall` and `sound_spectrum`, packs the tarball, then
   publishes. The release is created as a **draft** and only flipped to public after the asset
   upload succeeds, so a failed run never leaves a half-published version.

To publish by hand:

```bash
npm pack --pack-destination .
GITHUB_TOKEN=... node scripts/publish-release.mjs \
  --tag v0.6.2 --notes docs/release-notes.md --assets dsh-ding-0.6.2.tgz
```

## Layout

| file | role |
|---|---|
| [`lib/client.js`](lib/client.js) | everything: the turn-end watcher, the settings row, the `VOICES` recipes and synthesis |
| [`lib/index.js`](lib/index.js) | Node half — an empty `apply`, so the Loader has a mountable Host row |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle layer: inserts this package as one Loader row |
| [`docs/`](docs/) | offline-rendered WAV of every preset, plus notes |

## Tests

Nine layers, cheapest first, all runnable from this repository:

```bash
# 0. package shape: manifest fields, exports, bundle wrapper, version, patch — no browser
node tests/manifest_selftest.mjs

# 1. the bundle itself: loader wrapper, slot registration, turn-end detection,
#    fallback path, unlock path, disposal — pure Node, no browser
node tests/client_selftest.mjs

# 2. a hanging resume() must not silence the ring
node tests/audio_stall_selftest.mjs

# 3. acoustic check of every preset (renders to WAV and analyses it)
node tests/sound_spectrum_selftest.mjs docs

# 4. the running Host: the boot graph has dsh-ding and serves the bundle
node tests/host_probe.mjs http://127.0.0.1:PORT <secretBase64Url>

# 5. a real page: materialised bundle, settings row, persisted toggle, clean ring path
node tests/browser_probe.mjs http://127.0.0.1:PORT <secretBase64Url>

# 6. end to end: send a message, let the turn finish, watch the ring
node tests/live_turn_probe.mjs http://127.0.0.1:PORT <secretBase64Url>

# 7. three turns in a row — it must ring every time
node tests/multi_turn_probe.mjs http://127.0.0.1:PORT <secretBase64Url> 3

# 8. a turn that finishes while you look elsewhere must still ring
node tests/background_turn_probe.mjs http://127.0.0.1:PORT <secretBase64Url>
```

`<secretBase64Url>` is the `secret` of `client-connection/browser-session` in
`~/.dsh/.credentials.yaml`. The browser probes drive a local Chromium-based browser over CDP;
the executable is resolved from `CHROME_PATH` or an argument, never hard-coded.

Layer 2 output:

```
ok    suspended + hanging resume still produced audio (fallback plays: 1, webaudio notes: 0)
ok    running context uses WebAudio (2 notes, 0 fallback)
ok    rejected playback is recorded: resume did not take: timed out after 120ms | fallback playback rejected: NotAllowedError
OK  audio stall handling: hanging resume never silences the ring
```

Layer 7 output:

```
round 1: rings 0 → 1 (delta 1)  audio {"unlocked":true,"state":"running","hasFallback":true}
round 2: rings 1 → 2 (delta 1)  audio {"unlocked":true,"state":"running","hasFallback":true}
round 3: rings 2 → 3 (delta 1)  audio {"unlocked":true,"state":"running","hasFallback":true}

3/3 rounds rang
```

## Compatibility

Built against DSH `0.2.2-rc.1` on Windows. It depends only on four host surfaces:
`ctx.slots.inject` / `ctx.slots.register`, `ctx.uiSession.current`,
`ctx.uiSession.sessionStatus` and `ctx.sessions.binding` / `ctx.sessions.list`. Each of them is
guarded: if one changes shape, that part degrades and the rest keeps working, and the reason is
recorded in `__DSH_DING__.problems`.

## Scope

- Rings for the current and background sessions; never for subagents.
- Reads no conversation content, opens no network connection, writes no Host settings, and
  contributes nothing the model can see.

## License

MIT — see [LICENSE](LICENSE).
