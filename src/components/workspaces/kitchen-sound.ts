"use client";

/**
 * Мягкий ресторанный KDS-сигнал новых заказов Direct. Полностью синтезируется
 * через Web Audio API — без аудиофайлов, сторонних библиотек и чужих сэмплов.
 * Характер: «пик-пик-пик → короткая мелодия → пик-пик-пик» — узнаваемый, но не
 * пронзительный и не тревожный. Диапазон низкий (500–660 Гц), тембр sine +
 * тихий triangle, мягкая огибающая без щелчков. Ни одна фирменная мелодия не
 * копируется. Логика запуска/повтора/защиты от наложения — прежняя.
 *
 * Из-за политики браузеров AudioContext создаётся только по жесту пользователя
 * (кнопка-колокольчик на экране кухни).
 */

/** localStorage-ключ включённости звука (не в PrototypeState). */
export const KITCHEN_SOUND_KEY = "direct-kitchen-sound-enabled";

/** Декларативное описание одной ноты сигнала — чистые данные для синтеза/тестов. */
export interface KdsTone {
  /** Частота, Гц. */
  frequency: number;
  /** Длительность звучания ноты, мс. */
  durationMs: number;
  /** Пауза после ноты до следующей, мс. */
  gapAfterMs: number;
  /** Пиковая громкость ноты (0..1]; по умолчанию TONE_PEAK_GAIN. */
  gain?: number;
}

/** Безопасный потолок частот (§1): без высокочастотного писка. */
export const KDS_MAX_FREQUENCY_HZ = 850;

/** Волновые формы сигнала (§3): только мягкие sine + тихий triangle. */
export const KDS_WAVEFORMS: readonly OscillatorType[] = ["sine", "triangle"];

/** Пиковая громкость одиночной ноты по умолчанию (§4). */
const TONE_PEAK_GAIN = 0.2;
/** Средняя мелодическая часть немного тише коротких сигналов (§4). */
const MIDDLE_PEAK_GAIN = 0.17;

/**
 * Direct KDS chime (§2): 9 нот. Группа 1 — три коротких сигнала (пик-пик-пик),
 * средняя мелодия «тю-лю-лю», финальная группа — снова три сигнала с тем же
 * узнаваемым ритмом. Частоты 500–660 Гц (≤ KDS_MAX_FREQUENCY_HZ).
 */
export const DIRECT_KDS_CHIME: readonly KdsTone[] = [
  // Группа 1 — пик-пик-пик.
  { frequency: 560, durationMs: 120, gapAfterMs: 80 },
  { frequency: 560, durationMs: 120, gapAfterMs: 80 },
  { frequency: 620, durationMs: 140, gapAfterMs: 120 },
  // Средняя мелодия — тю-лю-лю (чуть тише).
  { frequency: 660, durationMs: 150, gapAfterMs: 55, gain: MIDDLE_PEAK_GAIN },
  { frequency: 590, durationMs: 150, gapAfterMs: 55, gain: MIDDLE_PEAK_GAIN },
  { frequency: 500, durationMs: 190, gapAfterMs: 300, gain: MIDDLE_PEAK_GAIN },
  // Финальная группа — пик-пик-пик (тот же ритм, что и группа 1).
  { frequency: 560, durationMs: 120, gapAfterMs: 80 },
  { frequency: 560, durationMs: 120, gapAfterMs: 80 },
  { frequency: 620, durationMs: 210, gapAfterMs: 0 },
];

/** Огибающая ноты (§3): мягкая атака и релиз, без щелчков. */
const ATTACK_SECONDS = 0.015;
const RELEASE_SECONDS = 0.06;

/** Суммарная длительность мелодии (звучание + релиз последней ноты), сек. */
export function directKdsChimeDurationSeconds(): number {
  const totalMs = DIRECT_KDS_CHIME.reduce(
    (sum, tone) => sum + tone.durationMs + tone.gapAfterMs,
    0,
  );
  return totalMs / 1000 + RELEASE_SECONDS;
}

/**
 * Окно защиты от наложения (§9): пока не истечёт, повторный вызов игнорируется.
 * Немного больше слышимой длины мелодии, но заметно меньше 20-сек интервала.
 */
export const KITCHEN_ALERT_DURATION_SECONDS =
  Math.round((directKdsChimeDurationSeconds() + 0.15) * 100) / 100;

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
/** Общий master gain (§4): мягче прежнего (было 0.38). */
export const KDS_MASTER_GAIN = 0.21;

/**
 * Проигрывает одну полную мелодию Direct KDS (§6). Планировщик считает старты
 * нот от AudioContext.currentTime по декларативному DIRECT_KDS_CHIME — без
 * разбросанных setTimeout. Каждая нота: sine (основной) + тихий triangle для
 * читаемости, своя мягкая огибающая. Цепь: osc → tone gain → master gain →
 * мягкий compressor → destination (§4). Повторный вызов, пока сигнал ещё звучит,
 * игнорируется (§9) — без наложения.
 */
export function playKitchenBeep(): void {
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") return;

  const now = ctx.currentTime;
  // §9: не запускаем второй экземпляр поверх ещё звучащего сигнала.
  if (now < alertPlayingUntil) return;
  alertPlayingUntil = now + KITCHEN_ALERT_DURATION_SECONDS;

  // Мягкий компрессор (§4): убирает пики, не допускает clipping.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 22;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.22;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = KDS_MASTER_GAIN;
  master.connect(compressor);

  const scheduleTone = (
    frequency: number,
    waveform: OscillatorType,
    peakGain: number,
    start: number,
    durationSeconds: number,
  ) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveform;
    osc.frequency.setValueAtTime(frequency, start);
    // Мягкая огибающая: attack → короткий sustain → release, без щелчков (§3).
    const releaseStart = start + Math.max(durationSeconds, ATTACK_SECONDS);
    gain.gain.setValueAtTime(MIN_GAIN, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + ATTACK_SECONDS);
    gain.gain.setValueAtTime(peakGain, releaseStart);
    gain.gain.exponentialRampToValueAtTime(
      MIN_GAIN,
      releaseStart + RELEASE_SECONDS,
    );
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(releaseStart + RELEASE_SECONDS + 0.02);
  };

  let cursorSeconds = 0;
  for (const tone of DIRECT_KDS_CHIME) {
    const start = now + cursorSeconds;
    const durationSeconds = tone.durationMs / 1000;
    const peak = tone.gain ?? TONE_PEAK_GAIN;
    // Основной sine + очень тихий triangle для читаемости (§3).
    scheduleTone(tone.frequency, "sine", peak, start, durationSeconds);
    scheduleTone(tone.frequency, "triangle", peak * 0.28, start, durationSeconds);
    cursorSeconds += (tone.durationMs + tone.gapAfterMs) / 1000;
  }
}
