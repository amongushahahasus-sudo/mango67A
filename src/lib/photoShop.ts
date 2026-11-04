import { supabase } from './supabase'

export type ShopRole = 'developer' | 'admin' | null
export type ShopProductKind = 'photo' | 'file'
export type ShopFileType = 'txt' | 'pdf' | 'zip'
export type ShopOrderSource = 'purchase' | 'lottery'
export type ShopDeliveryStatus = 'not_purchased' | 'pending' | 'approved' | 'rejected'
export interface ShopLotteryConfig { entryCost: number; winRateBps: number; enabled: boolean; revision: number }
export interface ShopPhoto {
  id: string
  title: string
  description: string
  price: number
  published: boolean
  kind: ShopProductKind
  saleMode: 'direct' | 'lottery'
  lottery: ShopLotteryConfig | null
  fileType: ShopFileType | null
  previewPath: string | null
  productImagePath: string | null
  stockRemaining: 0 | 1 | null
  deliveryStatus: ShopDeliveryStatus
  orderId: string | null
  orderSource: ShopOrderSource | null
  purchased: boolean
  paidPrice: number | null
  purchasedAt: string | null
  revision: number
  createdAt: string
}
export type ShopProduct = ShopPhoto
export interface ShopOrder {
  id: string
  productId: string
  productTitle: string
  buyerLabel: string
  paidPrice: number
  status: 'pending' | 'approved' | 'rejected'
  source: ShopOrderSource
  purchasedAt: string
  reviewedAt: string | null
}
export interface ShopSnapshot {
  role: ShopRole
  realizedProfit: number
  spentProfit: number
  availableProfit: number
  photos: ShopPhoto[]
  orders: ShopOrder[]
  fileProductsReady: boolean
  lotteriesReady: boolean
  productImagesReady: boolean
}
export interface ShopPhotoFields { title: string; description: string; price: number; published: boolean }
export interface UploadPhotoInput extends ShopPhotoFields { file: File; kind?: ShopProductKind; productImage?: File | null }
export interface UpdatePhotoInput extends ShopPhotoFields { productImage?: File | null; removeProductImage?: boolean }
export const PHOTO_FILE_MAX_BYTES = 15 * 1024 * 1024
export const PHOTO_MAX_PRICE = 100_000_000

export type PhotoShopErrorCode = 'setup' | 'session_changed' | 'admin_required' | 'account_required' | 'not_found' | 'unavailable' | 'price_changed' | 'insufficient_profit' | 'invalid_photo' | 'conflict' | 'purchase_required' | 'connection' | 'out_of_stock' | 'order_pending' | 'order_conflict' | 'lottery_required' | 'lottery_changed' | 'lottery_disabled' | 'lottery_conflict' | 'lottery_request_conflict' | 'invalid_lottery'
export class PhotoShopError extends Error {
  constructor(public readonly code: PhotoShopErrorCode, message: string) { super(message); this.name = 'PhotoShopError' }
}
export class SetupRequiredError extends PhotoShopError {
  constructor(message = 'ショップは準備中です。しばらくしてから、もう一度お試しください。') { super('setup', message); this.name = 'SetupRequiredError' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validMoney = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validPrice = (value: unknown): value is number => validMoney(value) && value >= 1 && value <= PHOTO_MAX_PRICE
const validDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 60 && Number.isFinite(Date.parse(value))
const validFileType = (value: unknown): value is ShopFileType => value === 'txt' || value === 'pdf' || value === 'zip'
const connectionError = () => new PhotoShopError('connection', 'ショップに接続できませんでした。通信を確認して、もう一度お試しください。')
const identityError = () => new PhotoShopError('session_changed', 'ログイン中のアカウントが変わりました。ショップを開き直してください。')
const invalidResponse = () => new PhotoShopError('connection', 'ショップの情報を読み込めませんでした。もう一度お試しください。')
const fileSetupError = () => new SetupRequiredError('ファイル商品の販売準備がまだ完了していません。管理者向けの設定を完了してからお試しください。')
const productImageSetupError = () => new SetupRequiredError('商品写真の設定がまだ完了していません。設定を完了してから、もう一度お試しください。')
const adminError = () => new PhotoShopError('admin_required', '商品を管理できるのは、管理者に指定されたアカウントだけです。')
const validProductImagePath = (path: unknown, productId: string): path is string => typeof path === 'string' && path.length === 77 && productId.length === 36 && UUID.test(productId)
  && new RegExp(`^${productId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`).test(path)

function client() {
  if (!supabase) throw new SetupRequiredError()
  return supabase
}

async function assertIdentity(expectedUserId: string | null) {
  if (expectedUserId !== null && !UUID.test(expectedUserId)) throw identityError()
  let sessionResult
  try { sessionResult = await client().auth.getSession() } catch { throw identityError() }
  const { data, error } = sessionResult
  if (error || (data.session?.user.id ?? null) !== expectedUserId) throw identityError()
}

function fail(error: { code?: string; message?: string; statusCode?: string | number; status?: number }): never {
  const message = error.message || ''
  if (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01' || /Bucket not found/i.test(message)) throw new SetupRequiredError()
  if (message.includes('ACCOUNT_USER_CHANGED') || error.code === 'PGRST301' || error.status === 401 || String(error.statusCode) === '401') throw identityError()
  const mappings: [string, PhotoShopErrorCode, string][] = [
    ['SHOP_ADMIN_REQUIRED', 'admin_required', '商品を管理できるのは、管理者に指定されたアカウントだけです。'],
    ['SHOP_ACCOUNT_REQUIRED', 'account_required', 'ログインして、練習口座の保存を完了してからお試しください。'],
    ['SHOP_PHOTO_NOT_FOUND', 'not_found', 'この商品は見つかりませんでした。一覧を読み込み直してください。'],
    ['SHOP_PRODUCT_NOT_FOUND', 'not_found', 'この商品は見つかりませんでした。一覧を読み込み直してください。'],
    ['SHOP_PHOTO_UNAVAILABLE', 'unavailable', 'この商品は現在公開されていません。'],
    ['SHOP_PRODUCT_UNAVAILABLE', 'unavailable', 'この商品は現在公開されていません。'],
    ['SHOP_PRICE_CHANGED', 'price_changed', '商品の価格が変更されました。一覧を更新し、新しい価格を確認してください。'],
    ['SHOP_INSUFFICIENT_PROFIT', 'insufficient_profit', '購入に使える確定利益が足りません。決済済みの利益を確認してください。'],
    ['SHOP_PHOTO_CONFLICT', 'conflict', '別の画面で商品が更新されました。一覧を読み込み直してから編集してください。'],
    ['SHOP_PRODUCT_CONFLICT', 'conflict', '別の画面で商品が更新されました。一覧を読み込み直してから編集してください。'],
    ['SHOP_FILES_IMMUTABLE', 'invalid_photo', '投稿済みの商品ファイルは変更できません。新しい商品として登録してください。'],
    ['SHOP_FILES_MISSING', 'invalid_photo', 'アップロードしたファイルを確認できませんでした。選び直してお試しください。'],
    ['SHOP_INVALID_PHOTO', 'invalid_photo', 'タイトル・価格・商品ファイルを確認してください。'],
    ['SHOP_INVALID_PRODUCT_IMAGE', 'invalid_photo', '商品写真を選び直してください。JPEG・PNG・WebPに対応しています。'],
    ['SHOP_INVALID_PRODUCT', 'invalid_photo', 'タイトル・価格・商品ファイルを確認してください。'],
    ['SHOP_PURCHASE_REQUIRED', 'purchase_required', 'このファイルをダウンロードするには、購入が必要です。'],
    ['SHOP_LOTTERY_REQUIRED', 'lottery_required', 'この商品はくじの対象です。くじの画面からお試しください。'],
    ['SHOP_OUT_OF_STOCK', 'out_of_stock', 'この商品は在庫がありません。すでにほかの購入申請が入っている可能性があります。'],
    ['SHOP_ORDER_PENDING', 'order_pending', '管理者による確認待ちです。承認後にファイルをダウンロードできます。'],
    ['SHOP_ORDER_CONFLICT', 'order_conflict', 'この購入申請はすでに処理されています。一覧を更新してください。'],
    ['SHOP_INVALID_DECISION', 'order_conflict', '購入申請の処理内容を確認してください。'],
    ['SHOP_LOTTERY_CHANGED', 'lottery_changed', 'くじの料金や当選確率が変更されました。最新の内容を確認してからお試しください。'],
    ['SHOP_LOTTERY_NOT_FOUND', 'lottery_disabled', 'このくじは現在利用できません。一覧を更新してください。'],
    ['SHOP_LOTTERY_UNAVAILABLE', 'lottery_disabled', 'このくじは現在利用できません。一覧を更新してください。'],
    ['SHOP_LOTTERY_CONFLICT', 'lottery_conflict', '別の画面でくじが更新されました。一覧を読み込み直してから編集してください。'],
    ['SHOP_LOTTERY_REQUEST_CONFLICT', 'lottery_request_conflict', 'くじの申込情報が一致しません。ショップを開き直してください。'],
    ['SHOP_INVALID_LOTTERY', 'invalid_lottery', 'くじの料金と当選確率を確認してください。'],
  ]
  for (const [marker, code, text] of mappings) if (message.includes(marker)) throw new PhotoShopError(code, text)
  if (error.code === '42501' || String(error.statusCode) === '403' || error.status === 403) throw new PhotoShopError('admin_required', 'この操作を利用する権限がありません。アカウントを確認してください。')
  throw connectionError()
}

function parsePhoto(value: unknown, legacy: boolean): ShopPhoto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const p = value as Record<string, unknown>
  if (typeof p.id !== 'string' || !UUID.test(p.id) || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 120
    || typeof p.description !== 'string' || p.description.length > 2000 || !validPrice(p.price)
    || typeof p.published !== 'boolean' || typeof p.purchased !== 'boolean'
    || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1 || !validDate(p.createdAt)) throw invalidResponse()
  const kind = legacy ? 'photo' : p.kind
  const productImagePath = legacy ? null : p.productImagePath ?? null
  if (productImagePath !== null && (kind !== 'file' || !validProductImagePath(productImagePath, p.id))) throw invalidResponse()
  const saleMode = legacy ? 'direct' : p.saleMode ?? 'direct'
  if (saleMode !== 'direct' && saleMode !== 'lottery') throw invalidResponse()
  let lottery: ShopLotteryConfig | null = null
  if (!legacy && p.lottery !== undefined && p.lottery !== null) {
    if (typeof p.lottery !== 'object' || Array.isArray(p.lottery)) throw invalidResponse()
    const config = p.lottery as Record<string, unknown>
    if (kind !== 'file' || saleMode !== 'lottery' || !validPrice(config.entryCost)
      || !Number.isInteger(config.winRateBps) || Number(config.winRateBps) < 1 || Number(config.winRateBps) > 10000
      || typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.revision) || Number(config.revision) < 1) throw invalidResponse()
    lottery = { entryCost: config.entryCost, winRateBps: config.winRateBps as number, enabled: config.enabled, revision: config.revision as number }
  }
  const deliveryStatus = legacy ? p.purchased ? 'approved' : 'not_purchased' : p.deliveryStatus
  const fileType = legacy ? null : p.fileType
  const stockRemaining = legacy ? null : p.stockRemaining
  const orderId = legacy ? null : p.orderId
  const orderSource = legacy || kind === 'photo' || deliveryStatus === 'not_purchased' ? null : p.orderSource ?? 'purchase'
  if (orderSource !== null && orderSource !== 'purchase' && orderSource !== 'lottery') throw invalidResponse()
  if (legacy && p.kind !== undefined && p.kind !== 'photo') throw invalidResponse()
  if (kind === 'photo') {
    if (fileType !== null || stockRemaining !== null || orderId !== null || p.previewPath !== `${p.id}/preview.jpg`
      || deliveryStatus !== (p.purchased ? 'approved' : 'not_purchased')) throw invalidResponse()
  } else if (kind === 'file') {
    if (!validFileType(fileType) || p.previewPath !== null || (stockRemaining !== 0 && stockRemaining !== 1)
      || !['not_purchased', 'pending', 'approved', 'rejected'].includes(deliveryStatus as string)) throw invalidResponse()
    const active = deliveryStatus === 'pending' || deliveryStatus === 'approved'
    if (p.purchased !== active || (active && stockRemaining !== 0)
      || (deliveryStatus === 'not_purchased' ? orderId !== null : typeof orderId !== 'string' || !UUID.test(orderId))) throw invalidResponse()
  } else throw invalidResponse()
  const hasReceipt = deliveryStatus !== 'not_purchased'
  const receiptPriceValid = kind === 'file' && orderSource === 'lottery' ? validMoney(p.paidPrice) && p.paidPrice <= PHOTO_MAX_PRICE : validPrice(p.paidPrice)
  if (hasReceipt ? !receiptPriceValid || !validDate(p.purchasedAt) : p.paidPrice !== null || p.purchasedAt !== null) throw invalidResponse()
  return { id: p.id, title: p.title, description: p.description, price: p.price, published: p.published, kind, saleMode, lottery,
    fileType: fileType as ShopFileType | null, previewPath: p.previewPath as string | null, productImagePath,
    stockRemaining: stockRemaining as 0 | 1 | null, deliveryStatus: deliveryStatus as ShopDeliveryStatus,
    orderId: orderId as string | null, orderSource, purchased: p.purchased, paidPrice: p.paidPrice as number | null,
    purchasedAt: p.purchasedAt as string | null, revision: p.revision as number, createdAt: p.createdAt }
}

function parseOrder(value: unknown): ShopOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const o = value as Record<string, unknown>
  const source = o.source ?? 'purchase'
  const priceValid = source === 'lottery' ? validMoney(o.paidPrice) && o.paidPrice <= PHOTO_MAX_PRICE : validPrice(o.paidPrice)
  if (typeof o.id !== 'string' || !UUID.test(o.id) || typeof o.productId !== 'string' || !UUID.test(o.productId)
    || typeof o.productTitle !== 'string' || !o.productTitle.trim() || o.productTitle.length > 120
    || typeof o.buyerLabel !== 'string' || !o.buyerLabel.trim() || o.buyerLabel.length > 400
    || (source !== 'purchase' && source !== 'lottery') || !priceValid || !['pending', 'approved', 'rejected'].includes(o.status as string)
    || !validDate(o.purchasedAt) || (o.status === 'pending' ? o.reviewedAt !== null : !validDate(o.reviewedAt))) throw invalidResponse()
  return { id: o.id, productId: o.productId, productTitle: o.productTitle, buyerLabel: o.buyerLabel, paidPrice: o.paidPrice as number,
    status: o.status as ShopOrder['status'], source, purchasedAt: o.purchasedAt, reviewedAt: o.reviewedAt as string | null }
}

/** Only legacy read responses may omit file/order fields. */
export function parseShopSnapshot(value: unknown, legacy = false): ShopSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const s = value as Record<string, unknown>
  if (![null, 'developer', 'admin'].includes(s.role as ShopRole) || !validMoney(s.realizedProfit) || !validMoney(s.spentProfit) || !validMoney(s.availableProfit)
    || s.availableProfit !== Math.max(0, s.realizedProfit - s.spentProfit) || !Array.isArray(s.photos) || s.photos.length > 5000) throw invalidResponse()
  const photos = s.photos.map(photo => parsePhoto(photo, legacy))
  if (new Set(photos.map(photo => photo.id)).size !== photos.length) throw invalidResponse()
  if (!legacy && (!Array.isArray(s.orders) || s.orders.length > 10000)) throw invalidResponse()
  const orders = legacy ? [] : (s.orders as unknown[]).map(parseOrder)
  if (!legacy && s.lotteriesReady !== undefined && typeof s.lotteriesReady !== 'boolean') throw invalidResponse()
  if (!legacy && s.productImagesReady !== undefined && typeof s.productImagesReady !== 'boolean') throw invalidResponse()
  if (new Set(orders.map(order => order.id)).size !== orders.length || (s.role === null && orders.length)) throw invalidResponse()
  return { role: s.role as ShopRole, realizedProfit: s.realizedProfit, spentProfit: s.spentProfit,
    availableProfit: s.availableProfit, photos, orders, fileProductsReady: !legacy, lotteriesReady: !legacy && s.lotteriesReady === true,
    productImagesReady: !legacy && s.productImagesReady === true }
}

async function rpc(name: string, params: Record<string, unknown>, expectedUserId: string | null) {
  await assertIdentity(expectedUserId)
  let result
  try { result = await client().rpc(name, params).abortSignal(AbortSignal.timeout(20_000)) }
  catch { throw connectionError() }
  await assertIdentity(expectedUserId)
  return result
}

/** Shared account-pinned RPC boundary. Callers never receive raw backend errors. */
export async function requestShopRpc(name: string, params: Record<string, unknown>, expectedUserId: string): Promise<unknown> {
  const result = await rpc(name, params, expectedUserId)
  if (result.error) fail(result.error)
  return result.data
}

function checkedSnapshot(data: unknown, expectedUserId: string | null, legacy: boolean): ShopSnapshot {
  const snapshot = parseShopSnapshot(data, legacy)
  if (expectedUserId === null && (snapshot.role !== null || snapshot.realizedProfit !== 0 || snapshot.spentProfit !== 0 || snapshot.availableProfit !== 0
    || snapshot.orders.length || snapshot.photos.some(photo => !photo.published || photo.deliveryStatus !== 'not_purchased'))) throw invalidResponse()
  return snapshot
}

async function snapshotRpc(name: string, params: Record<string, unknown>, expectedUserId: string, current: boolean): Promise<ShopSnapshot> {
  const result = await rpc(name, params, expectedUserId)
  if (result.error) fail(result.error)
  return checkedSnapshot(result.data, expectedUserId, !current)
}

export async function loadPhotoShop(expectedUserId: string | null): Promise<ShopSnapshot> {
  const result = await rpc('get_reward_shop', { p_expected_user_id: expectedUserId }, expectedUserId)
  if (result.error?.code === 'PGRST202') {
    const previous = await rpc('get_photo_shop', { p_expected_user_id: expectedUserId }, expectedUserId)
    if (previous.error) fail(previous.error)
    return checkedSnapshot(previous.data, expectedUserId, true)
  }
  if (result.error) fail(result.error)
  return checkedSnapshot(result.data, expectedUserId, false)
}

export async function purchasePhoto(photoId: string, expectedPrice: number, expectedUserId: string): Promise<ShopSnapshot> {
  if (!UUID.test(photoId) || !validPrice(expectedPrice)) throw new PhotoShopError('invalid_photo', '購入する商品と価格を確認してください。')
  const access = await loadPhotoShop(expectedUserId)
  if (!access.photos.some(photo => photo.id === photoId)) throw new PhotoShopError('not_found', 'この商品は見つかりませんでした。一覧を更新してください。')
  return access.fileProductsReady
    ? snapshotRpc('purchase_shop_product', { p_product_id: photoId, p_expected_price: expectedPrice, p_expected_user_id: expectedUserId }, expectedUserId, true)
    : snapshotRpc('purchase_shop_photo', { p_photo_id: photoId, p_expected_price: expectedPrice, p_expected_user_id: expectedUserId }, expectedUserId, false)
}

function photoFields(input: ShopPhotoFields): ShopPhotoFields {
  if (!input || typeof input.title !== 'string' || typeof input.description !== 'string') throw new PhotoShopError('invalid_photo', '商品のタイトルと説明を確認してください。')
  const title = input.title.trim(), description = input.description.trim()
  if (!title || title.length > 120 || description.length > 2000 || !validPrice(input.price) || typeof input.published !== 'boolean') throw new PhotoShopError('invalid_photo', 'タイトルは1〜120文字、説明は2,000文字以内、価格は1〜100,000,000の整数で入力してください。')
  return { title, description, price: input.price, published: input.published }
}

export function previewUrl(photo: ShopPhoto): string {
  if (photo.kind !== 'photo' || !UUID.test(photo.id) || photo.previewPath !== `${photo.id}/preview.jpg`) return ''
  return client().storage.from('photo-previews').getPublicUrl(photo.previewPath).data.publicUrl
}

/** Public display photography is separate from the privately delivered file. */
export function productImageUrl(product: ShopPhoto): string {
  if (product.kind !== 'file' || !validProductImagePath(product.productImagePath, product.id)) return ''
  return client().storage.from('shop-product-images').getPublicUrl(product.productImagePath).data.publicUrl
}

type ImageFormat = { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; extension: 'jpg' | 'png' | 'webp' }
async function imageFormat(file: File): Promise<ImageFormat> {
  if (!file.size || file.size > PHOTO_FILE_MAX_BYTES) throw new PhotoShopError('invalid_photo', '写真は15MB以下のJPEG・PNG・WebPファイルを選んでください。')
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: 'image/jpeg', extension: 'jpg' }
  if ([137,80,78,71,13,10,26,10].every((n, index) => bytes[index] === n)) return { contentType: 'image/png', extension: 'png' }
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return { contentType: 'image/webp', extension: 'webp' }
  throw new PhotoShopError('invalid_photo', 'JPEG・PNG・WebPの写真を選んでください。SVGなどのファイルは投稿できません。')
}

async function createPreview(file: Blob): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement | null = null
  let objectUrl: string | null = null
  try {
    if (typeof createImageBitmap === 'function') source = await createImageBitmap(file, { imageOrientation: 'from-image' })
    else {
      objectUrl = URL.createObjectURL(file)
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      source = image
    }
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height
    if (!width || !height || width * height > 60_000_000) throw new PhotoShopError('invalid_photo', '写真の画像サイズが大きすぎるため、少し小さくしてから投稿してください。')
    const ratio = Math.min(1, 960 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const preview = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Encoding failed')), 'image/jpeg', .8))
    canvas.width = 0; canvas.height = 0
    return preview
  } catch (error) {
    if (error instanceof PhotoShopError) throw error
    throw new PhotoShopError('invalid_photo', 'この写真を読み込めませんでした。別のJPEG・PNG・WebPファイルを選んでください。')
  } finally {
    if (source && 'close' in source) source.close()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

async function createProductImage(file: File): Promise<Blob> {
  const format = await imageFormat(file)
  const image = await createPreview(new Blob([file], { type: format.contentType }))
  if (!image.size || image.size > 2 * 1024 * 1024) throw new PhotoShopError('invalid_photo', '商品写真を小さくしてから、もう一度選んでください。')
  return image
}

type DocumentFormat = { contentType: 'text/plain' | 'application/pdf' | 'application/zip'; extension: ShopFileType }
async function documentFormat(file: File): Promise<DocumentFormat> {
  if (!file || typeof file.size !== 'number' || !file.size || file.size > PHOTO_FILE_MAX_BYTES) throw new PhotoShopError('invalid_photo', '商品ファイルは15MB以下のTXT・PDF・ZIPを選んでください。')
  const extension = file.name.includes('.') ? file.name.split('.').at(-1)!.toLowerCase() : ''
  if (extension && !validFileType(extension)) throw new PhotoShopError('invalid_photo', 'TXT・PDF・ZIP形式のファイルを選んでください。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') {
    if (extension && extension !== 'pdf') throw new PhotoShopError('invalid_photo', 'ファイルの拡張子と内容が一致していません。')
    return { contentType: 'application/pdf', extension: 'pdf' }
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8))) {
    if (extension && extension !== 'zip') throw new PhotoShopError('invalid_photo', 'ファイルの拡張子と内容が一致していません。')
    return { contentType: 'application/zip', extension: 'zip' }
  }
  if (extension && extension !== 'txt') throw new PhotoShopError('invalid_photo', 'ファイルの拡張子と内容が一致していません。')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new PhotoShopError('invalid_photo', 'テキストファイルはUTF-8形式で保存してから選んでください。') }
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /^\s*<(?:!doctype\s+html|html|script|svg|\?xml)\b/i.test(text)) throw new PhotoShopError('invalid_photo', 'TXT・PDF・ZIP形式の商品ファイルを選んでください。')
  return { contentType: 'text/plain', extension: 'txt' }
}

export async function uploadPhoto(input: UploadPhotoInput, expectedUserId: string): Promise<ShopSnapshot> {
  const fields = photoFields(input), kind = input.kind ?? 'photo'
  if (kind !== 'photo' && kind !== 'file') throw new PhotoShopError('invalid_photo', '商品の種類を確認してください。')
  if (kind !== 'file' && input.productImage) throw new PhotoShopError('invalid_photo', '商品写真を追加できるのは、コード・ファイル商品です。')
  await assertIdentity(expectedUserId)
  const access = await loadPhotoShop(expectedUserId)
  if (!access.role) throw adminError()
  if (kind === 'file' && !access.fileProductsReady) throw fileSetupError()
  if (input.productImage && !access.productImagesReady) throw productImageSetupError()
  const format = kind === 'file' ? await documentFormat(input.file) : await imageFormat(input.file)
  // Canonical MIME is derived from the file, never from an editable File.type.
  const original = new Blob([input.file], { type: format.contentType })
  const preview = kind === 'photo' ? await createPreview(original) : null
  const productImage = kind === 'file' && input.productImage ? await createProductImage(input.productImage) : null
  await assertIdentity(expectedUserId)
  const id = crypto.randomUUID(), originalPath = `${id}/original.${format.extension}`
  const previewPath = kind === 'photo' ? `${id}/preview.jpg` : null
  const productImagePath = productImage ? `${id}/${crypto.randomUUID()}.jpg` : null
  const bucket = kind === 'file' ? 'shop-files' : 'photo-originals'
  const uploaded: { bucket: string; path: string }[] = []
  let metadataAttempted = false
  try {
    const originalResult = await client().storage.from(bucket).upload(originalPath, original, { upsert: false, contentType: format.contentType, cacheControl: '3600' })
    if (originalResult.error) fail(originalResult.error)
    uploaded.push({ bucket, path: originalPath })
    await assertIdentity(expectedUserId)
    if (preview && previewPath) {
      const previewResult = await client().storage.from('photo-previews').upload(previewPath, preview, { upsert: false, contentType: 'image/jpeg', cacheControl: '3600' })
      if (previewResult.error) fail(previewResult.error)
      uploaded.push({ bucket: 'photo-previews', path: previewPath })
    }
    if (productImage && productImagePath) {
      const imageResult = await client().storage.from('shop-product-images').upload(productImagePath, productImage, { upsert: false, contentType: 'image/jpeg', cacheControl: '3600' })
      if (imageResult.error) fail(imageResult.error)
      uploaded.push({ bucket: 'shop-product-images', path: productImagePath })
    }
    metadataAttempted = true
    if (kind === 'file' && access.productImagesReady) {
      return await snapshotRpc('save_shop_product_with_image', { p_product_id: id, p_kind: kind, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: null, p_original_path: originalPath, p_file_ext: format.extension, p_expected_revision: null, p_expected_user_id: expectedUserId, p_product_image_path: productImagePath }, expectedUserId, true)
    }
    return access.fileProductsReady
      ? await snapshotRpc('save_shop_product', { p_product_id: id, p_kind: kind, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: previewPath, p_original_path: originalPath, p_file_ext: kind === 'file' ? format.extension : null, p_expected_revision: null, p_expected_user_id: expectedUserId }, expectedUserId, true)
      : await snapshotRpc('save_shop_photo', { p_photo_id: id, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: previewPath, p_original_path: originalPath, p_expected_revision: null, p_expected_user_id: expectedUserId }, expectedUserId, false)
  } catch (error) {
    // An ambiguous metadata response may still commit; never race its files.
    if (!metadataAttempted) {
      try { await assertIdentity(expectedUserId); await Promise.allSettled(uploaded.map(item => client().storage.from(item.bucket).remove([item.path]))) } catch { /* Only unreferenced orphans may be removed by storage policy. */ }
    }
    if (error instanceof PhotoShopError) throw error
    throw connectionError()
  }
}

export async function updatePhoto(photo: ShopPhoto, input: UpdatePhotoInput, expectedUserId: string): Promise<ShopSnapshot> {
  const fields = photoFields(input)
  if (!UUID.test(photo.id) || !Number.isSafeInteger(photo.revision) || photo.revision < 1) throw new PhotoShopError('invalid_photo', '更新する商品を確認してください。')
  if ((input.productImage || input.removeProductImage) && photo.kind !== 'file') throw new PhotoShopError('invalid_photo', '商品写真を追加できるのは、コード・ファイル商品です。')
  if (input.productImage && input.removeProductImage) throw new PhotoShopError('invalid_photo', '商品写真の変更と削除は、どちらか一方を選んでください。')
  const access = await loadPhotoShop(expectedUserId)
  if (!access.role) throw adminError()
  if (photo.kind === 'file' && !access.fileProductsReady) throw fileSetupError()
  if ((input.productImage || input.removeProductImage) && !access.productImagesReady) throw productImageSetupError()
  if (photo.kind === 'file' && access.productImagesReady) {
    const image = input.productImage ? await createProductImage(input.productImage) : null
    let imagePath = input.removeProductImage ? null : photo.productImagePath
    if (image) imagePath = `${photo.id}/${crypto.randomUUID()}.jpg`
    if (imagePath !== null && !validProductImagePath(imagePath, photo.id)) throw new PhotoShopError('invalid_photo', '商品の写真を確認してから、もう一度お試しください。')
    let metadataAttempted = false
    let uploaded = false
    try {
      await assertIdentity(expectedUserId)
      if (image && imagePath) {
        const result = await client().storage.from('shop-product-images').upload(imagePath, image, { upsert: false, contentType: 'image/jpeg', cacheControl: '3600' })
        if (result.error) fail(result.error)
        uploaded = true
      }
      metadataAttempted = true
      return await snapshotRpc('save_shop_product_with_image', { p_product_id: photo.id, p_kind: photo.kind, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: null, p_original_path: null, p_file_ext: null, p_expected_revision: photo.revision, p_expected_user_id: expectedUserId, p_product_image_path: imagePath }, expectedUserId, true)
    } catch (error) {
      if (uploaded && imagePath && !metadataAttempted) {
        try { await assertIdentity(expectedUserId); await client().storage.from('shop-product-images').remove([imagePath]) } catch { /* Preserve uncertain or referenced images. */ }
      }
      if (error instanceof PhotoShopError) throw error
      throw connectionError()
    }
  }
  return access.fileProductsReady
    ? snapshotRpc('save_shop_product', { p_product_id: photo.id, p_kind: photo.kind, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: null, p_original_path: null, p_file_ext: null, p_expected_revision: photo.revision, p_expected_user_id: expectedUserId }, expectedUserId, true)
    : snapshotRpc('save_shop_photo', { p_photo_id: photo.id, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: null, p_original_path: null, p_expected_revision: photo.revision, p_expected_user_id: expectedUserId }, expectedUserId, false)
}

export async function reviewShopOrder(orderId: string, decision: 'approve' | 'reject', expectedUserId: string): Promise<ShopSnapshot> {
  if (!UUID.test(orderId) || (decision !== 'approve' && decision !== 'reject')) throw new PhotoShopError('order_conflict', '購入申請の処理内容を確認してください。')
  const access = await loadPhotoShop(expectedUserId)
  if (!access.fileProductsReady) throw fileSetupError()
  if (!access.role) throw adminError()
  return snapshotRpc('review_shop_order', { p_order_id: orderId, p_decision: decision, p_expected_user_id: expectedUserId }, expectedUserId, true)
}

export async function downloadPhoto(photoId: string, title: string, expectedUserId: string): Promise<void> {
  if (!UUID.test(photoId)) throw new PhotoShopError('invalid_photo', 'ダウンロードする商品を確認してください。')
  const access = await loadPhotoShop(expectedUserId)
  const photo = access.photos.find(item => item.id === photoId)
  if (!photo) throw new PhotoShopError('not_found', 'この商品は見つかりませんでした。一覧を更新してください。')
  if (!access.role && photo.kind === 'file' && photo.deliveryStatus === 'pending') throw new PhotoShopError('order_pending', '管理者による確認待ちです。承認後にファイルをダウンロードできます。')
  if (!access.role && photo.deliveryStatus !== 'approved') throw new PhotoShopError('purchase_required', 'このファイルをダウンロードするには、購入と承認が必要です。')
  const current = access.fileProductsReady
  const result = await rpc(current ? 'get_shop_product_download' : 'get_shop_photo_download', current ? { p_product_id: photoId, p_expected_user_id: expectedUserId } : { p_photo_id: photoId, p_expected_user_id: expectedUserId }, expectedUserId)
  if (result.error) fail(result.error)
  const value = result.data as Record<string, unknown> | null
  const path = value?.originalPath
  const expectedBucket = photo.kind === 'file' ? 'shop-files' : 'photo-originals'
  if (current && value?.bucket !== expectedBucket) throw invalidResponse()
  const pathPattern = photo.kind === 'file' ? `^${photoId}/original\\.${photo.fileType}$` : `^${photoId}/original\\.(jpg|png|webp)$`
  if (typeof path !== 'string' || !new RegExp(pathPattern).test(path)) throw invalidResponse()
  const extension = path.split('.').at(-1)!
  const fallbackName = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'MANGO-FX-item'}.${extension}`
  const suppliedName = value?.fileName
  const fileName = typeof suppliedName === 'string' && suppliedName.length <= 160 && !/[\\/:*?"<>|\u0000-\u001f]/.test(suppliedName) && suppliedName.endsWith(`.${extension}`) ? suppliedName : fallbackName
  let download
  try { download = await client().storage.from(expectedBucket).download(path, {}, { signal: AbortSignal.timeout(45_000), cache: 'no-store' }) }
  catch { throw connectionError() }
  if (download.error) fail(download.error)
  if (!download.data || !download.data.size || download.data.size > PHOTO_FILE_MAX_BYTES) throw invalidResponse()
  await assertIdentity(expectedUserId)
  const url = URL.createObjectURL(download.data)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = fileName; anchor.rel = 'noopener'
  document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
