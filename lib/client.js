/**
 * dsh-ding —— 浏览器半边（客户端 bundle）。
 *
 * 手写、零打包器、零运行期依赖：本文件就是 bundle 源，由 package.json 的
 * `dsh.client` + `exports["./client"]` 交给 DSH 宿主的模块系统。
 *
 * 包装格式照本机已在跑的第三方客户端 bundle：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 * 加载语义：执行 bundle 只登记 factory，所有副作用（订阅、样式注入）都在
 * materialization 时随 apply() 跑。
 *
 * 功能：
 *   ① 会话 running 位 true → false 时播放提示音（= 这一轮对话结束）。
 *      只认当前主会话，切会话时重新基线，不会一进页面就响。
 *   ② 设置项注册到「通用」页（settings.general.item）：开关 / 音色 / 音量 / 试听。
 *      偏好存 localStorage，不碰 Host settings，换版本不会因 schema 漂移挂掉。
 *
 * 纪律：
 *   - 不得 import/export、不得顶层 await、不得 require Node 内置模块；
 *     require("react") 是平台 baseline，安全。
 *   - 任何播放失败静默降级：先 WebAudio，再 WAV data-URI 的 <audio>，都没有就静音。
 *   - 页面加载/切会话时的“本来就已结束”不算结束，不响。
 */
window.__ModuleLoader__.load({
	id: "dsh-ding",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		//#region 偏好存储
		/** localStorage 键。 */
		var STORAGE_KEY = "dsh-ding:settings";
		/**
		 * 偏好格式版本。
		 * v2 起默认音色换成水滴；读到没有版本号的旧偏好时，只把音色升级成新默认，
		 * 用户自己的开关与音量原样保留。
		 */
		var SETTINGS_VERSION = 2;
		/** 出厂默认值。 */
		var DEFAULTS = { enabled: true, sound: "droplet", volume: 0.6 };
		/** 可选的音色。 */
		var SOUNDS = [
			{ id: "droplet", label: "水滴落水 · 叮咚" },
			{ id: "waterdrop", label: "水滴 · 清脆" },
			{ id: "waterdrop2", label: "水泡 · 圆润" },
			{ id: "plop", label: "石头落水 · 咕咚" },
			{ id: "ding", label: "叮 · 双音铃" },
			{ id: "chime", label: "铃 · 三连音" },
			{ id: "blip", label: "哒 · 短促" }
		];
		/**
		 * 主增益。多音符叠加后峰值会超过 1，留出余量避免削波。
		 */
		var MASTER = 0.72;
		/**
		 * resume() 最多等多久（毫秒）。超时就放弃 WebAudio、立刻走 <audio> 兜底 ——
		 * Chrome 在设备切换 / 休眠恢复后 resume 的 promise 可能永远不落地。
		 */
		var RESUME_TIMEOUT_MS = 120;

		/**
		 * 每种音色的合成配方。
		 *
		 * `tones` 一个音符是
		 * `[起频, 起播毫秒, 时长毫秒, 止频, 相对音量, 起音毫秒, 衰减tau毫秒, 滑音毫秒]`。
		 *
		 * 关键：**滑音时长**和**音符时长**是分开的。水滴之所以是水滴，
		 * 是因为音高在二三十毫秒里"蹿"上去，然后那个高音再挂一会儿慢慢消失；
		 * 如果音高跟着整个时长一路滑，听起来就是滑哨 / 激光枪，不是水。
		 *
		 * 包络 `(1−e^(−t/attack)) · e^(−t/tau)`，tau 是绝对时间常数。
		 *
		 * `noises` 一个噪声段是
		 * `[起播毫秒, 时长毫秒, 相对音量, 带通中心起频, 带通中心止频, Q, 衰减tau毫秒]`。
		 */
		var VOICES = {
			/**
			 * 水滴落水：一颗水滴砸到水面上的那一声「叮—咚」。
			 *
			 * 与 waterdrop 的区别：音高起点更高、滑音稍长（40ms），衰减 tau 40ms
			 * 留出水面的余韵，另加一记 12ms 后才起的水面涟漪音，
			 * 听感是「叮」后面拖一记小小的「咚」，不是干脆的单点。
			 */
			droplet: {
				tones: [
					/* 主滴：900→1650Hz，40ms 滑完，余韵 40ms。 */
					[900, 0, 150, 1650, 1, 2, 40, 40],
					/* 水面涟漪：12ms 后起，低一个八度，轻，负责「咚」那一下。 */
					[520, 12, 110, 780, 0.3, 4, 45, 55]
				],
				noises: [
					[0, 8, 0.3, 5200, 2200, 1.6, 3.5]
				]
			},
			/**
			 * 石头落水：低频的「咕咚」，重心在 60–300Hz。
			 *
			 * 石头入水与水滴相反 —— 音高**往下掉**（水被推开、腔体变大），
			 * 低频衰减较慢，前面压一记又宽又长的水声噪声（45ms），
			 * 听感是「咕」然后「咚」地沉下去。
			 */
			plop: {
				tones: [
					/* 主体：280→115Hz 下行滑音，80ms 滑完，tau 70ms 沉下去。 */
					[280, 0, 260, 115, 1, 5, 70, 80],
					/* 空腔：更低一层，给「咕」的胸腔共鸣。 */
					[130, 0, 300, 72, 0.55, 8, 95, 130]
				],
				noises: [
					/* 水被推开：45ms 宽带噪声，中心 1500→380Hz。 */
					[0, 45, 0.8, 1500, 380, 1.1, 13],
					/* 溅起来的细碎水花。 */
					[18, 26, 0.28, 3000, 1200, 1.5, 8]
				]
			},
			/**
			 * 水滴：一次「噗通」的脆响。
			 *
			 * 三个数字决定它像不像水（改动前先想清楚）：
			 *   · 音高 620→1500Hz，**30ms 内**滑完 —— 气泡塌陷时共振频率快速升高；
			 *   · 衰减 tau 只有 26ms —— 25ms 后就掉到 1/e，听感是「叮」不是「咻」；
			 *   · 总长 90ms —— 水滴是一下，不是一段音，拉长立刻变成电子哔。
			 */
			waterdrop: {
				tones: [
					[620, 0, 90, 1500, 1, 2, 26, 30],
					/* 低频衬底：给「噗」的体积感，别让声音只有高频一点。 */
					[250, 0, 75, 360, 0.18, 3, 30, 40]
				],
				noises: [
					/* 水花：6ms 宽带噪声，只负责起音那一下的"水"。 */
					[0, 6, 0.35, 4000, 1500, 1.4, 3]
				]
			},
			/**
			 * 水泡：滑音更慢更圆、音程更小，余韵更长，听感是「啵咚」。
			 */
			waterdrop2: {
				tones: [
					[300, 0, 240, 700, 1, 8, 95, 120],
					[600, 0, 180, 1300, 0.18, 6, 60, 100]
				],
				noises: [
					[0, 12, 0.32, 3000, 1000, 1.3, 6]
				]
			},
			ding: {
				tones: [
					[1174.7, 0, 900, 1174.7, 1, 12, 300, 0],
					[1568.0, 110, 900, 1568.0, 1, 12, 300, 0]
				]
			},
			chime: {
				tones: [
					[1046.5, 0, 620, 1046.5, 1, 12, 200, 0],
					[1318.5, 150, 620, 1318.5, 1, 12, 200, 0],
					[1568.0, 300, 820, 1568.0, 1, 12, 260, 0]
				]
			},
			blip: {
				tones: [[1760.0, 0, 110, 1760.0, 1, 2, 40, 0]]
			}
		};
		/**
		 * 一个音符在某个时刻的瞬时频率。
		 * @param spec - 音符规格。
		 * @param local - 相对该音符起点的秒数。
		 * @returns {number} 频率 Hz。
		 */
		function toneFrequency(spec, local) {
			var from = spec[0];
			var to = spec[3] === void 0 ? spec[0] : spec[3];
			if (to === from) return from;
			var glide = spec[7] === void 0 || spec[7] <= 0 ? spec[2] : spec[7];
			var progress = Math.min(1, Math.max(0, local / (glide / 1000)));
			return from * Math.pow(to / from, progress);
		}
		/**
		 * 读一份可用的偏好；坏数据静默回落到默认值。
		 * @returns {{enabled: boolean, sound: string, volume: number}} 规范化后的偏好。
		 */
		function readSettings() {
			var fallbackSound = DEFAULTS.sound;
			var fallback = { enabled: DEFAULTS.enabled, sound: fallbackSound, volume: DEFAULTS.volume };
			var raw;
			try {
				raw = window.localStorage.getItem(STORAGE_KEY);
			} catch (error) {
				return fallback;
			}
			if (raw === null || raw === "") return fallback;
			var parsed;
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				return fallback;
			}
			if (parsed === null || typeof parsed !== "object") return fallback;
			var volume = typeof parsed.volume === "number" && isFinite(parsed.volume) ? Math.max(0, Math.min(1, parsed.volume)) : DEFAULTS.volume;
			/* 旧格式（无版本号）里的音色一律换成新默认，开关与音量照用户原来的。 */
			var legacy = parsed.v !== SETTINGS_VERSION;
			var storedSound = legacy ? void 0 : parsed.sound;
			var sound = typeof storedSound === "string" && VOICES[storedSound] !== void 0 ? storedSound : fallbackSound;
			return { enabled: parsed.enabled !== false, sound: sound, volume: volume };
		}
		/**
		 * 写回偏好；不可写（隐私模式等）时保持内存态可用。
		 * @param next - 规整过的偏好。
		 */
		function writeSettings(next) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: SETTINGS_VERSION, enabled: next.enabled, sound: next.sound, volume: next.volume }));
			} catch (error) {
				/* 存储不可用只影响持久化，不影响本次会话的提示音。 */
			}
		}
		//#endregion

		//#region 提示音
		/**
		 * 诊断面：装没装上、响过几次、上一次什么时候。
		 * 浏览器控制台一句 `__DSH_DING__` 就能自证，也是验收脚本的探针。
		 */
		var diagnostics = {
			version: "0.6.2",
			rings: 0,
			lastRingAt: 0,
			/** 是否真的拿到了 uiSession 并挂上监听：验收靠这个字段自证。 */
			watching: false,
			/** 当前盯着的会话数（不含子代理）。 */
			watched: 0,
			/** 最近一次判定为“一轮结束”的会话 id。 */
			lastSession: void 0,
			/** 降级记录：DSH 升级把某个宿主 API 改掉时，这里会写下哪一块失效了。 */
			problems: [],
			/**
			 * 每一轮「判定 → 出声」的流水，最多留最近 40 条。
			 * 间歇性不响时，靠这个能看出到底是没判定、还是判定后没出声。
			 */
			trace: [],
			settings: function () {
				return readSettings();
			},
			ring: function () {
				ring(readSettings());
			},
			/** 音频通道现状：WebAudio 的 state，以及是否已被一次真实手势解锁。 */
			audio: function () {
				var ctx = getAudioContext();
				return {
					unlocked: audioUnlocked,
					state: ctx === void 0 ? "unsupported" : ctx.state,
					hasFallback: fallbackPlayer !== void 0
				};
			},
			/** 手动解锁一次（在控制台点一下就相当于一次手势）。 */
			unlock: function () {
				primeAudio();
				return diagnostics.audio();
			},
			/**
			 * 把某个音色渲染成 WAV data URI，用来离线验收/调参。
			 * @param sound - 音色 id，缺省用当前偏好。
			 * @param volume - 音量，缺省 0.6。
			 * @returns {string} data URI。
			 */
			render: function (sound, volume) {
				var id = typeof sound === "string" && VOICES[sound] !== void 0 ? sound : readSettings().sound;
				var level = typeof volume === "number" && isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.6;
				return buildWavDataUri(VOICES[id], level);
			},
			/** 当前可选的音色 id 列表。 */
			sounds: function () {
				return SOUNDS.map(function (sound) {
					return sound.id;
				});
			}
		};
		try {
			window.__DSH_DING__ = diagnostics;
		} catch (error) {
			/* 全局被占用不影响插件本体。 */
		}

		/**
		 * 记一条流水（环形缓冲，最多 40 条）。
		 * @param kind - 事件类型：`turn-end` / `ring` / `skip` / `audio`。
		 * @param detail - 附带的细节。
		 */
		function trace(kind, detail) {
			diagnostics.trace.push({ at: Date.now(), kind: kind, detail: detail });
			if (diagnostics.trace.length > 40) diagnostics.trace.shift();
		}

		/** 共享 AudioContext；懒创建，任何播放前尝试 resume。 */
		var audioContext;
		/** 是否已经在一次真实用户手势里解锁过音频。 */
		var audioUnlocked = false;
		/** 常驻的兜底播放器：在手势里先"哑播"一次，之后才能自由 play()。 */
		var fallbackPlayer;
		/**
		 * 取（或建）共享 AudioContext。
		 * @returns {AudioContext|undefined} 不可用平台返回 undefined。
		 */
		function getAudioContext() {
			if (audioContext !== void 0) return audioContext;
			var Ctor = window.AudioContext !== void 0 ? window.AudioContext : window.webkitAudioContext;
			if (Ctor === void 0) {
				audioContext = null;
				return void 0;
			}
			try {
				audioContext = new Ctor();
			} catch (error) {
				audioContext = null;
				return void 0;
			}
			return audioContext === null ? void 0 : audioContext;
		}
		/**
		 * 在用户手势里把音频通道打开。
		 *
		 * 浏览器的自动播放策略只允许在「手势处理函数」里 resume AudioContext 与
		 * 首次 play() 一个媒体元素。轮次结束是异步回调，不在手势里，所以必须提前
		 * 借一次真实点击/按键把两条路都解锁，之后才能在任意时刻出声。
		 *
		 * @returns {void}
		 */
		function primeAudio() {
			if (audioUnlocked) return;
			audioUnlocked = true;
			var ctx = getAudioContext();
			if (ctx !== void 0) {
				try {
					/* 手势内 resume 才会被采纳；顺手排一段 0 增益静音把上下文真正跑起来。 */
					var resumeResult = ctx.state === "running" ? void 0 : ctx.resume();
					if (resumeResult !== void 0 && typeof resumeResult.catch === "function") resumeResult.catch(function () {});
					var silent = ctx.createOscillator();
					var mute = ctx.createGain();
					mute.gain.value = 0;
					silent.connect(mute);
					mute.connect(ctx.destination);
					silent.start(ctx.currentTime);
					silent.stop(ctx.currentTime + 0.01);
				} catch (error) {
					/* 失败只代表这条通道不可用，兜底那条还在。 */
				}
			}
			try {
				if (fallbackPlayer === void 0) fallbackPlayer = new window.Audio(buildWavDataUri(VOICES[DEFAULTS.sound], 0.0001));
				fallbackPlayer.muted = true;
				var played = fallbackPlayer.play();
				if (played !== void 0 && typeof played.then === "function") {
					played.then(function () {
						fallbackPlayer.muted = false;
						fallbackPlayer.pause();
						fallbackPlayer.currentTime = 0;
					}, function () {
						/* 哑播被拒说明浏览器连手势都不认，后面每次尝试都会再走一遍。 */
					});
				}
			} catch (error) {
				/* 没有 Audio 构造器时只有 WebAudio 一条路。 */
			}
		}
		/**
		 * 装一次性手势监听：任何一个真实点击/按键都会把音频解锁。
		 * @returns {void}
		 */
		function installGestureUnlock() {
			var unlock = function () {
				primeAudio();
				if (!audioUnlocked) return;
				window.removeEventListener("pointerdown", unlock, true);
				window.removeEventListener("keydown", unlock, true);
				window.removeEventListener("touchstart", unlock, true);
			};
			window.addEventListener("pointerdown", unlock, true);
			window.addEventListener("keydown", unlock, true);
			window.addEventListener("touchstart", unlock, true);
		}
		/**
		 * 用 WebAudio 排一遍音色配方。
		 * @param ctx - 已 resume 的上下文。
		 * @param voice - 音色配方（`{ tones, noises }`）。
		 * @param volume - 0..1 音量。
		 */
		function scheduleScore(ctx, voice, volume) {
			var start = ctx.currentTime + 0.02;
			var tones = voice.tones === void 0 ? [] : voice.tones;
			var noises = voice.noises === void 0 ? [] : voice.noises;
			/* WebAudio 的 destination 不吃 MASTER，所以这里直接把总音量压下来。 */
			var level = volume * MASTER;
			for (var index = 0; index < tones.length; index++) {
				var note = tones[index];
				var oscillator = ctx.createOscillator();
				var gain = ctx.createGain();
				var begin = start + note[1] / 1000;
				var length = note[2] / 1000;
				var from = note[0];
				var to = note[3] === void 0 ? note[0] : note[3];
				oscillator.type = "sine";
				oscillator.frequency.setValueAtTime(from, begin);
				if (to !== from) {
					/* 只在前 glide 毫秒里滑上去，之后保持高音 —— 水滴的"蹿"就是这一行。 */
					var glide = note[7] === void 0 || note[7] <= 0 ? note[2] : Math.min(note[7], note[2]);
					oscillator.frequency.exponentialRampToValueAtTime(to, begin + glide / 1000);
				}
				/* 用采样曲线写包络：和兜底 WAV 走同一个函数，两条路听感一致。 */
				var curve = buildEnvelope(note, length, level, 256);
				try {
					gain.gain.setValueCurveAtTime(curve, begin, length);
				} catch (error) {
					gain.gain.setValueAtTime(0.0001, begin);
					gain.gain.linearRampToValueAtTime(Math.max(0.0001, curve[curve.length - 1]), begin + length);
				}
				oscillator.connect(gain);
				gain.connect(ctx.destination);
				oscillator.start(begin);
				oscillator.stop(begin + length + 0.005);
			}
			for (var noiseIndex = 0; noiseIndex < noises.length; noiseIndex++) {
				var nodes = createNoiseBurst(ctx, noises[noiseIndex], start, level);
				if (nodes === void 0) continue;
				nodes.source.start(nodes.begin);
				nodes.source.stop(nodes.begin + nodes.length + 0.005);
			}
		}
		/**
		 * 一个音符的振幅包络：`(1−e^(−t/attack)) · e^(−t/tau)`，再乘峰值。
		 *
		 * tau 是绝对时间常数（毫秒），不随时长拉伸 —— 水滴之所以像水滴，
		 * 就是因为它在这条曲线上 30ms 内就从峰值掉到几乎听不见。
		 *
		 * @param spec - 音符规格。
		 * @param lengthSeconds - 该音符的总时长。
		 * @param volume - 总音量 0..1。
		 * @param points - 采样点数。
		 * @returns {Float32Array} 可直接喂给 setValueCurveAtTime 的曲线。
		 */
		function buildEnvelope(spec, lengthSeconds, volume, points) {
			var attack = Math.max(0.0005, (spec[5] === void 0 ? 12 : spec[5]) / 1000);
			var tau = Math.max(0.002, (spec[6] === void 0 ? 300 : spec[6]) / 1000);
			var peak = volume * (spec[4] === void 0 ? 1 : spec[4]);
			var curve = new Float32Array(points);
			for (var index = 0; index < points; index++) {
				var time = (index / (points - 1)) * lengthSeconds;
				var rise = 1 - Math.exp(-time / attack);
				var fall = Math.exp(-time / tau);
				curve[index] = Math.max(0.0001, peak * rise * fall);
			}
			return curve;
		}
		/**
		 * 造一段带包络的带通噪声，用来做「入水那一记啪」。
		 * @param ctx - 音频上下文。
		 * @param burst - `[起播毫秒, 时长毫秒, 相对音量, 带通起频, 带通止频, Q, 衰减时间常数毫秒]`。
		 * @param start - 本次播放的时间原点。
		 * @param volume - 0..1。
		 * @returns {{source: AudioBufferSourceNode, begin: number, length: number}|undefined} 排好的节点。
		 */
		function createNoiseBurst(ctx, burst, start, volume) {
			var sampleRate = ctx.sampleRate === void 0 ? 44100 : ctx.sampleRate;
			var frames = Math.max(1, Math.floor(sampleRate * (burst[1] / 1000)));
			var buffer;
			try {
				buffer = ctx.createBuffer(1, frames, sampleRate);
			} catch (error) {
				return void 0;
			}
			var data = buffer.getChannelData(0);
			for (var index = 0; index < frames; index++) data[index] = Math.random() * 2 - 1;
			var source = ctx.createBufferSource();
			source.buffer = buffer;
			var filter = ctx.createBiquadFilter();
			filter.type = "bandpass";
			filter.Q.value = burst[5] === void 0 ? 1.2 : burst[5];
			var begin = start + burst[0] / 1000;
			var length = burst[1] / 1000;
			filter.frequency.setValueAtTime(burst[3], begin);
			filter.frequency.exponentialRampToValueAtTime(Math.max(60, burst[4]), begin + length);
			var gain = ctx.createGain();
			var curve = buildNoiseEnvelope(burst, length, volume, 128);
			try {
				gain.gain.setValueCurveAtTime(curve, begin, length);
			} catch (error) {
				gain.gain.setValueAtTime(0.0001, begin);
				gain.gain.linearRampToValueAtTime(Math.max(0.0001, volume * burst[2]), begin + length);
			}
			source.connect(filter);
			filter.connect(gain);
			gain.connect(ctx.destination);
			return { source: source, begin: begin, length: length };
		}
		/**
		 * 噪声段的包络：4ms 起音 + 指数衰减。
		 * @param burst - 噪声段规格。
		 * @param lengthSeconds - 时长。
		 * @param volume - 总音量。
		 * @param points - 采样点数。
		 * @returns {Float32Array} 曲线。
		 */
		function buildNoiseEnvelope(burst, lengthSeconds, volume, points) {
			var attack = Math.min(0.004, lengthSeconds * 0.5);
			var tau = Math.max(0.001, (burst[6] === void 0 ? 4 : burst[6]) / 1000);
			var peak = volume * burst[2];
			var curve = new Float32Array(points);
			for (var index = 0; index < points; index++) {
				var time = (index / (points - 1)) * lengthSeconds;
				var rise = 1 - Math.exp(-time / Math.max(0.0002, attack));
				var fall = Math.exp(-time / tau);
				curve[index] = Math.max(0.0001, peak * rise * fall);
			}
			return curve;
		}
		/**
		 * 用纯计算合成整份音色配方，作为 <audio> 的兜底路径。
		 * 与 WebAudio 那条走同一份 VOICES，所以两条路听起来是同一个声音。
		 * @param voice - 音色配方（`{ tones, noises }`）。
		 * @param volume - 0..1。
		 * @returns {string} `data:audio/wav;base64,…`
		 */
		function buildWavDataUri(voice, volume) {
			var sampleRate = 22050;
			var tailSeconds = 0.06;
			var tones = voice.tones === void 0 ? [] : voice.tones;
			var noises = voice.noises === void 0 ? [] : voice.noises;
			var spanSeconds = 0;
			for (var tone = 0; tone < tones.length; tone++) {
				spanSeconds = Math.max(spanSeconds, (tones[tone][1] + tones[tone][2]) / 1000);
			}
			for (var burst = 0; burst < noises.length; burst++) {
				spanSeconds = Math.max(spanSeconds, (noises[burst][0] + noises[burst][1]) / 1000);
			}
			var durationSeconds = spanSeconds + tailSeconds;
			var frames = Math.max(1, Math.floor(sampleRate * durationSeconds));
			var bytes = 44 + frames * 2;
			var buffer = new ArrayBuffer(bytes);
			var view = new DataView(buffer);
			var ascii = function (offset, text) {
				for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
			};
			ascii(0, "RIFF");
			view.setUint32(4, bytes - 8, true);
			ascii(8, "WAVE");
			ascii(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			ascii(36, "data");
			view.setUint32(40, frames * 2, true);

			/* 噪声段先算：两级一阶滤波（低通 + 高通）做出带通，系数始终 <1，构造上稳定。 */
			var noiseBuffer = new Float32Array(frames);
			var random = makeRandom(0x7f4a7c15);
			for (var segment = 0; segment < noises.length; segment++) {
				var spec = noises[segment];
				var offset = spec[0] / 1000;
				var length = spec[1] / 1000;
				var centerFrom = spec[3];
				var centerTo = spec[4];
				var q = spec[5] === void 0 ? 1.2 : spec[5];
				var tau = Math.max(0.001, (spec[6] === void 0 ? 4 : spec[6]) / 1000);
				var attack = Math.min(0.004, length * 0.5);
				var lowState = 0;
				var highState = 0;
				var band = new Float32Array(frames);
				var bandPeak = 0;
				for (var index = 0; index < frames; index++) {
					var local = index / sampleRate - offset;
					if (local < 0 || local > length) continue;
					var progress = local / length;
					/* 带通中心扫频；上限压在 Nyquist 的三分之一以下，任何采样率都不会炸。 */
					var center = Math.min(centerFrom * Math.pow(centerTo / centerFrom, progress), sampleRate * 0.3);
					var lowCoefficient = 1 - Math.exp(-2 * Math.PI * center * 1.6 / sampleRate);
					var highCoefficient = 1 - Math.exp(-2 * Math.PI * (center / (1 + q)) / sampleRate);
					var input = random() * 2 - 1;
					lowState += lowCoefficient * (input - lowState);
					highState += highCoefficient * (lowState - highState);
					band[index] = lowState - highState;
					if (Math.abs(band[index]) > bandPeak) bandPeak = Math.abs(band[index]);
				}
				/* 归一化：两级一阶滤波会吃掉一大半能量，不归一化那记「噼」就听不见，
				   整段声音只剩下正弦滑音 —— 那正是"不像水滴"的根源。 */
				var normalize = bandPeak > 1e-6 ? 1 / bandPeak : 0;
				for (var sampleIndex = 0; sampleIndex < frames; sampleIndex++) {
					var sampleTime = sampleIndex / sampleRate - offset;
					if (sampleTime < 0 || sampleTime > length) continue;
					var rise = 1 - Math.exp(-sampleTime / Math.max(0.0002, attack));
					var fall = Math.exp(-sampleTime / tau);
					noiseBuffer[sampleIndex] += band[sampleIndex] * normalize * rise * fall * spec[2];
				}
			}

			for (var frame = 0; frame < frames; frame++) {
				var time = frame / sampleRate;
				var mixed = noiseBuffer[frame];
				for (var note = 0; note < tones.length; note++) {
					var noteSpec = tones[note];
					var noteOffset = noteSpec[1] / 1000;
					var noteLength = noteSpec[2] / 1000;
					var noteLocal = time - noteOffset;
					if (noteLocal < 0 || noteLocal > noteLength) continue;
					var from = noteSpec[0];
					var to = noteSpec[3] === void 0 ? noteSpec[0] : noteSpec[3];
					/* 与 WebAudio 的 exponentialRamp 对齐：频率按指数走。 */
					var sweep = toneFrequency(noteSpec, noteLocal);
					var attack = Math.max(0.0005, (noteSpec[5] === void 0 ? 12 : noteSpec[5]) / 1000);
					var tau = Math.max(0.002, (noteSpec[6] === void 0 ? 300 : noteSpec[6]) / 1000);
					var peak = volume * (noteSpec[4] === void 0 ? 1 : noteSpec[4]);
					var amp = peak * (1 - Math.exp(-noteLocal / attack)) * Math.exp(-noteLocal / tau);
					mixed += Math.sin(2 * Math.PI * sweep * noteLocal) * amp;
				}
				mixed = Math.max(-1, Math.min(1, mixed * MASTER));
				view.setInt16(44 + frame * 2, mixed * 0x7fff, true);
			}
			var binary = "";
			var bytesView = new Uint8Array(buffer);
			for (var cursor = 0; cursor < bytesView.length; cursor++) binary += String.fromCharCode(bytesView[cursor]);
			return "data:audio/wav;base64," + window.btoa(binary);
		}
		/**
		 * 一个确定的伪随机源，让兜底 WAV 每次生成的结果可复现（便于频谱验收）。
		 * @param seed - 32 位种子。
		 * @returns {function(): number} 返回 [0,1) 的生成器。
		 */
		function makeRandom(seed) {
			var state = seed >>> 0;
			return function () {
				/* xorshift32 */
				state ^= state << 13;
				state >>>= 0;
				state ^= state >>> 17;
				state ^= state << 5;
				state >>>= 0;
				return state / 4294967296;
			};
		}
		/**
		 * 用 <audio> 播一段兜底音。
		 * @param voice - 音色配方。
		 * @param volume - 0..1。
		 * @returns {Promise<void>} 播放结果，失败即 reject（调用方吞掉）。
		 */
		function playFallback(voice, volume) {
			diagnostics.lastPath = "fallback";
			var source = buildWavDataUri(voice, volume);
			/* 优先复用解锁时那个常驻播放器：它的 play() 已被手势授权过。 */
			if (fallbackPlayer !== void 0) {
				try {
					fallbackPlayer.muted = false;
					fallbackPlayer.src = source;
					fallbackPlayer.currentTime = 0;
					var reused = fallbackPlayer.play();
					return reused === void 0 ? Promise.resolve() : reused;
				} catch (error) {
					/* 落到新建一个播放器。 */
				}
			}
			try {
				var player = new window.Audio(source);
				player.volume = 1;
				var started = player.play();
				return started === void 0 ? Promise.resolve() : started;
			} catch (error) {
				return Promise.reject(error);
			}
		}
		/**
		 * 兜底播放并把失败写进诊断面（不静默吞掉）。
		 * @param voice - 音色配方。
		 * @param volume - 0..1。
		 * @returns {void}
		 */
		function playFallbackSafely(voice, volume) {
			var started;
			try {
				started = playFallback(voice, volume);
			} catch (error) {
				return degrade("fallback playback threw: " + describe(error));
			}
			if (started !== void 0 && typeof started.then === "function") {
				started.then(void 0, function (error) {
					degrade("fallback playback rejected: " + describe(error));
				});
			}
		}
		/**
		 * 把任意异常描述成一行人话。
		 * @param error - 抛出的东西。
		 * @returns {string} 描述。
		 */
		function describe(error) {
			if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
			return String(error);
		}
		/**
		 * 播一次提示音。
		 *
		 * 关键：**绝不等待一个不会落地的 resume()**。
		 * Chrome 在设备切换、长时间闲置、系统休眠之后会把 AudioContext 挂起，
		 * 此时 `resume()` 返回的 promise 可能永远不 resolve —— 旧代码在这里静默，
		 * 表现就是「有时候不响」。现在改成：resume 最多等 RESUME_TIMEOUT_MS，
		 * 超时立刻走 <audio> 兜底，保证这一声响出来。
		 *
		 * @param settings - 当前偏好。
		 * @returns {void}
		 */
		function ring(settings) {
			if (!settings.enabled || settings.volume <= 0) {
				trace("skip", settings.enabled ? "volume is 0" : "disabled");
				return;
			}
			diagnostics.rings += 1;
			diagnostics.lastRingAt = Date.now();
			trace("ring", settings.sound + " @" + Math.round(settings.volume * 100) + "%");
			var voice = VOICES[settings.sound] !== void 0 ? VOICES[settings.sound] : VOICES[DEFAULTS.sound];
			var ctx = getAudioContext();
			if (ctx === void 0) {
				playFallbackSafely(voice, settings.volume);
				return;
			}
			if (ctx.state === "running") {
				try {
					scheduleScore(ctx, voice, settings.volume);
					diagnostics.lastPath = "webaudio";
					return;
				} catch (error) {
					degrade("webaudio scheduling failed: " + describe(error));
					playFallbackSafely(voice, settings.volume);
					return;
				}
			}
			/*
			 * 上下文不在 running：先尽力 resume，但只给它很短的时间。
			 * resume 未落地就用兜底 —— 宁可两条路都试，也不能一声不响。
			 */
			var settled = false;
			var fallBack = function (reason) {
				if (settled) return;
				settled = true;
				if (reason !== void 0) degrade("resume did not take: " + reason);
				playFallbackSafely(voice, settings.volume);
			};
			var resumed;
			try {
				resumed = ctx.resume();
			} catch (error) {
				fallBack("resume threw " + describe(error));
				return;
			}
			if (resumed === void 0 || typeof resumed.then !== "function") {
				fallBack("resume returned no promise");
				return;
			}
			resumed.then(function () {
				if (settled) return;
				if (ctx.state !== "running") {
					fallBack("context still " + ctx.state);
					return;
				}
				settled = true;
				try {
					scheduleScore(ctx, voice, settings.volume);
					diagnostics.lastPath = "webaudio";
				} catch (error) {
					degrade("webaudio scheduling failed: " + describe(error));
					playFallbackSafely(voice, settings.volume);
				}
			}, function (error) {
				fallBack("rejected " + describe(error));
			});
			/* 超时兜底：resume 悬空时也要保证出声。 */
			var setTimer = window.setTimeout !== void 0 ? window.setTimeout : void 0;
			if (setTimer !== void 0) {
				setTimer.call(window, function () {
					fallBack("timed out after " + RESUME_TIMEOUT_MS + "ms");
				}, RESUME_TIMEOUT_MS);
			}
		}
		//#endregion

		//#region 设置行
		/**
		 * 「通用」页里的一横行设置：开关 / 音色 / 音量 / 试听。
		 * 槽位 owner 不传任何 props，文案与组件全由本包自持。
		 * @returns {object} React 元素。
		 */
		function DingSettingsRow() {
			var state = React.useState(readSettings);
			var settings = state[0];
			var setSettings = state[1];

			var update = function (patch) {
				var next = {
					enabled: patch.enabled !== void 0 ? patch.enabled : settings.enabled,
					sound: patch.sound !== void 0 ? patch.sound : settings.sound,
					volume: patch.volume !== void 0 ? patch.volume : settings.volume
				};
				setSettings(next);
				writeSettings(next);
				return next;
			};

			var labelStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "22px" };
			var hintStyle = { color: "var(--dsw-alias-label-tertiary, #8a8a8a)", fontSize: "12px", lineHeight: "18px", marginTop: "2px" };
			var controlStyle = {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				flexWrap: "wrap",
				justifyContent: "flex-end"
			};
			var inputStyle = {
				background: "var(--dsw-specific-menu, transparent)",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
				borderRadius: "6px",
				fontSize: "13px",
				padding: "4px 8px",
				minWidth: "120px"
			};
			var buttonStyle = {
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, inherit)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
				borderRadius: "999px",
				fontSize: "12px",
				lineHeight: "20px",
				padding: "2px 12px",
				cursor: "pointer"
			};

			return React.createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "16px",
						padding: "16px 0",
						borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.22))",
						flexWrap: "wrap"
					}
				},
				React.createElement(
					"div",
					{ style: { minWidth: "180px", flex: "1 1 200px" } },
					React.createElement("div", { style: labelStyle }, "对话结束提示音"),
					React.createElement("div", { style: hintStyle }, "一轮对话结束时播放提示音 · plays a sound when a turn finishes")
				),
				React.createElement(
					"div",
					{ style: controlStyle },
					React.createElement(
						"label",
						{ style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--dsw-alias-label-secondary, inherit)", cursor: "pointer" } },
						React.createElement("input", {
							type: "checkbox",
							checked: settings.enabled,
							onChange: function (event) {
								update({ enabled: event.target.checked });
							}
						}),
						"启用"
					),
					React.createElement(
						"select",
						{
							value: settings.sound,
							disabled: !settings.enabled,
							style: inputStyle,
							onChange: function (event) {
								update({ sound: event.target.value });
							}
						},
						SOUNDS.map(function (sound) {
							return React.createElement("option", { key: sound.id, value: sound.id }, sound.label);
						})
					),
					React.createElement(
						"label",
						{ style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8a8a8a)" } },
						"音量",
						React.createElement("input", {
							type: "range",
							min: "0",
							max: "1",
							step: "0.05",
							value: settings.volume,
							disabled: !settings.enabled,
							style: { width: "88px" },
							onChange: function (event) {
								update({ volume: Number(event.target.value) });
							}
						}),
						React.createElement("span", { style: { minWidth: "30px", textAlign: "right" } }, Math.round(settings.volume * 100) + "%")
					),
					React.createElement(
						"button",
						{
							type: "button",
							style: buttonStyle,
							disabled: !settings.enabled,
							onClick: function () {
								ring(settings);
							}
						},
						"试听"
					)
				)
			);
		}
		//#endregion

		//#region 生命周期
		/**
		 * 需要注入的服务：主会话绑定、槽位注册表、会话对象层。
		 * `sessions` 用来直接拿当前会话的 SessionBinding —— 那条 `running` 位
		 * 比聚合状态表更靠前，是修复「偶尔漏响」的关键。
		 */
		var inject = ["uiSession", "slots", "sessions"];

		/**
		 * 判断一份对象是否像某个可订阅快照源。
		 * 用来在 DSH 换名字/换形状时提前退出，而不是在回调里抛异常把插件 fiber 打掉。
		 * @param candidate - 待检查的值。
		 * @returns 具备 getSnapshot 与 subscribe 时为 true。
		 */
		function isSource(candidate) {
			return candidate !== null && typeof candidate === "object" && typeof candidate.getSnapshot === "function" && typeof candidate.subscribe === "function";
		}

		/**
		 * 记一条降级原因。插件在升级后失配时只静音，不打断页面，但要在诊断面留痕。
		 * @param reason - 人可读的原因。
		 */
		function degrade(reason) {
			diagnostics.problems.push(reason);
			try {
				console.warn("[dsh-ding] degraded:", reason);
			} catch (error) {
				/* 控制台不可用不影响插件。 */
			}
		}

		/**
		 * 跑一段可能因宿主 API 变化而抛错的挂载代码。
		 * 单个部件失配只影响它自己，不连累另一半（设置行 / 监听器各自独立）。
		 * @param label - 部件名，用于降级记录。
		 * @param body - 实际挂载逻辑。
		 */
		function guard(label, body) {
			try {
				body();
			} catch (error) {
				degrade(label + ": " + (error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error)));
			}
		}

		/**
		 * 挂载：会话结束监听 + 通用设置行。两块各自独立，任一失配不连累另一块。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			/* 先装手势解锁：任何一次真实点击/按键都把音频通道打开，后面轮次结束才能出声。 */
			guard("audio unlock", function () {
				installGestureUnlock();
			});

			/* 设置行：owner 只给 id/order，行内文案与写路径都在本包里。 */
			guard("settings row", function () {
				if (ctx.slots === void 0 || typeof ctx.slots.inject !== "function") {
					degrade("settings row: ctx.slots.inject is unavailable");
					return;
				}
				ctx.slots.inject("settings.general.item", function () {
					try {
						return ctx.slots.register({ name: "settings.general.item", id: "ding", order: 40 }, DingSettingsRow);
					} catch (error) {
						/* 槽位被改名/改 kind 时只丢掉这一行，不打断插件。 */
						degrade("settings row: slot rejected the registration — " + (error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error)));
						return function () {};
					}
				});
			});

			/* 会话结束监听：任何一个「正经会话」跑完一轮都响，子代理不算。 */
			guard("turn-end watcher", function () {
				var uiSession = ctx.uiSession;
				if (uiSession === void 0) {
					degrade("turn-end watcher: ctx.uiSession is unavailable");
					return;
				}
				/*
				 * sessionStatus 不是致命依赖：它只是「路径一」。
				 * 形状不对就降级到 binding 单路，而不是整块监听都不装 ——
				 * 之前正是这一步把插件彻底静音了。
				 */
				if (!isSource(uiSession.sessionStatus)) {
					degrade("turn-end watcher: sessionStatus changed shape; continuing with the binding path only");
				}
				diagnostics.watching = true;
				ctx.effect(function () {
					/* 两条触发路径共用的去重：同一次结束别响两声。 */
					var lastRingSession;
					var lastRingAt = 0;
					/**
					 * 每条路径**各自**的上一拍 running，避免两条路互相把基线覆盖掉。
					 * 之前只用一个 Map，binding 的初始快照会盖掉聚合表已经观测到的 true，
					 * 于是那一次结束被当成「本来就空闲」而漏掉。
					 */
					var statusRunning = new Map();
					var bindingRunning = new Map();
					/** 每个会话的 SessionBinding 订阅。 */
					var watchers = new Map();

					/**
					 * 子代理会话不响：它们本来就短、数量又多，响了就是噪音。
					 * @param sessionId - 会话 id。
					 * @returns {boolean} 属于子代理时为 true。
					 */
					function isSubagent(sessionId) {
						var sessions = ctx.sessions;
						var list = sessions === void 0 ? void 0 : sessions.list;
						if (list === void 0) return false;
						var row = list.getSnapshot().byId[sessionId];
						return row !== void 0 && row !== null && row.origin === "subagent";
					}

					/**
					 * 判定一次「这一轮结束」并出声。
					 * @param sessionId - 结束的会话。
					 * @param source - 触发来源，写进流水便于排查。
					 * @returns {void}
					 */
					function finish(sessionId, source) {
						if (isSubagent(sessionId)) {
							trace("skip", "subagent turn ended: " + sessionId + " (" + source + ")");
							return false;
						}
						var stamp = Date.now();
						if (sessionId === lastRingSession && stamp - lastRingAt < 700) {
							trace("dedupe", sessionId + " via " + source);
							return false;
						}
						lastRingSession = sessionId;
						lastRingAt = stamp;
						diagnostics.lastSession = sessionId;
						trace("turn-end", sessionId + " via " + source);
						ring(readSettings());
						return true;
					}

					/**
					 * 记录一次 running 观测：真值→假值就判一次结束。
					 * @param previousMap - 该路径自己的上一拍表。
					 * @param sessionId - 会话。
					 * @param running - 本次观测值。
					 * @param source - 来源。
					 * @returns {void}
					 */
					function observe(previousMap, sessionId, running, source) {
						var previous = previousMap.get(sessionId);
						previousMap.set(sessionId, running);
						if (running === true && sessionId === lastRingSession) {
							/* 新一轮开始：清掉去重，下一轮结束必须能再响。 */
							lastRingSession = void 0;
							lastRingAt = 0;
						}
						if (previous === true && running !== true) finish(sessionId, source);
					}

					/**
					 * 给一个会话挂上 binding 监听。binding 比聚合表更靠前，
					 * 聚合表漏掉的翻转它能看到。
					 * @param sessionId - 会话 id。
					 * @returns {void}
					 */
					function watch(sessionId) {
						if (watchers.has(sessionId)) return;
						var sessions = ctx.sessions;
						if (sessions === void 0 || typeof sessions.binding !== "function") return;
						var binding = sessions.binding(sessionId);
						if (binding === void 0 || binding.session === void 0) return;
						var session = binding.session;
						bindingRunning.set(sessionId, session.getSnapshot().running === true);
						var dispose = session.subscribe(function () {
							observe(bindingRunning, sessionId, session.getSnapshot().running === true, "binding");
						});
						watchers.set(sessionId, dispose);
						diagnostics.watched = watchers.size;
					}

					/**
					 * 丢掉一个会话的 binding 监听（会话被移除 / 换掉）。
					 * @param sessionId - 会话 id。
					 * @returns {void}
					 */
					function unwatch(sessionId) {
						var dispose = watchers.get(sessionId);
						if (dispose === void 0) return;
						dispose();
						watchers.delete(sessionId);
						bindingRunning.delete(sessionId);
						statusRunning.delete(sessionId);
						diagnostics.watched = watchers.size;
					}

					/**
					 * 按当前会话列表补齐 / 清理监听。
					 *
					 * 这里是「有时候不响」的根因所在：早期版本只盯当前主会话，
					 * 一旦你切到别的会话（或在后台跑完），那一轮就再也没人看着。
					 * 现在改成盯**所有**会话，只有子代理排除。
					 * @returns {void}
					 */
					function reconcile() {
						var sessions = ctx.sessions;
						if (sessions === void 0 || sessions.list === void 0) return;
						var list = sessions.list.getSnapshot();
						var seen = new Set();
						for (var index = 0; index < list.ids.length; index++) {
							var id = list.ids[index];
							seen.add(id);
							watch(id);
						}
						var stale = [];
						watchers.forEach(function (_dispose, id) {
							if (!seen.has(id)) stale.push(id);
						});
						for (var drop = 0; drop < stale.length; drop++) unwatch(stale[drop]);
					}

					/*
					 * 路径一：聚合状态表。覆盖所有会话，即使暂时没有 binding 也能看到翻转。
					 */
					function onStatus() {
						var statusSource = uiSession.sessionStatus;
						if (!isSource(statusSource)) return;
						var statuses = statusSource.getSnapshot();
						if (statuses === void 0 || typeof statuses.forEach !== "function") return;
						statuses.forEach(function (status, sessionId) {
							observe(statusRunning, sessionId, status !== void 0 && status.running === true, "status");
						});
					}

					var sessions = ctx.sessions;
					var disposeList = function () {};
					if (sessions !== void 0 && sessions.list !== void 0 && isSource(sessions.list)) {
						reconcile();
						disposeList = sessions.list.subscribe(reconcile);
					}
					var disposeStatus = isSource(uiSession.sessionStatus) ? uiSession.sessionStatus.subscribe(onStatus) : function () {};
					/*
					 * 当前会话也要单独挂一次：列表快照可能还没把它收进来
					 * （刚新建、刚发送第一句），只靠 reconcile 会漏掉这一小段。
					 */
					var disposeCurrent = function () {};
					if (isSource(uiSession.current)) {
						var adoptCurrent = function () {
							var snapshot = uiSession.current.getSnapshot();
							if (snapshot !== void 0 && snapshot.key !== void 0) watch(snapshot.key);
						};
						adoptCurrent();
						disposeCurrent = uiSession.current.subscribe(adoptCurrent);
					}

					return function () {
						disposeStatus();
						disposeList();
						disposeCurrent();
						watchers.forEach(function (dispose) {
							dispose();
						});
						watchers.clear();
					};
				}, "dsh-ding: turn-end watcher");
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.DingSettingsRow = DingSettingsRow;
		return module.exports;
	}
});
