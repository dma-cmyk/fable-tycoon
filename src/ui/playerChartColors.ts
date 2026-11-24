import { playerColor, type PlayerLike } from './format';

/**
 * High-contrast, color-vision-friendly fallback palette against the warm white chart card
 * (`#fffdf5`). Ordered so 2–4 player games get strongly distinct hues immediately.
 */
export const DISTINCT_CHART_PALETTE = [
  '#1d70d8', // vivid blue
  '#159947', // emerald green
  '#d97706', // deep amber
  '#7c3aed', // violet
  '#e63946', // crimson
  '#0891b2', // cyan-teal
  '#db2777', // magenta
  '#4f46e5', // indigo
] as const;

/** Redmean weighted RGB distance below which two chart lines look confusingly similar. */
export const MIN_CHART_COLOR_DISTANCE = 155;

const CHART_BG_RGB: readonly [number, number, number] = [255, 253, 245];
const MIN_BG_DISTANCE = 140;

export function parseHexRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(cleaned)) {
    return [
      Number.parseInt(cleaned[0] + cleaned[0], 16),
      Number.parseInt(cleaned[1] + cleaned[1], 16),
      Number.parseInt(cleaned[2] + cleaned[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(cleaned)) {
    return [
      Number.parseInt(cleaned.slice(0, 2), 16),
      Number.parseInt(cleaned.slice(2, 4), 16),
      Number.parseInt(cleaned.slice(4, 6), 16),
    ];
  }
  return null;
}

/** Perceptual weighted RGB distance (redmean approximation, 0..~765). */
export function colorDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const rMean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(
    (2 + rMean / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - rMean) / 256) * db * db,
  );
}

/**
 * Resolves one chart color per player: preserves each character's own color when it is
 * legible on the chart background and distinct from earlier seats, and swaps to the most
 * visually distinct seat color from `DISTINCT_CHART_PALETTE` whenever two characters share
 * a similar hue (e.g. Momotaro & Red Riding Hood both being red).
 */
export function resolvePlayerChartColors(players: ReadonlyArray<PlayerLike>): string[] {
  const baseColors = players.map((player) => playerColor(player));
  return resolveDistinctColors(baseColors);
}

export function resolveDistinctColors(baseColors: ReadonlyArray<string>): string[] {
  const chosenHex: string[] = [];
  const chosenRgb: [number, number, number][] = [];
  const baseRgb = baseColors.map((hex) => parseHexRgb(hex));

  for (let i = 0; i < baseColors.length; i++) {
    const candidateHex = baseColors[i];
    const candidateRgb = baseRgb[i];
    const legible = candidateRgb !== null && colorDistance(candidateRgb, CHART_BG_RGB) >= MIN_BG_DISTANCE;
    const distinctFromChosen =
      candidateRgb !== null &&
      chosenRgb.every((existing) => colorDistance(candidateRgb, existing) >= MIN_CHART_COLOR_DISTANCE);

    if (legible && distinctFromChosen) {
      chosenHex.push(candidateHex);
      chosenRgb.push(candidateRgb);
      continue;
    }

    // Also try not to steal a color that closely matches a later player's distinct base color.
    const upcomingRgb = baseRgb
      .slice(i + 1)
      .filter((rgb): rgb is [number, number, number] => rgb !== null);

    let bestHex: string = DISTINCT_CHART_PALETTE[i % DISTINCT_CHART_PALETTE.length];
    let bestRgb: [number, number, number] = parseHexRgb(bestHex) ?? [29, 112, 216];
    let bestScore = -1;

    for (const paletteHex of DISTINCT_CHART_PALETTE) {
      const rgb = parseHexRgb(paletteHex);
      if (!rgb) continue;
      const minChosen =
        chosenRgb.length === 0
          ? 765
          : Math.min(...chosenRgb.map((existing) => colorDistance(rgb, existing)));
      const minUpcoming =
        upcomingRgb.length === 0
          ? 765
          : Math.min(...upcomingRgb.map((next) => colorDistance(rgb, next)));
      // Primary objective: maximize separation from already-assigned seats; tie-break by avoiding
      // future seats' base colors so later players can keep their own colors when possible.
      const score = minChosen * 10 + Math.min(minUpcoming, 220);
      if (score > bestScore) {
        bestScore = score;
        bestHex = paletteHex;
        bestRgb = rgb;
      }
    }

    chosenHex.push(bestHex);
    chosenRgb.push(bestRgb);
  }

  return chosenHex;
}
