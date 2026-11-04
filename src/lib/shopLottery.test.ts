import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: mocks.getSession }, rpc: mocks.rpc } }))

import { parseShopSnapshot } from './photoShop'
import { configureShopLottery, drawShopLottery, loadShopLotteryEntry } from './shopLottery'

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const productId = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'
const orderId = '55555555-5555-4555-8555-555555555555'
const entryId = '66666666-6666-4666-8666-666666666666'
const lottery = { entryCost: 100, winRateBps: 1250, enabled: true, revision: 2 }
const product = { id: productId, title: 'ごほうび', description: '', price: 500, published: true,
  kind: 'file', saleMode: 'lottery', lottery, fileType: 'txt', previewPath: null, stockRemaining: 1,
  deliveryStatus: 'not_purchased', orderId: null, orderSource: null, purchased: false, paidPrice: null, purchasedAt: null,
  revision: 1, createdAt: '2026-11-04T02:00:00Z' }
const shop = { role: null, realizedProfit: 1200, spentProfit: 100, availableProfit: 1100,
  photos: [product], orders: [], lotteriesReady: true }
const entry = { id: entryId, requestId, productId, outcome: 'lose', cost: 100, createdAt: '2026-11-04T02:20:00Z', refunded: false, orderId: null }
const session = (uid: string) => ({ data: { session: { user: { id: uid } } }, error: null })
const response = (data: unknown, error: unknown = null) => ({ abortSignal: vi.fn().mockResolvedValue({ data, error }) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSession.mockResolvedValue(session(alice))
  mocks.rpc.mockImplementation((name: string) => response(name === 'get_reward_shop' || name === 'configure_shop_lottery' ? { ...shop, role: 'admin' } : name === 'get_shop_lottery_entry' ? entry : { shop, entry }))
})

describe('lottery metadata compatibility', () => {
  it('normalizes earlier file-shop snapshots without enabling missing lottery APIs', () => {
    const { lotteriesReady: _ready, ...previous } = shop
    const { lottery: _lottery, saleMode: _mode, ...previousProduct } = product
    expect(parseShopSnapshot({ ...previous, photos: [previousProduct] })).toMatchObject({ lotteriesReady: false,
      photos: [expect.objectContaining({ lottery: null, saleMode: 'direct' })] })
    expect(parseShopSnapshot(shop).photos[0].lottery).toEqual(lottery)
  })

  it('rejects invalid odds, prices, revisions, and inappropriate photo lottery metadata', () => {
    for (const changes of [{ winRateBps: 0 }, { winRateBps: 10001 }, { winRateBps: 1.5 }, { entryCost: 0 }, { revision: 0 }, { enabled: 'true' }]) {
      expect(() => parseShopSnapshot({ ...shop, photos: [{ ...product, lottery: { ...lottery, ...changes } }] })).toThrow()
    }
    expect(() => parseShopSnapshot({ ...shop, lotteriesReady: 'true' })).toThrow()
    expect(() => parseShopSnapshot({ ...shop, photos: [{ ...product, kind: 'photo' }] })).toThrow()
  })
})

describe('administrator lottery configuration', () => {
  it('pins administrator identity and configuration revision without exposing files', async () => {
    await configureShopLottery(productId, { entryCost: 150, winRateBps: 500, enabled: true }, 2, alice)
    expect(mocks.rpc).toHaveBeenCalledWith('configure_shop_lottery', {
      p_product_id: productId, p_entry_cost: 150, p_win_rate_bps: 500, p_enabled: true, p_expected_revision: 2, p_expected_user_id: alice,
    })
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('prevents invalid settings, ordinary accounts, and older SQL from reaching a write', async () => {
    await expect(configureShopLottery(productId, { entryCost: 0, winRateBps: 100, enabled: true }, null, alice)).rejects.toMatchObject({ code: 'invalid_lottery' })
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.rpc.mockImplementation(() => response(shop))
    await expect(configureShopLottery(productId, lottery, null, alice)).rejects.toMatchObject({ code: 'admin_required' })
    mocks.rpc.mockImplementation(() => response({ ...shop, role: 'admin', lotteriesReady: false }))
    await expect(configureShopLottery(productId, lottery, null, alice)).rejects.toMatchObject({ code: 'setup' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('configure_shop_lottery', expect.anything())
  })
})

describe('account-pinned idempotent draws', () => {
  it('sends the caller request UUID once without a catalog pre-read or a client random result', async () => {
    await expect(drawShopLottery(productId, 2, requestId, alice)).resolves.toMatchObject({ entry })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalledWith('draw_shop_lottery', {
      p_product_id: productId, p_expected_revision: 2, p_request_id: requestId, p_expected_user_id: alice,
    })
  })

  it('does not retry or rotate the request UUID after an ambiguous response', async () => {
    mocks.rpc.mockImplementationOnce(() => ({ abortSignal: vi.fn().mockRejectedValue(new DOMException('Lost response', 'TimeoutError')) }))
    await expect(drawShopLottery(productId, 2, requestId, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    // The same caller ID can recover a committed result, even with a stale revision.
    await expect(drawShopLottery(productId, 2, requestId, alice)).resolves.toMatchObject({ entry })
    expect(mocks.rpc.mock.calls.map(([, params]) => params.p_request_id)).toEqual([requestId, requestId])
  })

  it('rejects a request before sending or before exposing its result if the account changed', async () => {
    mocks.getSession.mockResolvedValue(session(bob))
    await expect(drawShopLottery(productId, 2, requestId, alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.getSession.mockResolvedValueOnce(session(alice)).mockResolvedValueOnce(session(bob))
    await expect(drawShopLottery(productId, 2, requestId, alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('maps definitive server rejection codes and conceals arbitrary backend details', async () => {
    const codes = { SHOP_LOTTERY_CHANGED: 'lottery_changed', SHOP_LOTTERY_UNAVAILABLE: 'lottery_disabled', SHOP_OUT_OF_STOCK: 'out_of_stock',
      SHOP_INSUFFICIENT_PROFIT: 'insufficient_profit', SHOP_LOTTERY_REQUEST_CONFLICT: 'lottery_request_conflict' }
    for (const [marker, code] of Object.entries(codes)) {
      mocks.rpc.mockImplementation(() => response(null, { message: `${marker}: private database value` }))
      await expect(drawShopLottery(productId, 2, requestId, alice)).rejects.toMatchObject({ code })
      try { await drawShopLottery(productId, 2, requestId, alice) } catch (error) { expect((error as Error).message).not.toContain('private database value') }
    }
    mocks.rpc.mockImplementation(() => response(null, { code: 'PGRST202' }))
    await expect(drawShopLottery(productId, 2, requestId, alice)).rejects.toMatchObject({ code: 'setup' })
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'draw_shop_lottery')).toBe(true)
  })

  it('rejects mismatched requests, invalid wins, and refunded losing entries', async () => {
    for (const changes of [{ requestId: bob }, { productId: bob }, { cost: 0 }, { outcome: 'win' }, { outcome: 'lose', orderId }, { refunded: true }]) {
      mocks.rpc.mockImplementation(() => response({ shop, entry: { ...entry, ...changes } }))
      await expect(drawShopLottery(productId, 2, requestId, alice)).rejects.toMatchObject({ code: 'connection' })
    }
  })

  it('keeps an awarded file pending until the server approval receipt changes', async () => {
    const awarded = { ...product, stockRemaining: 0, purchased: true, paidPrice: 0, purchasedAt: entry.createdAt,
      orderId, orderSource: 'lottery', deliveryStatus: 'pending' }
    mocks.rpc.mockImplementation(() => response({ shop: { ...shop, photos: [awarded] }, entry: { ...entry, outcome: 'win', orderId } }))
    const result = await drawShopLottery(productId, 2, requestId, alice)
    expect(result.entry.outcome).toBe('win')
    expect(result.shop.photos[0]).toMatchObject({ deliveryStatus: 'pending', paidPrice: 0, orderSource: 'lottery' })
  })
})

describe('recovering a pending draw', () => {
  it('reads only the caller entry and preserves a missing result as null', async () => {
    await expect(loadShopLotteryEntry(productId, requestId, alice)).resolves.toEqual(entry)
    expect(mocks.rpc).toHaveBeenCalledWith('get_shop_lottery_entry', { p_product_id: productId, p_request_id: requestId, p_expected_user_id: alice })
    mocks.rpc.mockImplementation(() => response(null))
    await expect(loadShopLotteryEntry(productId, requestId, alice)).resolves.toBeNull()
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'get_shop_lottery_entry')).toBe(true)
  })

  it('validates lookup identity, result ownership, and a refunded winning result', async () => {
    mocks.rpc.mockImplementation(() => response({ ...entry, requestId: bob }))
    await expect(loadShopLotteryEntry(productId, requestId, alice)).rejects.toMatchObject({ code: 'connection' })
    mocks.rpc.mockImplementation(() => response({ ...entry, outcome: 'win', orderId, refunded: true }))
    await expect(loadShopLotteryEntry(productId, requestId, alice)).resolves.toMatchObject({ outcome: 'win', refunded: true, orderId })
    mocks.getSession.mockResolvedValue(session(bob))
    await expect(loadShopLotteryEntry(productId, requestId, alice)).rejects.toMatchObject({ code: 'session_changed' })
  })
})
