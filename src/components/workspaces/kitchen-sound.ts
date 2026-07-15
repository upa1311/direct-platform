"use client";

/**
 * Сигнал новых заказов кухни Direct. Основной звук — пользовательский mp3-файл
 * (`public/sounds/kitchen-new-order.mp3`), проигрываемый через Web Audio API.
 * Если файл не загрузился/не декодировался — автоматический fallback на прежний
 * синтезированный Direct KDS chime (пик-пик-пик → мелодия → пик-пик-пик), чтобы
 * кухня никогда не осталась без сигнала.
 *
 * Логика запуска/повтора неизменна: включение только по жесту пользователя
 * (кнопка-колокольчик), повтор каждые 20 секунд решает isKitchenBeepDue, защита
 * от наложения — окно alertPlayingUntil, тишина после 7 минут — селектор.
 */

/** localStorage-ключ включённости звука (не в PrototypeState). */
export const KITCHEN_SOUND_KEY = "direct-kitchen-sound-enabled";

/** URL пользовательского сигнала (лежит в public/, попадает в репозиторий). */
export const KITCHEN_SOUND_FILE_URL = "/sounds/kitchen-new-order.mp3";

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
/** Декодированный пользовательский mp3 (основной сигнал); null — не загружен. */
let alertFileBuffer: AudioBuffer | null = null;
/** Однократная загрузка файла; повторные вызовы ждут ту же промис-цепочку. */
let alertFileLoading: Promise<void> | null = null;

/**
 * Загружает и декодирует пользовательский mp3. Ошибки глотаются: при неудаче
 * остаётся синтезированный fallback, кухня без сигнала не остаётся.
 */
function loadKitchenSoundFile(ctx: AudioContext): Promise<void> {
  if (alertFileBuffer) return Promise.resolve();
  if (alertFileLoading) return alertFileLoading;
  alertFileLoading = fetch(KITCHEN_SOUND_FILE_URL)
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.arrayBuffer();
    })
    .then((data) => ctx.decodeAudioData(data))
    .then((buffer) => {
      alertFileBuffer = buffer;
    })
    .catch(() => {
      alertFileBuffer = null;
    })
    .finally(() => {
      alertFileLoading = null;
    });
  return alertFileLoading;
}

/**
 * Создаёт/возобновляет AudioContext по жесту пользователя и подгружает
 * пользовательский mp3. Возвращает true, если звук готов к воспроизведению.
 * При блокировке браузером — false.
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
    if (audioContext.state === "running") {
      // Файл маленький и локальный; ждём, чтобы первый сигнал был уже из mp3.
      await loadKitchenSoundFile(audioContext);
      return true;
    }
    return false;
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

/** Громкость проигрывания пользовательского mp3 (файл уже смастерен). */
export const KITCHEN_FILE_GAIN = 0.9;

/**
 * Проигрывает сигнал нового заказа. Основной путь — пользовательский mp3 через
 * AudioBufferSourceNode; окно защиты от наложения равно фактической длительности
 * файла. Если буфер недоступен (ошибка загрузки/декодирования) — синтезированный
 * Direct KDS chime как fallback, а загрузка файла тихо повторяется в фоне.
 * Повторный вызов, пока сигнал ещё звучит, игнорируется (§9) — без наложения.
 */
export function playKitchenBeep(): void {
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") return;

  const now = ctx.currentTime;
  // §9: не запускаем второй экземпляр поверх ещё звучащего сигнала.
  if (now < alertPlayingUntil) return;

  // Основной сигнал — пользовательский mp3.
  if (alertFileBuffer) {
    alertPlayingUntil = now + alertFileBuffer.duration;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 22;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.22;
    compressor.connect(ctx.destination);
    const gain = ctx.createGain();
    gain.gain.value = KITCHEN_FILE_GAIN;
    gain.connect(compressor);
    const source = ctx.createBufferSource();
    source.buffer = alertFileBuffer;
    source.connect(gain);
    source.start(now);
    return;
  }

  // Файл ещё не готов — пробуем догрузить в фоне и играем синтезированный chime.
  void loadKitchenSoundFile(ctx);
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
