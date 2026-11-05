import { PAIRS, createAccount, generateInitialCandles } from './engine'
import type { Account, Candle, CurrencyPair, Prices, Scenario } from './engine'
export type Timeframe = '1m' | '5m' | '15m' | '1h'
export const GUEST_STORAGE_KEY = 'mango-fx-simulator-v1'
const pairs = Object.keys(PAIRS) as CurrencyPair[]
const scenarios = ['balanced','bullish','bearish','volatile']
const pricesOf = (markets: SavedState['markets']): Prices => Object.fromEntries(pairs.map(pair => [pair, markets[pair].at(-1)!.close])) as Prices
// Keep the legacy paused field for the existing cloud schema; new state always runs.
export type SavedState = { version: 1; account: Account; markets: Record<CurrencyPair, Candle[]>; baseline: Prices; pair: CurrencyPair; scenario: Scenario; timeframe: Timeframe; speed: number; paused: boolean; marketEvent?: { id: number; text: string } }
export function createSavedState(): SavedState {
  const markets = Object.fromEntries(pairs.map((pair, i) => [pair, generateInitialCandles(pair, 1440, 42 + i * 99)])) as SavedState['markets']
  return { version: 1, account: createAccount(), markets, baseline: pricesOf(markets), pair: 'USDJPY', scenario: 'balanced', timeframe: '1m', speed: 1, paused: false }
}
export function parseSavedState(value: unknown): SavedState | null {
  try {
    const s = value as SavedState | null
    if (!s || s.version !== 1 || !pairs.includes(s.pair) || !scenarios.includes(s.scenario) || !['1m','5m','15m','1h'].includes(s.timeframe) || ![1,2,5].includes(s.speed) || typeof s.paused !== 'boolean') return null
    if (!s.account || !Number.isFinite(s.account.balance) || !['positions','orders','history'].every(key => Array.isArray(s.account[key as 'positions']))) return null
    if (!pairs.every(pair => Number.isFinite(s.baseline?.[pair]) && s.baseline[pair] > 0 && Array.isArray(s.markets?.[pair]) && s.markets[pair].length > 0 && s.markets[pair].every(c => [c.time,c.open,c.high,c.low,c.close].every(Number.isFinite) && Math.min(c.open,c.high,c.low,c.close)>0))) return null
    if (![...s.account.positions, ...s.account.orders, ...s.account.history].every(p => pairs.includes(p.pair) && ['buy','sell'].includes(p.side) && Number.isFinite(p.units) && p.units > 0 && typeof p.id === 'string')) return null
    const validTimestamp = (value: number) => Number.isFinite(value) && Math.abs(value) <= 8.64e15
    const validTargets = (item: { takeProfit?: number; stopLoss?: number }) => [item.takeProfit,item.stopLoss].every(value => value === undefined || (Number.isFinite(value) && value > 0))
    if (!s.account.positions.every(p => Number.isFinite(p.entryPrice) && p.entryPrice>0 && validTimestamp(p.openedAt) && validTargets(p)) || !s.account.orders.every(o => ['limit','stop'].includes(o.type) && Number.isFinite(o.price) && o.price>0 && validTimestamp(o.createdAt) && validTargets(o)) || !s.account.history.every(t => Number.isFinite(t.pnl) && Number.isFinite(t.entryPrice) && t.entryPrice>0 && Number.isFinite(t.exitPrice) && t.exitPrice>0 && validTimestamp(t.openedAt) && validTimestamp(t.closedAt) && typeof t.reason==='string')) return null
    return s.paused ? { ...s, paused: false } : s
  } catch { return null }
}

export function readSavedState(key = GUEST_STORAGE_KEY): SavedState | null {
  try { return parseSavedState(JSON.parse(localStorage.getItem(key) || 'null')) }
  catch { return null }
}
export function loadSavedState(key = GUEST_STORAGE_KEY): SavedState { return readSavedState(key) ?? createSavedState() }
export function userStorageKey(userId: string): string { return `mango-fx-user:${userId}:v1` }
export function hasPracticeProgress(state: SavedState | null): boolean {
  return Boolean(state && (state.account.balance !== 1_000_000 || state.account.positions.length || state.account.orders.length || state.account.history.length))
}
