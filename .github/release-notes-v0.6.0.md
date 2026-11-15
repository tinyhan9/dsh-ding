## dsh-ding 0.6.0

Turn-end chime for DeepSeek Harness — plays a short synthesised sound when a conversation turn finishes.

### Highlights

- **Seven presets**, default `droplet` (water drop landing). `plop` is a low, downward-gliding stone dropping into water.
- **Volume 0–100%, global switch, live preview** — settings row inside *Settings → General*.
- **No audio files.** Every sound is a recipe of tones and filtered noise bursts, synthesised at play time.
- **Zero runtime dependencies.** No build step, no bundler, no network.

### Detection fixes in this release

Two separate failure modes shaped the turn-end watcher, and both are pinned by tests:

| symptom | cause | fix |
|---|---|---|
| occasionally silent | the aggregate `sessionStatus` map can skip a `true → false` transition under some orderings | a second, independent path reads each session's `SessionBinding.session` |
| silent after switching sessions | watching only the *current* session drops a turn that finishes while you look elsewhere | every session in `ctx.sessions.list` is watched; subagents are excluded |

Also fixed: each path keeps **its own** previous `running` value (sharing one map let the binding baseline erase a `true` the aggregate map had already seen), and `sessionStatus` changing shape now degrades to the binding path only instead of disabling the watcher.

### Audio robustness

Chrome can leave an `AudioContext` suspended after device switches, long idle periods or sleep
resume, and `resume()` may then return a promise that **never settles**. `ring()` never waits on
it: `resume()` gets at most 120 ms, after which playback falls back to an `<audio>` element.
A rejected playback is recorded in `__DSH_DING__.problems` rather than swallowed.

### Install

```
link:<absolute path to this checkout>
```

or, from the DSH profile directory:

```
dsh plugin --profile desktop install link:<absolute path to this checkout>
```

Restart the desktop app once, then open **Settings → General** to pick a sound.

### Verifying it works

```js
__DSH_DING__.version      // "0.6.0"
__DSH_DING__.watching     // true when the watcher is installed
__DSH_DING__.watched      // how many sessions are watched (> 0 once a session exists)
__DSH_DING__.ring()       // ring once to check the audio path
__DSH_DING__.trace        // last 40 detection → playback steps
```

### Assets

- `dsh-ding-0.6.0.tgz` — npm-style tarball of the installable package, tests included
  SHA-256 `2bbb5191071fafa8aaa429806db3d491dcbc8720785437bda30591c1fe01e76e` (175070 bytes, 27 files)

Unpack and run the offline suites straight from it:

```bash
tar -xzf dsh-ding-0.6.0.tgz
cd package
node tests/client_selftest.mjs
node tests/audio_stall_selftest.mjs
node tests/sound_spectrum_selftest.mjs .
```

### Compatibility

Built against DSH `0.2.2-rc.1` on Windows. Depends only on `ctx.slots.inject` / `ctx.slots.register`,
`ctx.uiSession.current`, `ctx.uiSession.sessionStatus` and `ctx.sessions.binding` / `ctx.sessions.list`;
each is shape-checked so a change degrades that part alone.

**Full Changelog**: https://github.com/tinyhan9/dsh-ding/commits/v0.6.0
