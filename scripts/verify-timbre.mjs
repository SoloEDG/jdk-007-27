// 临时验证脚本：mock Web Audio 节点图，验证每轨音色引擎的关键行为。
// 位于 src 之外的独立目录；用 TypeScript 转译后动态运行。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { transpileModule } from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "src");
const out = join(here, ".tmp-build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function load(rel, name, alias = {}) {
  const source = readFileSync(join(root, rel), "utf8");
  let code = transpileModule(source, {
    compilerOptions: { module: "esnext", target: "es2019" },
  }).outputText;
  for (const [from, to] of Object.entries(alias))
    code = code.replaceAll(`from "${from}"`, `from "${to}"`);
  code = code.replaceAll(
    "crypto.randomUUID()",
    `"id-${Math.random().toString(36).slice(2)}"`,
  );
  const path = join(out, name);
  writeFileSync(path, code);
  return pathToFileURL(path).href;
}
const u = {
  timbre: load("shared/timbre.ts", "timbre.js"),
  types: load("shared/types.ts", "types.js"),
  voices: load("features/instruments/lib/voices.ts", "voices.js", {
    "@/shared/timbre": "./timbre.js",
    "@/shared/types": "./types.js",
  }),
  engine: load("features/instruments/model/engine.ts", "engine.js", {
    "@/shared/types": "./types.js",
    "@/shared/timbre": "./timbre.js",
    "../lib/voices": "./voices.js",
  }),
  validation: load("features/arrangement/lib/validation.ts", "validation.js", {
    "@/shared/types": "./types.js",
    "@/shared/timbre": "./timbre.js",
  }),
};

// ---- mock Web Audio：所有节点登记到 registry，便于按图检查 ----
let clock = 1000;
const registry = { osc: [], gain: [], filter: [] };
class MockParam {
  constructor(value = 0) { this.value = value; this.calls = []; }
  setValueAtTime(v, t) { this.value = v; this.calls.push(["set", v, t]); }
  linearRampToValueAtTime(v, t) { this.calls.push(["lin", v, t]); }
  exponentialRampToValueAtTime(v, t) { this.calls.push(["exp", v, t]); }
  setTargetAtTime(v, t, tc) { this.calls.push(["target", v, t, tc]); this.value = v; }
  cancelScheduledValues(t) { this.calls.push(["cancel", t]); }
  cancelAndHoldAtTime(t) { this.calls.push(["hold", t]); }
}
class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.connected = []; this.disconnected = false;
    registry[kind].push(this);
  }
  connect(n) { this.connected.push(n); return n; }
  disconnect() { this.disconnected = true; }
}
class MockGain extends MockNode { constructor(ctx) { super(ctx, "gain"); this.gain = new MockParam(1); } }
class MockFilter extends MockNode {
  constructor(ctx) { super(ctx, "filter"); this.type = ""; this.frequency = new MockParam(1000); this.Q = new MockParam(1); }
}
class MockOsc extends MockNode {
  constructor(ctx) { super(ctx, "osc"); this.type = "triangle"; this.frequency = new MockParam(440); this.started = null; this.stopped = null; this.onended = null; }
  start(t) { if (this.started === null) this.started = t; }
  stop(t) { if (this.stopped === null) this.stopped = t; }
}
class MockContext {
  constructor() { this.currentTime = clock; this.sampleRate = 44100; this.state = "running"; this.destination = new MockGain(this); }
  createGain() { return new MockGain(this); }
  createBiquadFilter() { return new MockFilter(this); }
  createOscillator() { return new MockOsc(this); }
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
  async resume() { this.state = "running"; }
  async close() {}
}

const { createEngine } = await import(u.engine);
const { validateSession } = await import(u.validation);
const { DEFAULT_TIMBRE, WAVE_CROSSFADE } = await import(u.timbre);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log("  ✓", label); }
  else { fail++; console.log("  ✗ FAIL:", label); }
};
// 捕获一次引擎调用在该 bus 下新建的全部节点；按所属 context 隔离不同引擎。
// 立即执行并快照，保证多次 capture 的 play 调用顺序与书写顺序一致。
// 需要观察后续交叉淡化新节点的场景，用返回的 live 实时视图。
function captureOnce(ctx, fn) {
  const mine = (arr) => arr.filter((n) => n.ctx === ctx);
  const before = {
    osc: mine(registry.osc).length,
    gain: mine(registry.gain).length,
    filter: mine(registry.filter).length,
  };
  const bus = new MockGain(ctx);
  fn(bus);
  return {
    bus,
    osc: mine(registry.osc).slice(before.osc),
    gain: mine(registry.gain).slice(before.gain),
    filter: mine(registry.filter).slice(before.filter),
    // 实时视图：交叉淡化会在 play 之后新建振荡器/增益
    live: {
      get osc() { return mine(registry.osc).slice(before.osc); },
      get gain() { return mine(registry.gain).slice(before.gain); },
      get filter() { return mine(registry.filter).slice(before.filter); },
    },
  };
}
const liveEngines = [];
async function newEngine() {
  // 释放上一个引擎，避免其闭包内残留声音在共享时钟下被误回收，干扰本块断言
  while (liveEngines.length) {
    const prev = liveEngines.pop();
    prev.dispose();
  }
  clock = 1000;
  const context = new MockContext();
  const engine = createEngine(context);
  liveEngines.push(engine);
  const buses = {};
  engine.route((id) => buses[id]);
  await engine.unlock();
  const tick = (sec) => { clock += sec; engine.context.currentTime = clock; };
  return { engine, buses, tick, context };
}
// amp（包络增益）是带自动化调用、且不连接到一次性 bus 的增益；
// 振荡器淡入淡出增益也会有 lin 调用，因此用“连接到滤波器”排除 oscBus 后，
// 再取有自动化调用者。链路：osc->g->oscBus->filter->amp->levelGain->bus
const ampOf = (cap) => {
  const beforeFilter = cap.gain.filter((g) => !g.connected.includes(cap.filter[0]));
  return beforeFilter.find((g) => g.gain.calls.length > 0 && !g.connected.includes(cap.bus));
};
const levelGainOf = (cap) =>
  cap.gain.find((g) => g.connected.includes(cap.bus));

console.log("\n[1] 发声时读取已确认音色（注册表快照，不被排队时旧值绑死）");
{
  const { engine, buses, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "sine", cutoff: 3000, resonance: 2 }, false);
  const cap = captureOnce(context, (bus) => { buses.A = bus; engine.play({ instrument: "keys", pitch: 69, velocity: 0.8, duration: 1, when: clock, trackId: "A" }); });
  ok(cap.osc.length === 1 && cap.osc[0].type === "sine", "振荡器按已确认音色建为正弦波");
  ok(cap.filter[0].frequency.value === 3000 && cap.filter[0].Q.value === 2, "滤波器使用已确认的截止/谐振");
  ok(cap.osc[0].stopped !== null, "排队音符（无 key）按包络自动安排停止时间");
}

console.log("\n[2] 按住声音：松键严格按当时音色的 release 结算");
{
  const { engine, buses, tick, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, envelope: { ...DEFAULT_TIMBRE.envelope, release: 0.2 } }, false);
  const cap = captureOnce(context, (b) => { buses.A = b; engine.play({ instrument: "keys", pitch: 60, velocity: 0.7, duration: 6, when: clock, trackId: "A" }, "piano:60"); });
  const heldVoice = engine.inspect().heldVoice("piano:60");
  ok(heldVoice && heldVoice.end === Infinity, "按住声音 end=Infinity，不会被定时回收");
  ok(cap.osc[0].stopped === null, "按住振荡器未预设停止时间");
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, envelope: { ...DEFAULT_TIMBRE.envelope, release: 0.9 } }, true);
  tick(0.2);
  engine.release("piano:60");
  const lastTarget = ampOf(cap).gain.calls.filter((c) => c[0] === "target").at(-1);
  ok(heldVoice.end !== Infinity, "松键后获得具体结束时间");
  ok(lastTarget && Math.abs(lastTarget[3] - 0.9 / 3) < 1e-9, `释放时间常数按松键时 release=0.9 结算（得到 ${lastTarget?.[3]}）`);
  ok(cap.osc.every((o) => o.stopped !== null), "松键后振荡器被安排在释放结束处停止");
}

console.log("\n[3] 波形切换：短交叉淡化，不重启音符/不重触发包络");
{
  const { engine, buses, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "sine" }, false);
  const cap = captureOnce(context, (b) => { buses.A = b; engine.play({ instrument: "keys", pitch: 64, velocity: 0.7, duration: 6, when: clock, trackId: "A" }, "piano:64"); });
  const firstOsc = cap.osc[0];
  ok(firstOsc.type === "sine" && firstOsc.stopped === null, "初始正弦、按住中无停止时间");
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "square" }, true);
  // 淡化在 play 之后新建节点，用实时视图观察
  const liveOsc = cap.live.osc;
  const liveGain = cap.live.gain;
  ok(liveOsc.length === 2, "新增第二个振荡器做淡化，而非重建整个声音");
  ok(liveOsc[1].type === "square", "新振荡器为方波");
  const fadeOut = liveGain.some((g) => g.gain.calls.some((c) => c[0] === "lin" && c[1] === 0.0001));
  const fadeIn = liveGain.some((g) => g.gain.calls.some((c) => c[0] === "lin" && c[1] === 1));
  ok(fadeOut && fadeIn, "旧振荡器淡出、新振荡器淡入（交叉淡化）");
  const fadeSpan = liveGain.flatMap((g) => g.gain.calls).find((c) => c[0] === "lin" && c[1] === 1);
  ok(fadeSpan && fadeSpan[2] <= clock + WAVE_CROSSFADE + 1e-6, `交叉淡化为短时长 ${WAVE_CROSSFADE}s`);
  ok(firstOsc.stopped === null, "按住中旧振荡器只淡出不立即停止（不打断音符）");
  const attackResets = ampOf(cap).gain.calls.filter((c) => c[0] === "set" && c[1] === 0.0001);
  ok(attackResets.length === 1, "包络仅起音一次，换波形未重触发");
}

console.log("\n[4] 连续参数平滑作用于已按住的声音");
{
  const { engine, buses, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "square" }, false);
  const cap = captureOnce(context, (b) => { buses.A = b; engine.play({ instrument: "keys", pitch: 64, velocity: 0.7, duration: 6, when: clock, trackId: "A" }, "piano:64"); });
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "square", cutoff: 880, resonance: 6, level: 0.2 }, true);
  ok(cap.filter[0].frequency.calls.some((c) => c[0] === "target" && c[1] === 880), "截止频率平滑到 880Hz");
  ok(cap.filter[0].Q.calls.some((c) => c[0] === "target" && c[1] === 6), "谐振平滑更新");
  ok(levelGainOf(cap).gain.calls.some((c) => c[0] === "target" && c[1] === 0.2), "音色音量平滑更新");
}

console.log("\n[5] 换轨不串用参数：各轨独立波形");
{
  const { engine, buses, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "square" }, false);
  engine.registerTimbre("B", { ...DEFAULT_TIMBRE, waveform: "sawtooth" }, false);
  const capA = captureOnce(context, (b) => { buses.A = b; engine.play({ instrument: "keys", pitch: 60, velocity: 0.7, duration: 6, when: clock, trackId: "A" }, "kA"); });
  const capB = captureOnce(context, (b) => { buses.B = b; engine.play({ instrument: "keys", pitch: 72, velocity: 0.7, duration: 6, when: clock, trackId: "B" }, "kB"); });
  ok(capA.osc.length === 1 && capA.osc[0].type === "square", "A 轨声音使用本轨方波");
  ok(capB.osc.length === 1 && capB.osc[0].type === "sawtooth", "B 轨声音使用本轨锯齿波，互不串用");
}

console.log("\n[6] 音色试听：草稿隔离 + 取消清理临时节点 + 不影响正式声音");
{
  const { engine, buses, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE, waveform: "triangle" }, false);
  const liveCap = captureOnce(context, (b) => { buses.A = b; engine.play({ instrument: "keys", pitch: 60, velocity: 0.7, duration: 6, when: clock, trackId: "A" }, "hold"); });
  const prevCap = captureOnce(context, (b) => { buses.A = b; engine.previewTimbre("A", { ...DEFAULT_TIMBRE, waveform: "sawtooth" }); });
  ok(engine.inspect().previews === 1, "试听进入临时预览表");
  ok(prevCap.osc[0].type === "sawtooth", "试听使用草稿锯齿波");
  ok(liveCap.osc[0].type === "triangle", "正式声音仍用已确认三角波，未被草稿改动");
  engine.patchPreview("A", { ...DEFAULT_TIMBRE, waveform: "square" });
  ok(prevCap.live.osc.at(-1).type === "square", "试听中拖动可平滑变化");
  const previewVoice = engine.inspect().preview("A");
  engine.stopPreview();
  ok(engine.inspect().previews === 0, "取消后预览表清空");
  ok(previewVoice.end !== Infinity, "试听临时节点被停止清理");
  const after = engine.inspect();
  ok(after.voices === 1 && after.held === 1, "正式演奏声音不受取消试听影响");
}

console.log("\n[7] cancel 清空声音、按住与试听");
{
  const { engine, context } = await newEngine();
  engine.registerTimbre("A", { ...DEFAULT_TIMBRE }, false);
  engine.previewTimbre("A", { ...DEFAULT_TIMBRE });
  engine.cancel();
  const s = engine.inspect();
  ok(s.voices === 0 && s.held === 0 && s.previews === 0, "cancel 全部清空");
}

console.log("\n[8] 鼓组不受音色影响（无低通音色链，走原合成）");
{
  const { engine, buses, context } = await newEngine();
  const cap = captureOnce(context, (b) => { buses.D = b; engine.play({ instrument: "drums", pitch: 0, velocity: 0.9, duration: 0.3, when: clock, trackId: "D" }); });
  ok(cap.filter.length === 0 && cap.osc.length === 1, "底鼓仍为原振荡器直连，无低通音色链");
}

console.log("\n[9] 校验：旧存档（无 timbre）迁移为三角波默认值");
{
  const legacy = baseSession();
  delete legacy.tracks[1].timbre;
  delete legacy.tracks[2].timbre;
  const migrated = validateSession(legacy);
  ok(migrated.tracks[1].timbre && migrated.tracks[1].timbre.waveform === "triangle", "旧琴键轨迁移为三角波");
  ok(JSON.stringify(migrated.tracks[1].timbre) === JSON.stringify(DEFAULT_TIMBRE), "迁移结果等于默认音色");
  ok(migrated.tracks[0].timbre === null, "鼓组轨保持 null");
}

console.log("\n[10] 校验：音色损坏时拒绝整次加载（不混入当前作品）");
{
  const cases = [
    [{ ...DEFAULT_TIMBRE, cutoff: 999999 }, "截止越界"],
    [{ waveform: "square" }, "半套音色缺字段"],
    [{ ...DEFAULT_TIMBRE, envelope: { ...DEFAULT_TIMBRE.envelope, release: -1 } }, "release 非法"],
    [{ ...DEFAULT_TIMBRE, waveform: "moog" }, "波形枚举非法"],
    [{ ...DEFAULT_TIMBRE, level: 2 }, "level 越界"],
  ];
  for (const [bad, label] of cases) {
    const s = baseSession();
    s.tracks[1].timbre = bad;
    let threw = false;
    try { validateSession(s); } catch { threw = true; }
    ok(threw, `${label} → 抛错拒绝整次加载`);
  }
  const drumBad = baseSession();
  drumBad.tracks[0].timbre = DEFAULT_TIMBRE;
  let threw = false;
  try { validateSession(drumBad); } catch { threw = true; }
  ok(threw, "鼓组轨误带音色 → 拒绝");
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);

function baseSession() {
  return {
    version: 1, title: "t", bpm: 108, beats: 16, master: 0.7,
    channels: {
      d: { volume: 0.8, muted: false },
      k: { volume: 0.7, muted: false },
      k2: { volume: 0.7, muted: false },
    },
    tracks: [
      { id: "d", name: "鼓", instrument: "drums", color: "#123456", timbre: null, notes: [] },
      { id: "k", name: "琴1", instrument: "keys", color: "#123456", timbre: structuredClone(DEFAULT_TIMBRE), notes: [] },
      { id: "k2", name: "琴2", instrument: "keys", color: "#654321", timbre: structuredClone(DEFAULT_TIMBRE), notes: [] },
    ],
  };
}
