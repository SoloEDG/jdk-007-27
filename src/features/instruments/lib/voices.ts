import type { ScheduledNote } from "@/shared/types";
import {
  DEFAULT_TIMBRE,
  WAVE_CROSSFADE,
  type Timbre,
  type WaveKind,
} from "@/shared/timbre";
export type Voice = {
  stop: () => void;
  /** 引擎据此回收已结束的声音；按住中的声音为 Infinity。 */
  end: number;
  /** 连续参数与波形的实时更新；鼓组声音不提供。 */
  patch?: (next: Timbre, fade: number) => void;
};
export function synthesize(
  ctx: AudioContext,
  output: AudioNode,
  note: ScheduledNote,
  timbre: Timbre | null,
  held = false,
): Voice {
  if (note.instrument === "drums") return synthesizeDrums(ctx, output, note);
  // 正常路径下引擎总会注册琴键轨音色；fallback 仅用于防御性兜底。
  return synthesizeKey(ctx, output, note, timbre ?? DEFAULT_TIMBRE, held);
}
function synthesizeDrums(
  ctx: AudioContext,
  output: AudioNode,
  note: ScheduledNote,
): Voice {
  const when = Math.max(ctx.currentTime, note.when);
  const gain = ctx.createGain();
  gain.connect(output);
  const sources: AudioScheduledSourceNode[] = [];
  const length = note.pitch === 0 ? 0.38 : note.pitch === 1 ? 0.22 : 0.12;
  const amp = Math.max(0.001, note.velocity) * 0.35;
  if (note.pitch === 0) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(145, when);
    osc.frequency.exponentialRampToValueAtTime(42, when + 0.18);
    osc.connect(gain);
    sources.push(osc);
  } else {
    const buffer = ctx.createBuffer(
      1,
      Math.ceil(ctx.sampleRate * length),
      ctx.sampleRate,
    );
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = note.pitch === 1 ? 1000 : 6500;
    source.connect(filter);
    filter.connect(gain);
    sources.push(source);
  }
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(amp, when + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const s of sources) {
      try {
        s.stop();
      } catch {}
    }
    gain.disconnect();
  };
  let ended = 0;
  for (const source of sources) {
    source.onended = () => {
      ended++;
      if (ended === sources.length) {
        gain.disconnect();
        stopped = true;
      }
    };
    source.start(when);
    source.stop(when + length + 0.02);
  }
  return { stop, end: when + length + 0.02 };
}
function synthesizeKey(
  ctx: AudioContext,
  output: AudioNode,
  note: ScheduledNote,
  timbre: Timbre,
  held: boolean,
): Voice {
  const when = Math.max(ctx.currentTime, note.when);
  const length = Math.max(0.08, note.duration);
  const freq = 440 * 2 ** ((note.pitch - 69) / 12);
  // 链路：振荡器(组) -> 低通滤波 -> 包络增益 -> 音色音量 -> 混音总线
  const levelGain = ctx.createGain();
  levelGain.gain.value = timbre.level;
  const amp = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = timbre.cutoff;
  filter.Q.value = timbre.resonance;
  filter.connect(amp);
  amp.connect(levelGain);
  levelGain.connect(output);
  const live = new Set<AudioScheduledSourceNode>();
  const track = (s: AudioScheduledSourceNode) => {
    live.add(s);
    s.onended = () => {
      live.delete(s);
      if (live.size === 0) {
        try {
          oscBus.disconnect();
          amp.disconnect();
          levelGain.disconnect();
        } catch {}
      }
    };
  };
  // 每个振荡器挂在独立增益后汇入滤波，波形切换时做短交叉淡化。
  const oscBus = ctx.createGain();
  oscBus.connect(filter);
  let activeOsc: OscillatorNode;
  let activeGain: GainNode;
  // 排队声音的硬停止时刻；按住中为 Infinity，松键时再确定。
  let hardStopAt = Infinity;
  let end = Infinity;
  const spawnOsc = (kind: WaveKind, gainValue: number) => {
    const osc = ctx.createOscillator();
    osc.type = kind;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gainValue;
    osc.connect(g);
    g.connect(oscBus);
    track(osc);
    // 按住中的声音无硬停止时间，由松键/取消统一停止；
    // 排队声音在自身结束点停止，包括淡化后新换入的振荡器。
    if (hardStopAt !== Infinity) osc.stop(hardStopAt + 0.05);
    return { osc, g };
  };
  const first = spawnOsc(timbre.waveform, 1);
  activeOsc = first.osc;
  activeGain = first.g;
  let current = timbre;
  let released = false;
  let stopped = false;
  const peak = () => Math.max(0.0002, note.velocity * current.level);
  const sustainLevel = () => Math.max(0.0001, peak() * current.envelope.sustain);
  // 起音与衰减阶段
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.linearRampToValueAtTime(peak(), when + current.envelope.attack);
  amp.gain.setTargetAtTime(
    sustainLevel(),
    when + current.envelope.attack,
    Math.max(0.001, current.envelope.decay / 3),
  );
  if (!held) {
    // 排队/循环音符：到点自动进入释放阶段
    const releaseAt = when + length;
    amp.gain.cancelAndHoldAtTime(releaseAt);
    amp.gain.setTargetAtTime(
      0.0001,
      releaseAt,
      Math.max(0.001, current.envelope.release / 3),
    );
    end = releaseAt + current.envelope.release * 2 + 0.1;
    hardStopAt = end;
    activeOsc.stop(hardStopAt + 0.05);
  }
  activeOsc.start(when);
  const morphWave = (kind: WaveKind, fade: number) => {
    if (released || stopped || activeOsc.type === kind) return;
    const now = ctx.currentTime;
    const oldOsc = activeOsc;
    const oldGain = activeGain;
    const next = spawnOsc(kind, 0.0001);
    next.g.gain.setValueAtTime(0.0001, now);
    next.g.gain.linearRampToValueAtTime(1, now + fade);
    next.osc.start(now);
    oldGain.gain.cancelScheduledValues(now);
    oldGain.gain.setValueAtTime(Math.max(0.0001, oldGain.gain.value), now);
    oldGain.gain.linearRampToValueAtTime(0.0001, now + fade);
    if (hardStopAt !== Infinity) {
      try {
        oldOsc.stop(Math.max(now + fade, hardStopAt + 0.05));
      } catch {}
    }
    activeOsc = next.osc;
    activeGain = next.g;
  };
  const patch = (next: Timbre, fade: number) => {
    if (released || stopped) return;
    const now = ctx.currentTime;
    // 连续参数平滑变化，立即作用于已经按住的声音
    filter.frequency.setTargetAtTime(next.cutoff, now, 0.015);
    filter.Q.setTargetAtTime(next.resonance, now, 0.015);
    levelGain.gain.setTargetAtTime(next.level, now, 0.02);
    // 波形切换走短交叉淡化，不重启音符、不重触发包络
    morphWave(next.waveform, fade);
    if (held) {
      // 按住中拖动：把持续段平滑带到新的音量/持续电平
      current = next;
      amp.gain.setTargetAtTime(
        sustainLevel(),
        now,
        Math.max(0.001, next.envelope.decay / 3),
      );
    } else {
      current = next;
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    if (held && !released) {
      // 释放阶段严格按松键这一刻该轨的音色设置结算
      released = true;
      const r = current.envelope.release;
      const hold = Math.max(0.0001, amp.gain.value);
      amp.gain.cancelAndHoldAtTime(now);
      amp.gain.setValueAtTime(hold, now);
      amp.gain.setTargetAtTime(0.0001, now, Math.max(0.001, r / 3));
      end = now + r * 2 + 0.1;
      for (const s of live) {
        try {
          s.stop(end + 0.05);
        } catch {}
      }
    } else {
      // 停止/暂停/切轨等硬取消
      amp.gain.cancelAndHoldAtTime(now);
      amp.gain.setTargetAtTime(0.0001, now, 0.008);
      for (const s of live) {
        try {
          s.stop(now + 0.08);
        } catch {}
      }
      end = now + 0.1;
    }
  };
  return {
    stop,
    get end() {
      return end;
    },
    patch,
  };
}
/** 波形切换的默认交叉淡化时长，引擎在换波形时使用。 */
export const WAVE_FADE = WAVE_CROSSFADE;
