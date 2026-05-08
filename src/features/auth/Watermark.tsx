export function Watermark({ displayName }: { displayName: string }) {
  if (!displayName) return null
  const text = `小灵看板 · ${displayName}`
  return (
    <div className="bi-watermark" aria-hidden="true">
      {Array.from({ length: 36 }, (_, index) => (
        <span key={index}>{text}</span>
      ))}
    </div>
  )
}
