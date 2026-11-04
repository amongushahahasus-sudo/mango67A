import { supabase } from './supabase'
import { drawPhotoWatermark } from './photoWatermark'

export type ShopRole = 'developer' | 'admin' | null
export interface ShopPhoto {
  id: string
  title: string
  description: string
  price: number
  published: boolean
  previewPath: string
  purchased: boolean
  paidPrice: number | null
  purchasedAt: string | null
  revision: number
  createdAt: string
}
export interface ShopSnapshot {
  role: ShopRole
  realizedProfit: number
  spentProfit: number
  availableProfit: number
  photos: ShopPhoto[]
}
export interface ShopPhotoFields { title: string; description: string; price: number; published: boolean }
export interface UploadPhotoInput extends ShopPhotoFields { file: File }
export const PHOTO_FILE_MAX_BYTES = 15 * 1024 * 1024
export const PHOTO_MAX_PRICE = 100_000_000

export type PhotoShopErrorCode = 'setup' | 'session_changed' | 'admin_required' | 'account_required' | 'not_found' | 'unavailable' | 'price_changed' | 'insufficient_profit' | 'invalid_photo' | 'conflict' | 'purchase_required' | 'connection'
export class PhotoShopError extends Error {
  constructor(public readonly code: PhotoShopErrorCode, message: string) { super(message); this.name = 'PhotoShopError' }
}
export class SetupRequiredError extends PhotoShopError {
  constructor() { super('setup', '写真ショップは準備中です。しばらくしてから、もう一度お試しください。'); this.name = 'SetupRequiredError' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validMoney = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validPrice = (value: unknown): value is number => validMoney(value) && value >= 1 && value <= PHOTO_MAX_PRICE
const validDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 60 && Number.isFinite(Date.parse(value))
const connectionError = () => new PhotoShopError('connection', '写真ショップに接続できませんでした。通信を確認して、もう一度お試しください。')
const identityError = () => new PhotoShopError('session_changed', 'ログイン中のアカウントが変わりました。写真ショップを開き直してください。')
const invalidResponse = () => new PhotoShopError('connection', '写真ショップの情報を読み込めませんでした。もう一度お試しください。')

function client() {
  if (!supabase) throw new SetupRequiredError()
  return supabase
}

async function assertIdentity(expectedUserId: string | null) {
  if (expectedUserId !== null && !UUID.test(expectedUserId)) throw identityError()
  const target = client()
  let sessionResult
  try { sessionResult = await target.auth.getSession() } catch { throw identityError() }
  const { data, error } = sessionResult
  if (error || (data.session?.user.id ?? null) !== expectedUserId) throw identityError()
}

function fail(error: { code?: string; message?: string; statusCode?: string | number; status?: number }): never {
  const message = error.message || ''
  if (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01' || /Bucket not found/i.test(message)) throw new SetupRequiredError()
  if (message.includes('ACCOUNT_USER_CHANGED') || error.code === 'PGRST301' || error.status === 401 || String(error.statusCode) === '401') throw identityError()
  const mappings: [string, PhotoShopErrorCode, string][] = [
    ['SHOP_ADMIN_REQUIRED', 'admin_required', '写真を管理できるのは、管理者に指定されたアカウントだけです。'],
    ['SHOP_ACCOUNT_REQUIRED', 'account_required', 'ログインして、練習口座の保存を完了してからお試しください。'],
    ['SHOP_PHOTO_NOT_FOUND', 'not_found', 'この写真は見つかりませんでした。一覧を読み込み直してください。'],
    ['SHOP_PHOTO_UNAVAILABLE', 'unavailable', 'この写真は現在公開されていません。'],
    ['SHOP_PRICE_CHANGED', 'price_changed', '写真の価格が変更されました。一覧を更新し、新しい価格を確認してください。'],
    ['SHOP_INSUFFICIENT_PROFIT', 'insufficient_profit', '購入に使える確定利益が足りません。決済済みの利益を確認してください。'],
    ['SHOP_PHOTO_CONFLICT', 'conflict', '別の画面で写真が更新されました。一覧を読み込み直してから編集してください。'],
    ['SHOP_FILES_IMMUTABLE', 'invalid_photo', '投稿済みの写真ファイルは変更できません。新しい写真として投稿してください。'],
    ['SHOP_FILES_MISSING', 'invalid_photo', '写真のアップロードを確認できませんでした。ファイルを選び直してお試しください。'],
    ['SHOP_INVALID_PHOTO', 'invalid_photo', 'タイトル・価格・写真ファイルを確認してください。'],
    ['SHOP_PURCHASE_REQUIRED', 'purchase_required', 'この写真をダウンロードするには、購入が必要です。'],
  ]
  for (const [marker, code, text] of mappings) if (message.includes(marker)) throw new PhotoShopError(code, text)
  if (error.code === '42501' || String(error.statusCode) === '403' || error.status === 403) throw new PhotoShopError('admin_required', 'この操作を利用する権限がありません。アカウントを確認してください。')
  throw connectionError()
}

function parsePhoto(value: unknown): ShopPhoto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const p = value as Record<string, unknown>
  if (typeof p.id !== 'string' || !UUID.test(p.id) || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 120
    || typeof p.description !== 'string' || p.description.length > 2000 || !validPrice(p.price)
    || typeof p.published !== 'boolean' || p.previewPath !== `${p.id}/preview.jpg` || typeof p.purchased !== 'boolean'
    || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1 || !validDate(p.createdAt)
    || (p.purchased ? !validPrice(p.paidPrice) || !validDate(p.purchasedAt) : p.paidPrice !== null || p.purchasedAt !== null)) throw invalidResponse()
  return { id: p.id, title: p.title, description: p.description, price: p.price, published: p.published, previewPath: p.previewPath as string, purchased: p.purchased, paidPrice: p.paidPrice as number | null, purchasedAt: p.purchasedAt as string | null, revision: p.revision as number, createdAt: p.createdAt }
}

/** Validate API data before using paths, prices, or role labels in the UI. */
export function parseShopSnapshot(value: unknown): ShopSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const s = value as Record<string, unknown>
  if (![null, 'developer', 'admin'].includes(s.role as ShopRole) || !validMoney(s.realizedProfit) || !validMoney(s.spentProfit) || !validMoney(s.availableProfit)
    || s.availableProfit !== Math.max(0, s.realizedProfit - s.spentProfit) || !Array.isArray(s.photos) || s.photos.length > 5000) throw invalidResponse()
  const photos = s.photos.map(parsePhoto)
  if (new Set(photos.map(photo => photo.id)).size !== photos.length) throw invalidResponse()
  return { role: s.role as ShopRole, realizedProfit: s.realizedProfit, spentProfit: s.spentProfit, availableProfit: s.availableProfit, photos }
}

async function snapshotRpc(name: string, params: Record<string, unknown>, expectedUserId: string | null): Promise<ShopSnapshot> {
  await assertIdentity(expectedUserId)
  let result
  try { result = await client().rpc(name, params).abortSignal(AbortSignal.timeout(20_000)) }
  catch { throw connectionError() }
  if (result.error) fail(result.error)
  await assertIdentity(expectedUserId)
  const snapshot = parseShopSnapshot(result.data)
  if (expectedUserId === null && (snapshot.role !== null || snapshot.realizedProfit !== 0 || snapshot.spentProfit !== 0 || snapshot.availableProfit !== 0 || snapshot.photos.some(photo => photo.purchased))) throw invalidResponse()
  return snapshot
}

export function loadPhotoShop(expectedUserId: string | null): Promise<ShopSnapshot> {
  return snapshotRpc('get_photo_shop', { p_expected_user_id: expectedUserId }, expectedUserId)
}

export function purchasePhoto(photoId: string, expectedPrice: number, expectedUserId: string): Promise<ShopSnapshot> {
  if (!UUID.test(photoId) || !validPrice(expectedPrice)) return Promise.reject(new PhotoShopError('invalid_photo', '購入する写真と価格を確認してください。'))
  return snapshotRpc('purchase_shop_photo', { p_photo_id: photoId, p_expected_price: expectedPrice, p_expected_user_id: expectedUserId }, expectedUserId)
}

function photoFields(input: ShopPhotoFields): ShopPhotoFields {
  if (!input || typeof input.title !== 'string' || typeof input.description !== 'string') throw new PhotoShopError('invalid_photo', '写真のタイトルと説明を確認してください。')
  const title = input.title.trim(), description = input.description.trim()
  if (!title || title.length > 120 || description.length > 2000 || !validPrice(input.price) || typeof input.published !== 'boolean') throw new PhotoShopError('invalid_photo', 'タイトルは1〜120文字、説明は2,000文字以内、価格は1〜100,000,000の整数で入力してください。')
  return { title, description, price: input.price, published: input.published }
}

export function previewUrl(photo: ShopPhoto): string {
  if (!UUID.test(photo.id) || photo.previewPath !== `${photo.id}/preview.jpg`) return ''
  return client().storage.from('photo-previews').getPublicUrl(photo.previewPath).data.publicUrl
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
    const ratio = Math.min(1, 640 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    drawPhotoWatermark(context, canvas.width, canvas.height)
    const strip = Math.min(canvas.height, Math.max(25, canvas.height * .13))
    context.fillStyle = '#172d24b8'; context.fillRect(0, canvas.height - strip, canvas.width, strip)
    context.fillStyle = '#fff'; context.font = `600 ${Math.max(12, Math.min(28, canvas.width / 22))}px sans-serif`
    context.textAlign = 'center'; context.textBaseline = 'middle'
    context.fillText('MANGO FX · PREVIEW', canvas.width / 2, canvas.height - strip / 2, Math.max(1, canvas.width - 16))
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

export async function uploadPhoto(input: UploadPhotoInput, expectedUserId: string): Promise<ShopSnapshot> {
  const fields = photoFields(input)
  await assertIdentity(expectedUserId)
  const access = await loadPhotoShop(expectedUserId)
  if (!access.role) throw new PhotoShopError('admin_required', '写真を投稿できるのは管理者だけです。')
  const format = await imageFormat(input.file)
  // Blob MIME follows the decoded file signature, including cameras that omit
  // File.type. The original bytes and metadata remain unchanged.
  const original = new Blob([input.file], { type: format.contentType })
  const preview = await createPreview(original)
  await assertIdentity(expectedUserId)
  const id = crypto.randomUUID(), originalPath = `${id}/original.${format.extension}`, previewPath = `${id}/preview.jpg`
  const uploaded: { bucket: string; path: string }[] = []
  let metadataAttempted = false
  try {
    const originalResult = await client().storage.from('photo-originals').upload(originalPath, original, { upsert: false, contentType: format.contentType, cacheControl: '3600' })
    if (originalResult.error) fail(originalResult.error)
    uploaded.push({ bucket: 'photo-originals', path: originalPath })
    await assertIdentity(expectedUserId)
    const previewResult = await client().storage.from('photo-previews').upload(previewPath, preview, { upsert: false, contentType: 'image/jpeg', cacheControl: '3600' })
    if (previewResult.error) fail(previewResult.error)
    uploaded.push({ bucket: 'photo-previews', path: previewPath })
    metadataAttempted = true
    return await snapshotRpc('save_shop_photo', { p_photo_id: id, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: previewPath, p_original_path: originalPath, p_expected_revision: null, p_expected_user_id: expectedUserId }, expectedUserId)
  } catch (error) {
    // Once metadata may be saving, a lost response cannot tell us whether the
    // transaction is still running. Leave its files intact rather than race it.
    if (!metadataAttempted) {
      try { await assertIdentity(expectedUserId); await Promise.allSettled(uploaded.map(item => client().storage.from(item.bucket).remove([item.path]))) } catch { /* Leave unconfirmed orphans for the administrator. */ }
    }
    if (error instanceof PhotoShopError) throw error
    throw connectionError()
  }
}

export function updatePhoto(photo: ShopPhoto, input: ShopPhotoFields, expectedUserId: string): Promise<ShopSnapshot> {
  const fields = photoFields(input)
  if (!UUID.test(photo.id) || !Number.isSafeInteger(photo.revision) || photo.revision < 1) return Promise.reject(new PhotoShopError('invalid_photo', '更新する写真を確認してください。'))
  return snapshotRpc('save_shop_photo', { p_photo_id: photo.id, p_title: fields.title, p_description: fields.description, p_price: fields.price, p_published: fields.published, p_preview_path: null, p_original_path: null, p_expected_revision: photo.revision, p_expected_user_id: expectedUserId }, expectedUserId)
}

export async function downloadPhoto(photoId: string, title: string, expectedUserId: string): Promise<void> {
  if (!UUID.test(photoId)) throw new PhotoShopError('invalid_photo', 'ダウンロードする写真を確認してください。')
  await assertIdentity(expectedUserId)
  let result
  try { result = await client().rpc('get_shop_photo_download', { p_photo_id: photoId, p_expected_user_id: expectedUserId }).abortSignal(AbortSignal.timeout(20_000)) }
  catch { throw connectionError() }
  if (result.error) fail(result.error)
  await assertIdentity(expectedUserId)
  const value = result.data as Record<string, unknown> | null
  const path = value?.originalPath
  if (typeof path !== 'string' || !new RegExp(`^${photoId}/original\\.(jpg|png|webp)$`).test(path)) throw invalidResponse()
  const extension = path.split('.').at(-1)!
  const fallbackName = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'MANGO-FX-photo'}.${extension}`
  const suppliedName = value?.fileName
  const fileName = typeof suppliedName === 'string' && suppliedName.length <= 160 && !/[\\/:*?"<>|\u0000-\u001f]/.test(suppliedName) && suppliedName.endsWith(`.${extension}`) ? suppliedName : fallbackName
  let download
  try { download = await client().storage.from('photo-originals').download(path, {}, { signal: AbortSignal.timeout(45_000), cache: 'no-store' }) }
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
