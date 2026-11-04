import { loadPhotoShop, parseShopSnapshot, PhotoShopError, PHOTO_MAX_PRICE, requestShopRpc, SetupRequiredError } from './photoShop'
import type { ShopSnapshot } from './photoShop'

export interface LotterySettings { entryCost: number; winRateBps: number; enabled: boolean }
export interface LotteryEntry {
  id: string
  requestId: string
  productId: string
  outcome: 'win' | 'lose'
  cost: number
  createdAt: string
  refunded: boolean
  orderId: string | null
}
export interface LotteryDraw { shop: ShopSnapshot; entry: LotteryEntry }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const validCost = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= PHOTO_MAX_PRICE
const invalidRequest = () => new PhotoShopError('invalid_lottery', 'くじの申込内容を確認してください。')
const invalidResponse = () => new PhotoShopError('connection', 'くじの結果を確認できませんでした。同じ申込から、もう一度結果を確認してください。')
const setupRequired = () => new SetupRequiredError('くじの準備がまだ完了していません。管理者向けの設定を完了してからお試しください。')

function checkRequest(productId: string, requestId: string) {
  if (!UUID.test(productId) || !UUID.test(requestId)) throw invalidRequest()
}

function parseEntry(value: unknown, productId: string, requestId: string): LotteryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || !UUID.test(entry.id) || entry.productId !== productId || entry.requestId !== requestId
    || (entry.outcome !== 'win' && entry.outcome !== 'lose') || !validCost(entry.cost)
    || typeof entry.createdAt !== 'string' || entry.createdAt.length > 60 || !Number.isFinite(Date.parse(entry.createdAt))
    || typeof entry.refunded !== 'boolean'
    || (entry.outcome === 'win' ? typeof entry.orderId !== 'string' || !UUID.test(entry.orderId) : entry.orderId !== null || entry.refunded)) throw invalidResponse()
  return { id: entry.id, requestId, productId, outcome: entry.outcome, cost: entry.cost,
    createdAt: entry.createdAt, refunded: entry.refunded, orderId: entry.orderId as string | null }
}

export async function configureShopLottery(productId: string, settings: LotterySettings, expectedRevision: number | null, expectedUserId: string): Promise<ShopSnapshot> {
  if (!UUID.test(productId) || !settings || !validCost(settings.entryCost)
    || !Number.isInteger(settings.winRateBps) || settings.winRateBps < 1 || settings.winRateBps > 10000
    || typeof settings.enabled !== 'boolean' || (expectedRevision !== null && !validRevision(expectedRevision))) throw invalidRequest()
  const access = await loadPhotoShop(expectedUserId)
  if (!access.role) throw new PhotoShopError('admin_required', 'くじを管理できるのは、管理者に指定されたアカウントだけです。')
  if (!access.lotteriesReady) throw setupRequired()
  const value = await requestShopRpc('configure_shop_lottery', {
    p_product_id: productId, p_entry_cost: settings.entryCost, p_win_rate_bps: settings.winRateBps,
    p_enabled: settings.enabled, p_expected_revision: expectedRevision, p_expected_user_id: expectedUserId,
  }, expectedUserId)
  const shop = parseShopSnapshot(value)
  if (!shop.lotteriesReady) throw invalidResponse()
  return shop
}

/** The caller persists this request ID before sending and reuses it after an uncertain response. */
export async function drawShopLottery(productId: string, expectedRevision: number, requestId: string, expectedUserId: string): Promise<LotteryDraw> {
  checkRequest(productId, requestId)
  if (!validRevision(expectedRevision)) throw invalidRequest()
  // The server checks an existing entry first. Local stock/config checks would break retries.
  const value = await requestShopRpc('draw_shop_lottery', {
    p_product_id: productId, p_expected_revision: expectedRevision, p_request_id: requestId, p_expected_user_id: expectedUserId,
  }, expectedUserId)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const result = value as Record<string, unknown>, shop = parseShopSnapshot(result.shop)
  if (!shop.lotteriesReady) throw invalidResponse()
  return { shop, entry: parseEntry(result.entry, productId, requestId) }
}

/** A missing entry is not proof that an earlier, unanswered draw cannot still commit. */
export async function loadShopLotteryEntry(productId: string, requestId: string, expectedUserId: string): Promise<LotteryEntry | null> {
  checkRequest(productId, requestId)
  const value = await requestShopRpc('get_shop_lottery_entry', {
    p_product_id: productId, p_request_id: requestId, p_expected_user_id: expectedUserId,
  }, expectedUserId)
  return value === null ? null : parseEntry(value, productId, requestId)
}
