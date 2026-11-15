/**
 * 复现「间歇性不响」：模拟 AudioContext 处于 suspended、而 resume() 的 promise
 * 永远不落地的情形（Chrome 在设备切换 / 长时间闲置 / 系统休眠后确实会这样）。
 *
 * 期望：ring() 必须仍然出声（走 <audio> 兜底），而不是静默等一个不会来的 resolve。
 *
 * 跑法：node tests/audio_stall_selftest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};
const ok = (message) => console.log(`ok    ${message}`);

/**
 * 加载 bundle 并返回一个可控的音频环境。
 * @param {{ state?: string, resumeHangs?: boolean, playRejects?: boolean }} options - 环境设定。
 * @returns {object} 句柄。
 */
function load(options = {}) {
  const plays = [];
  const notes = 0;
  let noteCount = 0;

  const audioContext = {
    state: options.state ?? "running",
    currentTime: 0,
    destination: {},
    sampleRate: 44100,
    resume() {
      /* 关键：永远不 resolve —— 真实浏览器在设备被占用/挂起时就是这个表现。 */
      if (options.resumeHangs === true) return new Promise(() => {});
      audioContext.state = "running";
      return Promise.resolve();
    },
    createOscillator() {
      noteCount += 1;
      return {
        type: "",
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
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
          exponentialRampToValueAtTime() {},
          setValueCurveAtTime() {}
        },
        connect() {}
      };
    },
    createBuffer(channels, frames, rate) {
      return { getChannelData: () => new Float32Array(frames), sampleRate: rate };
    },
    createBufferSource() {
      return { buffer: null, connect() {}, start() {}, stop() {} };
    },
    createBiquadFilter() {
      return { type: "", Q: { value: 0 }, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  };

  const registrations = new Map();
  const listeners = new Map();
  const windowStub = {
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
    AudioContext: function AudioContext() {
      return audioContext;
    },
    Audio: function Audio(src) {
      this.src = src;
      this.volume = 1;
      this.muted = false;
      this.currentTime = 0;
      this.play = () => {
        if (options.playRejects === true) return Promise.reject(new Error("NotAllowedError"));
        plays.push(src);
        return Promise.resolve();
      };
      this.pause = () => {};
    },
    __ModuleLoader__: {
      load(registration) {
        registrations.set(registration.id, registration.factory);
      }
    }
  };

  const sandbox = {
    window: windowStub,
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
    require: (id) => {
      if (id === "react") return { createElement: () => null, useState: (value) => [value, () => {}] };
      throw new Error(`unexpected require: ${id}`);
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "dsh-ding/lib/client.js" });

  const factory = registrations.get("dsh-ding");
  if (factory === undefined) throw new Error("bundle did not register");
  factory((id) => {
    if (id === "react") return { createElement: () => null, useState: (value) => [value, () => {}] };
    throw new Error(`unexpected require: ${id}`);
  });

  return { ding: windowStub.__DSH_DING__, audioContext, plays, notes: () => noteCount, listeners };
}

/* ---------- 场景 1：AudioContext 被挂起，resume 永不落地 ---------- */
{
  const env = load({ state: "suspended", resumeHangs: true });
  env.ding.ring();
  /* 给可能的微任务/定时器一点时间。 */
  await new Promise((resolve) => setTimeout(resolve, 400));

  if (env.plays.length === 0 && env.notes() === 0) {
    fail("resume() hung and nothing played: this is the intermittent silence the user reports");
  }
  ok(`suspended + hanging resume still produced audio (fallback plays: ${env.plays.length}, webaudio notes: ${env.notes()})`);
}

/* ---------- 场景 2：正常 running ---------- */
{
  const env = load({ state: "running" });
  env.ding.ring();
  await new Promise((resolve) => setTimeout(resolve, 60));
  if (env.notes() === 0) fail("a running context must use WebAudio");
  ok(`running context uses WebAudio (${env.notes()} notes, ${env.plays.length} fallback)`);
}

/* ---------- 场景 3：兜底 play() 也被拒一次 ---------- */
{
  const env = load({ state: "suspended", resumeHangs: true, playRejects: true });
  env.ding.ring();
  await new Promise((resolve) => setTimeout(resolve, 600));
  /* 播放被拒是浏览器策略的最终形态，这里只要求它被记录，而不是悄悄吞掉。 */
  const problems = env.ding.problems.join(" | ");
  if (problems === "") fail("a rejected playback must be recorded on the diagnostics face");
  ok(`rejected playback is recorded: ${problems}`);
}

console.log("OK  audio stall handling: hanging resume never silences the ring");
