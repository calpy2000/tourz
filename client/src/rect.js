// Every popup that anchors to the element which triggered it (hint/reveal confirms, why?, the
// dev menu) needs a plain snapshot of that element's position, taken at click time.
export function rectFromEvent(e) {
  const r = e.currentTarget.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height }
}
