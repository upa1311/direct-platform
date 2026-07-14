"use client";

/**
 * Оригинальный громкий четырёхимпульсный сигнал новых заказов кухни Direct для
 * ресторанного KDS (§2–§6). Полностью синтезируется через Web Audio API — без
 * аудиофайлов, сторонних библиотек и чужих сэмплов. Из-за политики браузеров
 * AudioContext создаётся только по действию пользователя («колокольчик»).
 *
 * Сигнал — собственная последовательность Direct: два восходящих импульса,
 * короткая пауза, усиленный повтор и финальный двухчастотный аккорд. Ни одна
 * фирменная мелодия/аудиологотип не копируется.
 */

/** localStorage-ключ включённости звука (не в PrototypeState). */
export const KITCHEN_SOUND_KEY = "direct-kitchen-sound-enabled";

/** Полная слышимая длительность сигнала (§3). */
export const KITCHEN_ALERT_DURATION_SECONDS = 2.25;

/** Один импульс сигнала — чистые данные для синтеза и тестов (§11). */
export interface KitchenAlertPulse {
  startSeconds: number;
  durationSeconds: number;
  frequenciesHz: readonly number[];
  waveform: OscillatorType;
  peakGain: number;
}

/**
 * Рисунок сигнала (§4): 4 импульса, частоты 750–1450 Гц. Финальный импульс —
 * двухчастотный аккорд. Заканчивается на 2.20с (не раньше DURATION − 0.05).
 */
export const KITCHEN_ALERT_PATTERN: readonly KitchenAlertPulse[] = [
  { startSeconds: 0.0, durationSeconds: 0.38, frequenciesHz: [820], waveform: "triangle", peakGain: 0.9 },
  { startSeconds: 0.42, durationSeconds: 0.38, frequenciesHz: [980], waveform: "triangle", peakGain: 0.95 },
  // 0.80–1.15 — короткая пауза (нет импульса).
  { startSeconds: 1.15, durationSeconds: 0.4, frequenciesHz: [820], waveform: "square", peakGain: 1.0 },
  { startSeconds: 1.6, durationSeconds: 0.6, frequenciesHz: [1040, 1320], waveform: "triangle", peakGain: 0.9 },
];

/** Момент окончания последнего импульса (для тестов длительности). */
export function kitchenAlertPatternEndSeconds(): number {
  return KITCHEN_ALERT_PATTERN.reduce(
    (end, pulse) => Math.max(end, pulse.startSeconds + pulse.durationSeconds),
    0,
  );
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext ??
    null
  );
}

let audioContext: AudioContext | null = null;
/** Защита от наложения (§9): до этого времени новый сигнал не запускаем. */
let alertPlayingUntil = 0;

/**
 * Создаёт/возобновляет AudioContext по жесту пользователя. Возвращает true,
 * если звук готов к воспроизведению. При блокировке браузером — false.
 */
export async function enableKitchenSound(): Promise<boolean> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return false;
  try {
    if (!audioContext) {
      audioContext = new Ctor();
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext.state === "running";
  } catch {
    return false;
  }
}

/** Готов ли звук (context запущен). */
export function isKitchenSoundReady(): boolean {
  return audioContext !== null && audioContext.state === "running";
}

/** Освобождает контекст и сбрасывает защиту от наложения (при выключении). */
export function disableKitchenSound(): void {
  if (audioContext) {
    void audioContext.close().catch(() => {});
    audioContext = null;
  }
  alertPlayingUntil = 0;
}

/** Минимальная безопасная амплитуда для экспоненциальных рамп (без нулей). */
const MIN_GAIN = 0.0001;
/** Общая громкость (§5): заметно громче прежних 0.12, но без clipping. */
const MASTER_GAIN = 0.38;

/**
 * Проигрывает одну полную последовательность сигнала (§8): один вызов —
 * минимум 2 секунды звука. Повторный вызов, пока сигнал ещё играет, ничего не
 * делает (§9) — без хаотичного наложения. Цепь: oscillator → tone gain →
 * master gain → dynamics compressor → destination (§5). Компрессор защищает от
 * clipping; на destination напрямую gain = 1 не подаётся.
 */
export function playKitchenBeep(): void {
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") return;

  const now = ctx.currentTime;
  // §9: не запускаем второй экземпляр поверх ещё звучащего сигнала.
  if (now < alertPlayingUntil) return;
  alertPlayingUntil = now + KITCHEN_ALERT_DURATION_SECONDS;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 20;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(compressor);

  const layer = (
    frequency: number,
    waveform: OscillatorType,
    peakGain: number,
    start: number,
    duration: number,
  ) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveform;
    osc.frequency.setValueAtTime(frequency, start);
    // Короткая атака и плавное затухание — без щелчков (§6).
    gain.gain.setValueAtTime(MIN_GAIN, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.018);
    gain.gain.setValueAtTime(peakGain, start + duration * 0.4);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  };

  for (const pulse of KITCHEN_ALERT_PATTERN) {
    const start = now + pulse.startSeconds;
    for (const frequency of pulse.frequenciesHz) {
      // Основной слой (triangle/square) + тихий sine-слой для плотности (§4).
      layer(frequency, pulse.waveform, pulse.peakGain, start, pulse.durationSeconds);
      layer(frequency, "sine", pulse.peakGain * 0.5, start, pulse.durationSeconds);
    }
  }
}
