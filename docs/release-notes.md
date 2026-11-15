# dsh-ding 0.6.0

DeepSeek Harness 的轮次结束提示音：一轮对话跑完时播一声。

Turn-end chime for DeepSeek Harness — plays a short synthesised sound when a conversation turn finishes.

---

## 中文说明

### 这个版本带来什么

- **七种音色**，默认 `droplet`（水滴落水 · 叮咚）。`plop` 是石头落水的低频「咕咚」，音高**下行**。
- **音量 0–100%、总开关、即时试听** —— 设置项在 设置 → 通用设置。
- **不带音频文件**。每个声音都是「音符 + 带通噪声段」的配方，播放时现场合成。
- **零运行期依赖**。没有构建步骤、没有打包器、不联网。

### 本版修掉的两个「不响」

两轮真实故障塑造了现在的判定逻辑，都被测试固定住了：

| 现象 | 原因 | 修法 |
|---|---|---|
| 偶尔不响 | 聚合的 `sessionStatus` 表在某些时序下会整段跳过一次 `true → false` | 增加第二条独立路径，直接订阅每个会话的 `SessionBinding.session` |
| 切到别的会话后不响 | 早期只盯「当前会话」，你在别处看内容时那一轮就没人看着 | 改为盯 `ctx.sessions.list` 里的**每一个**会话，只排除子代理 |

另外修掉：两条路径各自保存上一拍 `running`（共用一份时，binding 的初始快照会擦掉聚合表已经看到的 `true`），以及 `sessionStatus` 形状变化时只降级到 binding 单路，而不是把整块监听停掉。

### 音频可靠性

Chrome 在设备切换、长时间闲置、系统休眠恢复之后会把 `AudioContext` 挂起，此时 `resume()`
返回的 promise **可能永远不 resolve**。`ring()` 不等它：最多给 120ms，超时立刻回落到
`<audio>` 元素。被拒的播放会写进 `__DSH_DING__.problems`，不再静默吞掉。

### 安装

    link:<本目录绝对路径>

或在 DSH 的 profile 目录下：

    dsh plugin --profile desktop install link:<本目录绝对路径>

桌面端重启一次，然后打开 **设置 → 通用设置** 选音色。

### 验证是否生效

```js
__DSH_DING__.version      // "0.6.0"
__DSH_DING__.watching     // 轮次监听是否装上
__DSH_DING__.watched      // 正在盯几个会话（有会话时应 > 0）
__DSH_DING__.ring()       // 手动响一次，验证音频链路
__DSH_DING__.trace        // 最近 40 条「判定 → 出声」流水
```

### 资产

<!--ASSETS-->

解包即可自己跑离线测试：

    tar -xzf dsh-ding-0.6.0.tgz
    cd package
    node tests/manifest_selftest.mjs
    node tests/client_selftest.mjs
    node tests/audio_stall_selftest.mjs
    node tests/sound_spectrum_selftest.mjs .

### 兼容性

对着 DSH `0.2.2-rc.1`、Windows 开发。只依赖四个宿主面：`ctx.slots.inject` / `ctx.slots.register`、
`ctx.uiSession.current`、`ctx.uiSession.sessionStatus`、`ctx.sessions.binding` / `ctx.sessions.list`。
每一处都做了形状校验，哪块变了就只降级那一块，原因写进 `problems`。

---

## English

### What's in this release

- **Seven presets**, default `droplet` (water drop landing). `plop` is a low, downward-gliding stone dropping into water.
- **Volume 0–100%, a global switch, live preview** — the settings row lives in *Settings → General*.
- **No audio files.** Every sound is a recipe of tones and band-passed noise bursts, synthesised at play time.
- **Zero runtime dependencies.** No build step, no bundler, no network.

### Two detection bugs fixed

| symptom | cause | fix |
|---|---|---|
| occasionally silent | the aggregate `sessionStatus` map can skip a `true → false` transition under some orderings | a second, independent path subscribes to each session's `SessionBinding.session` |
| silent after switching sessions | watching only the *current* session drops a turn that finishes while you look elsewhere | every session in `ctx.sessions.list` is watched; subagents are excluded |

Also fixed: each path keeps **its own** previous `running` value (sharing one map let the
binding baseline erase a `true` the aggregate map had already seen), and a reshaped
`sessionStatus` now degrades to the binding path only instead of disabling the watcher.

### Audio robustness

Chrome can leave an `AudioContext` suspended after device switches, long idle periods or sleep
resume, and `resume()` may then return a promise that **never settles**. `ring()` never waits on
it: `resume()` gets at most 120 ms, after which playback falls back to an `<audio>` element.
A rejected playback is recorded in `__DSH_DING__.problems` rather than swallowed.

### Install

    link:<absolute path to this checkout>

or, from the DSH profile directory:

    dsh plugin --profile desktop install link:<absolute path to this checkout>

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

<!--ASSETS-->

Unpack and run the offline suites straight from it:

    tar -xzf dsh-ding-0.6.0.tgz
    cd package
    node tests/manifest_selftest.mjs
    node tests/client_selftest.mjs
    node tests/audio_stall_selftest.mjs
    node tests/sound_spectrum_selftest.mjs .

### Compatibility

Built against DSH `0.2.2-rc.1` on Windows. Depends only on `ctx.slots.inject` / `ctx.slots.register`,
`ctx.uiSession.current`, `ctx.uiSession.sessionStatus` and `ctx.sessions.binding` / `ctx.sessions.list`;
each is shape-checked so a change degrades that part alone.

---

**Full Changelog**: https://github.com/tinyhan9/dsh-ding/commits/v0.6.0
