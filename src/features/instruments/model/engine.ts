import type { Instrument, ScheduledNote } from "@/shared/types";
import type { Timbre } from "@/shared/timbre";
import { synthesize, WAVE_FADE, type Voice } from "../lib/voices";
type ActiveVoice = Voice & { trackId: string; key?: string };
export function createEngine(initialContext?: AudioContext) {
  let context: AudioContext | null = initialContext ?? null;
  let destination: ((id: string) => AudioNode) | null = null;
  /** 每轨已确认的音色；播放与试听都只取这里的版本。 */
  const timbres = new Map<string, Timbre>();
  const voices = new Map<string, ActiveVoice>();
  const held = new Map<string, string>();
  /** 音色试听的临时声音，取消试听时必须全部清理。 */
  const previews = new Map<string, ActiveVoice>();
  const prune = () => {
    if (!context) return;
    const t = context.currentTime;
    for (const [id, v] of voices)
      if (v.end !== Infinity && v.end < t) {
        voices.delete(id);
        if (v.key) held.delete(v.key);
      }
  };
  return {
    get context() {
      return context;
    },
    async unlock() {
      context ??= new AudioContext();
      if (context.state === "suspended") await context.resume();
      return context;
    },
    route(resolve: (id: string) => AudioNode) {
      destination = resolve;
    },
    /** 只读内部检视：返回当前声音/按住/试听的数量，供测试与诊断使用。 */
    inspect() {
      return {
        voices: voices.size,
        held: held.size,
        previews: previews.size,
        heldKey(key: string) {
          return held.has(key);
        },
        heldVoice(key: string) {
          const id = held.get(key);
          return id ? voices.get(id) ?? null : null;
        },
        preview(trackId: string) {
          return previews.get(trackId) ?? null;
        },
      };
    },
    /** 注册/更新轨道的已确认音色；平滑作用于该轨正在响的声音。 */
    registerTimbre(trackId: string, timbre: Timbre, live = true) {
      const next = structuredClone(timbre);
      timbres.set(trackId, next);
      if (!live) return;
      prune();
      for (const v of voices.values())
        if (v.trackId === trackId) v.patch?.(next, WAVE_FADE);
    },
    removeTimbre(trackId: string) {
      timbres.delete(trackId);
    },
    play(note: ScheduledNote, key?: string) {
      if (!context || !destination) return;
      prune();
      // 真正发声这一刻才读取已确认音色，排队期间的修改不会被旧快照绑死
      const timbre = timbres.get(note.trackId) ?? null;
      const id = crypto.randomUUID();
      const voice = synthesize(
        context,
        destination(note.trackId),
        note,
        timbre,
        !!key && note.instrument === "keys",
      ) as ActiveVoice;
      voice.trackId = note.trackId;
      voice.key = key;
      voices.set(id, voice);
      if (key && note.instrument === "keys") held.set(key, id);
    },
    release(key: string) {
      const id = held.get(key);
      if (id) {
        // 此时 voice 内部持有的是松键前最后确认的音色，释放阶段按它结算
        voices.get(id)?.stop();
        held.delete(key);
      }
    },
    releaseHeld() {
      for (const id of held.values()) voices.get(id)?.stop();
      held.clear();
    },
    /** 开始/刷新音色试听：用临时声音表达草稿，不触碰已确认音色。 */
    previewTimbre(trackId: string, timbre: Timbre) {
      if (!context || !destination) return;
      this.stopPreview(trackId);
      const note: ScheduledNote = {
        instrument: "keys",
        pitch: 67,
        velocity: 0.7,
        duration: 6,
        when: context.currentTime,
        trackId,
      };
      const voice = synthesize(
        context,
        destination(trackId),
        note,
        structuredClone(timbre),
        true,
      ) as ActiveVoice;
      voice.trackId = trackId;
      previews.set(trackId, voice);
    },
    /** 试听中拖动：平滑变化并作用于临时试听声音。 */
    patchPreview(trackId: string, timbre: Timbre) {
      previews.get(trackId)?.patch?.(structuredClone(timbre), WAVE_FADE);
    },
    stopPreview(trackId?: string) {
      if (trackId) {
        previews.get(trackId)?.stop();
        previews.delete(trackId);
      } else {
        for (const v of previews.values()) v.stop();
        previews.clear();
      }
    },
    cancel() {
      for (const voice of voices.values()) voice.stop();
      voices.clear();
      held.clear();
      this.stopPreview();
    },
    releaseInstrument(_instrument: Instrument) {
      this.cancel();
    },
    dispose() {
      this.cancel();
      void context?.close();
      context = null;
      destination = null;
      timbres.clear();
    },
  };
}
export type Engine = ReturnType<typeof createEngine>;
