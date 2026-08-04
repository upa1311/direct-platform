"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { DeliveryAddress } from "@/lib/delivery-quotes/catalog";
import type {
  QuoteCalculation,
  QuoteStatus,
  SignedQuoteCalculation,
  StoredQuote,
} from "@/lib/delivery-quotes/types";

import styles from "./delivery-quotes.module.css";

type Tab = "calculator" | "history" | "registry";
type MapPoint = Pick<DeliveryAddress, "id" | "lon" | "lat" | "zoneId" | "status">;

interface CatalogMetadata {
  source: unknown;
  canonical: {
    catalogTotal: number;
    routed: number;
    duplicate: number;
    zoneCounts: readonly number[];
  };
}

interface CalculationResponse {
  calculation: QuoteCalculation;
  envelope: SignedQuoteCalculation;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

function money(cents: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
  }).format(cents / 100);
}

function distance(meters: number): string {
  return `${(meters / 1_000).toFixed(2)} км`;
}

function duration(seconds: number): string {
  return `${Math.round(seconds / 60)} мин`;
}

function AddressPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DeliveryAddress | null;
  onChange: (value: DeliveryAddress | null) => void;
}) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [items, setItems] = useState<readonly DeliveryAddress[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2 || query === value?.label) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ items: DeliveryAddress[] }>(
        `/api/delivery-addresses?q=${encodeURIComponent(query)}&limit=12`,
        { signal: controller.signal },
      ).then((result) => {
        setItems(result.items);
        setOpen(true);
      }).catch((error) => {
        if ((error as Error).name !== "AbortError") setItems([]);
      });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, value?.label]);

  return (
    <label className={styles.picker}>
      <span>{label}</span>
      <input
        aria-label={label}
        autoComplete="off"
        placeholder="Начните вводить населённый пункт, улицу или дом"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setItems([]);
          onChange(null);
        }}
        onFocus={() => setOpen(true)}
      />
      {value ? (
        <small>UID {value.id} · зона {value.zoneId}</small>
      ) : null}
      {open && items.length ? (
        <div className={styles.suggestions} role="listbox">
          {items.map((item) => (
            <button
              key={item.id}
              aria-selected={value?.id === item.id}
              role="option"
              type="button"
              onClick={() => {
                setQuery(item.label);
                onChange(item);
                setOpen(false);
              }}
            >
              <span>{item.label}</span>
              <small>{item.id} · зона {item.zoneId}</small>
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}

function RouteCanvas({
  route,
  points = [],
}: {
  route?: QuoteCalculation["routeGeometry"];
  points?: readonly MapPoint[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      context.fillStyle = "#f3f0ea";
      context.fillRect(0, 0, bounds.width, bounds.height);
      const coordinates = route?.coordinates ?? points.map((point) => [point.lon, point.lat] as const);
      if (!coordinates.length) return;
      const lons = coordinates.map((point) => point[0]);
      const lats = coordinates.map((point) => point[1]);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const pad = 22;
      const x = (lon: number) => pad + ((lon - minLon) / (maxLon - minLon || 1)) * (bounds.width - pad * 2);
      const y = (lat: number) => bounds.height - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (bounds.height - pad * 2);
      const colors = ["#777", "#23845a", "#cb6831", "#5c6fb3", "#9a5e9a"];
      for (const point of points) {
        context.fillStyle = point.status === "duplicate" ? "#111" : colors[point.zoneId] ?? colors[0];
        context.globalAlpha = point.status === "duplicate" ? 1 : 0.48;
        context.fillRect(x(point.lon) - 1, y(point.lat) - 1, 2, 2);
      }
      context.globalAlpha = 1;
      if (route) {
        context.strokeStyle = "#cb6831";
        context.lineWidth = 4;
        context.lineJoin = "round";
        context.beginPath();
        route.coordinates.forEach(([lon, lat], index) => {
          if (index === 0) context.moveTo(x(lon), y(lat));
          else context.lineTo(x(lon), y(lat));
        });
        context.stroke();
        for (const [index, point] of [route.coordinates[0], route.coordinates.at(-1)!].entries()) {
          context.fillStyle = index === 0 ? "#23845a" : "#292623";
          context.beginPath();
          context.arc(x(point[0]), y(point[1]), 7, 0, Math.PI * 2);
          context.fill();
        }
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [points, route]);

  return (
    <div className={styles.mapPanel} data-testid="quote-map">
      <canvas ref={canvasRef} aria-label="Карта маршрута и адресного реестра" />
      <div className={styles.legend} data-testid="map-legend">
        <span><i className={styles.routeKey} />маршрут</span>
        <span><i className={styles.originKey} />A</span>
        <span><i className={styles.destinationKey} />B</span>
      </div>
    </div>
  );
}

function QuoteSummary({ quote }: { quote: QuoteCalculation }) {
  return (
    <div className={styles.summary} data-testid="quote-summary">
      <div><span>Маршрут</span><strong>{distance(quote.routeDistanceMeters)}</strong></div>
      <div><span>Время</span><strong>{duration(quote.routeDurationSeconds)}</strong></div>
      <div><span>Вне checkpoint</span><strong>{distance(quote.externalMeters)}</strong></div>
      <div><span>Базовая цена</span><strong>{money(quote.basePriceCents)}</strong></div>
      <div><span>Доплата</span><strong>{money(quote.externalSurchargeCents)}</strong></div>
      <div className={styles.total}><span>Итого</span><strong>{money(quote.totalPriceCents)}</strong></div>
      <p>
        {quote.crossesCheckpoint ? "Маршрут пересекает" : "Маршрут не пересекает"} утверждённый checkpoint · {quote.tariffVersion}
      </p>
    </div>
  );
}

export function DeliveryQuoteConsole({ metadata }: { metadata: CatalogMetadata }) {
  const [tab, setTab] = useState<Tab>("calculator");
  const [origin, setOrigin] = useState<DeliveryAddress | null>(null);
  const [destination, setDestination] = useState<DeliveryAddress | null>(null);
  const [result, setResult] = useState<CalculationResponse | null>(null);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<readonly StoredQuote[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyStatus, setHistoryStatus] = useState("");
  const [selectedQuote, setSelectedQuote] = useState<StoredQuote | null>(null);
  const [mapPoints, setMapPoints] = useState<readonly MapPoint[]>([]);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryItems, setRegistryItems] = useState<readonly DeliveryAddress[]>([]);

  const loadHistory = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" });
    if (historyQuery) params.set("q", historyQuery);
    if (historyStatus) params.set("status", historyStatus);
    try {
      const response = await api<{ total: number; items: StoredQuote[] }>(`/api/quotes?${params}`);
      setHistory(response.items);
      setHistoryTotal(response.total);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, [historyQuery, historyStatus]);

  useEffect(() => {
    if (tab !== "registry" || mapPoints.length) return;
    api<{ items: MapPoint[] }>("/api/delivery-addresses?view=map")
      .then((response) => setMapPoints(response.items))
      .catch((error) => setMessage((error as Error).message));
  }, [mapPoints.length, tab]);

  useEffect(() => {
    if (tab !== "registry") return;
    const timer = window.setTimeout(() => {
      api<{ items: DeliveryAddress[] }>(`/api/delivery-addresses?q=${encodeURIComponent(registryQuery)}&limit=50`)
        .then((response) => setRegistryItems(response.items))
        .catch((error) => setMessage((error as Error).message));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [registryQuery, tab]);

  async function calculate() {
    if (!origin || !destination) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    try {
      setResult(await api<CalculationResponse>("/api/quotes/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originAddressId: origin.id, destinationAddressId: destination.id }),
      }));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await api<{ quote: StoredQuote }>("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: result.envelope, notes }),
      });
      setMessage(`Сохранено: ${response.quote.quoteNumber}`);
      setSelectedQuote(response.quote);
      await loadHistory();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function updateQuote(status: QuoteStatus, nextNotes: string) {
    if (!selectedQuote) return;
    try {
      const response = await api<{ quote: StoredQuote }>(`/api/quotes/${selectedQuote.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes: nextNotes }),
      });
      setSelectedQuote(response.quote);
      await loadHistory();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  const exportParams = new URLSearchParams();
  if (historyQuery) exportParams.set("q", historyQuery);
  if (historyStatus) exportParams.set("status", historyStatus);

  return (
    <>
      <nav className={styles.tabs} aria-label="Разделы котировок">
        {(["calculator", "history", "registry"] as const).map((name) => (
          <button
            key={name}
            className={tab === name ? styles.activeTab : ""}
            onClick={() => {
              setTab(name);
              if (name === "history") void loadHistory();
            }}
            type="button"
          >
            {name === "calculator" ? "Калькулятор" : name === "history" ? "История" : "Адресный реестр"}
          </button>
        ))}
      </nav>

      {message ? <div className={styles.message} role="status">{message}</div> : null}

      {tab === "calculator" ? (
        <div className={styles.calculatorGrid}>
          <section className={styles.card} data-testid="calculator-panel">
            <h2>Новая котировка</h2>
            <AddressPicker key={`origin-${origin?.id ?? "empty"}`} label="Адрес A" value={origin} onChange={(value) => { setOrigin(value); setResult(null); }} />
            <button
              aria-label="Поменять адреса местами"
              className={styles.swapButton}
              type="button"
              onClick={() => {
                setOrigin(destination);
                setDestination(origin);
                setResult(null);
              }}
            >↕ Поменять A и B</button>
            <AddressPicker key={`destination-${destination?.id ?? "empty"}`} label="Адрес B" value={destination} onChange={(value) => { setDestination(value); setResult(null); }} />
            <button
              className={styles.primaryButton}
              disabled={!origin || !destination || busy}
              onClick={calculate}
              type="button"
            >{busy ? "Расчёт…" : "Рассчитать на сервере"}</button>
            {result ? (
              <div className={styles.saveBlock}>
                <label>Заметка<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4000} /></label>
                <button className={styles.primaryButton} disabled={busy} onClick={save} type="button">
                  Явно сохранить котировку
                </button>
                <small>Без этой кнопки расчёт не появится в истории.</small>
              </div>
            ) : null}
          </section>
          <section className={styles.visualColumn}>
            <RouteCanvas route={result?.calculation.routeGeometry} />
            {result ? <QuoteSummary quote={result.calculation} /> : (
              <div className={styles.emptyState}>Выберите два канонических адреса и запустите серверный расчёт.</div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className={styles.historyGrid}>
          <section className={styles.card}>
            <div className={styles.toolbar}>
              <input aria-label="Поиск котировок" placeholder="Номер или адрес" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} />
              <select aria-label="Статус котировки" value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value)}>
                <option value="">Все статусы</option>
                <option value="draft">Черновик</option>
                <option value="confirmed">Подтверждена</option>
                <option value="cancelled">Отменена</option>
              </select>
              <button className={styles.secondaryButton} onClick={() => void loadHistory()} type="button">Найти</button>
              <a className={styles.linkButton} href={`/api/quotes/export?${exportParams}`}>Скачать CSV</a>
            </div>
            <p className={styles.count}>Найдено: {historyTotal}</p>
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>Номер</th><th>Маршрут</th><th>Цена</th><th>Статус</th><th>Дата</th></tr></thead>
                <tbody>{history.map((quote) => (
                  <tr key={quote.id} onClick={() => setSelectedQuote(quote)}>
                    <td>{quote.quoteNumber}</td>
                    <td>{quote.origin.label}<br />→ {quote.destination.label}</td>
                    <td>{money(quote.totalPriceCents)}</td>
                    <td>{quote.status}</td>
                    <td>{new Date(quote.createdAt).toLocaleString("ru-RU")}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
          <section className={styles.card} data-testid="quote-detail">
            {selectedQuote ? (
              <>
                <div className={styles.detailTitle}><h2>{selectedQuote.quoteNumber}</h2><a href={`/api/quotes/${selectedQuote.id}/export`}>JSON</a></div>
                <QuoteSummary quote={selectedQuote} />
                <p><strong>A:</strong> {selectedQuote.origin.label}</p>
                <p><strong>B:</strong> {selectedQuote.destination.label}</p>
                <label>Статус<select value={selectedQuote.status} onChange={(event) => void updateQuote(event.target.value as QuoteStatus, selectedQuote.notes)}><option value="draft">Черновик</option><option value="confirmed">Подтверждена</option><option value="cancelled">Отменена</option></select></label>
                <label>Заметка<textarea value={selectedQuote.notes} onChange={(event) => setSelectedQuote({ ...selectedQuote, notes: event.target.value })} /></label>
                <button className={styles.secondaryButton} onClick={() => void updateQuote(selectedQuote.status, selectedQuote.notes)} type="button">Сохранить статус и заметку</button>
                <button className={styles.linkButton} type="button" onClick={() => {
                  setOrigin(selectedQuote.origin);
                  setDestination(selectedQuote.destination);
                  setResult(null);
                  setTab("calculator");
                }}>Пересчитать как новую</button>
              </>
            ) : <div className={styles.emptyState}>Выберите строку истории.</div>}
          </section>
        </div>
      ) : null}

      {tab === "registry" ? (
        <div className={styles.registryGrid}>
          <section className={styles.card}>
            <div className={styles.registryHeader}>
              <div><h2>{metadata.canonical.catalogTotal.toLocaleString("ru-RU")} адресов</h2><p>{metadata.canonical.routed} маршрутизируемых · {metadata.canonical.duplicate} дубликат</p></div>
              <a className={styles.linkButton} href="/api/delivery-addresses?view=csv">Скачать CSV</a>
            </div>
            <input aria-label="Поиск по адресному реестру" placeholder="Населённый пункт, улица, дом или UID" value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} />
            <div className={styles.registryList}>{registryItems.map((item) => (
              <button key={item.id} type="button" onClick={() => { if (item.status === "routed") { setOrigin(item); setTab("calculator"); } }}>
                <span>{item.label}</span><small>{item.id} · зона {item.zoneId} · {item.status}</small>
              </button>
            ))}</div>
          </section>
          <section className={styles.visualColumn}>
            <RouteCanvas points={mapPoints} />
            <div className={styles.zoneCounts}>
              {metadata.canonical.zoneCounts.map((count, index) => <span key={index}>Зона {index + 1}: <strong>{count}</strong></span>)}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
