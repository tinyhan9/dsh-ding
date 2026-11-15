# dsh-ding 0.6.1

> 文档与发布说明的语言改成以中文为主。这个版本**没有任何行为变化**：插件逻辑、音色配方、
> 音频路径与 0.6.0 完全一致，只改了文档组织和仓库展示。
>
> Documentation-only release. **No behaviour change** — the plugin logic, sound recipes and
> audio paths are identical to 0.6.0. Only the docs layout and the repository presentation differ.

---

## 中文说明

### 这次改了什么

- **README 主语言改成中文**：`README.md` 现在是中文版，原来的英文版移到 `README.en.md`，
  两份互相链接。
- **加了「快速开始」**：三条命令 + 两句控制台自检，不用先读完整篇。
- **仓库 About 用中文写**：一句话说清这是什么、有什么。
- **打好的包里不再带发布说明**：`files` 字段收紧，tarball 只含可安装内容 + 测试。

功能本身一个字没动：七种音色、默认 `droplet`、音量、总开关、试听，位置还是在
**设置 → 通用设置 → 对话结束提示音**。

### 装法（和之前一样）

    dsh plugin --profile desktop install link:<本目录绝对路径>

或用插件管理界面，安装 spec 填 `link:<本目录绝对路径>`。

### 升级后要做什么

- 只换了文档，**不需要刷新也不需要重启**。
- 如果只是想确认版本：控制台 `__DSH_DING__.version` 应显示 `"0.6.1"`。

### 资产

<!--ASSETS-->

### 兼容性

对着 DSH `0.2.2-rc.1`、Windows 开发。只依赖 `ctx.slots.inject` / `ctx.slots.register`、
`ctx.uiSession.current`、`ctx.uiSession.sessionStatus`、`ctx.sessions.binding` / `ctx.sessions.list`。

---

## English

### What changed

- **Chinese is now the primary README**: `README.md` is Chinese, the English one moved to
  `README.en.md`, and the two link to each other.
- **Added a Quick start**: three commands plus two console checks, before the long read.
- **The repo About is written in Chinese** now: one sentence covering what it is and what it has.
- **The packed tarball no longer carries release notes**: the `files` list was tightened, so the
  tarball holds only installable content plus tests.

Nothing functional changed: seven presets, default `droplet`, volume, global switch, preview —
still under **Settings → General → turn-end chime**.

### Install (unchanged)

    dsh plugin --profile desktop install link:<absolute path to this checkout>

or use the plugin manager UI with the spec `link:<absolute path to this checkout>`.

### After upgrading

- Docs only — **no reload and no restart needed**.
- To confirm the version: `__DSH_DING__.version` should read `"0.6.1"`.

### Assets

<!--ASSETS-->

### Compatibility

Built against DSH `0.2.2-rc.1` on Windows. Depends only on `ctx.slots.inject` / `ctx.slots.register`,
`ctx.uiSession.current`, `ctx.uiSession.sessionStatus` and `ctx.sessions.binding` / `ctx.sessions.list`.

---

**Full Changelog**: https://github.com/tinyhan9/dsh-ding/compare/v0.6.0...v0.6.1
