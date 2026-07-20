/**
 * Prototype media store для фотографий блюд.
 *
 * Blob-данные НЕ входят в PrototypeState и localStorage: они хранятся отдельно
 * в IndexedDB текущего origin, поэтому переживают reload и доступны из всех
 * вкладок. Домены (MenuItemSubmission / MenuItem) хранят только строковый
 * `imageMediaId` — запрещено записывать туда base64, data URI, Blob URL или
 * содержимое файла. Object URL создаётся только на время отображения и
 * освобождается в cleanup (см. useMenuMediaUrl).
 *
 * Чистая часть модуля (валидация файла, масштаб, формат id) не трогает
 * браузерные API и покрывается node-тестами; IndexedDB-обвязка изолирована.
 */

/** Допустимые MIME-типы исходной фотографии. */
export const MENU_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** Максимальный размер исходного файла: 10 МБ. */
export const MENU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Максимальная сторона сохранённого изображения. */
export const MENU_IMAGE_MAX_DIMENSION = 1600;

export const MENU_IMAGE_TYPE_ERROR =
  "Выберите изображение JPG, PNG или WEBP.";
export const MENU_IMAGE_SIZE_ERROR =
  "Размер фотографии не должен превышать 10 МБ.";
export const MENU_IMAGE_PROCESS_ERROR = "Не удалось обработать фотографию.";

/**
 * Валидация выбранного файла ДО обработки: только тип и размер. Возвращает
 * русскую ошибку либо null. Чистая функция — file может быть любым объектом
 * с type/size.
 */
export function validateMenuImageFile(file: {
  type: string;
  size: number;
}): string | null {
  if (
    !(MENU_IMAGE_MIME_TYPES as readonly string[]).includes(
      (file.type || "").toLowerCase(),
    )
  ) {
    return MENU_IMAGE_TYPE_ERROR;
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return MENU_IMAGE_PROCESS_ERROR;
  }
  if (file.size > MENU_IMAGE_MAX_BYTES) {
    return MENU_IMAGE_SIZE_ERROR;
  }
  return null;
}

/**
 * Целевой размер после оптимизации: пропорциональное уменьшение до максимум
 * 1600×1600. Изображение меньше лимита не увеличивается.
 */
export function computeScaledSize(
  width: number,
  height: number,
  maxDimension: number = MENU_IMAGE_MAX_DIMENSION,
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Формат стабильного media id. Только ссылка — никаких данных внутри. */
const MEDIA_ID_PATTERN = /^media-[a-z0-9-]{8,}$/;

/** Проверка, что строка — корректный media id (а не data URI/base64/путь). */
export function isValidMenuMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value);
}

/** Генерация стабильного media id. */
export function createMenuMediaId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `media-${cryptoApi.randomUUID()}`;
  }
  // Fallback без crypto: время + случайный суффикс. Стабильность обеспечивает
  // само хранение — id генерируется один раз при сохранении Blob.
  return `media-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// --- IndexedDB-обвязка (только браузер) --------------------------------------

const MEDIA_DB_NAME = "direct-menu-media";
const MEDIA_DB_VERSION = 1;
const MEDIA_STORE_NAME = "media";

function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступна."));
      return;
    }
    const request = indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB"));
  });
}

function runMediaTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openMediaDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(MEDIA_STORE_NAME, mode);
        const request = operation(transaction.objectStore(MEDIA_STORE_NAME));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error("IndexedDB"));
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error ?? new Error("IndexedDB"));
        };
      }),
  );
}

/** Сохраняет Blob и возвращает новый стабильный media id. */
export async function saveMenuMediaBlob(blob: Blob): Promise<string> {
  const mediaId = createMenuMediaId();
  await runMediaTransaction("readwrite", (store) => store.put(blob, mediaId));
  return mediaId;
}

/** Читает Blob по id; null, если изображения нет. */
export async function loadMenuMediaBlob(
  mediaId: string,
): Promise<Blob | null> {
  if (!isValidMenuMediaId(mediaId)) return null;
  try {
    const result = await runMediaTransaction<Blob | undefined>(
      "readonly",
      (store) => store.get(mediaId) as IDBRequest<Blob | undefined>,
    );
    return result instanceof Blob ? result : null;
  } catch {
    return null;
  }
}

/** Удаляет Blob по id. Ошибки удаления не критичны для UX. */
export async function deleteMenuMediaBlob(mediaId: string): Promise<void> {
  if (!isValidMenuMediaId(mediaId)) return;
  try {
    await runMediaTransaction("readwrite", (store) => store.delete(mediaId));
  } catch {
    // Осиротевший Blob в prototype-хранилище допустим; заявка уже не ссылается.
  }
}

// --- Оптимизация изображения --------------------------------------------------

/** Декодирует файл с учётом EXIF orientation. */
async function decodeMenuImage(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      // imageOrientation: "from-image" применяет EXIF-поворот при декодировании.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Падаем в <img>-fallback ниже.
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(MENU_IMAGE_PROCESS_ERROR));
    };
    image.src = url;
  });
}

/**
 * Оптимизирует исходный файл: EXIF-поворот, уменьшение до 1600×1600 и WEBP.
 * Исходные 10 МБ не сохраняются — в store попадает только сжатая версия.
 */
export async function optimizeMenuImage(file: Blob): Promise<Blob> {
  const source = await decodeMenuImage(file);
  const sourceWidth =
    "naturalWidth" in source ? source.naturalWidth : source.width;
  const sourceHeight =
    "naturalHeight" in source ? source.naturalHeight : source.height;
  const target = computeScaledSize(sourceWidth, sourceHeight);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(MENU_IMAGE_PROCESS_ERROR);
  }
  context.drawImage(source, 0, 0, target.width, target.height);
  if ("close" in source && typeof source.close === "function") {
    source.close();
  }

  const optimized = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", 0.85);
  });
  if (!optimized) {
    throw new Error(MENU_IMAGE_PROCESS_ERROR);
  }
  return optimized;
}

/**
 * Полный путь загрузки фотографии блюда: валидация → оптимизация → сохранение.
 * Возвращает media id либо бросает Error с русским пользовательским текстом.
 */
export async function processAndSaveMenuImage(file: File): Promise<string> {
  const validationError = validateMenuImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }
  let optimized: Blob;
  try {
    optimized = await optimizeMenuImage(file);
  } catch {
    throw new Error(MENU_IMAGE_PROCESS_ERROR);
  }
  try {
    return await saveMenuMediaBlob(optimized);
  } catch {
    throw new Error(MENU_IMAGE_PROCESS_ERROR);
  }
}
