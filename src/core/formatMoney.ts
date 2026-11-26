// Shared 億円 formatter (2026-11-26 Sol playtest: a CPU toast read `22.950000000000003 億`).
//
// Money in the engine is a float (prices, 5% tariffs, 1.5x buyouts), so any text that prints a
// raw number leaks binary-fraction noise. Engines and UI both build player-facing strings, so
// the single implementation lives below the UI layer and `src/ui/format.ts` re-exports it.

/** Integer 億円 display. 12480 -> 1兆2,480億円; -30 -> ▲30億円. */
export function formatOku(n: number): string {
  const total = Math.round(n);
  const abs = Math.abs(total);
  const sign = total < 0 ? '▲' : '';
  if (abs >= 10000) {
    const cho = Math.floor(abs / 10000);
    const rest = abs % 10000;
    return rest > 0
      ? `${sign}${cho.toLocaleString('ja-JP')}兆${rest.toLocaleString('ja-JP')}億円`
      : `${sign}${cho.toLocaleString('ja-JP')}兆円`;
  }
  return `${sign}${abs.toLocaleString('ja-JP')}億円`;
}

/** Same as formatOku but without 円, for compact chips: 1兆2,480億. */
export function formatOkuShort(n: number): string {
  return formatOku(n).replace(/円$/, '');
}

/** '+12億' / '▲12億' for floating cash text. */
export function formatDelta(n: number): string {
  const total = Math.round(n);
  if (total > 0) return `+${formatOkuShort(total)}`;
  if (total < 0) return formatOkuShort(total);
  return '±0億';
}