import { describe, expect, it } from 'vitest';
import {
  INITIAL_BALANCE, PAIRS, accountMetrics, cancelOrder, closePosition, createAccount,
  generateInitialCandles, getQuote, marginRequired, nextCandle, openMarketPosition,
  placeOrder, processMarket, unrealizedPnl,
} from './engine';
import type { CurrencyPair, Prices, Side } from './engine';

const prices: Prices = { USDJPY: 150, EURJPY: 165, GBPJPY: 190, EURUSD: 1.1 };
const open = (account = createAccount(), side: Side = 'buy', pair: CurrencyPair = 'USDJPY', units = 10_000) => {
  const result = openMarketPosition(account, { pair, side, units }, prices, 1_000);
  expect(result.error).toBeUndefined();
  return result.account;
};

describe('quotes and JPY account valuation', () => {
  it('charges the quoted spread for an immediate round trip, for both buy and sell', () => {
    for (const side of ['buy', 'sell'] as const) {
      const account = open(createAccount(), side);
      expect(account.balance).toBe(INITIAL_BALANCE);
      expect(unrealizedPnl(account.positions[0], prices)).toBeCloseTo(-30, 6);
      const closed = closePosition(account, account.positions[0].id, prices);
      expect(closed.balance).toBeCloseTo(INITIAL_BALANCE - 30, 6);
      expect(closed.positions).toHaveLength(0);
      expect(closed.history[0].pnl).toBeCloseTo(-30, 6);
    }
  });

  it('keeps the advertised spread at each pair precision', () => {
    for (const pair of Object.keys(PAIRS) as CurrencyPair[]) {
      const quote = getQuote(pair, prices[pair]);
      expect(quote.ask - quote.bid).toBeCloseTo(PAIRS[pair].spread, PAIRS[pair].decimals + 2);
      expect(quote.bid).toBeLessThan(quote.ask);
    }
  });

  it('values EUR/USD P&L in yen using the current USD/JPY rate', () => {
    const account = open(createAccount(), 'buy', 'EURUSD');
    const moved = { ...prices, EURUSD: 1.11, USDJPY: 160 };
    // EUR 10,000 × (bid 1.10996 - entry 1.10004) = USD 99.20 = JPY 15,872.
    expect(unrealizedPnl(account.positions[0], moved)).toBeCloseTo(15_872, 5);
    expect(marginRequired('EURUSD', 10_000, moved)).toBeCloseTo(71_040, 5);
  });

  it('treats a falling market as a profit for short positions', () => {
    const account = open(createAccount(), 'sell');
    const moved = { ...prices, USDJPY: 149 };
    expect(unrealizedPnl(account.positions[0], moved)).toBeCloseTo(9_970, 6);
  });

  it('includes unrealized losses in free margin and equity', () => {
    const account = open();
    const metrics = accountMetrics(account, prices);
    expect(metrics.usedMargin).toBe(60_000);
    expect(metrics.equity).toBeCloseTo(999_970, 6);
    expect(metrics.freeMargin).toBeCloseTo(939_970, 6);
    expect(metrics.marginLevel).toBeCloseTo(999_970 / 60_000 * 100, 6);
    expect(accountMetrics(createAccount(), prices).marginLevel).toBe(Infinity);
  });
});

describe('order validation and immutable accounting', () => {
  it.each([0, -1_000, 500, 1_500, 1_001_000, NaN, Infinity])('rejects invalid quantity %s', (units) => {
    const original = createAccount();
    const result = openMarketPosition(original, { pair: 'USDJPY', side: 'buy', units }, prices);
    expect(result.error).toBeTruthy();
    expect(result.account).toBe(original);
  });

  it('rejects exposure whose margin exceeds available equity', () => {
    const original = createAccount();
    const result = openMarketPosition(original, { pair: 'USDJPY', side: 'buy', units: 200_000 }, prices);
    expect(result.error).toContain('証拠金');
    expect(result.account).toBe(original);
  });

  it('accounts for the initial spread loss when testing available margin', () => {
    const original = { ...createAccount(), balance: 60_000 };
    const result = openMarketPosition(original, { pair: 'USDJPY', side: 'buy', units: 10_000 }, prices);
    expect(result.error).toContain('証拠金');
  });

  it('rejects inverted targets and nonpositive prices', () => {
    for (const extra of [{ takeProfit: 149 }, { stopLoss: 151 }, { stopLoss: NaN }]) {
      expect(openMarketPosition(createAccount(), { pair: 'USDJPY', side: 'buy', units: 1_000, ...extra }, prices).error).toBeTruthy();
    }
    expect(placeOrder(createAccount(), { pair: 'USDJPY', side: 'buy', units: 1_000, type: 'limit', price: 0 }, prices).error).toBeTruthy();
  });

  it('preserves prior state and assigns unique IDs even at the same clock time', () => {
    const original = createAccount();
    const before = JSON.stringify(original);
    const first = open(original);
    const second = open(first);
    expect(JSON.stringify(original)).toBe(before);
    expect(first.positions).toHaveLength(1);
    expect(second.positions).toHaveLength(2);
    expect(new Set(second.positions.map((item) => item.id)).size).toBe(2);
    const closed = closePosition(second, second.positions[0].id, prices, '手動決済', 2_000);
    expect(second.history).toHaveLength(0);
    expect(closed.history[0].closedAt).toBe(2_000);
    expect(closePosition(closed, 'missing', prices)).toBe(closed);
  });
});

describe('pending orders and risk execution', () => {
  it.each([
    { side: 'buy' as const, type: 'limit' as const, price: 149, moved: 148.9 },
    { side: 'sell' as const, type: 'limit' as const, price: 151, moved: 151.1 },
    { side: 'buy' as const, type: 'stop' as const, price: 151, moved: 151.1 },
    { side: 'sell' as const, type: 'stop' as const, price: 149, moved: 148.9 },
  ])('executes a $side $type only when its executable quote crosses the level', ({ side, type, price, moved }) => {
    const result = placeOrder(createAccount(), { pair: 'USDJPY', side, units: 1_000, type, price }, prices, 1_000);
    expect(result.error).toBeUndefined();
    const waiting = processMarket(result.account, prices, 2_000);
    expect(waiting.orders).toHaveLength(1);
    expect(waiting.positions).toHaveLength(0);
    const crossed = { ...prices, USDJPY: moved };
    const executed = processMarket(waiting, crossed, 3_000);
    expect(executed.orders).toHaveLength(0);
    expect(executed.positions).toHaveLength(1);
    expect(executed.positions[0].entryPrice).toBe(side === 'buy' ? getQuote('USDJPY', moved).ask : getQuote('USDJPY', moved).bid);
    expect(executed.positions[0].openedAt).toBe(3_000);
  });

  it('does not trigger a buy limit based only on the midpoint', () => {
    const account = placeOrder(createAccount(), { pair: 'USDJPY', side: 'buy', units: 1_000, type: 'limit', price: 149 }, prices).account;
    const waiting = processMarket(account, { ...prices, USDJPY: 149 });
    expect(waiting.orders).toHaveLength(1);
    expect(waiting.positions).toHaveLength(0);
  });

  it.each([
    { side: 'buy' as const, type: 'limit' as const, price: 151 },
    { side: 'sell' as const, type: 'limit' as const, price: 149 },
    { side: 'buy' as const, type: 'stop' as const, price: 149 },
    { side: 'sell' as const, type: 'stop' as const, price: 151 },
  ])('rejects a $side $type on the wrong side of the current quote', ({ side, type, price }) => {
    expect(placeOrder(createAccount(), { pair: 'USDJPY', side, units: 1_000, type, price }, prices).error).toBeTruthy();
  });

  it('cancels an order without changing cash or opening a position', () => {
    const account = placeOrder(createAccount(), { pair: 'USDJPY', side: 'buy', units: 1_000, type: 'limit', price: 149 }, prices).account;
    const cancelled = cancelOrder(account, account.orders[0].id);
    expect(cancelled.balance).toBe(INITIAL_BALANCE);
    expect(cancelled.orders).toHaveLength(0);
    expect(cancelled.positions).toHaveLength(0);
    expect(account.orders).toHaveLength(1);
  });

  it('cancels a triggered order that cannot be funded', () => {
    const account = placeOrder(createAccount(), { pair: 'USDJPY', side: 'buy', units: 1_000_000, type: 'stop', price: 151 }, prices).account;
    const processed = processMarket(account, { ...prices, USDJPY: 152 });
    expect(processed.orders).toHaveLength(0);
    expect(processed.positions).toHaveLength(0);
    expect(processed.balance).toBe(INITIAL_BALANCE);
  });

  it.each([
    { side: 'buy' as const, takeProfit: 151, stopLoss: 149, moved: 152, reason: '利確' },
    { side: 'buy' as const, takeProfit: 151, stopLoss: 149, moved: 148, reason: '損切り' },
    { side: 'sell' as const, takeProfit: 149, stopLoss: 151, moved: 148, reason: '利確' },
    { side: 'sell' as const, takeProfit: 149, stopLoss: 151, moved: 152, reason: '損切り' },
  ])('closes a $side for $reason at the available quote', ({ side, takeProfit, stopLoss, moved, reason }) => {
    const account = openMarketPosition(createAccount(), { pair: 'USDJPY', side, units: 1_000, takeProfit, stopLoss }, prices).account;
    const processed = processMarket(account, { ...prices, USDJPY: moved }, 9_000);
    expect(processed.positions).toHaveLength(0);
    expect(processed.history).toHaveLength(1);
    expect(processed.history[0].reason).toBe(reason);
    expect(processed.history[0].exitPrice).toBe(side === 'buy' ? getQuote('USDJPY', moved).bid : getQuote('USDJPY', moved).ask);
    expect(processed.balance).toBeCloseTo(INITIAL_BALANCE + processed.history[0].pnl);
  });

  it('liquidates all positions when equity falls below 50% of required margin', () => {
    const account = open(createAccount(), 'buy', 'USDJPY', 150_000);
    const shock = { ...prices, USDJPY: 145 };
    expect(accountMetrics(account, shock).marginLevel).toBeLessThan(50);
    const processed = processMarket(account, shock, 10_000);
    expect(processed.positions).toHaveLength(0);
    expect(processed.history[0].reason).toBe('ロスカット');
    expect(processed.balance).toBeCloseTo(249_550, 5);
    expect(accountMetrics(processed, shock).usedMargin).toBe(0);
  });

  it('closes a just-triggered stop immediately if the market gaps through its take-profit', () => {
    const account = placeOrder(createAccount(), { pair: 'USDJPY', side: 'buy', units: 1_000, type: 'stop', price: 151, takeProfit: 152 }, prices).account;
    const processed = processMarket(account, { ...prices, USDJPY: 153 });
    expect(processed.orders).toHaveLength(0);
    expect(processed.positions).toHaveLength(0);
    expect(processed.history[0].reason).toBe('利確');
    expect(processed.history[0].pnl).toBeCloseTo(-3, 6);
  });
});

describe('simulated market candles', () => {
  it('repeats seeded prices and produces valid, sequential OHLC data', () => {
    const first = generateInitialCandles('USDJPY', 100, 42);
    const second = generateInitialCandles('USDJPY', 100, 42);
    expect(first.map(({ time: _time, ...bar }) => bar)).toEqual(second.map(({ time: _time, ...bar }) => bar));
    expect(first).toHaveLength(100);
    for (let i = 0; i < first.length; i += 1) {
      const candle = first[i];
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
      expect(candle.low).toBeGreaterThan(0);
      if (i) {
        expect(candle.open).toBe(first[i - 1].close);
        expect(candle.time - first[i - 1].time).toBe(60_000);
      }
    }
  });

  it('gives the bullish and bearish scenarios opposing drift with neutral randomness', () => {
    const previous = { time: 0, open: 150, high: 150, low: 150, close: 150 };
    expect(nextCandle(previous, 'USDJPY', 'bullish', () => 0.5).close).toBeGreaterThan(150);
    expect(nextCandle(previous, 'USDJPY', 'bearish', () => 0.5).close).toBeLessThan(150);
    expect(nextCandle(previous, 'USDJPY', 'balanced', () => 0.5).close).toBe(150);
  });
});
