import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { PAIRS, type Candle, type CurrencyPair, type Position } from '../lib/engine';
import './PriceChart.css';

export type ChartTimeframe = '1m' | '5m' | '15m' | '1h';

interface PriceChartProps {
  candles: Candle[];
  pair: CurrencyPair;
  positions: Position[];
  onTimeframeChange?: (timeframe: ChartTimeframe) => void;
  timeframe?: ChartTimeframe;
}

const HEIGHT = 330;
const LEFT = 14;
const RIGHT = 91;
const TOP = 24;
const BOTTOM = 247;
const TIMEFRAMES: { value: ChartTimeframe; label: string }[] = [
  { value: '1m', label: '1分' },
  { value: '5m', label: '5分' },
  { value: '15m', label: '15分' },
  { value: '1h', label: '1時間' },
];
const timeLabel = (time: number) => new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo',
}).format(time);
const fullTimeLabel = (time: number) => new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Asia/Tokyo',
}).format(time);

export default function PriceChart({
  candles, pair, positions, onTimeframeChange, timeframe = '1m',
}: PriceChartProps) {
  const clipId = `price-plot-${useId().replaceAll(':', '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const [chartWidth, setChartWidth] = useState(1000);
  const [hover, setHover] = useState<{ pair: CurrencyPair; index: number; y: number | null } | null>(null);
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setChartWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const WIDTH = chartWidth;
  const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
  const visible = candles.slice(-Math.max(20, Math.min(70, Math.floor(PLOT_WIDTH / 9))));
  const metadata = PAIRS[pair];
  const formatPrice = (price: number) => price.toFixed(metadata.decimals);
  const latest = visible.at(-1);
  const activeIndex = hover?.pair === pair ? Math.min(hover.index, visible.length - 1) : -1;
  const active = activeIndex >= 0 ? visible[activeIndex] : latest;

  const low = visible.length ? Math.min(...visible.map((candle) => candle.low)) : 0;
  const high = visible.length ? Math.max(...visible.map((candle) => candle.high)) : 1;
  const range = Math.max(high - low, metadata.pipSize * 12);
  const floor = low - range * 0.12;
  const ceiling = high + range * 0.12;
  const span = ceiling - floor;
  const y = (price: number) => TOP + (ceiling - price) / span * (BOTTOM - TOP);
  const spacing = PLOT_WIDTH / Math.max(visible.length, 1);
  const x = (index: number) => LEFT + spacing * (index + 0.5);
  const candleWidth = Math.max(2, Math.min(spacing * 0.57, 11));
  const maxCandleRange = Math.max(...visible.map((candle) => candle.high - candle.low), metadata.pipSize);
  const direction = active && active.close >= active.open ? 'up' : 'down';

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - bounds.left) / bounds.width * WIDTH;
    const py = (event.clientY - bounds.top) / bounds.height * HEIGHT;
    if (px < LEFT || px > WIDTH - RIGHT || !visible.length) {
      setHover(null);
      return;
    }
    setHover({ pair, index: Math.max(0, Math.min(visible.length - 1, Math.floor((px - LEFT) / spacing))), y: Math.max(TOP, Math.min(BOTTOM, py)) });
  };

  const handleKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!visible.length) return;
    const current = activeIndex >= 0 ? activeIndex : visible.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = Math.max(0, current - 1); break;
      case 'ArrowRight': next = Math.min(visible.length - 1, current + 1); break;
      case 'Home': next = 0; break;
      case 'End': next = visible.length - 1; break;
      case 'Escape': setHover(null); return;
      default: return;
    }
    event.preventDefault();
    setHover({ pair, index: next, y: null });
  };

  const crosshairY = hover?.pair === pair && active ? (hover.y ?? y(active.close)) : null;
  const crosshairPrice = crosshairY === null ? null : ceiling - (crosshairY - TOP) / (BOTTOM - TOP) * span;
  const visiblePositions = positions.filter((position) => position.pair === pair && position.entryPrice > floor && position.entryPrice < ceiling).slice(-3);

  return (
    <section className="chart-panel" aria-label={`${metadata.label}のマーケットチャート`}>
      <div className="chart-toolbar">
        <div className="chart-title-group">
          <h2 className="chart-title">マーケットチャート</h2>
          <span className="chart-type"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 1v14M11 3v10" stroke="currentColor" /><path d="M3 4h4v6H3zM9 6h4v4H9z" fill="currentColor" /></svg>ローソク足</span>
        </div>
        <div className="chart-timeframes" role="group" aria-label="チャートの時間足">
          {TIMEFRAMES.map((option) => (
            <button key={option.value} type="button" aria-pressed={timeframe === option.value} className={timeframe === option.value ? 'chart-timeframe chart-timeframe-active' : 'chart-timeframe'} onClick={() => onTimeframeChange?.(option.value)}>{option.label}</button>
          ))}
        </div>
      </div>

      <div className="chart-information">
        <span className="chart-symbol">{pair.slice(0, 3)}<span>/</span>{pair.slice(3)}</span>
        <div className={`chart-ohlc chart-${direction}`} aria-live={activeIndex >= 0 ? 'polite' : 'off'}>
          {active ? <>
            <span><span className="chart-ohlc-label">始</span>{formatPrice(active.open)}</span>
            <span><span className="chart-ohlc-label">高</span>{formatPrice(active.high)}</span>
            <span><span className="chart-ohlc-label">安</span>{formatPrice(active.low)}</span>
            <span><span className="chart-ohlc-label">終</span>{formatPrice(active.close)}</span>
          </> : <span className="chart-ohlc-label">価格データを準備しています</span>}
        </div>
        <span className="chart-currency">{metadata.quote}</span>
      </div>

      <div className="chart-canvas-wrap">
        <svg ref={svgRef} className="chart-canvas" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0} aria-label={latest ? `${metadata.label}、${TIMEFRAMES.find((option) => option.value === timeframe)?.label}足。現在値 ${formatPrice(latest.close)} ${metadata.quote}。左右矢印キーでローソク足を選択できます。` : '価格データがありません'} onPointerMove={handlePointer} onPointerLeave={() => setHover(null)} onKeyDown={handleKeyboard} onBlur={() => setHover(null)}>
          <defs><clipPath id={clipId}><rect x={LEFT} y={TOP - 10} width={PLOT_WIDTH} height={BOTTOM - TOP + 22} /></clipPath></defs>
          {Array.from({ length: 6 }, (_, index) => {
            const tickY = TOP + (BOTTOM - TOP) / 5 * index;
            const price = ceiling - span / 5 * index;
            return <g key={`horizontal-${index}`}><line x1={LEFT} x2={WIDTH - RIGHT} y1={tickY} y2={tickY} className="chart-gridline" /><text x={WIDTH - RIGHT + 14} y={tickY + 4} className="chart-axis-label">{formatPrice(price)}</text></g>;
          })}
          {Array.from({ length: 6 }, (_, index) => {
            const tickIndex = Math.min(visible.length - 1, Math.max(0, Math.round((visible.length - 1) * index / 5)));
            const tickX = visible.length ? x(tickIndex) : LEFT + PLOT_WIDTH * index / 5;
            return <g key={`vertical-${index}`}><line x1={tickX} x2={tickX} y1={TOP} y2={290} className="chart-gridline chart-gridline-vertical" />{visible[tickIndex] && <text x={tickX} y={310} textAnchor="middle" className="chart-axis-label">{timeLabel(visible[tickIndex].time)}</text>}</g>;
          })}
          <line x1={LEFT} x2={WIDTH - RIGHT} y1={290} y2={290} className="chart-gridline" />
          <g clipPath={`url(#${clipId})`}>
            {visiblePositions.map((position) => <g key={position.id}><line x1={LEFT} x2={WIDTH - RIGHT} y1={y(position.entryPrice)} y2={y(position.entryPrice)} className={`chart-position-line chart-position-${position.side}`} /><rect x={LEFT + 4} y={y(position.entryPrice) - 9} width={100} height={17} rx={3} className="chart-position-tag" /><text x={LEFT + 10} y={y(position.entryPrice) + 3} className="chart-position-label">{position.side === 'buy' ? '買' : '売'} {formatPrice(position.entryPrice)}</text></g>)}
            {visible.map((candle, index) => {
              const up = candle.close >= candle.open;
              const top = y(Math.max(candle.open, candle.close));
              const body = Math.max(Math.abs(y(candle.open) - y(candle.close)), 1.5);
              return <g key={candle.time} className={up ? 'chart-candle-up' : 'chart-candle-down'} opacity={activeIndex >= 0 && activeIndex !== index ? 0.72 : 1}><line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} strokeWidth={1.2} /><rect x={x(index) - candleWidth / 2} y={top} width={candleWidth} height={body} rx={0.8} /></g>;
            })}
          </g>
          {visible.map((candle, index) => {
            const height = Math.max(2, (candle.high - candle.low) / maxCandleRange * 25);
            return <rect key={`range-${candle.time}`} className={candle.close >= candle.open ? 'chart-range-up' : 'chart-range-down'} x={x(index) - candleWidth / 2} y={286 - height} width={candleWidth} height={height} rx={0.6} />;
          })}
          <text x={LEFT + 5} y={263} className="chart-range-label">値幅</text>
          {latest && <g><line x1={LEFT} x2={WIDTH - RIGHT + 2} y1={y(latest.close)} y2={y(latest.close)} className={`chart-current-line chart-${latest.close >= latest.open ? 'up' : 'down'}`} /><rect x={WIDTH - RIGHT + 2} y={y(latest.close) - 11} width={RIGHT - 5} height={22} rx={4} className={latest.close >= latest.open ? 'chart-price-up' : 'chart-price-down'} /><text x={WIDTH - RIGHT + 11} y={y(latest.close) + 4} className="chart-current-label">{formatPrice(latest.close)}</text></g>}
          {activeIndex >= 0 && active && crosshairY !== null && crosshairPrice !== null && <g className="chart-crosshair" pointerEvents="none"><line x1={x(activeIndex)} x2={x(activeIndex)} y1={TOP} y2={290} /><line x1={LEFT} x2={WIDTH - RIGHT} y1={crosshairY} y2={crosshairY} /><circle cx={x(activeIndex)} cy={y(active.close)} r={3.5} /><rect x={WIDTH - RIGHT + 2} y={crosshairY - 11} width={RIGHT - 5} height={22} rx={4} className="chart-crosshair-tag" /><text x={WIDTH - RIGHT + 11} y={crosshairY + 4} className="chart-crosshair-text">{formatPrice(crosshairPrice)}</text><rect x={Math.max(LEFT, Math.min(WIDTH - RIGHT - 114, x(activeIndex) - 57))} y={298} width={114} height={22} rx={4} className="chart-crosshair-tag" /><text x={Math.max(LEFT + 57, Math.min(WIDTH - RIGHT - 57, x(activeIndex)))} y={313} textAnchor="middle" className="chart-crosshair-text">{fullTimeLabel(active.time)}</text></g>}
          {!latest && <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" className="chart-empty-label">シミュレーションを開始するとチャートが表示されます</text>}
        </svg>
      </div>
      <div className="chart-footer"><span><span className="chart-legend-dot chart-legend-up" />上昇<span className="chart-legend-dot chart-legend-down" />下落</span><span>カーソル・矢印キーで価格を確認<span className="chart-timezone"> · 日本時間（JST）</span></span></div>
    </section>
  );
}
