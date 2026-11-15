/**
 * dsh-ding 客户端 bundle 的离线自测。
 *
 * 目的：在没有浏览器的环境里证明四件事——
 *   ① bundle 能被模块加载器包装格式解析，factory 产出 apply/inject；
 *   ② 会话 running 位 true → false 时真的触发一次播放，且只认当前主会话；
 *   ③ 开关关掉、后台会话结束、重复空闲状态都不会响；
 *   ④ 没有 AudioContext 的平台走 WAV data-URI 兜底，卸载后彻底静音。
 *
 * 跑法：node tests/client_selftest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
const BUNDLE_ID = "dsh-ding";

/** 默认音色（水滴）一次响几个音符 —— 与 lib/client.js 的 SCORES.waterdrop 对齐。 */
const NOTES_PER_RING = 3;
/** 一次「响」在 WebAudio 路径上调度几个振荡器。 */
const SCHEDULED_PER_RING = 2;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** 极简 React 替身：只够设置行 render 与 useState。 */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useState(initial) {
    const value = typeof initial === "function" ? initial() : initial;
    return [value, () => {}];
  },
  Fragment: "Fragment"
};

/** 可订阅的快照源，模拟 uiSession.current / uiSession.sessionStatus。 */
function makeSource(initial) {
  return {
    value: initial,
    listeners: new Set(),
    getSnapshot() {
      return this.value;
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    publish(next) {
      this.value = next;
      for (const listener of [...this.listeners]) listener();
    }
  };
}

/**
 * 建一个隔离的“浏览器 + 插件宿主”沙箱并加载 bundle。
 * @param {{ audioContext?: boolean }} options - 是否提供 AudioContext。
 * @returns 沙箱句柄：source、ctx、播放记录、调度计数。
 */
function load(options = {}) {
  const withAudio = options.audioContext !== false;
  const plays = [];
  let notes = 0;

  const audioContext = {
    state: "running",
    currentTime: 0,
    destination: {},
    resume() {
      audioContext.state = "running";
      return Promise.resolve();
    },
    createOscillator() {
      notes += 1;
      return {
        type: "",
        frequency: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {},
        start() {},
        stop() {}
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {}
      };
    }
  };

  const currentSource = makeSource({ key: void 0 });
  const statusSource = makeSource(new Map());
  const registrations = new Map();

  const windowListeners = new Map();
  const windowStub = {
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null;
      },
      setItem(key, value) {
        this.store.set(key, String(value));
      }
    },
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    removeEventListener(type) {
      windowListeners.delete(type);
    },
    Audio: function Audio(src) {
      this.src = src;
      this.volume = 1;
      this.muted = false;
      this.currentTime = 0;
      this.play = () => {
        if (this.muted === true) return Promise.resolve();
        plays.push(src);
        return Promise.resolve();
      };
      this.pause = () => {};
    },
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    __ModuleLoader__: {
      load(registration) {
        registrations.set(registration.id, registration.factory);
      }
    }
  };
  if (withAudio) windowStub.AudioContext = function AudioContext() { return audioContext; };

  /** 插件降级时打的 warn 收进数组，避免污染测试输出（PowerShell 会把 stderr 当错误）。 */
  const warnings = [];
  const sandbox = {
    window: windowStub,
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {} }),
      head: { appendChild() {} }
    },
    require: (id) => {
      if (id === "react") return reactStub;
      throw new Error(`unexpected require: ${id}`);
    },
    console: {
      log: () => {},
      warn: (...args) => warnings.push(args.join(" ")),
      error: (...args) => warnings.push(args.join(" "))
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "dsh-ding/lib/client.js" });

  const factory = registrations.get(BUNDLE_ID);
  expect(factory !== void 0, "bundle did not register under id dsh-ding");

  const bundle = factory((id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });
  expect(typeof bundle.apply === "function", "bundle exports no apply()");
  expect(Array.isArray(bundle.inject), "bundle exports no inject[]");

  const slots = {
    injected: [],
    items: [],
    register(target, component) {
      this.items.push({ target, component });
      return () => {};
    },
    inject(name, build) {
      this.injected.push(name);
      build();
      return () => {};
    }
  };
  const effects = [];
  /* 假的会话对象层：binding(id) 返回一个可订阅 running 的快照源。 */
  const sessionBuckets = new Map();
  /* 会话列表快照：插件用它决定盯哪些会话、以及排除子代理。 */
  const sessionList = makeSource({ ids: [], byId: {} });
  const fakeSessions = {
    list: sessionList,
    binding(id) {
      let bucket = sessionBuckets.get(id);
      if (bucket === undefined) {
        const source = makeSource({ running: false, removed: false, subagent: null });
        bucket = { session: source };
        sessionBuckets.set(id, bucket);
      }
      return bucket;
    },
    setRunning(id, running) {
      const bucket = fakeSessions.binding(id);
      bucket.session.publish({ ...bucket.session.getSnapshot(), running });
    }
  };
  const ctx = {
    slots,
    sessions: fakeSessions,
    uiSession: { current: currentSource, sessionStatus: statusSource },
    effect(factory) {
      effects.push(factory());
      return () => {};
    }
  };

  return { bundle, ctx, slots, effects, currentSource, statusSource, plays, notes: () => notes, windowStub, warnings, audioContext, windowListeners, sessions: fakeSessions };
}

/** 让挂起的 Promise 链（resume → schedule / fallback）走完。 */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** ---------- 场景 1：有 WebAudio 的桌面/Chromium 路径 ---------- */
{
  const env = load();
  env.bundle.apply(env.ctx);

  expect(env.slots.injected.includes("settings.general.item"), "settings row was not registered");
  expect(env.slots.items.length === 1, "expected exactly one slot registration");
  const row = env.slots.items[0].component();
  expect(row !== null && typeof row === "object", "settings row did not render");

  /* 切到会话 A，A 已经在跑 —— 这是基线，不该响。 */
  env.currentSource.publish({ key: "session-A" });
  env.statusSource.publish(new Map([["session-A", { running: true, completionUnread: false }]]));
  await settle();
  expect(env.notes() === 0 && env.plays.length === 0, "already-running baseline must not ring");

  /* A 跑完：ding 是两个音。 */
  env.statusSource.publish(new Map([["session-A", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING, `turn end should schedule one full score, got ${env.notes()}`);
  expect(env.plays.length === 0, "WebAudio path should win while available");

  /* 同一条空闲状态重复发布：不重复响。 */
  env.statusSource.publish(new Map([["session-A", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING, "idle baseline must not re-ring");

  /* 后台会话结束：**也要响** —— 用户切到别的会话时，原来那轮跑完同样要提醒。 */
  env.statusSource.publish(new Map([
    ["session-A", { running: false, completionUnread: false }],
    ["session-B", { running: true, completionUnread: false }]
  ]));
  await settle();
  env.statusSource.publish(new Map([
    ["session-A", { running: false, completionUnread: false }],
    ["session-B", { running: false, completionUnread: true }]
  ]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING * 2, "a turn that finishes in another session must still ring");

  /* 子代理会话结束：不响（它们本来就短、数量又多，响了就是噪音）。 */
  env.sessions.list.publish({ ids: ["session-A", "session-B", "session-S"], byId: { "session-S": { id: "session-S", origin: "subagent" } } });
  await settle();
  env.statusSource.publish(new Map([
    ["session-A", { running: false, completionUnread: false }],
    ["session-B", { running: false, completionUnread: false }],
    ["session-S", { running: true, completionUnread: false }]
  ]));
  await settle();
  env.statusSource.publish(new Map([
    ["session-A", { running: false, completionUnread: false }],
    ["session-B", { running: false, completionUnread: false }],
    ["session-S", { running: false, completionUnread: true }]
  ]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING * 2, "a subagent turn must stay silent");

  /* 关掉开关：即便主会话结束也不响。 */
  env.windowStub.localStorage.setItem("dsh-ding:settings", JSON.stringify({ enabled: false, sound: "ding", volume: 0.6 }));
  env.statusSource.publish(new Map([
    ["session-A", { running: true, completionUnread: false }],
    ["session-B", { running: false, completionUnread: false }]
  ]));
  await settle();
  env.statusSource.publish(new Map([
    ["session-A", { running: false, completionUnread: true }],
    ["session-B", { running: false, completionUnread: false }]
  ]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING * 2, "disabled switch must stay silent");

  /* 卸载：监听全部摘掉。 */
  for (const dispose of env.effects) if (typeof dispose === "function") dispose();
  env.windowStub.localStorage.setItem("dsh-ding:settings", JSON.stringify({ enabled: true, sound: "ding", volume: 0.6 }));
  env.statusSource.publish(new Map([["session-A", { running: true, completionUnread: false }]]));
  await settle();
  env.statusSource.publish(new Map([["session-A", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING * 2, "disposed watcher must stay silent");
}

/** ---------- 场景 2：没有 WebAudio，只能走 WAV 兜底 ---------- */
{
  const env = load({ audioContext: false });
  env.bundle.apply(env.ctx);
  env.currentSource.publish({ key: "session-C" });
  env.statusSource.publish(new Map([["session-C", { running: true, completionUnread: false }]]));
  await settle();
  expect(env.plays.length === 0, "baseline must not play");

  env.statusSource.publish(new Map([["session-C", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.plays.length === 1, `fallback path should play once, got ${env.plays.length}`);
  expect(String(env.plays[0]).startsWith("data:audio/wav;base64,"), "fallback should use a WAV data URI");
  expect(env.notes() === 0, "fallback must not touch WebAudio");
}

/** ---------- 场景 3：坏掉的 localStorage 不炸 ---------- */
{
  const env = load();
  env.windowStub.localStorage.getItem = () => "{ not json";
  env.bundle.apply(env.ctx);
  env.currentSource.publish({ key: "session-D" });
  env.statusSource.publish(new Map([["session-D", { running: true, completionUnread: false }]]));
  await settle();
  env.statusSource.publish(new Map([["session-D", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING, "corrupt stored settings must fall back to defaults and still ring");
}

/** ---------- 场景 4：切到一个“正在跑”的会话，它跑完要响 ---------- */
{
  const env = load();
  env.bundle.apply(env.ctx);

  /* 先停在会话 E，且 E 已经空闲 —— 不该响。 */
  env.currentSource.publish({ key: "session-E" });
  env.statusSource.publish(new Map([["session-E", { running: false, completionUnread: false }]]));
  await settle();
  expect(env.notes() === 0, "switching to an idle session must not ring");

  /* 现在切到正在跑的会话 F：基线取“正在跑”，所以 F 结束时响一次。 */
  env.statusSource.publish(new Map([
    ["session-E", { running: false, completionUnread: false }],
    ["session-F", { running: true, completionUnread: false }]
  ]));
  await settle();
  env.currentSource.publish({ key: "session-F" });
  await settle();
  expect(env.notes() === 0, "adopting a running session must not ring immediately");

  env.statusSource.publish(new Map([
    ["session-E", { running: false, completionUnread: false }],
    ["session-F", { running: false, completionUnread: true }]
  ]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING, `the adopted running session must ring at its end, got ${env.notes()}`);
}

/** ---------- 场景 7：聚合状态表漏掉一次 true→false 时，binding 路径要补上 ---------- */
{
  const env = load();
  env.bundle.apply(env.ctx);
  env.currentSource.publish({ key: "session-L" });
  await settle();

  /* binding 这一路：先把会话跑到 running，再让它掉下来。 */
  env.sessions.setRunning("session-L", true);
  await settle();
  env.sessions.setRunning("session-L", false);
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING, `binding path must ring when the aggregate map misses it, got ${env.notes()}`);

  /* 两条路都报同一次结束：不许响两声。 */
  env.sessions.setRunning("session-L", true);
  await settle();
  env.sessions.setRunning("session-L", false);
  env.statusSource.publish(new Map([["session-L", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING * 2, `the same turn end must ring exactly once, got ${env.notes()}`);
}

/** ---------- 场景 6：自动播放策略下的解锁路径 ---------- */
{
  const env = load();

  /* 让 AudioContext 一开始是 suspended（真实浏览器的初始态），且没有手势时 resume 不生效。 */
  env.audioContext.state = "suspended";
  env.audioContext.resume = function () {
    return Promise.resolve();
  };

  env.bundle.apply(env.ctx);

  /* 手势监听应已装上。 */
  expect(typeof env.windowListeners.get("pointerdown") === "function", "no gesture listener installed");

  /* suspended + resume 不生效时，必须落到 <audio> 兜底，而不是静默什么都不做。 */
  env.currentSource.publish({ key: "session-H" });
  env.statusSource.publish(new Map([["session-H", { running: true, completionUnread: false }]]));
  await settle();
  env.statusSource.publish(new Map([["session-H", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.plays.length === 1, `suspended audio must fall back to <audio>, got ${env.plays.length} plays`);

  /* 走一次真实手势：解锁后 WebAudio 变成 running，且手势监听被摘掉。 */
  env.audioContext.resume = function () {
    env.audioContext.state = "running";
    return Promise.resolve();
  };
  const handler = env.windowListeners.get("pointerdown");
  if (typeof handler === "function") handler({ type: "pointerdown" });
  await settle();
  expect(env.audioContext.state === "running", "a real gesture must bring the AudioContext to running");
  expect(!env.windowListeners.has("pointerdown"), "the one-shot gesture listener must detach after unlocking");

  /* 解锁后再结束一轮：这次应当走 WebAudio，不再用 <audio>。 */
  const playsBefore = env.plays.length;
  env.statusSource.publish(new Map([["session-H", { running: true, completionUnread: false }]]));
  await settle();
  env.statusSource.publish(new Map([["session-H", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.plays.length === playsBefore, "after unlocking, WebAudio must be preferred over the <audio> fallback");
}

{
  /* 5a：ctx.slots 没了 —— 设置行挂不上，监听器照旧工作。 */
  const env = load();
  const ctxNoSlots = {
    uiSession: { current: env.currentSource, sessionStatus: env.statusSource },
    effect(factory) {
      env.effects.push(factory());
      return () => {};
    },
  };
  let threw = false;
  try {
    env.bundle.apply(ctxNoSlots);
  } catch (error) {
    threw = true;
  }
  expect(!threw, "apply must not throw when ctx.slots is missing");
  expect(env.warnings.some((line) => line.includes("ctx.slots.inject is unavailable")), "missing slots must be recorded on the diagnostics face");
  env.currentSource.publish({ key: "session-G" });
  env.statusSource.publish(new Map([["session-G", { running: true, completionUnread: false }]]));
  await settle();
  env.statusSource.publish(new Map([["session-G", { running: false, completionUnread: true }]]));
  await settle();
  expect(env.notes() === SCHEDULED_PER_RING, "turn-end watcher must keep working without ctx.slots");

  /* 5b：settings.general.item 改名 —— register 抛错，插件不得把异常冒出来。 */
  const env2 = load();
  env2.slots.register = () => {
    throw new Error("slot 'settings.general.item' is not declared by this entry's children");
  };
  let threw2 = false;
  try {
    env2.bundle.apply(env2.ctx);
  } catch (error) {
    threw2 = true;
  }
  expect(!threw2, "a rejected slot registration must not escape apply()");
  expect(env2.warnings.some((line) => line.includes("slot rejected the registration")), "a rejected slot must be recorded on the diagnostics face");

  /* 5c：uiSession.sessionStatus 换了形状（不再是可订阅源）—— 静音但不抛。 */
  const env3 = load();
  let threw3 = false;
  try {
    env3.bundle.apply({
      slots: env3.slots,
      sessions: env3.sessions,
      uiSession: { current: env3.currentSource, sessionStatus: "map-ish" },
      effect(factory) {
        env3.effects.push(factory());
        return () => {};
      },
    });
  } catch (error) {
    threw3 = true;
  }
  expect(!threw3, "a reshaped uiSession must not throw out of apply()");
  expect(env3.warnings.some((line) => line.includes("changed shape")), "a reshaped uiSession must be recorded on the diagnostics face");
  /* 关键：sessionStatus 坏了，binding 那条路必须还在工作。 */
  env3.sessions.list.publish({ ids: ["session-M"], byId: { "session-M": { id: "session-M" } } });
  await settle();
  env3.sessions.setRunning("session-M", true);
  await settle();
  env3.sessions.setRunning("session-M", false);
  await settle();
  expect(env3.notes() === SCHEDULED_PER_RING, `a reshaped sessionStatus must degrade to the binding path, got ${env3.notes()}`);
}

console.log("OK  client bundle: settings row + turn-end ring + current-session filter + fallback + dispose");
