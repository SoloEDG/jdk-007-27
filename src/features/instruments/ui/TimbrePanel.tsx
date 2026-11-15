import type { Timbre, WaveKind } from "@/shared/timbre";
import { TIMBRE_LIMITS, WAVEFORMS, WAVE_LABELS } from "@/shared/timbre";
const waveName: Record<WaveKind, string> = {
  triangle: "三角",
  sine: "正弦",
  square: "方波",
  sawtooth: "锯齿",
};
const hz = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
const sec = (v: number) => `${Math.round(v * 1000)} ms`;
function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="timbre-slider">
      <span>
        {label}
        <i>{display}</i>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export function TimbrePanel({
  confirmed,
  draft,
  previewing,
  onChange,
  onPreview,
  onCommit,
  onCancel,
}: {
  confirmed: Timbre;
  draft: Timbre | null;
  previewing: boolean;
  onChange: (next: Timbre) => void;
  onPreview: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const value = draft ?? confirmed;
  const dirty = draft !== null;
  const env = value.envelope;
  const patch = (next: Partial<Timbre>) => onChange({ ...value, ...next });
  const patchEnv = (next: Partial<Timbre["envelope"]>) =>
    onChange({ ...value, envelope: { ...env, ...next } });
  return (
    <div className={`timbre-panel ${dirty ? "dirty" : ""}`}>
      <div className="timbre-head">
        <small>本轨音色 / TRACK TIMBRE</small>
        <span className={`timbre-state ${previewing ? "on" : ""}`}>
          {dirty ? (previewing ? "试听中 · 未确认" : "草稿未确认") : "已保存音色"}
        </span>
      </div>
      <div className="wave-row" role="group" aria-label="振荡波形">
        {WAVEFORMS.map((w) => (
          <button
            key={w}
            className={value.waveform === w ? "active" : ""}
            aria-pressed={value.waveform === w}
            title={WAVE_LABELS[w]}
            onClick={() => patch({ waveform: w })}
          >
            {waveName[w]}
          </button>
        ))}
      </div>
      <div className="timbre-grid">
        <Slider
          label="滤波截止"
          value={value.cutoff}
          min={TIMBRE_LIMITS.cutoff.min}
          max={TIMBRE_LIMITS.cutoff.max}
          step={10}
          display={hz(value.cutoff)}
          onChange={(n) => patch({ cutoff: n })}
        />
        <Slider
          label="谐振"
          value={value.resonance}
          min={TIMBRE_LIMITS.resonance.min}
          max={TIMBRE_LIMITS.resonance.max}
          step={0.1}
          display={value.resonance.toFixed(1)}
          onChange={(n) => patch({ resonance: n })}
        />
        <Slider
          label="起音 A"
          value={env.attack}
          min={TIMBRE_LIMITS.attack.min}
          max={TIMBRE_LIMITS.attack.max}
          step={0.001}
          display={sec(env.attack)}
          onChange={(n) => patchEnv({ attack: n })}
        />
        <Slider
          label="衰减 D"
          value={env.decay}
          min={TIMBRE_LIMITS.decay.min}
          max={TIMBRE_LIMITS.decay.max}
          step={0.001}
          display={sec(env.decay)}
          onChange={(n) => patchEnv({ decay: n })}
        />
        <Slider
          label="持续 S"
          value={env.sustain}
          min={TIMBRE_LIMITS.sustain.min}
          max={TIMBRE_LIMITS.sustain.max}
          step={0.01}
          display={`${Math.round(env.sustain * 100)}%`}
          onChange={(n) => patchEnv({ sustain: n })}
        />
        <Slider
          label="释放 R"
          value={env.release}
          min={TIMBRE_LIMITS.release.min}
          max={TIMBRE_LIMITS.release.max}
          step={0.001}
          display={sec(env.release)}
          onChange={(n) => patchEnv({ release: n })}
        />
        <Slider
          label="音色音量"
          value={value.level}
          min={TIMBRE_LIMITS.level.min}
          max={TIMBRE_LIMITS.level.max}
          step={0.01}
          display={`${Math.round(value.level * 100)}%`}
          onChange={(n) => patch({ level: n })}
        />
      </div>
      <div className="timbre-actions">
        <button onClick={onPreview}>
          {previewing ? "重新试听" : "试听音色"}
        </button>
        <button className="commit" disabled={!dirty} onClick={onCommit}>
          确认并保存
        </button>
        <button disabled={!dirty} onClick={onCancel}>
          取消试听
        </button>
      </div>
      <p className="timbre-hint">
        拖动即时作用于正在响的声音；换波形为短交叉淡化，不会打断音符。确认后循环与演奏都用本轨音色。
      </p>
    </div>
  );
}
