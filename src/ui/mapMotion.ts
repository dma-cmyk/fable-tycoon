import type { MapView } from '../render/map';
import type { RealmId } from '../core/types';

export type MapViewId = RealmId | 'world';

export interface ExtraMapView {
  setView?: (view: MapViewId) => void;
  screenPositionOfNode?: (nodeId: string) => { x: number; y: number; visible?: boolean } | null;
}

/** Additive MapView hooks that may still be landing from the renderer worker. */
export function extraMapView(map: MapView | null): ExtraMapView | null {
  return map as unknown as ExtraMapView | null;
}
