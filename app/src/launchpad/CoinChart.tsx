/// Candlestick chart for a launchpad coin, in the openperps.fun terminal style
/// (lightweight-charts, neon-on-OLED). It plots market cap in USD: historical
/// candles are bucketed from recent on-chain trades (passed in via `history`) at
/// the selected timeframe, and the live value extends the latest candle. No server
/// index needed, the history is whatever the trade reader surfaced.

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

import { fmtUsdK } from "./lib";

const BULL = "#16f2b3";
const BEAR = "#ff4d57";
const GRID = "rgba(35, 255, 190, 0.06)";
const AXIS = "rgba(35, 255, 190, 0.10)";
const MUTED = "#5b716d";

const TIMEFRAMES = ["1s", "1m", "5m", "15m", "1h"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];
const BUCKET_S: Record<Timeframe, number> = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };

export type ChartPoint = { time: number; value: number }; // time in unix seconds

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

/// Bucket sparse (time,value) points into OHLC candles at `bucketS` seconds; each
/// candle opens at the previous candle's close for a continuous series.
function toCandles(points: ChartPoint[], bucketS: number): Candle[] {
  const sorted = [...points].filter((p) => p.value > 0).sort((a, b) => a.time - b.time);
  const buckets = new Map<number, { o: number; h: number; l: number; c: number }>();
  let prevClose = sorted[0]?.value ?? 0;
  for (const p of sorted) {
    const t = Math.floor(p.time / bucketS) * bucketS;
    const b = buckets.get(t);
    if (!b) {
      buckets.set(t, {
        o: prevClose || p.value,
        h: Math.max(prevClose || p.value, p.value),
        l: Math.min(prevClose || p.value, p.value),
        c: p.value,
      });
    } else {
      b.h = Math.max(b.h, p.value);
      b.l = Math.min(b.l, p.value);
      b.c = p.value;
    }
    prevClose = p.value;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, b]) => ({ time: time as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }));
}

export function CoinChart({
  history = [],
  value,
  className,
}: {
  /// Historical (time, market-cap-USD) points from recent trades.
  history?: ChartPoint[];
  /// Live market cap (USD), appended as the latest point.
  value: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [tf, setTf] = useState<Timeframe>("1m");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: MUTED,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 11,
      },
      // Market cap is in USD; force English locale so axis dates stay English.
      localization: { locale: "en-US", priceFormatter: (p: number) => fmtUsdK(p) },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: AXIS },
      timeScale: { borderColor: AXIS, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addCandlestickSeries({
      upColor: BULL,
      downColor: BEAR,
      wickUpColor: BULL,
      wickDownColor: BEAR,
      borderVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 } });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Rebuild the series from history + the live point on any data or timeframe change.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    chart.timeScale().applyOptions({ secondsVisible: BUCKET_S[tf] < 60 });
    const now = Math.floor(Date.now() / 1000);
    const points: ChartPoint[] = [...history];
    if (value > 0) points.push({ time: now, value });
    const candles = toCandles(points, BUCKET_S[tf]);
    if (candles.length > 0) series.setData(candles);
    else series.setData([]);
  }, [history, value, tf]);

  return (
    <div className={`relative ${className ?? ""}`}>
      <div className="absolute left-2 top-2 z-10 flex gap-1 text-[11px]">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTf(t)}
            className={`rounded px-2 py-0.5 transition-colors ${
              tf === t ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
