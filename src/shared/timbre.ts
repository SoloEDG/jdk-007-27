export const WAVEFORMS = ["triangle", "sine", "square", "sawtooth"] as const;
export type WaveKind = (typeof WAVEFORMS)[number];
export type Envelope = {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
};
export type Timbre = {
  waveform: WaveKind;
  cutoff: number;
  resonance: number;
  envelope: Envelope;
  level: number;
};
export const WAVE_LABELS: Record<WaveKind, string> = {
  triangle: "三角波 TRIANGLE",
  sine: "正弦波 SINE",
  square: "方波 SQUARE",
  sawtooth: "锯齿波 SAW",
};
export const TIMBRE_LIMITS = {
  cutoff: { min: 200, max: 12000 },
  resonance: { min: 0.1, max: 18 },
  attack: { min: 0.005, max: 2 },
  decay: { min: 0.005, max: 2 },
  sustain: { min: 0, max: 1 },
  release: { min: 0.005, max: 2 },
  level: { min: 0, max: 1 },
} as const;
/** 旧版本固定三角波的等价音色，也是新琴键轨的默认音色。 */
export const DEFAULT_TIMBRE: Timbre = {
  waveform: "triangle",
  cutoff: 6000,
  resonance: 0.8,
  envelope: { attack: 0.008, decay: 0.12, sustain: 0.75, release: 0.25 },
  level: 0.35,
};
/** 切换波形时的短交叉淡化时长（秒），避免重启所有音符。 */
export const WAVE_CROSSFADE = 0.03;
const clampNum = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : min;
export function isWaveKind(v: unknown): v is WaveKind {
  return typeof v === "string" && (WAVEFORMS as readonly string[]).includes(v);
}
/** 把任意输入收敛为合法音色，用于界面拖动产生的数值。 */
export function clampTimbre(input: Partial<Timbre> | undefined): Timbre {
  const src = input ?? {};
  const env: Partial<Envelope> = src.envelope ?? {};
  return {
    waveform: isWaveKind(src.waveform) ? src.waveform : "triangle",
    cutoff: clampNum(src.cutoff, TIMBRE_LIMITS.cutoff.min, TIMBRE_LIMITS.cutoff.max),
    resonance: clampNum(
      src.resonance,
      TIMBRE_LIMITS.resonance.min,
      TIMBRE_LIMITS.resonance.max,
    ),
    envelope: {
      attack: clampNum(env.attack, TIMBRE_LIMITS.attack.min, TIMBRE_LIMITS.attack.max),
      decay: clampNum(env.decay, TIMBRE_LIMITS.decay.min, TIMBRE_LIMITS.decay.max),
      sustain: clampNum(
        env.sustain,
        TIMBRE_LIMITS.sustain.min,
        TIMBRE_LIMITS.sustain.max,
      ),
      release: clampNum(
        env.release,
        TIMBRE_LIMITS.release.min,
        TIMBRE_LIMITS.release.max,
      ),
    },
    level: clampNum(src.level, TIMBRE_LIMITS.level.min, TIMBRE_LIMITS.level.max),
  };
}
export function timbreEqual(a: Timbre, b: Timbre): boolean {
  return (
    a.waveform === b.waveform &&
    a.cutoff === b.cutoff &&
    a.resonance === b.resonance &&
    a.level === b.level &&
    a.envelope.attack === b.envelope.attack &&
    a.envelope.decay === b.envelope.decay &&
    a.envelope.sustain === b.envelope.sustain &&
    a.envelope.release === b.envelope.release
  );
}
