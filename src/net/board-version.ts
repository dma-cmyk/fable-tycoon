// Stable version of the world board + cities, used to reject saves/peers built against a different
// map. Runtime FNV-1a is enough: this is a compatibility marker, not a security boundary.
import { GAME_DATA } from '../data/index';

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const payload = {
  nodes: GAME_DATA.board.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    cityId: node.cityId ?? null,
    realm: node.realm ?? null,
    x: node.x,
    y: node.y,
  })),
  edges: GAME_DATA.board.edges.map((edge) => ({
    a: edge.a,
    b: edge.b,
    mode: edge.mode,
  })),
  cities: GAME_DATA.cities.map((city) => ({
    id: city.id,
    properties: city.properties.map((property) => ({
      id: property.id,
      price: property.price,
      yieldPct: property.yieldPct,
      industry: property.industry,
    })),
  })),
};

export const BOARD_VERSION = `b${fnv1a(JSON.stringify(payload))}`;
