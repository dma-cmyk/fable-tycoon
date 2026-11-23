import type { PublicState } from '../../core/engine';
import type {} from '../../core/types';
import { h } from '../dom';
import { displayPlayerName, formatOkuShort, playerColor } from '../format';

export interface AssetChartOptions {
  canvas: HTMLCanvasElement;
  state: PublicState;
  finalAssets?: number[];
}

/** Draws one line per player over the assetHistory rounds. Pure canvas 2D, DPR aware. */
export function drawAssetChart(options: AssetChartOptions): void {
  const { canvas, state } = options;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(280, Math.round(rect.width || 560));
  const cssHeight = Math.max(150, Math.round(rect.height || 190));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = '#fffdf5';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const padLeft = 58;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 24;
  const plotW = cssWidth - padLeft - padRight;
  const plotH = cssHeight - padTop - padBottom;

  const history = state.assetHistory;
  const final = options.finalAssets;
  const series: number[][] = state.players.map((_, index) => {
    const values = history.map((round) => round[index] ?? 0);
    if (final && final[index] !== undefined) {
      const last = values[values.length - 1];
      if (last === undefined || Math.abs(last - final[index]) > 0.5) values.push(final[index]);
    }
    return values;
  });
  const pointCount = Math.max(2, ...series.map((values) => values.length));
  const allValues = series.flat();
  if (allValues.length === 0) {
    ctx.fillStyle = '#8a806b';
    ctx.font = "600 13px 'M PLUS Rounded 1c', sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('まだ資産推移がありません', cssWidth / 2, cssHeight / 2);
    return;
  }

  let min = Math.min(0, ...allValues);
  let max = Math.max(1, ...allValues);
  if (max - min < 10) max = min + 10;
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;

  const xAt = (index: number): number =>
    padLeft + (pointCount <= 1 ? plotW / 2 : (index / (pointCount - 1)) * plotW);
  const yAt = (value: number): number => padTop + plotH - ((value - min) / (max - min)) * plotH;

  // Grid + Y labels
  ctx.strokeStyle = '#e6dcc2';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#7c735e';
  ctx.font = "600 10px 'M PLUS Rounded 1c', sans-serif";
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = min + ((max - min) * i) / 4;
    const y = yAt(value);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(cssWidth - padRight, y);
    ctx.stroke();
    ctx.fillText(formatOkuShort(value), padLeft - 7, y);
  }

  // Zero line
  if (min < 0 && max > 0) {
    const y0 = yAt(0);
    ctx.strokeStyle = '#c9b98d';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, y0);
    ctx.lineTo(cssWidth - padRight, y0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // X labels
  ctx.fillStyle = '#7c735e';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('開始', padLeft, cssHeight - padBottom + 6);
  ctx.textAlign = 'right';
  ctx.fillText('現在', cssWidth - padRight, cssHeight - padBottom + 6);

  // Lines
  state.players.forEach((player, index) => {
    const values = series[index];
    if (values.length === 0) return;
    const color = playerColor(player);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    values.forEach((value, i) => {
      const x = xAt(i);
      const y = yAt(value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Last point marker
    const lastIndex = values.length - 1;
    const lx = xAt(lastIndex);
    const ly = yAt(values[lastIndex]);
    ctx.beginPath();
    ctx.fillStyle = '#fffdf5';
    ctx.arc(lx, ly, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  });
}

export function assetLegend(state: PublicState): HTMLElement {
  const legend = h('div', { class: 'asset-legend' });
  for (const player of state.players) {
    legend.append(
      h(
        'span',
        { class: 'asset-legend-item' },
        h('span', { class: 'asset-legend-dot', attrs: { style: `background:${playerColor(player)}` } }),
        h('span', { text: displayPlayerName(player) }),
      ),
    );
  }
  return legend;
}