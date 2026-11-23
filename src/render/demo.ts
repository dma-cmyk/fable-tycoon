// Standalone development harness for MapView. Not the game page.
// URL params: ?zoom=far|mid|near|0.8 &focus=tokyo &ui=0 &emote=jump &measure=1

import '@fontsource/m-plus-rounded-1c/500.css';
import '@fontsource/m-plus-rounded-1c/700.css';
import '@fontsource/m-plus-rounded-1c/800.css';

import { createGame } from '../core/engine';
import type { EmoteAnim, EmoteDef, GameState, MoveOption, PlayerSetup } from '../core/types';
import { GAME_DATA as data } from '../data/index';
import { loadMapAssets } from './assets';
import { MapView } from './map';
import type { FrameStats, CelebrateKind, Mood, WarpVia } from './map';
import type { RealmId } from '../core/types';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('map') as HTMLCanvasElement | null;
const panel = document.getElementById('panel');
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const emoteGrid = document.getElementById('emotes');
if (!canvas) throw new Error('#map がありません');
const mapCanvas: HTMLCanvasElement = canvas;

const setStatus = (text: string): void => {
  if (statusEl) statusEl.textContent = text;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DemoApi {
  ready: boolean;
  map: MapView;
  state: GameState;
  fit(): Promise<void>;
  focus(cityId: string, zoom?: number): Promise<void>;
  setZoom(zoom: number): Promise<void>;
  playAnim(anim: EmoteAnim, target?: number): Promise<void>;
  bubble(text?: string, playerId?: number): void;
  floatText(text?: string, color?: string): void;
  animateMoveTo(cityId: string, dice?: number): Promise<void>;
  showMoveOptions(): void;
  measurePan(ms?: number): Promise<FrameStats>;
  celebrate(kind: CelebrateKind): void;
  shake(intensity?: number): void;
  setMonth(month: number): void;
  setView(realm: RealmId | 'world'): void;
  setMood(mood: Mood, playerId?: number): void;
  setReducedMotion(on: boolean): void;
  warpTo(via: WarpVia): Promise<void>;
  lastStats: FrameStats | null;
}

declare global {
  interface Window {
    __mapDemo?: DemoApi;
  }
}

const CHAR_IDS = ['momotaro', 'cinderella', 'wukong', 'red_hood'];
const NODE_BY_PLAYER = ['c:tokyo', 'c:osaka', 'c:kyoto', 'c:london'];

function buildState(): GameState {
  const players: PlayerSetup[] = CHAR_IDS.map((id, i) => ({
    name: data.characters.find((c) => c.id === id)?.nameJa ?? `プレイヤー${i + 1}`,
    characterId: id,
    isCpu: false,
  }));
  const { state } = createGame(data, { years: 3, players, seed: 20261123 });
  NODE_BY_PLAYER.forEach((nodeId, i) => {
    if (state.players[i]) {
      state.players[i].nodeId = nodeId;
      state.players[i].prevNodeId = null;
    }
  });
  state.current = 0;
  state.destination = 'rio-de-janeiro';
  state.piper = { holder: 1, level: 2, heldTurns: 3 };
  state.year = 3;
  state.month = 4;
  state.round = 7;

  const assign = (cityId: string, owners: number[]): void => {
    const city = data.cities.find((c) => c.id === cityId);
    if (!city) return;
    city.properties.forEach((prop, index) => {
      const owner = owners[index % owners.length];
      if (owner !== undefined) state.owner[prop.id] = owner;
    });
  };
  assign('tokyo', [0]);
  assign('paris', [1, 2, 1]);
  assign('london', [3, 3, 1]);
  assign('osaka', [1, 1]);
  assign('cairo', [2, 2, 2]);
  return state;
}

function adjacency(): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const node of data.board.nodes) adj.set(node.id, []);
  for (const edge of data.board.edges) {
    adj.get(edge.a)?.push(edge.b);
    adj.get(edge.b)?.push(edge.a);
  }
  return adj;
}

const ADJ = adjacency();

/** BFS paths (excluding the start node) up to maxDepth. */
function bfsPaths(from: string, maxDepth: number): Map<string, string[]> {
  const paths = new Map<string, string[]>([[from, []]]);
  let frontier = [from];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const path = paths.get(nodeId) ?? [];
      for (const neighbor of ADJ.get(nodeId) ?? []) {
        if (paths.has(neighbor)) continue;
        paths.set(neighbor, [...path, neighbor]);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return paths;
}

function pathTo(from: string, to: string): string[] | null {
  if (from === to) return [];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const neighbor of ADJ.get(id) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      prev.set(neighbor, id);
      if (neighbor === to) {
        const path: string[] = [to];
        let cursor = to;
        while (cursor !== from) {
          const parent = prev.get(cursor);
          if (!parent) return null;
          cursor = parent;
          if (cursor !== from) path.push(cursor);
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }
  return null;
}

function nodeLabel(nodeId: string): string {
  if (nodeId.startsWith('c:')) {
    const city = data.cities.find((c) => c.id === nodeId.slice(2));
    return city?.nameJa ?? nodeId;
  }
  return nodeId;
}

function emoteForAnim(anim: EmoteAnim): EmoteDef {
  const preferred = data.emotes.find((e) => e.anim === anim && e.targeted === (anim === 'throw'));
  return preferred ?? data.emotes.find((e) => e.anim === anim) ?? data.emotes[0];
}

async function main(): Promise<void> {
  if (loadingText) loadingText.textContent = '世界地図を準備しています…';
  if (params.get('ui') === '0') {
    if (panel) panel.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
  }

  const assets = await loadMapAssets(data, (p) => {
    if (loadingText) loadingText.textContent = `世界地図を準備しています… ${p.loaded}/${p.total}`;
  });
  await document.fonts.load('800 16px "M PLUS Rounded 1c"', 'あいうえお');
  await document.fonts.ready;

  const state = buildState();
  const map = new MapView(mapCanvas, data, assets);
  map.setState(state);
  map.onCityTap((cityId) => {
    const city = data.cities.find((c) => c.id === cityId);
    setStatus(`都市タップ: ${city?.nameJa ?? cityId}`);
  });

  let moveOptions: MoveOption[] = [];
  const showMoveOptions = (): void => {
    const from = state.players[state.current]?.nodeId ?? 'c:tokyo';
    const paths = bfsPaths(from, 4);
    const candidates: MoveOption[] = [];
    for (const [nodeId, path] of paths) {
      if (path.length !== 3 && path.length !== 4) continue;
      const node = data.board.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      candidates.push({ nodeId, path });
    }
    const canvasRect = mapCanvas.getBoundingClientRect();
    const isVisible = (nodeId: string): boolean => {
      const p = map.getNodeScreenPosition(nodeId);
      return !!p && p.x > 60 && p.x < canvasRect.width - 60 && p.y > 80 && p.y < canvasRect.height - 40;
    };
    const visible = candidates.filter((o) => isVisible(o.nodeId));
    const pool = visible.length >= 2 ? visible : candidates;
    const picked: MoveOption[] = [];
    for (const option of pool) {
      const node = data.board.nodes.find((n) => n.id === option.nodeId);
      if (!node) continue;
      if (
        picked.every((p) => {
          const q = data.board.nodes.find((n) => n.id === p.nodeId);
          return !q || Math.hypot(node.x - q.x, node.y - q.y) > 40;
        })
      ) {
        picked.push(option);
      }
      if (picked.length === 3) break;
    }
    moveOptions = picked.length > 0 ? picked : pool.slice(0, 3);
    map.setMoveOptions(moveOptions, (nodeId) => {
      const option = moveOptions.find((o) => o.nodeId === nodeId);
      if (!option) return;
      const target = state.players[state.current];
      if (target) {
        target.prevNodeId = target.nodeId;
        target.nodeId = nodeId;
      }
      map.floatText(nodeId, '移動決定！', '#c88900');
      setStatus(`移動先を選択: ${nodeLabel(nodeId)}（${option.path.length} 歩）`);
      map.bubble(0, `${nodeLabel(nodeId)}へ向かうぞ！`, 2600);
    });
    setStatus(`移動先候補 ${moveOptions.length} 件（1回目タップで経路、2回目で決定）`);
  };

  const playAnim = (anim: EmoteAnim, target = 1): Promise<void> => {
    const def = emoteForAnim(anim);
    const charId = state.players[0]?.characterId ?? '';
    const line = def.lines[charId] ?? def.lines.default;
    map.bubble(0, line, Math.min(2600, def.cooldownMs + 800));
    return map.playEmote(0, def, target);
  };

  const animateMoveTo = async (cityId: string, dice = 1): Promise<void> => {
    const player = state.players[0];
    const nodeId = `c:${cityId}`;
    if (!player) return;
    const path = pathTo(player.nodeId, nodeId);
    if (!path || path.length === 0) {
      setStatus(`${cityId} への経路が見つかりません`);
      return;
    }
    setStatus(`${nodeLabel(nodeId)} まで ${path.length} 歩を移動中…`);
    await map.animateMove(0, path, 180, { dice });
    player.prevNodeId = player.nodeId;
    player.nodeId = nodeId;
    setStatus(`${nodeLabel(nodeId)} に到着（${path.length} 歩）`);
  };

  const measurePan = async (ms = 3000): Promise<FrameStats> => {
    // Let a pending zoom/asset/static-layer rebuild finish before sampling.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    map.resetFrameStats();
    const rect = mapCanvas.getBoundingClientRect();
    const startX = rect.width * 0.72;
    const startY = rect.height * 0.55;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      mapCanvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 99,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: rect.left + startX,
          clientY: rect.top + startY,
          bubbles: true,
        }),
      );
      const step = (): void => {
        const now = performance.now();
        const p = Math.min(1, (now - start) / ms);
        const x = rect.width * 0.72 + Math.sin(p * Math.PI * 4) * rect.width * 0.24;
        const y = rect.height * 0.55 + Math.sin(p * Math.PI * 2.5) * rect.height * 0.12;
        mapCanvas.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 99,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: 1,
            clientX: rect.left + x,
            clientY: rect.top + y,
            bubbles: true,
          }),
        );
        if (p >= 1) {
          mapCanvas.dispatchEvent(
            new PointerEvent('pointerup', {
              pointerId: 99,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              clientX: rect.left + x,
              clientY: rect.top + y,
              bubbles: true,
            }),
          );
          resolve();
        } else {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
    await delay(160);
    const stats = map.getFrameStats();
    const text = `avg ${stats.avgMs.toFixed(2)}ms / p95 ${stats.p95Ms.toFixed(2)}ms / max ${stats.maxMs.toFixed(2)}ms / ${stats.fps.toFixed(1)}fps (${stats.frames}f)`;
    console.log(`[map-demo] pan ${(ms / 1000).toFixed(1)}s: ${text}`);
    setStatus(`描画計測: ${text}`);
    if (api) api.lastStats = stats;
    return stats;
  };

  let api: DemoApi | null = null;
  const createdApi: DemoApi = {
    ready: false,
    map,
    state,
    fit: () => map.fitWorld(0),
    focus: (cityId, zoom) => map.focusNode(`c:${cityId}`, { zoom, ms: 0 }),
    setZoom: (zoom) => map.focusNode(state.players[0]?.nodeId ?? 'c:tokyo', { zoom, ms: 0 }),
    playAnim,
    bubble: (text = 'この波に乗って資産を増やすぞ！', playerId = 0) => map.bubble(playerId, text, 4000),
    floatText: (text = '+12億', color = '#139b4c') =>
      map.floatText(state.players[0]?.nodeId ?? 'c:tokyo', text, color),
    animateMoveTo,
    showMoveOptions,
    measurePan,
    celebrate: (kind) => {
      const nodeId = state.players[state.current]?.nodeId;
      if (nodeId) map.celebrate(nodeId, kind);
    },
    shake: (intensity = 0.8) => map.shake(intensity),
    setMonth: (month) => {
      map.setMonth(month);
      setStatus(`季節: ${month}月`);
    },
    setView: (realm) => {
      map.setView(realm);
      setStatus(`ビュー: ${realm}`);
    },
    setMood: (mood, playerId = 0) => map.setMood(playerId, mood, 5000),
    setReducedMotion: (on) => map.setReducedMotion(on),
    warpTo: async (via) => {
      const target = via === 'plane' || via === 'rocket' || via === 'carpet' ? 'c:paris' : 'c:tokyo';
      await map.warp(0, target, via);
      const p = state.players[0];
      if (p) p.nodeId = target;
    },
    lastStats: null,
  };
  api = createdApi;
  window.__mapDemo = createdApi;

  // Controls -----------------------------------------------------------------
  const bind = (id: string, fn: () => void): void => {
    document.getElementById(id)?.addEventListener('click', fn);
  };
  bind('btn-move', () => {
    void animateMoveTo('seoul');
  });
  bind('btn-options', showMoveOptions);
  bind('btn-focus', () => {
    void map.focusNode('c:paris', { zoom: 1.9, ms: 650 });
  });
  bind('btn-fit', () => {
    void map.fitWorld(700);
  });
  bind('btn-bubble', () => createdApi.bubble());
  bind('btn-float', () => createdApi.floatText());
  bind('btn-measure', () => {
    void measurePan(3000);
  });
  bind('btn-dice1', () => { void animateMoveTo('seoul', 1); });
  bind('btn-dice2', () => { void animateMoveTo('seoul', 2); });
  bind('btn-dice3', () => { void animateMoveTo('seoul', 3); });
  bind('btn-sea', () => { void animateMoveTo('sydney', 1); });
  bind('btn-plane', () => { void map.warp(0, 'c:paris', 'plane'); });
  bind('btn-rocket', () => { void map.warp(0, 'c:paris', 'rocket'); });
  bind('btn-carpet', () => { void map.warp(0, 'c:paris', 'carpet'); });
  bind('btn-tornado', () => { void map.warp(0, 'c:paris', 'tornado'); });
  bind('btn-mood-joy', () => map.setMood(0, 'joy', 5000));
  bind('btn-mood-sad', () => map.setMood(0, 'sad', 5000));
  bind('btn-mood-clear', () => map.setMood(0, null));
  bind('btn-buy', () => map.celebrate(0, 'buy'));
  bind('btn-monopoly', () => map.celebrate(0, 'monopoly'));
  bind('btn-goal', () => map.celebrate(0, 'goal'));
  bind('btn-bad', () => map.celebrate(0, 'bad'));
  bind('btn-shake', () => map.shake(1));
  bind('btn-month4', () => map.setMonth(4));
  bind('btn-month8', () => map.setMonth(8));
  bind('btn-month11', () => map.setMonth(11));
  bind('btn-month1', () => map.setMonth(1));
  bind('btn-view-world', () => map.setView('world'));
  bind('btn-view-heaven', () => map.setView('heaven'));
  bind('btn-view-hell', () => map.setView('hell'));
  bind('btn-view-space', () => map.setView('space'));
  bind('btn-reduced', () => map.setReducedMotion(true));
  bind('btn-reduced-off', () => map.setReducedMotion(false));
  bind('btn-emote-all', () => {
    const anims: EmoteAnim[] = [
      'jump', 'angry', 'cry', 'laugh', 'dance', 'taunt', 'dogeza',
      'money_rain', 'flex', 'sleep', 'heart', 'throw', 'hit', 'spotlight',
    ];
    void (async () => {
      setStatus('全エモートを順番に再生中…');
      for (const anim of anims) {
        await playAnim(anim, 1);
        await delay(120);
      }
      setStatus('全エモート再生完了');
    })();
  });

  if (emoteGrid) {
    const anims: EmoteAnim[] = [
      'jump', 'angry', 'cry', 'laugh', 'dance', 'taunt', 'dogeza',
      'money_rain', 'flex', 'sleep', 'heart', 'throw', 'hit', 'spotlight',
    ];
    for (const anim of anims) {
      const def = emoteForAnim(anim);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${def.icon} ${def.label}`;
      button.title = `${anim} / ${def.id}`;
      button.addEventListener('click', () => {
        void playAnim(anim, 1);
      });
      emoteGrid.appendChild(button);
    }
  }

  // URL presets used by the screenshot harness.
  const zoomParam = params.get('zoom');
  const focusParam = params.get('focus');
  if (zoomParam === 'far') {
    await map.fitWorld(0);
  } else if (zoomParam === 'mid' || zoomParam === 'near') {
    const city = focusParam ?? (zoomParam === 'near' ? 'tokyo' : 'paris');
    const zoom = zoomParam === 'near' ? 2.3 : 0.95;
    await map.focusNode(`c:${city}`, { zoom, ms: 0 });
  } else if (zoomParam !== null && Number.isFinite(Number(zoomParam))) {
    await map.focusNode(`c:${focusParam ?? 'tokyo'}`, { zoom: Number(zoomParam), ms: 0 });
  }
  if (focusParam && !zoomParam) {
    await map.focusNode(`c:${focusParam}`, { zoom: 1.4, ms: 0 });
  }

  if (loadingEl) loadingEl.style.display = 'none';
  createdApi.ready = true;
  setStatus('準備完了 — ドラッグ / ホイール / ピンチ / ダブルタップで操作');

  const emoteParam = params.get('emote');
  if (emoteParam) {
    const anim = (emoteParam as EmoteAnim);
    setTimeout(() => {
      void playAnim(anim, 1);
    }, 350);
  }
  if (params.get('measure') === '1') {
    setTimeout(() => {
      void measurePan(3000);
    }, 500);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  if (loadingEl) loadingEl.textContent = `読み込みに失敗しました: ${String(err)}`;
  setStatus('読み込み失敗');
});