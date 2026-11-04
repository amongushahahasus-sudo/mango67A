import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn(), getPublicUrl: vi.fn(), download: vi.fn(), upload: vi.fn(), remove: vi.fn(), from: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: {
  auth: { getSession: mocks.getSession },
  rpc: mocks.rpc,
  storage: { from: (bucket: string) => mocks.from(bucket) },
} }))

import { downloadPhoto, loadPhotoShop, parseShopSnapshot, previewUrl, productImageUrl, purchasePhoto, reviewShopOrder, SetupRequiredError, updatePhoto, uploadPhoto } from './photoShop'
import type { ShopPhoto, ShopSnapshot } from './photoShop'

const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const orderId = '44444444-4444-4444-8444-444444444444'
const photo: ShopPhoto = { id, title: '夕方の空', description: '撮影した写真', price: 500, published: true, kind: 'photo', saleMode: 'direct', lottery: null, fileType: null, stockRemaining: null, deliveryStatus: 'not_purchased', orderId: null, orderSource: null, previewPath: `${id}/preview.jpg`, productImagePath: null, purchased: false, paidPrice: null, purchasedAt: null, revision: 1, createdAt: '2026-11-04T02:00:00Z' }
const snapshot: ShopSnapshot = { role: null, realizedProfit: 1200, spentProfit: 200, availableProfit: 1000, photos: [photo], orders: [], fileProductsReady: true, lotteriesReady: false, productImagesReady: false }
const codeFile: ShopPhoto = { ...photo, title: 'コードファイル', kind: 'file', fileType: 'txt', previewPath: null, stockRemaining: 1 }
const pendingFile: ShopPhoto = { ...codeFile, stockRemaining: 0, purchased: true, paidPrice: 500, purchasedAt: '2026-11-04T02:20:00Z', orderId, orderSource: 'purchase', deliveryStatus: 'pending' }
const session = (uid: string | null) => ({ data: { session: uid ? { user: { id: uid } } : null }, error: null })
const rpcResult = (data: unknown = snapshot, error: unknown = null) => ({ abortSignal: vi.fn().mockResolvedValue({ data, error }) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSession.mockResolvedValue(session(alice))
  mocks.rpc.mockImplementation(() => rpcResult())
  mocks.upload.mockResolvedValue({ data: { path: 'uploaded' }, error: null })
  mocks.remove.mockResolvedValue({ data: [], error: null })
  mocks.from.mockImplementation((bucket: string) => ({ getPublicUrl: (path: string) => mocks.getPublicUrl(path, bucket), download: mocks.download, upload: mocks.upload, remove: mocks.remove }))
  mocks.getPublicUrl.mockImplementation((path: string, bucket: string) => ({ data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/${bucket}/${path}` } }))
})

afterEach(() => { vi.unstubAllGlobals() })

function prepareImageDecoding() {
  vi.stubGlobal('HTMLImageElement', class {})
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 10, height: 10, close: vi.fn() }))
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn() }
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['preview'], { type: 'image/jpeg' })) }
  vi.stubGlobal('document', { createElement: () => canvas })
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' })
}

describe('shop response boundaries', () => {
  it('preserves price snapshots and ownership independently of current prices', () => {
    const owned = { ...photo, price: 900, purchased: true, paidPrice: 500, purchasedAt: '2026-11-04T02:20:00Z', deliveryStatus: 'approved' as const, published: false }
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
    expect(mocks.rpc).toHaveBeenCalledWith('get_reward_shop', { p_expected_user_id: alice })
    expect(mocks.rpc).not.toHaveBeenCalledWith('purchase_shop_product', expect.anything())
  })

  it('returns meaningful price/funds errors without exposing backend details', async () => {
    for (const [message, code] of [['SHOP_PRICE_CHANGED', 'price_changed'], ['SHOP_INSUFFICIENT_PROFIT', 'insufficient_profit'], ['SHOP_ADMIN_REQUIRED', 'admin_required']]) {
      mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult() : rpcResult(null, { message: `${message}: private database detail` }))
      await expect(purchasePhoto(id, 500, alice)).rejects.toMatchObject({ code })
      try { await purchasePhoto(id, 500, alice) } catch (error) { expect((error as Error).message).not.toContain('private database detail') }
    }
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult() : rpcResult(null, { code: 'PGRST202', message: 'schema cache missing function' }))
    await expect(purchasePhoto(id, 500, alice)).rejects.toBeInstanceOf(SetupRequiredError)
  })

  it('keeps original file paths out of metadata edits and pins the product revision', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    await updatePhoto(photo, { title: ' 新しいタイトル ', description: ' 説明 ', price: 700, published: false }, alice)
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_product', expect.objectContaining({ p_product_id: id, p_expected_revision: 1, p_original_path: null, p_preview_path: null, p_title: '新しいタイトル', p_description: '説明' }))
  })

  it('does not fetch a private file when the returned path is outside the purchased photo', async () => {
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult({ ...snapshot, role: 'admin' }) : rpcResult({ bucket: 'photo-originals', originalPath: `${bob}/original.jpg`, fileName: 'photo.jpg' }))
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
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop'
      ? rpcResult({ ...snapshot, role: 'admin' })
      : { abortSignal: vi.fn().mockRejectedValue(new DOMException('Response lost', 'TimeoutError')) })
    await expect(uploadPhoto({ file, title: '写真', description: '', price: 100, published: true }, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_product', expect.anything())
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('cleans up an uploaded original when preview upload fails before metadata is sent', async () => {
    const file = prepareImageDecoding()
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    mocks.upload.mockResolvedValueOnce({ data: { path: 'uploaded' }, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'Storage unavailable' } })
    await expect(uploadPhoto({ file, title: '写真', description: '', price: 100, published: true }, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product', expect.anything())
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(mocks.remove).toHaveBeenCalledWith([expect.stringMatching(/\/original\.jpg$/)])
  })
})

describe('file products and compatibility', () => {
  it('keeps old photo shops usable when the new read RPC is not installed', async () => {
    const { kind: _kind, fileType: _fileType, stockRemaining: _stock, deliveryStatus: _delivery, orderId: _order, ...legacyPhoto } = photo
    const legacy = { ...snapshot, photos: [legacyPhoto] }
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult(null, { code: 'PGRST202' }) : rpcResult(legacy))
    const loaded = await loadPhotoShop(alice)
    expect(loaded.fileProductsReady).toBe(false)
    expect(loaded.photos[0]).toMatchObject({ kind: 'photo', deliveryStatus: 'not_purchased', fileType: null })
    await purchasePhoto(id, 500, alice)
    expect(mocks.rpc).toHaveBeenCalledWith('purchase_shop_photo', expect.objectContaining({ p_photo_id: id }))
    expect(mocks.rpc).not.toHaveBeenCalledWith('purchase_shop_product', expect.anything())
  })

  it('does not fall back after a failed current write or a broken current read', async () => {
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult() : { abortSignal: vi.fn().mockRejectedValue(new DOMException('Lost response', 'TimeoutError')) })
    await expect(purchasePhoto(id, 500, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.rpc).not.toHaveBeenCalledWith('purchase_shop_photo', expect.anything())
    mocks.rpc.mockClear()
    mocks.rpc.mockImplementation(() => rpcResult(null, { code: 'XX000', message: 'Database failure' }))
    await expect(loadPhotoShop(alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_photo_shop', expect.anything())
  })

  it('validates pending/rejected receipts and keeps secret file paths out of previews', () => {
    expect(parseShopSnapshot({ ...snapshot, photos: [pendingFile] }).photos[0].deliveryStatus).toBe('pending')
    const rejected = { ...pendingFile, deliveryStatus: 'rejected', purchased: false, stockRemaining: 1 }
    expect(parseShopSnapshot({ ...snapshot, photos: [rejected] }).photos[0].paidPrice).toBe(500)
    expect(previewUrl(pendingFile)).toBe('')
    expect(mocks.getPublicUrl).not.toHaveBeenCalled()
    for (const changes of [{ previewPath: `${id}/original.txt` }, { fileType: 'html' }, { purchased: false }, { stockRemaining: 1 }, { orderId: null }]) {
      expect(() => parseShopSnapshot({ ...snapshot, photos: [{ ...pendingFile, ...changes }] })).toThrow()
    }
  })

  it('accepts a zero-price lottery award but never a zero-price direct purchase receipt', () => {
    const prize = { ...pendingFile, saleMode: 'lottery', orderSource: 'lottery', paidPrice: 0 }
    expect(parseShopSnapshot({ ...snapshot, photos: [prize] }).photos[0].paidPrice).toBe(0)
    expect(() => parseShopSnapshot({ ...snapshot, photos: [{ ...prize, orderSource: 'purchase' }] })).toThrow()
    const order = { id: orderId, productId: id, productTitle: '賞品', buyerLabel: 'buyer@example.test', paidPrice: 0, status: 'pending', source: 'lottery', purchasedAt: '2026-11-04T02:20:00Z', reviewedAt: null }
    expect(parseShopSnapshot({ ...snapshot, role: 'admin', orders: [order] }).orders[0].source).toBe('lottery')
    expect(() => parseShopSnapshot({ ...snapshot, role: 'admin', orders: [{ ...order, source: 'purchase' }] })).toThrow()
  })

  it('never fetches a private file while administrator approval is pending', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, photos: [pendingFile] }))
    await expect(downloadPhoto(id, codeFile.title, alice)).rejects.toMatchObject({ code: 'order_pending' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_shop_product_download', expect.anything())
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('rejects a download response that names the wrong private bucket', async () => {
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop'
      ? rpcResult({ ...snapshot, photos: [{ ...pendingFile, deliveryStatus: 'approved' }] })
      : rpcResult({ bucket: 'photo-originals', originalPath: `${id}/original.txt`, fileName: 'code.txt' }))
    await expect(downloadPhoto(id, codeFile.title, alice)).rejects.toThrow()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('delivers an approved code file as an attachment and rechecks identity before exposing it', async () => {
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop'
      ? rpcResult({ ...snapshot, photos: [{ ...pendingFile, deliveryStatus: 'approved' }] })
      : rpcResult({ bucket: 'shop-files', originalPath: `${id}/original.txt`, fileName: 'reward.txt' }))
    mocks.download.mockResolvedValue({ data: new Blob(['TEST-REWARD-CODE']), error: null })
    const anchor = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() }
    const createElement = vi.fn().mockReturnValue(anchor)
    vi.stubGlobal('document', { createElement, body: { append: vi.fn() } })
    vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:reward'), revokeObjectURL: vi.fn() })
    for (let i = 0; i < 4; i++) mocks.getSession.mockResolvedValueOnce(session(alice))
    mocks.getSession.mockResolvedValueOnce(session(bob))
    await expect(downloadPhoto(id, codeFile.title, alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(createElement).not.toHaveBeenCalled()
    await downloadPhoto(id, codeFile.title, alice)
    expect(mocks.download).toHaveBeenCalledWith(`${id}/original.txt`, {}, expect.objectContaining({ cache: 'no-store' }))
    expect(anchor).toMatchObject({ href: 'blob:reward', download: 'reward.txt', rel: 'noopener' })
    expect(anchor.click).toHaveBeenCalledOnce()
  })

  it('uploads a code file only into the private bucket and never creates a public preview', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin', photos: [codeFile] }))
    const file = new File(['TEST-REWARD-CODE\n説明'], 'reward.txt', { type: 'application/octet-stream' })
    await uploadPhoto({ kind: 'file', file, title: 'コード商品', description: '', price: 500, published: true }, alice)
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    const [path, body, options] = mocks.upload.mock.calls[0]
    expect(path).toMatch(/^[0-9a-f-]+\/original\.txt$/)
    expect(await (body as Blob).text()).toBe(await file.text())
    expect(options.contentType).toBe('text/plain')
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_product', expect.objectContaining({ p_kind: 'file', p_file_ext: 'txt', p_preview_path: null }))
    expect(mocks.getPublicUrl).not.toHaveBeenCalled()
  })

  it('rejects executable names, disguised HTML and binary text before upload', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    const files = [new File(['CODE'], 'code.exe'), new File(['<script>alert(1)</script>'], 'code.txt'), new File([new Uint8Array([0, 0xff])], 'code.txt'), new File(['plain'], 'code.pdf')]
    for (const file of files) await expect(uploadPhoto({ kind: 'file', file, title: '商品', description: '', price: 100, published: true }, alice)).rejects.toMatchObject({ code: 'invalid_photo' })
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('derives PDF and ZIP formats from bytes instead of an editable MIME label', async () => {
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    for (const [file, extension, contentType] of [
      [new File(['%PDF-1.7\n'], 'reward.pdf', { type: 'text/html' }), 'pdf', 'application/pdf'],
      [new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], 'reward.zip', { type: 'text/html' }), 'zip', 'application/zip'],
    ] as const) {
      mocks.upload.mockClear()
      await uploadPhoto({ kind: 'file', file, title: '商品', description: '', price: 100, published: true }, alice)
      expect(mocks.upload).toHaveBeenCalledOnce()
      expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/original\\.${extension}$`)), expect.any(Blob), expect.objectContaining({ contentType }))
    }
  })

  it('does not upload a file product when only the legacy shop is available', async () => {
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult(null, { code: 'PGRST202' }) : rpcResult({ ...snapshot, role: 'admin' }))
    await expect(uploadPhoto({ kind: 'file', file: new File(['CODE'], 'code.txt'), title: '商品', description: '', price: 100, published: true }, alice)).rejects.toBeInstanceOf(SetupRequiredError)
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('pins administrator order reviews and rejects ordinary-user review attempts', async () => {
    await expect(reviewShopOrder(orderId, 'approve', alice)).rejects.toMatchObject({ code: 'admin_required' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('review_shop_order', expect.anything())
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    await reviewShopOrder(orderId, 'reject', alice)
    expect(mocks.rpc).toHaveBeenCalledWith('review_shop_order', { p_order_id: orderId, p_decision: 'reject', p_expected_user_id: alice })
  })

  it('rejects administrator-only buyer metadata in an ordinary-user snapshot', () => {
    const order = { id: orderId, productId: id, productTitle: '商品', buyerLabel: 'buyer@example.test', paidPrice: 500, status: 'pending', purchasedAt: '2026-11-04T02:20:00Z', reviewedAt: null }
    expect(() => parseShopSnapshot({ ...snapshot, orders: [order] })).toThrow()
    expect(parseShopSnapshot({ ...snapshot, role: 'admin', orders: [order] }).orders).toHaveLength(1)
  })
})

describe('public product photos with private code files', () => {
  const imageId = '55555555-5555-4555-8555-555555555555'
  const imagePath = `${id}/${imageId}.jpg`
  const picturedFile: ShopPhoto = { ...codeFile, productImagePath: imagePath }
  const fields = { title: 'コード商品', description: '商品の説明', price: 500, published: true }
  const code = () => new File(['EXAMPLE-NOT-REDEEMABLE\n'], 'reward.txt', { type: 'text/plain' })
  const mockImageShop = (product = codeFile) => {
    const data: ShopSnapshot = { ...snapshot, role: 'admin', productImagesReady: true, photos: [product] }
    mocks.rpc.mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name !== 'save_shop_product_with_image') return rpcResult(data)
      return rpcResult({ ...data, photos: [{ ...product, id: params!.p_product_id, productImagePath: params!.p_product_image_path }] })
    })
  }

  it('normalizes older catalogs without enabling product-image writes', () => {
    const { productImagePath: _path, ...oldFile } = codeFile
    const { productImagesReady: _ready, ...oldShop } = snapshot
    const parsed = parseShopSnapshot({ ...oldShop, photos: [oldFile] })
    expect(parsed.productImagesReady).toBe(false)
    expect(parsed.photos[0].productImagePath).toBeNull()
    expect(parseShopSnapshot({ ...snapshot, productImagesReady: true, photos: [picturedFile] }).photos[0]).toEqual(picturedFile)
    expect(() => parseShopSnapshot({ ...snapshot, productImagesReady: 'true' })).toThrow()
  })

  it('accepts only same-product public JPG paths, including for lottery products', () => {
    const lottery = { ...picturedFile, saleMode: 'lottery', lottery: { entryCost: 500, winRateBps: 1000, enabled: true, revision: 1 } }
    expect(parseShopSnapshot({ ...snapshot, photos: [lottery] }).photos[0].productImagePath).toBe(imagePath)
    for (const path of [`${bob}/${imageId}.jpg`, `${id}/original.txt`, `${id}/../${imageId}.jpg`, `https://elsewhere.example/${imageId}.jpg`, `${imagePath}\n`, `${imagePath}\r`, `${imagePath}\u0000`, `${id}/${imageId}.png`]) {
      expect(() => parseShopSnapshot({ ...snapshot, photos: [{ ...codeFile, productImagePath: path }] })).toThrow()
      expect(productImageUrl({ ...codeFile, productImagePath: path })).toBe('')
    }
    expect(() => parseShopSnapshot({ ...snapshot, photos: [{ ...photo, productImagePath: imagePath }] })).toThrow()
    expect(productImageUrl(picturedFile)).toContain(`/shop-product-images/${imagePath}`)
    expect(productImageUrl(codeFile)).toBe('')
    expect(productImageUrl(photo)).toBe('')
    expect(previewUrl(picturedFile)).toBe('')
    expect(mocks.getPublicUrl).toHaveBeenCalledOnce()
  })

  it('uploads code privately and a separately generated display photo publicly in one metadata save', async () => {
    mockImageShop()
    const image = prepareImageDecoding(), file = code()
    const result = await uploadPhoto({ ...fields, kind: 'file', file, productImage: image }, alice)
    expect(mocks.from.mock.calls.map(([bucket]) => bucket)).toEqual(['shop-files', 'shop-product-images'])
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    const [privatePath, privateBody, privateOptions] = mocks.upload.mock.calls[0]
    const [publicPath, publicBody, publicOptions] = mocks.upload.mock.calls[1]
    expect(privatePath).toMatch(/\/original\.txt$/)
    expect(await (privateBody as Blob).text()).toBe(await file.text())
    expect(privateOptions.contentType).toBe('text/plain')
    expect(await (publicBody as Blob).text()).toBe('preview')
    expect(publicOptions).toMatchObject({ contentType: 'image/jpeg', upsert: false })
    expect(publicPath).toHaveLength(77)
    expect(publicPath.split('/')[0]).toBe(privatePath.split('/')[0])
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_product_with_image', expect.objectContaining({ p_kind: 'file', p_preview_path: null, p_original_path: privatePath, p_file_ext: 'txt', p_product_image_path: publicPath, p_expected_revision: null }))
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product', expect.anything())
    expect(result.photos[0].productImagePath).toBe(publicPath)
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('rejects unavailable or disguised display photos before uploading either file', async () => {
    const image = prepareImageDecoding()
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin' }))
    await expect(uploadPhoto({ ...fields, kind: 'file', file: code(), productImage: image }, alice)).rejects.toBeInstanceOf(SetupRequiredError)
    mockImageShop()
    const disguised = new File(['<svg>not a photo</svg>'], 'cover.jpg', { type: 'image/jpeg' })
    await expect(uploadPhoto({ ...fields, kind: 'file', file: code(), productImage: disguised }, alice)).rejects.toMatchObject({ code: 'invalid_photo' })
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('cleans up the private original if the public photo upload fails before metadata is sent', async () => {
    mockImageShop()
    const image = prepareImageDecoding()
    mocks.upload.mockResolvedValueOnce({ data: { path: 'uploaded' }, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'Upload unavailable' } })
    await expect(uploadPhoto({ ...fields, kind: 'file', file: code(), productImage: image }, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product_with_image', expect.anything())
    expect(mocks.remove).toHaveBeenCalledWith([expect.stringMatching(/\/original\.txt$/)])
    expect(mocks.from).toHaveBeenLastCalledWith('shop-files')
  })

  it('keeps both uploads and never retries a different write after an uncertain metadata result', async () => {
    const image = prepareImageDecoding()
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult({ ...snapshot, role: 'admin', productImagesReady: true })
      : { abortSignal: vi.fn().mockRejectedValue(new DOMException('Lost response', 'TimeoutError')) })
    await expect(uploadPhoto({ ...fields, kind: 'file', file: code(), productImage: image }, alice)).rejects.toMatchObject({ code: 'connection' })
    expect(mocks.upload).toHaveBeenCalledTimes(2)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product', expect.anything())
  })

  it('replaces an existing product photo without uploading or changing its private code file', async () => {
    mockImageShop(picturedFile)
    const image = prepareImageDecoding()
    const result = await updatePhoto(picturedFile, { ...fields, productImage: image }, alice)
    expect(mocks.from).toHaveBeenCalledOnce()
    expect(mocks.from).toHaveBeenCalledWith('shop-product-images')
    expect(mocks.upload).toHaveBeenCalledOnce()
    const path = mocks.upload.mock.calls[0][0]
    expect(path).not.toBe(imagePath)
    expect(path).toHaveLength(77)
    expect(mocks.rpc).toHaveBeenCalledWith('save_shop_product_with_image', expect.objectContaining({ p_product_id: id, p_product_image_path: path, p_expected_revision: 1, p_original_path: null, p_preview_path: null, p_file_ext: null }))
    expect(result.photos[0].productImagePath).toBe(path)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('preserves the photo on normal edits and removes it only on an explicit request', async () => {
    mockImageShop(picturedFile)
    await updatePhoto(picturedFile, fields, alice)
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_shop_product_with_image', expect.objectContaining({ p_product_image_path: imagePath }))
    const result = await updatePhoto(picturedFile, { ...fields, removeProductImage: true }, alice)
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_shop_product_with_image', expect.objectContaining({ p_product_image_path: null }))
    expect(result.photos[0].productImagePath).toBeNull()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('blocks image changes on old schema and conflicting add/remove requests', async () => {
    const image = prepareImageDecoding()
    mocks.rpc.mockImplementation(() => rpcResult({ ...snapshot, role: 'admin', photos: [codeFile] }))
    await expect(updatePhoto(codeFile, { ...fields, productImage: image }, alice)).rejects.toBeInstanceOf(SetupRequiredError)
    await expect(updatePhoto(codeFile, { ...fields, removeProductImage: true }, alice)).rejects.toBeInstanceOf(SetupRequiredError)
    mockImageShop()
    await expect(updatePhoto(codeFile, { ...fields, productImage: image, removeProductImage: true }, alice)).rejects.toMatchObject({ code: 'invalid_photo' })
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product_with_image', expect.anything())
  })

  it('pins image edits to the active account and keeps uploaded images after CAS or lost responses', async () => {
    mockImageShop(picturedFile)
    const image = prepareImageDecoding()
    mocks.getSession.mockResolvedValueOnce(session(alice)).mockResolvedValueOnce(session(alice)).mockResolvedValueOnce(session(alice)).mockResolvedValueOnce(session(bob))
    await expect(updatePhoto(picturedFile, { ...fields, productImage: image }, alice)).rejects.toMatchObject({ code: 'session_changed' })
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product_with_image', expect.anything())
    mocks.rpc.mockImplementation((name: string) => name === 'get_reward_shop' ? rpcResult({ ...snapshot, role: 'admin', productImagesReady: true, photos: [picturedFile] })
      : rpcResult(null, { message: 'SHOP_PHOTO_CONFLICT: private detail' }))
    await expect(updatePhoto(picturedFile, { ...fields, productImage: image }, alice)).rejects.toMatchObject({ code: 'conflict' })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_shop_product', expect.anything())
  })
})
