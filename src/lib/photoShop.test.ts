import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn(), getPublicUrl: vi.fn(), download: vi.fn(), upload: vi.fn(), remove: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: {
  auth: { getSession: mocks.getSession },
  rpc: mocks.rpc,
  storage: { from: () => ({ getPublicUrl: mocks.getPublicUrl, download: mocks.download, upload: mocks.upload, remove: mocks.remove }) },
} }))

import { downloadPhoto, parseShopSnapshot, previewUrl, purchasePhoto, SetupRequiredError, updatePhoto, uploadPhoto } from './photoShop'
import type { ShopPhoto, ShopSnapshot } from './photoShop'

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const photo: ShopPhoto = { id, title: '夕方の空', description: '撮影した写真', price: 500, published: true, previewPath: `${id}/preview.jpg`, purchased: false, paidPrice: null, purchasedAt: null, revision: 1, createdAt: '2026-11-04T02:00:00Z' }
const snapshot: ShopSnapshot = { role: null, realizedProfit: 1200, spentProfit: 200, availableProfit: 1000, photos: [photo] }
const session = (uid: string | null) => ({ data: { session: uid ? { user: { id: uid } } : null }, error: null })
const rpcResult = (data: unknown = snapshot, error: unknown = null) => ({ abortSignal: vi.fn().mockResolvedValue({ data, error }) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSession.mockResolvedValue(session(alice))
  mocks.rpc.mockImplementation(() => rpcResult())
  mocks.upload.mockResolvedValue({ data: { path: 'uploaded' }, error: null })
  mocks.remove.mockResolvedValue({ data: [], error: null })
  mocks.getPublicUrl.mockImplementation((path: string) => ({ data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/photo-previews/${path}` } }))
})

afterEach(() => { vi.unstubAllGlobals() })

function prepareImageDecoding() {
  vi.stubGlobal('HTMLImageElement', class {})
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 10, height: 10, close: vi.fn() }))
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn() }
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['preview'], { type: 'image/jpeg' })) }
  vi.stubGlobal('document', { createElement: () => canvas })
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' })
}

describe('shop response boundaries', () => {
  it('preserves price snapshots and ownership independently of current prices', () => {
    const owned = { ...photo, price: 900, purchased: true, paidPrice: 500, purchasedAt: '2026-11-04T02:20:00Z', published: false }
    expect(parseShopSnapshot({ ...snapshot, role: 'developer', photos: [owned] }).photos[0]).toEqual(owned)
  })

  it('rejects made-up role labels, inconsistent wallets, and unsafe numbers', () => {
    for (const changes of [{ role: 'owner' }, { role: 'superadmin' }, { realizedProfit: -1 }, { spentProfit: 1.5 }, { availableProfit: 1200 }, { realizedProfit: Number.MAX_VALUE }]) {
      expect(() => parseShopSnapshot({ ...snapshot, ...changes })).toThrow()
    }
    expect(parseShopSnapshot({ ...snapshot, spentProfit: 2000, availableProfit: 0 }).availableProfit).toBe(0)
  })

  it('rejects traversal/external preview paths, duplicate products, and incomplete entitlements', () => {
    for (const changes of [{ previewPath: 'https://elsewhere.example/image.jpg' }, { previewPath: `${id}/../../original.jpg` }, { price: 0 }, { price: 1.5 }, { purchased: true }, { paidPrice: 500 }]) {
      expect(() => parseShopSnapshot({ ...snapshot, photos: [{ ...photo, ...changes }] })).toThrow()
    }
    expect(() => parseShopSnapshot({ ...snapshot, photos: [photo, photo] })).toThrow()
  })

  it('builds URLs only for validated public previews', () => {
    expect(previewUrl(photo)).toContain(`/photo-previews/${id}/preview.jpg`)
    expect(previewUrl({ ...photo, previewPath: `${id}/original.jpg` })).toBe('')
    expect(mocks.getPublicUrl).toHaveBeenCalledTimes(1)
  })
})

describe('account-pinned shop operations', () => {
  it('does not send a purchase for a different logged-in account', async () => {
    mocks.getSession.mockResolvedValue(session(bob))
    await expect(purchasePhoto(id, 500, alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a response if the account changed during the request', async () => {
    mocks.getSession.mockResolvedValueOnce(session(alice)).mockResolvedValueOnce(session(bob))
    await expect(purchasePhoto(id, 500, alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).toHaveBeenCalledWith('purchase_shop_photo', { p_photo_id: id, p_expected_price: 500, p_expected_user_id: alice })
  })

  it('returns meaningful price/funds errors without exposing backend details', async () => {
    for (const [message, code] of [['SHOP_PRICE_CHANGED', 'price_changed'], ['SHOP_INSUFFICIENT_PROFIT', 'insufficient_profit'], ['SHOP_ADMIN_REQUIRED', 'admin_required']]) {
      mocks.rpc.mockImplementation(() => rpcResult(null, { message: `${message}: private database detail` }))
      await expect(purchasePhoto(id, 500, alice)).rejects.toMatchObject({ code })
      try { await purchasePhoto(id, 500, alice) } catch (error) { expect((error as Error).message).not.toContain('private database detail') }
    }
    mocks.rpc.mockImplementation(() => rpcResult(null, { code: 'PGRST202', message: 'schema cache missing function' }))
    await expect(purchasePhoto(id, 500, alice)).rejects.toBeInstanceOf(SetupRequiredError)
  })

  it('keeps original file paths out of metadata edits and pins the product revision', async () => {
    await updatePhoto(photo, { title: ' 新しいタイトル ', description: ' 説明 ', price: 700, published: false }, alice)
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_photo', expect.objectContaining({ p_photo_id: id, p_expected_revision: 1, p_original_path: null, p_preview_path: null, p_title: '新しいタイトル', p_description: '説明' }))
  })

  it('does not fetch a private file when the returned path is outside the purchased photo', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ originalPath: `${bob}/original.jpg`, fileName: 'photo.jpg' }))
    await expect(downloadPhoto(id, photo.title, alice)).rejects.toThrow()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('rejects disguised SVG content before uploading any bytes', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'photo.jpg', { type: 'image/jpeg' })
    await expect(uploadPhoto({ file, title: '写真', description: '', price: 100, published: true }, alice)).rejects.toMatchObject({ code: 'invalid_photo' })
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('keeps uploaded originals when a metadata-save response is lost', async () => {
    const file = prepareImageDecoding()
    mocks.rpc.mockImplementation((name: string) => name === 'get_photo_shop'
      ? rpcResult({ ...snapshot, role: 'admin' })
      : { abortSignal: vi.fn().mockRejectedValue(new DOMException('Response lost', 'TimeoutError')) })
    await expect(uploadPhoto({ file, title: '写真', description: '', price: 100, published: true }, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_photo', expect.anything())
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('cleans up an uploaded original when preview upload fails before metadata is sent', async () => {
    const file = prepareImageDecoding()
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    mocks.upload.mockResolvedValueOnce({ data: { path: 'uploaded' }, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'Storage unavailable' } })
    await expect(uploadPhoto({ file, title: '写真', description: '', price: 100, published: true }, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_photo', expect.anything())
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.remove).toHaveBeenCalledWith([expect.stringMatching(/\/original\.jpg$/)])
  })
})
