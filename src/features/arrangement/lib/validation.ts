import type { Session, Track, Note } from "@/shared/types";
import {
  DEFAULT_TIMBRE,
  TIMBRE_LIMITS,
  WAVEFORMS,
  isWaveKind,
  type Timbre,
} from "@/shared/timbre";
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x: unknown, min: number, max: number): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
/**
 * 严格校验音色：任何字段缺失或越界都抛错，由上层拒绝整次加载，
 * 避免把半套新音色混进当前作品。
 */
function validateTimbre(raw: unknown): Timbre {
  if (!object(raw)) throw new Error("音色数据无效");
  const env = raw.envelope;
  if (
    !isWaveKind(raw.waveform) ||
    !finite(raw.cutoff, TIMBRE_LIMITS.cutoff.min, TIMBRE_LIMITS.cutoff.max) ||
    !finite(
      raw.resonance,
      TIMBRE_LIMITS.resonance.min,
      TIMBRE_LIMITS.resonance.max,
    ) ||
    !finite(raw.level, TIMBRE_LIMITS.level.min, TIMBRE_LIMITS.level.max) ||
    !object(env) ||
    !finite(
      env.attack,
      TIMBRE_LIMITS.attack.min,
      TIMBRE_LIMITS.attack.max,
    ) ||
    !finite(env.decay, TIMBRE_LIMITS.decay.min, TIMBRE_LIMITS.decay.max) ||
    !finite(
      env.sustain,
      TIMBRE_LIMITS.sustain.min,
      TIMBRE_LIMITS.sustain.max,
    ) ||
    !finite(
      env.release,
      TIMBRE_LIMITS.release.min,
      TIMBRE_LIMITS.release.max,
    )
  )
    throw new Error("音色参数损坏，已拒绝加载整个作品");
  return {
    waveform: raw.waveform as (typeof WAVEFORMS)[number],
    cutoff: raw.cutoff,
    resonance: raw.resonance,
    envelope: {
      attack: env.attack,
      decay: env.decay,
      sustain: env.sustain,
      release: env.release,
    },
    level: raw.level,
  };
}
export function validateSession(raw: unknown): Session {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    typeof raw.title !== "string" ||
    raw.title.length > 80 ||
    !finite(raw.bpm, 40, 220) ||
    ![4, 8, 16, 32].includes(raw.beats as number) ||
    !Array.isArray(raw.tracks) ||
    raw.tracks.length > 8 ||
    !object(raw.channels) ||
    !finite(raw.master, 0, 1)
  )
    throw new Error("存档格式或版本不受支持");
  const ids = new Set<string>();
  const noteIds = new Set<string>();
  const tracks: Track[] = [];
  for (const value of raw.tracks) {
    if (!object(value)) throw new Error("轨道损坏");
    const t = value as unknown as Track;
    if (
      typeof t.id !== "string" ||
      ids.has(t.id) ||
      !t.id ||
      typeof t.name !== "string" ||
      t.name.length > 32 ||
      !["drums", "keys"].includes(t.instrument) ||
      !/^#[0-9a-f]{6}$/i.test(t.color) ||
      !Array.isArray(t.notes) ||
      t.notes.length > 2048
    )
      throw new Error("轨道数据无效");
    ids.add(t.id);
    for (const n of t.notes as Note[]) {
      if (
        !object(n) ||
        typeof n.id !== "string" ||
        noteIds.has(n.id) ||
        !finite(
          n.pitch,
          t.instrument === "drums" ? 0 : 24,
          t.instrument === "drums" ? 3 : 108,
        ) ||
        !Number.isInteger(n.pitch) ||
        !finite(n.beat, 0, (raw.beats as number) - 0.000001) ||
        !finite(n.duration, 0.01, raw.beats as number) ||
        !finite(n.velocity, 0.01, 1)
      )
        throw new Error("音符数据无效");
      noteIds.add(n.id);
    }
    const c = raw.channels[t.id];
    if (!object(c) || !finite(c.volume, 0, 1) || typeof c.muted !== "boolean")
      throw new Error("混音数据无效");
    // 旧作品没有音色字段：迁移为原固定三角波的等价默认值；
    // 一旦带了音色字段就必须完整合法，否则拒绝整次加载。
    let timbre: Timbre | null;
    if (t.instrument === "keys") {
      timbre =
        t.timbre === undefined
          ? structuredClone(DEFAULT_TIMBRE)
          : validateTimbre(t.timbre);
    } else {
      if (t.timbre !== undefined && t.timbre !== null)
        throw new Error("鼓组轨道音色数据无效");
      timbre = null;
    }
    tracks.push({ ...structuredClone(t), timbre });
  }
  return {
    ...(structuredClone(raw) as Session),
    tracks,
  };
}
