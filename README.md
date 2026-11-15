# dsh-ding

DeepSeek Harness 插件：**一轮对话结束时播放提示音**。

跑长任务时人不在屏幕前，回来只知道“好像跑完了”。这个插件在每轮结束时响一声，声音可选、音量可调、可以整个关掉。

声音全部由程序合成：七种音色（水滴落水、石头落水、水泡、铃、连音、短促音），可调音量、总开关、即时试听。不带音频文件、不联网、没有构建步骤、没有运行期依赖。

> 设置项位置：**设置 → 通用设置 → 对话结束提示音**。
> 装好后随便点一下窗口把音频解锁，之后每一轮跑完都会响。

[English](README.en.md)

---

## 快速开始

```bash
# 装到本地 profile（把路径换成你这份 checkout 的位置）
dsh plugin --profile desktop install link:<本目录绝对路径>

# 或者用插件管理界面，安装 spec 填：
link:<本目录绝对路径>
```

装完重启一次桌面端，然后发一句话试试。要确认装上了，控制台敲：

```js
__DSH_DING__.version    // "0.6.0"
__DSH_DING__.ring()     // 立刻响一声，验证音频链路
```

嫌吵就去设置里换音色或关掉；听不见就看 [诊断](#诊断) 那张表。

## 功能

- **轮次结束提示音**：任一会话从「运行中」掉到「空闲」时播一次。
  - 盯**所有**会话 —— 你在别的会话里看着，原来那一轮跑完同样会响。
  - 子代理会话不响：它们又短又多，响了就是噪音。
  - 进页面时重新取基线 —— 不会一打开就响。
  - 同一条空闲状态重复发布只响一次。
- **七种音色**，默认 `droplet`：

  | id | 音色 | 特征 |
  |---|---|---|
  | `droplet` | 水滴落水 · 叮咚 | 900→1650Hz，40ms 滑完，后面跟一记水面「咚」 |
  | `waterdrop` | 水滴 · 清脆 | 620→1500Hz，30ms 滑完，90ms 收干净 |
  | `waterdrop2` | 水泡 · 圆润 | 300→700Hz，滑得更慢、余韵更长 |
  | `plop` | 石头落水 · 咕咚 | 280→115Hz **下行**滑音，低频沉底 |
  | `ding` | 叮 · 双音铃 | 两声铃 |
  | `chime` | 铃 · 三连音 | 三声铃 |
  | `blip` | 哒 · 短促 | 单声短促 |

- **音量 0–100%**，默认 60%。
- **总开关**，关掉后完全不碰音频。
- **设置项在「设置 → 通用设置」**里：开关 / 音色 / 音量 / 试听。

每个音色是一组「音符 + 噪声段」配方。音高按指数滑音，包络是
`(1−e^(−t/attack))·e^(−t/tau)`。WebAudio 用 `setValueCurveAtTime` 播这条曲线；
没有 WebAudio 时把同一份配方算成 WAV data-URI 交给 `<audio>`，两条路听感一致。

## 安装

用插件管理装本地目录：

```
link:<本目录绝对路径>
```

命令行等价做法（profile 目录下）：

```
dsh plugin --profile desktop install link:<本目录绝对路径>
```

装完 `plugin_manager` 会把 `dsh-ding` 写进 profile 的 `dependencies` 与
`dsh.profile.bundles`，并在 `cordis.patch.yml` 里加一行 Loader 行。
桌面端重启一次，Web 端刷新页面。

## 使用

1. 打开 设置（`Ctrl+Alt+,` 或 账号菜单）→ **通用设置**。
2. 找到「对话结束提示音」一行：
   - 勾选/取消 **启用**；
   - 下拉选音色；
   - 拖音量条；
   - **试听** 立刻按当前设置响一次。
3. 回到对话发一句话，这轮跑完就会响。

偏好存在浏览器 `localStorage` 的 `dsh-ding:settings` 里（带 `v: 2` 版本号），形如：

```json
{ "v": 2, "enabled": true, "sound": "droplet", "volume": 0.6 }
```

坏数据（半截 JSON、越界音量、不存在的音色）一律静默回落到默认值，不会让设置页白屏。

## 为什么偏好不放 Host settings

故意的。不依赖 `schemastery` schema，DSH 升级、换 profile 都不会因为 schema 漂移把这个插件搞挂。
代价是偏好跟着浏览器走、不跟着 profile 走 —— 对一个开关音色的插件来说可以接受。

## 诊断

页面控制台里有一个只读把手：

```js
__DSH_DING__.version      // "0.6.0"
__DSH_DING__.watching     // 轮次监听是否装上
__DSH_DING__.watched      // 当前盯了几个会话
__DSH_DING__.rings        // 累计响过多少次
__DSH_DING__.lastSession  // 最近一次判定结束的会话
__DSH_DING__.lastPath     // "webaudio" | "fallback"
__DSH_DING__.trace        // 最近 40 条「判定 → 出声」流水
__DSH_DING__.problems     // 降级记录
__DSH_DING__.audio()      // { unlocked, state, hasFallback }
__DSH_DING__.settings()   // 当前偏好
__DSH_DING__.ring()       // 手动响一次，验证音频链路
__DSH_DING__.unlock()     // 不用点击也能解锁音频
__DSH_DING__.render(id)   // 把某个音色渲染成 WAV data URI
__DSH_DING__.sounds()     // 音色 id 列表
```

听不见声音时按这个顺序看：

| 看到的 | 含义 |
|---|---|
| `__DSH_DING__` 是 `undefined` | 插件没激活（`inject` 名变了，或没装上） |
| `watched` 是 `0` | 还没拿到会话列表，监听没有对象可挂 |
| `rings` 不涨 | 没观测到 `running → idle`，看 `trace` 里有没有 `turn-end` |
| `rings` 涨了但没声音 | 音频被拦，看 `trace` 里的 `skip` 和 `problems` |

## 轮次判定怎么做的

| 项 | 行为 |
|---|---|
| 盯谁 | `ctx.sessions.list` 里的**每一个**会话，随列表增删自动补/撤监听 |
| 不盯谁 | `origin === "subagent"` 的子代理会话 |
| 数据源 | 每个会话的 `SessionBinding.session` 订阅 **和** `uiSession.sessionStatus` 聚合表，两条独立路径 |
| 基线 | 两条路径**各存一份**上一拍 `running`，互不覆盖 |
| 去重 | 同一会话 700ms 内只响一次；观测到重新 `running: true` 立刻清空 |
| `sessionStatus` 形状变了 | 只降级成 binding 单路，不会把整块监听停掉 |

两个真实故障塑造了这个设计，都被测试钉住了：

1. 只看聚合表时，某些时序下会整段跳过一次 `true → false`；
2. 只盯「当前会话」时，你切到别的会话看内容，原来那一轮跑完就没人看着。

## 音频与自动播放策略

浏览器只允许在真实用户手势里 `AudioContext.resume()` 与首次 `play()`，而轮次结束是异步回调、
不在手势里。所以插件装一次性 `pointerdown` / `keydown` / `touchstart` 监听，在第一个真实手势里
把两条通道都解锁，然后摘掉监听。

Chrome 在设备切换、长时间闲置、系统休眠恢复之后会把 `AudioContext` 挂起，此时 `resume()`
返回的 promise **可能永远不 resolve**。所以 `ring()` 不等它：最多给 `RESUME_TIMEOUT_MS = 120ms`，
超时立刻走 `<audio>` 兜底。两条路都试；被拒的播放写进 `problems`，不静默吞掉。

## 改完代码怎么生效

| 情况 | 需要做什么 |
|---|---|
| 只改了 `lib/client.js` | 什么都不用做，HMR 一秒内推新 bundle |
| 改了 `package.json` 的 `dsh.client` / `exports` | 页面按 `F5`（或 `Ctrl+R`） |
| 新装 / 卸载插件、改 `cordis.patch.yml` | 重启应用 |

桌面端生产构建**没有「刷新」菜单项**（`reloadPageMenu` 只在 development 分支注册），
但 Chromium 自带的键盘刷新仍然有效：`F5` / `Ctrl+R` / `Ctrl+F5` 都会重载，
`Ctrl+Shift+R` 被拦。刷新只重载页面文档，Host 进程不动，会话记录和正在跑的任务都还在。

## 文件

| 文件 | 作用 |
|---|---|
| [`lib/client.js`](lib/client.js) | 全部逻辑：轮次监听、设置行、`VOICES` 音色配方与合成 |
| [`lib/index.js`](lib/index.js) | Node 半边，空 `apply`，只为给 Loader 一行可挂载的 Host 实体 |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 层：把本包插成 profile 的一个 Loader 行 |
| [`docs/`](docs/) | 每个音色的离线渲染 WAV，以及说明 |

## 自测

九层，从便宜到贵，全部在仓库内可跑：

```bash
# ⓿ 包结构：清单字段、exports、bundle 包装格式、版本号、patch —— 不需要浏览器
node tests/manifest_selftest.mjs

# ① bundle 本身：加载器包装、槽位注册、轮次判定、兜底路径、解锁路径、卸载 —— 纯 Node
node tests/client_selftest.mjs

# ② resume 悬空不再静音
node tests/audio_stall_selftest.mjs

# ③ 音色声学验收：每个音色渲染成 WAV 做频谱分析
node tests/sound_spectrum_selftest.mjs docs

# ④ 运行中的 Host：boot 图里有 dsh-ding、bundle 服务得出来
node tests/host_probe.mjs http://127.0.0.1:PORT <secretBase64Url>

# ⑤ 真页面：bundle 已 materialize、设置行画出来了、开关能改并持久化
node tests/browser_probe.mjs http://127.0.0.1:PORT <secretBase64Url>

# ⑥ 端到端：真发一句话，等这一轮跑完
node tests/live_turn_probe.mjs http://127.0.0.1:PORT <secretBase64Url>

# ⑦ 连发三轮，验证每次都响
node tests/multi_turn_probe.mjs http://127.0.0.1:PORT <secretBase64Url> 3

# ⑧ 后台会话结束也要响（发问后立刻切走）
node tests/background_turn_probe.mjs http://127.0.0.1:PORT <secretBase64Url>
```

`<secretBase64Url>` 是 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session`
的 `secret`。浏览器探针用 CDP 驱动本机 Chromium 内核浏览器，路径走 `CHROME_PATH`
或参数，不写死。

② 的输出：

```
ok    suspended + hanging resume still produced audio (fallback plays: 1, webaudio notes: 0)
ok    running context uses WebAudio (2 notes, 0 fallback)
ok    rejected playback is recorded: resume did not take: timed out after 120ms | fallback playback rejected: NotAllowedError
OK  audio stall handling: hanging resume never silences the ring
```

⑦ 的输出：

```
round 1: rings 0 → 1 (delta 1)  audio {"unlocked":true,"state":"running","hasFallback":true}
round 2: rings 1 → 2 (delta 1)  audio {"unlocked":true,"state":"running","hasFallback":true}
round 3: rings 2 → 3 (delta 1)  audio {"unlocked":true,"state":"running","hasFallback":true}

3/3 rounds rang
```

## 兼容性

对着 DSH `0.2.2-rc.1`、Windows 开发。只依赖四个宿主面：
`ctx.slots.inject` / `ctx.slots.register`、`ctx.uiSession.current`、
`ctx.uiSession.sessionStatus`、`ctx.sessions.binding` / `ctx.sessions.list`。
每一处都有形状校验：哪一块变了就只降级那一块，原因写进 `__DSH_DING__.problems`。

## 边界

- 当前会话与后台会话都响；子代理不响。
- 不读会话内容、不联网、不写 Host 设置、不产生模型可见内容。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
