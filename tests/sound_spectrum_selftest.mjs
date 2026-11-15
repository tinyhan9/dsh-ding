/**
 * 音色验收：把每个音色真渲染成 WAV，做客观声学分析，确认它是不是「水滴」。
 *
 * 判据（水滴声的物理特征，按重要性排序）：
 *   ① 音高**上滑**：气泡塌陷时共振频率升高，滑音前的基频明显低于滑音后；
 *   ② 滑音**快**：几十毫秒内完成，慢了就成滑哨 / 警报；
 *   ③ 起音有**水花噪声**：波形跳变剧烈（lag-1 自相关低），纯正弦是电子音；
 *   ④ 总时长**短**：水滴是「叮」的一下，不是一段旋律；
 *   ⑤ 不削波、峰值够响。
 *
 * 跑法：node tests/sound_spectrum_selftest.mjs [输出目录]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
const outputDir = process.argv[2] ?? process.env.SOUND_OUT_DIR ?? null;

/* ---------- 在沙箱里加载 bundle，拿到诊断面 ---------- */
const registrations = new Map();
const windowStub = {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  btoa: (text) => Buffer.from(text, "binary").toString("base64"),
  /* 刻意不给 AudioContext：强制走纯计算渲染，这样能直接分析采样。 */
  Audio: function Audio() {
    this.play = () => Promise.resolve();
    this.pause = () => {};
  },
  __ModuleLoader__: {
    load(registration) {
      registrations.set(registration.id, registration.factory);
    }
  }
};
const reactStub = { createElement: () => null, useState: (value) => [value, () => {}] };
const sandbox = {
  window: windowStub,
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
  require: (id) => {
    if (id === "react") return reactStub;
    throw new Error(`unexpected require: ${id}`);
  },
  console: { log() {}, warn() {}, error() {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "dsh-ding/lib/client.js" });

const factory = registrations.get("dsh-ding");
if (factory === undefined) throw new Error("bundle did not register under id dsh-ding");
factory((id) => {
  if (id === "react") return reactStub;
  throw new Error(`unexpected require: ${id}`);
});
const ding = windowStub.__DSH_DING__;
if (ding === undefined) throw new Error("diagnostics face is missing");

/* ---------- 分析工具 ---------- */
/**
 * 把 WAV data URI 解成归一化采样。
 * @param {string} dataUri - 音频 data URI。
 * @returns {{samples: Float32Array, sampleRate: number}} 采样与采样率。
 */
function decodeWav(dataUri) {
  const wav = Buffer.from(String(dataUri).replace(/^data:audio\/wav;base64,/u, ""), "base64");
  const sampleRate = wav.readUInt32LE(24);
  const frames = wav.readUInt32LE(40) / 2;
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index++) samples[index] = wav.readInt16LE(44 + index * 2) / 32768;
  return { samples, sampleRate, wav };
}

/**
 * 估一段窗内的基频：先一阶低通到 1.1kHz 压掉泛音与噪声，再数过零。
 * @param {Float32Array} samples - 采样。
 * @param {number} sampleRate - 采样率。
 * @param {number} from - 窗起（秒）。
 * @param {number} to - 窗止（秒）。
 * @returns {number} 频率 Hz，窗内无声返回 0。
 */
function baseFrequency(samples, sampleRate, from, to) {
  const start = Math.max(1, Math.floor(from * sampleRate));
  const end = Math.min(samples.length - 1, Math.floor(to * sampleRate));
  if (end <= start) return 0;
  const coefficient = 1 - Math.exp((-2 * Math.PI * 1100) / sampleRate);
  let low = 0;
  let previous = 0;
  let crossings = 0;
  let energy = 0;
  for (let index = start; index < end; index++) {
    low += coefficient * (samples[index] - low);
    energy += low * low;
    if (index > start && ((previous < 0 && low >= 0) || (previous >= 0 && low < 0))) crossings += 1;
    previous = low;
  }
  if (Math.sqrt(energy / (end - start)) < 1e-4) return 0;
  return crossings / 2 / ((end - start) / sampleRate);
}

/**
 * lag-1 归一化自相关：纯音接近 1，噪声接近 0。用来判断起音有没有水花噪声。
 * @param {Float32Array} samples - 采样。
 * @param {number} sampleRate - 采样率。
 * @param {number} from - 窗起（秒）。
 * @param {number} to - 窗止（秒）。
 * @returns {number} 相关系数。
 */
function lagOneCorrelation(samples, sampleRate, from, to) {
  const start = Math.max(1, Math.floor(from * sampleRate));
  const end = Math.min(samples.length, Math.floor(to * sampleRate));
  let numerator = 0;
  let energy = 0;
  for (let index = start; index < end; index++) {
    numerator += samples[index] * samples[index - 1];
    energy += samples[index] * samples[index];
  }
  return energy === 0 ? 1 : numerator / energy;
}

/**
 * 峰值。
 * @param {Float32Array} samples - 采样。
 * @returns {number} 峰值绝对值。
 */
function peakOf(samples) {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  return peak;
}

/* ---------- 逐个音色验收 ---------- */
const sounds = ding.sounds();
if (!sounds.includes("waterdrop")) throw new Error(`waterdrop is missing from ${sounds.join(",")}`);

const results = [];
for (const sound of sounds) {
  const { samples, sampleRate, wav } = decodeWav(ding.render(sound, 0.6));
  const durationSeconds = samples.length / sampleRate;
  const peak = peakOf(samples);
  const onset = lagOneCorrelation(samples, sampleRate, 0.0005, 0.006);
  const body = lagOneCorrelation(samples, sampleRate, 0.055, 0.085);
  const early = baseFrequency(samples, sampleRate, 0.008, 0.016);
  const late = baseFrequency(samples, sampleRate, 0.055, 0.09);

  results.push({ sound, durationSeconds, peak, onset, body, early, late, bytes: wav.length });
  if (outputDir !== null) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, `${sound}.wav`), wav);
  }
}

for (const row of results) {
  console.log(
    `${row.sound.padEnd(11)} ${(row.durationSeconds * 1000).toFixed(0).padStart(4)}ms  ` +
      `peak ${row.peak.toFixed(2)}  ` +
      `pitch ${row.early.toFixed(0)}→${row.late.toFixed(0)}Hz  ` +
      `lag1 onset ${row.onset.toFixed(2)} / body ${row.body.toFixed(2)}`,
  );
}

/* 每个音色的硬指标：有声、不削波。 */
for (const row of results) {
  if (row.peak <= 0.02) throw new Error(`${row.sound} is silent`);
  if (row.peak >= 0.99) throw new Error(`${row.sound} clips`);
}

/* 水滴落水（droplet）：短、音高上滑、有水花噪声。 */
const droplet = results.find((row) => row.sound === "droplet");
if (droplet === undefined) throw new Error("droplet is missing");
if (droplet.durationSeconds > 0.4) throw new Error(`droplet is too long: ${droplet.durationSeconds.toFixed(2)}s`);
if (!(droplet.late > droplet.early * 1.2)) {
  throw new Error(`droplet pitch must rise: ${droplet.early.toFixed(0)} → ${droplet.late.toFixed(0)}Hz`);
}

/* 石头落水（plop）：音高必须**下行**（石头把水推开，腔体变大），且落点要低。 */
const plop = results.find((row) => row.sound === "plop");
if (plop === undefined) throw new Error("plop is missing");
if (plop.durationSeconds > 0.6) throw new Error(`plop is too long: ${plop.durationSeconds.toFixed(2)}s`);
if (!(plop.late < plop.early * 0.6)) {
  throw new Error(`plop pitch must fall: ${plop.early.toFixed(0)} → ${plop.late.toFixed(0)}Hz`);
}
if (plop.late > 200) throw new Error(`plop must settle into the low register, got ${plop.late.toFixed(0)}Hz`);
if (!(plop.onset < 0.9)) throw new Error(`plop onset must be noisy (water pushed aside), lag1 ${plop.onset.toFixed(2)}`);

console.log("OK  droplet rises like a drop; plop falls like a stone; nothing clips");
if (outputDir !== null) console.log(`wav samples written to ${outputDir}`);
