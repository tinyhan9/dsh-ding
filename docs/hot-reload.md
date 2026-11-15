# 改完代码怎么生效

改完 dsh-ding 的代码后，需要让浏览器重新加载插件 bundle。这台机器上有三种做法，代价从小到大。

## 结论先说

**多数情况下不用你操作。** 实测（`tests/hmr_probe.mjs`）：改完 `lib/client.js`，
一个**已经开着**的页面在 1 秒内自己就换上了新 bundle：

```
version in the open page: 0.6.0
patched the file to 0.6.0+hmrprobe; watching the same page (no reload)…
ok    the open page picked up the new bundle WITHOUT a reload (0.6.0 → 0.6.0+hmrprobe)
```

DSH 的 HMR 通道（`dsh-hmr` + `dsh-client-hmr`）常开着，它盯着 bundle 的 mtime/size，
一变就通过 `/plugins/events` 推给页面。所以「改文件 → 等一秒 → 试听」通常就可以了。

## 什么时候真的需要刷新

| 情况 | 需要做什么 |
|---|---|
| 只改了 `lib/client.js` | 什么都不用做，等一秒 |
| 改了 `package.json` 的 `dsh.client` / `exports` | 刷新页面（manifest 只在 entry 启动时读） |
| 新装 / 卸载插件、改 `cordis.patch.yml` | 重启应用（Loader 行变了） |
| 页面报「Failed to load plugins」 | 刷新页面；还不行就重启 |

## 三个做法

### 1. 不用管（推荐先试）

改完源码，回到窗口点一下页面，然后发一句话试听。HMR 已经把新 bundle 推过去了。
验证：控制台 `__DSH_DING__.version` 应等于新版本号。

### 2. 刷新页面

Electron 桌面端**生产构建没有「刷新」菜单项**（`lib/main.js` 里 `reloadPageMenu`
只在 `development` 分支里注册）。但 Chromium 自带的键盘刷新仍然有效，实测：

```
Ctrl+R                 reload=true
Ctrl+Shift+R           reload=false   ← 强刷被拦，别用
F5                     reload=true
Ctrl+F5                reload=true
```

所以在窗口内按 **`F5`** 或 **`Ctrl+R`** 就是「刷新页面」：
页面文档重载，插件 bundle 全部重新拉一遍，**Host 进程不动**，会话记录、正在跑的任务都还在。

### 3. 重启应用

只有改 Loader 行（装/卸插件、改 `cordis.patch.yml`）或改 `package.json` 的入口声明时才需要。
Win11 上关窗口默认收进托盘，要从**托盘图标右键 → 退出**，再重新打开。

顺带一提：`F12` 能打开开发者工具（菜单里那个隐藏的 `toggleDevTools` 加速键），
所以想看 `__DSH_DING__.trace` 不必另外找入口。

## 怎么确认自己看的是新版

控制台一行：

```js
__DSH_DING__.version   // 现在应该是 "0.6.0"
```

对不上就是还没换过来 —— 先按 `F5`，再看一眼。
