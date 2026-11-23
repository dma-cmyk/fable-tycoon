import { assetUrl } from './format';
import { VEHICLE_FILES } from './assetManifest';

export interface VehicleInfo {
  key: string;
  emoji: string;
  label: string;
}

export const CARD_VEHICLES: Record<string, VehicleInfo> = {
  express2: { key: 'train', emoji: '🚃', label: '急行列車' },
  express3: { key: 'bullet_train', emoji: '🚄', label: '超特急' },
  pegasus: { key: 'plane', emoji: '✈️', label: '飛行機' },
  carpet: { key: 'carpet', emoji: '🧞', label: 'じゅうたん' },
  rocket: { key: 'rocket', emoji: '🚀', label: 'ロケット' },
  ferry: { key: 'ferry', emoji: '⛴️', label: '船' },
};

export function cardVehicle(cardId: string): VehicleInfo | undefined {
  return CARD_VEHICLES[cardId];
}

export function vehicleForDice(count: number): VehicleInfo {
  if (count >= 3) return { key: 'bullet_train', emoji: '🚄', label: '超特急' };
  if (count === 2) return { key: 'express', emoji: '🚄', label: '急行列車' };
  return { key: 'train', emoji: '🚃', label: '電車' };
}

export function vehicleBadge(info: VehicleInfo, size = 40): HTMLElement {
  const span = document.createElement('span');
  span.className = 'vehicle-badge';
  span.style.setProperty('--vsize', `${size}px`);
  if (VEHICLE_FILES.has(info.key)) {
    const img = document.createElement('img');
    img.src = assetUrl(`assets/vehicles/${info.key}.webp`);
    img.alt = info.label;
    img.draggable = false;
    span.append(img);
  } else {
    const emoji = document.createElement('span');
    emoji.className = 'vehicle-emoji';
    emoji.textContent = info.emoji;
    span.append(emoji);
  }
  return span;
}

/** Called from UI after a card use/draw to show the vehicle name in banners. */
export function cardDepartureText(cardId: string): string | null {
  if (cardId === 'express2') return '急行列車で出発！';
  if (cardId === 'express3') return '超特急で出発！';
  if (cardId === 'pegasus') return '飛行機でひとっ飛び！';
  if (cardId === 'rocket') return 'ロケットで打ち上げ！';
  if (cardId === 'carpet') return '魔法のじゅうたんで出発！';
  return null;
}
