# dsh-ding 0.6.2

> 这个版本**没有改插件本身的行为**：音色、判定逻辑、音频路径与 0.6.1 完全一致。
> 新增的是「排查两个插件同时响」的工具，以及把这两个工具一起打进了发布包。
>
> **No behaviour change.** Same presets, same detection, same audio paths as 0.6.1. What is new:
> a tool that finds out which plugin is making a sound, and both tools are now shipped inside
> the tarball instead of living only in the repository.

---

## 中文说明

### 这次加了什么

一轮结束时你听到两声，而 `__DSH_DING__.rings` 只涨了 1 —— 这说明**另一个插件也在放音**。
以前只能靠猜，现在能直接抓出来：

```bash
node tests/audio_sources_probe.mjs http://127.0.0.1:PORT <secretBase64Url>
```

它 hook 住页面里所有音频起播点（`HTMLMediaElement.play` / `AudioBufferSource.start` /
`OscillatorNode.start`），每一条都带调用栈：

```
+ 4578ms  oscillator   at scheduleScore (...plugins/.../client.js)     ← dsh-ding
+ 4578ms  buffer       at scheduleScore (...)                          ← dsh-ding
+ 4970ms  buffer       at beginWithBuffer (/dsh-whale/widget.js:268)   ← 另一个插件
```

另外两个配套脚本：

| 脚本 | 作用 |
|---|---|
| `tests/double_ring_probe.mjs` | 只看 dsh-ding 自己的流水，区分「同一会话响两次」与「两个会话各一次」 |
| `scripts/whale-usage-settings.mjs` | 读写 `dsh-whale-widget` 的任务结束音开关，不用手改内部 JSON |
| `scripts/clean-whale-ledger.mjs` | 清掉账本里没人读的残留键（排查时误加的） |

### 一个值得知道的上游行为

`dsh-whale-widget` 的设置**只在页面加载时读一次**。服务端改了而页面不刷新，它会继续按旧值响。
三段对照实测（`tests/whale_reload_probe.mjs`）：

```
① 页面加载时 taskEnd=on   → 跑一轮：whale 播放 1 次
② 服务端改 off + 刷新页面 → 跑一轮：whale 播放 0 次
③ 服务端改回 on，不刷新   → 跑一轮：whale 播放 0 次   ← 证明它不重读
```

所以改完 whale 的开关，**记得按 F5**。

### 两声不是 bug

`dsh-whale-widget` 主要用来查官方余额，每轮消耗提示是附带功能，出厂默认开。
两声是各自独立的事件音，留哪个都可以：

```bash
# 关掉 whale 那一声
node scripts/whale-usage-settings.mjs http://127.0.0.1:PORT <secretBase64Url> --set-task-end off

# 恢复
node scripts/whale-usage-settings.mjs http://127.0.0.1:PORT <secretBase64Url> --set-task-end on
```

也可以在它自己的面板里改：**小鲸鱼 → 全局音效设置 → 每轮消耗提示**。

### 其它

- 发布包里现在带 `scripts/`，所以上面这些命令解包即可用。
- `tests/manifest_selftest.mjs` 增加了一条断言：`files` 必须包含 `scripts`，否则 CI 失败。
- CI 的产物检查也加了两条：`package/scripts/publish-release.mjs` 与 `package/scripts/whale-usage-settings.mjs` 必须存在。

### 资产

<!--ASSETS-->

### 从 0.6.1 升上来要做什么

- 插件代码没变，**不需要刷新也不需要重启**（除非你想让 `__DSH_DING__.version` 显示 0.6.2）。
- 仓库里的新脚本是给排查用的，不装包也能直接从仓库跑。

---

## English

### What's new

You hear two sounds at turn end while `__DSH_DING__.rings` only went up by 1 — which means
**another plugin is playing too**. Until now that was guesswork; now it is measurable:

```bash
node tests/audio_sources_probe.mjs http://127.0.0.1:PORT <secretBase64Url>
```

It hooks every audio start in the page (`HTMLMediaElement.play` / `AudioBufferSource.start` /
`OscillatorNode.start`) and records the call stack with each one:

```
+ 4578ms  oscillator   at scheduleScore (...plugins/.../client.js)     ← dsh-ding
+ 4578ms  buffer       at scheduleScore (...)                          ← dsh-ding
+ 4970ms  buffer       at beginWithBuffer (/dsh-whale/widget.js:268)   ← another plugin
```

Companion tools:

| script | what it does |
|---|---|
| `tests/double_ring_probe.mjs` | reads only dsh-ding's own trace, telling "same session rang twice" from "two sessions, one each" |
| `scripts/whale-usage-settings.mjs` | reads/writes `dsh-whale-widget`'s turn-end sound switch through its own endpoint |
| `scripts/clean-whale-ledger.mjs` | removes a leftover key from the ledger that nothing reads |

### An upstream behaviour worth knowing

`dsh-whale-widget` reads its settings **once per page load**. Change the server value without
reloading and it keeps ringing with the old one. Verified in three stages
(`tests/whale_reload_probe.mjs`):

```
① loaded with taskEnd=on    → one turn: whale played 1
② server off + page reload  → one turn: whale played 0
③ server back on, no reload → one turn: whale played 0   ← it does not re-read
```

So after flipping whale's switch, **press F5**.

### Two sounds are not a bug

`dsh-whale-widget` is primarily a balance checker; the per-turn cost notice is a side feature and
is on by default. The two are independent event sounds — keep whichever you like:

```bash
node scripts/whale-usage-settings.mjs http://127.0.0.1:PORT <secretBase64Url> --set-task-end off
node scripts/whale-usage-settings.mjs http://127.0.0.1:PORT <secretBase64Url> --set-task-end on
```

Or in its own panel: **whale → global sound settings → per-turn cost notice**.

### Also

- The tarball now ships `scripts/`, so the commands above work straight from the unpack.
- `tests/manifest_selftest.mjs` gained an assertion: `files` must include `scripts`, or CI fails.
- CI's tarball check gained two entries: `package/scripts/publish-release.mjs` and
  `package/scripts/whale-usage-settings.mjs` must be present.

### Assets

<!--ASSETS-->

### Upgrading from 0.6.1

- The plugin code is unchanged, so **no reload and no restart needed** — unless you want
  `__DSH_DING__.version` to read 0.6.2.
- The new scripts are diagnostic aids; they run from the repository without installing anything.

---

**Full Changelog**: https://github.com/tinyhan9/dsh-ding/compare/v0.6.1...v0.6.2
