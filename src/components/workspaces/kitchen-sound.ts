"use client";

/**
 * Мягкий двухтональный сигнал новых заказов кухни (§2), синтезируемый через
 * Web Audio API — без аудиофайлов и сторонних библиотек. Из-за политики
 * браузеров AudioContext создаётся только по действию пользователя
 * («Включить звук»).
 */

/** localStorage-ключ включённости звука (не в PrototypeState). */
export const KITCHEN_SOUND_KEY = "direct-kitchen-sound-enabled";

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

/** Освобождает контекст (при выключении звука). */
export function disableKitchenSound(): void {
  if (audioContext) {
    void audioContext.close().catch(() => {});
    audioContext = null;
  }
}

/**
 * Короткий мягкий двухтональный сигнал (~0.7с, умеренная громкость). Одинаков
 * для всех новых заказов; без резкого писка (плавные атака/затухание).
 */
export function playKitchenBeep(): void {
  const ctx = audioContext;
  if (!ctx || ctx.state !== "running") return;

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.12; // умеренная громкость
  master.connect(ctx.destination);

  const tone = (frequency: number, start: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    // Плавные атака и затухание вместо резкого щелчка.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(1, start + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  };

  // Два мягких тона подряд.
  tone(660, now, 0.28);
  tone(880, now + 0.32, 0.32);
}
