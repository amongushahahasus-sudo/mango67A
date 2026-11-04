/** Burn the preview mark into pixels, including the center of the photograph. */
export function drawPhotoWatermark(context: CanvasRenderingContext2D, width: number, height: number) {
  const size = Math.max(16, Math.min(30, Math.max(width, height) / 20))
  const span = Math.hypot(width, height)
  const spacingX = size * 14, spacingY = size * 3
  context.save()
  context.translate(width / 2, height / 2)
  context.rotate(-Math.PI / 6)
  context.font = `700 ${size}px sans-serif`
  context.textAlign = 'center'; context.textBaseline = 'middle'
  context.fillStyle = '#ffffffad'; context.strokeStyle = '#1735278f'; context.lineWidth = Math.max(1, size / 18)
  for (let row = -Math.ceil(span / spacingY); row <= Math.ceil(span / spacingY); row += 1) {
    const offset = Math.abs(row) % 2 ? spacingX / 2 : 0
    for (let column = -Math.ceil(span / spacingX); column <= Math.ceil(span / spacingX); column += 1) {
      const x = column * spacingX + offset, y = row * spacingY
      context.strokeText('MANGO FX · PREVIEW', x, y)
      context.fillText('MANGO FX · PREVIEW', x, y)
    }
  }
  context.restore()
}
