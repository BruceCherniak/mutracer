/** Internal frame scheduling; dedicated workers without rAF use a 16 ms timer. */
export function scheduleFrame(callback: (time: number) => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(() => callback(performance.now()), 16);
  return () => clearTimeout(id);
}
