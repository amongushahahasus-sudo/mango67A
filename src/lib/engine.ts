/** A local, JPY-denominated FX practice engine. Prices are simulated, never live. */
export type CurrencyPair = 'USDJPY' | 'EURJPY' | 'GBPJPY' | 'EURUSD';
export type Side = 'buy' | 'sell';
export type Scenario = 'balanced' | 'bullish' | 'bearish' | 'volatile';
export type Prices = Record<CurrencyPair, number>;

export interface PairMetadata {
  id: CurrencyPair;
  label: string;
  base: string;
  quote: string;
  decimals: number;
  spread: number;
  pipSize: number;
  initialPrice: number;
  accent: string;
}

export const PAIRS: Record<CurrencyPair, PairMetadata> = {
  USDJPY: { id: 'USDJPY', label: 'USD / JPY', base: 'USD', quote: 'JPY', decimals: 3, spread: 0.003, pipSize: 0.01, initialPrice: 153.482, accent: '#4cc9ab' },
  EURJPY: { id: 'EURJPY', label: 'EUR / JPY', base: 'EUR', quote: 'JPY', decimals: 3, spread: 0.005, pipSize: 0.01, initialPrice: 166.174, accent: '#9298ff' },
  GBPJPY: { id: 'GBPJPY', label: 'GBP / JPY', base: 'GBP', quote: 'JPY', decimals: 3, spread: 0.01, pipSize: 0.01, initialPrice: 198.376, accent: '#e7b46a' },
  EURUSD: { id: 'EURUSD', label: 'EUR / USD', base: 'EUR', quote: 'USD', decimals: 5, spread: 0.00008, pipSize: 0.0001, initialPrice: 1.08269, accent: '#66b4ec' },
};

export interface Candle { time: number; open: number; high: number; low: number; close: number }
export interface Position {
  id: string;
  pair: CurrencyPair;
  side: Side;
  units: number;
  entryPrice: number;
  openedAt: number;
  takeProfit?: number;
  stopLoss?: number;
}
export interface ClosedTrade {
  id: string;
  pair: CurrencyPair;
  side: Side;
  units: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnl: number;
  reason: string;
}
export interface Order {
  id: string;
  pair: CurrencyPair;
  side: Side;
  units: number;
  type: 'limit' | 'stop';
  price: number;
  takeProfit?: number;
  stopLoss?: number;
  createdAt: number;
}
export interface Account { balance: number; positions: Position[]; orders: Order[]; history: ClosedTrade[] }
export type MarketOrderInput = Pick<Position, 'pair' | 'side' | 'units' | 'takeProfit' | 'stopLoss'>;
export type PendingOrderInput = Omit<Order, 'id' | 'createdAt'>;
export interface TradeResult { account: Account; error?: string }
export const INITIAL_BALANCE = 1_000_000;
export const LEVERAGE = 25;
export const STOP_OUT_LEVEL = 50;
export const MAX_OPEN_ITEMS = 100;

export function createAccount(): Account {
  return { balance: INITIAL_BALANCE, positions: [], orders: [], history: [] };
}

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;
const validPrice = (value: number) => Number.isFinite(value) && value > 0;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** One simulated minute. The injected random source makes scenarios reproducible. */
export function nextCandle(previous: Candle, pair: CurrencyPair, scenario: Scenario = 'balanced', random: () => number = Math.random): Candle {
  const { decimals } = PAIRS[pair];
  const volatility = scenario === 'volatile' ? 0.00048 : 0.00015;
  const drift = scenario === 'bullish' ? 0.000075 : scenario === 'bearish' ? -0.000075 : 0;
  const sample = () => Math.max(0, Math.min(1, random()));
  const noise = (sample() + sample() + sample() - 1.5) * volatility;
  const open = previous.close;
  const floor = 1 / 10 ** decimals;
  const close = Math.max(floor, round(open * (1 + drift + noise), decimals));
  const wick = open * volatility * (0.18 + sample() * 0.5);
  const high = Math.max(open, close, round(Math.max(open, close) + wick * sample(), decimals));
  const low = Math.max(floor, Math.min(open, close, round(Math.min(open, close) - wick * sample(), decimals)));
  return { time: previous.time + 60_000, open, high, low, close };
}

/** The seed determines prices; the last historical bar ends at the current minute. */
export function generateInitialCandles(pair: CurrencyPair, count = 100, seed = 67): Candle[] {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new RangeError('ローソク足の本数が不正です。');
  const pairSeed = pair.split('').reduce((value, char) => value * 31 + char.charCodeAt(0), seed);
  const random = seededRandom(pairSeed);
  const firstTime = Math.floor(Date.now() / 60_000) * 60_000 - (count - 1) * 60_000;
  const initialPrice = PAIRS[pair].initialPrice;
  let previous: Candle = { time: firstTime - 60_000, open: initialPrice, high: initialPrice, low: initialPrice, close: initialPrice };
  const candles: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    previous = nextCandle(previous, pair, 'balanced', random);
    candles.push(previous);
  }
  return candles;
}

export function getQuote(pair: CurrencyPair, mid: number) {
  const { spread, decimals } = PAIRS[pair];
  const bid = round(mid - spread / 2, decimals);
  return { bid, ask: round(bid + spread, decimals), spread };
}

function quoteToYen(pair: CurrencyPair, amount: number, prices: Prices) {
  return PAIRS[pair].quote === 'JPY' ? amount : amount * prices.USDJPY;
}

export function unrealizedPnl(position: Position, prices: Prices): number {
  const quote = getQuote(position.pair, prices[position.pair]);
  const exitPrice = position.side === 'buy' ? quote.bid : quote.ask;
  const direction = position.side === 'buy' ? 1 : -1;
  return quoteToYen(position.pair, (exitPrice - position.entryPrice) * position.units * direction, prices);
}

export function marginRequired(pair: CurrencyPair, units: number, prices: Prices, leverage = LEVERAGE): number {
  return quoteToYen(pair, units * prices[pair], prices) / leverage;
}

export function accountMetrics(account: Account, prices: Prices) {
  const unrealized = account.positions.reduce((total, position) => total + unrealizedPnl(position, prices), 0);
  const usedMargin = account.positions.reduce((total, position) => total + marginRequired(position.pair, position.units, prices), 0);
  const equity = account.balance + unrealized;
  return {
    balance: account.balance,
    equity,
    unrealizedPnl: unrealized,
    usedMargin,
    freeMargin: equity - usedMargin,
    marginLevel: usedMargin > 0 ? equity / usedMargin * 100 : Infinity,
  };
}

function nextId(account: Account, kind: 'position' | 'order', now: number) {
  const ids = new Set([...account.positions, ...account.orders, ...account.history].map((item) => item.id));
  let index = 0;
  while (ids.has(`${kind}-${now}-${index}`)) index += 1;
  return `${kind}-${now}-${index}`;
}

function validateInput(input: MarketOrderInput, prices: Prices): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(PAIRS, input.pair) || !['buy', 'sell'].includes(input.side)) return '通貨ペアまたは売買方向が不正です。';
  if (!Object.values(prices).every(validPrice) || !validPrice(prices[input.pair]) || !validPrice(prices.USDJPY)) return '有効なレートを取得できません。';
  if (!Number.isInteger(input.units) || input.units < 1_000 || input.units > 1_000_000 || input.units % 1_000 !== 0) return '数量は1,000〜1,000,000通貨の範囲で、1,000通貨単位で指定してください。';
  if ((input.takeProfit !== undefined && !validPrice(input.takeProfit)) || (input.stopLoss !== undefined && !validPrice(input.stopLoss))) return '利確・損切りには正の価格を指定してください。';
  return undefined;
}

function validateTargets(input: MarketOrderInput, entry: number): string | undefined {
  if (input.takeProfit !== undefined && (input.side === 'buy' ? input.takeProfit <= entry : input.takeProfit >= entry)) return input.side === 'buy' ? '買いの利確価格は注文価格より高くしてください。' : '売りの利確価格は注文価格より低くしてください。';
  if (input.stopLoss !== undefined && (input.side === 'buy' ? input.stopLoss >= entry : input.stopLoss <= entry)) return input.side === 'buy' ? '買いの損切り価格は注文価格より低くしてください。' : '売りの損切り価格は注文価格より高くしてください。';
  return undefined;
}

function executeMarket(account: Account, input: MarketOrderInput, prices: Prices, now: number, validateBrackets: boolean): TradeResult {
  const error = validateInput(input, prices);
  if (error) return { account, error };
  if (account.positions.length >= MAX_OPEN_ITEMS) return { account, error: '保有ポジションは最大100件です。' };
  const quote = getQuote(input.pair, prices[input.pair]);
  const entryPrice = input.side === 'buy' ? quote.ask : quote.bid;
  const targetError = validateBrackets ? validateTargets(input, entryPrice) : undefined;
  if (targetError) return { account, error: targetError };
  const position: Position = { ...input, id: nextId(account, 'position', now), entryPrice, openedAt: now };
  const candidate = { ...account, positions: [...account.positions, position] };
  if (accountMetrics(candidate, prices).freeMargin < -0.000001) return { account, error: '証拠金が不足しています。数量を減らすか、保有ポジションを決済してください。' };
  return { account: candidate };
}

export function openMarketPosition(account: Account, input: MarketOrderInput, prices: Prices, now = Date.now()): TradeResult {
  return executeMarket(account, input, prices, now, true);
}

export function closePosition(account: Account, id: string, prices: Prices, reason = '手動決済', now = Date.now()): Account {
  const position = account.positions.find((item) => item.id === id);
  if (!position) return account;
  const quote = getQuote(position.pair, prices[position.pair]);
  const exitPrice = position.side === 'buy' ? quote.bid : quote.ask;
  const pnl = unrealizedPnl(position, prices);
  const trade: ClosedTrade = {
    id: position.id, pair: position.pair, side: position.side, units: position.units,
    entryPrice: position.entryPrice, exitPrice, openedAt: position.openedAt, closedAt: now, pnl, reason,
  };
  return { ...account, balance: account.balance + pnl, positions: account.positions.filter((item) => item.id !== id), history: [trade, ...account.history] };
}

export function placeOrder(account: Account, input: PendingOrderInput, prices: Prices, now = Date.now()): TradeResult {
  const error = validateInput(input, prices);
  if (error) return { account, error };
  if (!validPrice(input.price)) return { account, error: '注文価格には正の数値を指定してください。' };
  if (!['limit', 'stop'].includes(input.type)) return { account, error: '注文方法が不正です。' };
  if (account.orders.length >= MAX_OPEN_ITEMS) return { account, error: '未約定注文は最大100件です。' };
  const quote = getQuote(input.pair, prices[input.pair]);
  const current = input.side === 'buy' ? quote.ask : quote.bid;
  const wantsLower = (input.side === 'buy' && input.type === 'limit') || (input.side === 'sell' && input.type === 'stop');
  if (wantsLower ? input.price >= current : input.price <= current) return { account, error: wantsLower ? 'この注文の価格は現在の約定レートより低くしてください。' : 'この注文の価格は現在の約定レートより高くしてください。' };
  const targetError = validateTargets(input, input.price);
  if (targetError) return { account, error: targetError };
  return { account: { ...account, orders: [...account.orders, { ...input, id: nextId(account, 'order', now), createdAt: now }] } };
}

export function cancelOrder(account: Account, id: string): Account {
  if (!account.orders.some((order) => order.id === id)) return account;
  return { ...account, orders: account.orders.filter((order) => order.id !== id) };
}

function closeTriggeredPositions(account: Account, prices: Prices, now: number): Account {
  return account.positions.reduce((state, position) => {
    const quote = getQuote(position.pair, prices[position.pair]);
    const exit = position.side === 'buy' ? quote.bid : quote.ask;
    const stopHit = position.stopLoss !== undefined && (position.side === 'buy' ? exit <= position.stopLoss : exit >= position.stopLoss);
    const profitHit = position.takeProfit !== undefined && (position.side === 'buy' ? exit >= position.takeProfit : exit <= position.takeProfit);
    return stopHit || profitHit ? closePosition(state, position.id, prices, stopHit ? '損切り' : '利確', now) : state;
  }, account);
}

function liquidateIfNeeded(account: Account, prices: Prices, now: number): Account {
  if (!account.positions.length || accountMetrics(account, prices).marginLevel > STOP_OUT_LEVEL) return account;
  return account.positions.reduce((state, position) => closePosition(state, position.id, prices, 'ロスカット', now), account);
}

/** Orders fill at the current executable quote, allowing favorable limits and stop slippage.
 * Triggered orders that cannot meet margin/position requirements are cancelled.
 */
export function processMarket(account: Account, prices: Prices, now = Date.now()): Account {
  if (!(Object.keys(PAIRS) as CurrencyPair[]).every((pair) => validPrice(prices[pair]))) return account;
  let state = liquidateIfNeeded(closeTriggeredPositions(account, prices, now), prices, now);
  for (const order of state.orders) {
    const quote = getQuote(order.pair, prices[order.pair]);
    const executable = order.side === 'buy' ? quote.ask : quote.bid;
    const triggerLower = (order.side === 'buy' && order.type === 'limit') || (order.side === 'sell' && order.type === 'stop');
    if (!(triggerLower ? executable <= order.price : executable >= order.price)) continue;
    state = cancelOrder(state, order.id);
    const { pair, side, units, takeProfit, stopLoss } = order;
    state = executeMarket(state, { pair, side, units, takeProfit, stopLoss }, prices, now, false).account;
  }
  return liquidateIfNeeded(closeTriggeredPositions(state, prices, now), prices, now);
}
