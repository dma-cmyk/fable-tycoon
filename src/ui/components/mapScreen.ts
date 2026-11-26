// Full-screen read-only world map (地図 button / key 5). It is deliberately a second
// MapView over the shared MapAssets: the play camera can never be disturbed or restored
// wrong, and closing releases the extra land caches. The screen owns its own realm tabs,
// search, layer toggles, player list and marker overlay.

import type { City, GameData, PublicState } from '../../core/types';
import { MapView, type MapAssets } from '../../render/map';
import { h } from '../dom';
import {
  characterSprite,
  charsById,
  citiesById,
  cityNodeId,
  displayPlayerName,
  nodesById,
  propertiesById,
  REALM_ICON,
  realmLabel,
  seatColor,
} from '../format';
import type { MapViewId } from '../mapMotion';
import { filterCities, groupCityOwners } from '../mapScreenData';
import '../../styles/mapScreen.css';

export type MapScreenLayer = 'own' | 'rival' | 'effects' | 'errand' | 'destination' | 'players';

interface LayerDef {
  key: MapScreenLayer;
  icon: string;
  label: string;
}

const LAYERS: LayerDef[] = [
  { key: 'own', icon: '🏠', label: '自分の物件' },
  { key: 'rival', icon: '🏢', label: 'ライバルの物件' },
  { key: 'effects', icon: '📈', label: '都市効果' },
  { key: 'errand', icon: '📜', label: '寄り道依頼' },
  { key: 'destination', icon: '🎯', label: '目的地' },
  { key: 'players', icon: '🧍', label: 'プレイヤーの位置' },
];

const REALMS: Array<{ id: MapViewId; short: string }> = [
  { id: 'world', short: '地上' },
  { id: 'heaven', short: '天国' },
  { id: 'hell', short: '地獄' },
  { id: 'space', short: '宇宙' },
];

interface MarkerSpec {
  id: string;
  nodeId: string;
  icon: string;
  count: number | null;
  tone: 'mine' | 'rival' | 'focus';
  color: string;
  offsetX: number;
  offsetY: number;
  label: string;
}

export interface MapScreenOptions {
  host: HTMLElement;
  data: GameData;
  assets: MapAssets;
  state: () => PublicState | null;
  myPlayerIds: () => number[];
  reducedMotion: () => boolean;
  openCitySheet: (cityId: string) => void;
  /** Called for the close button; the host owns history/back-gesture handling. */
  onRequestClose: () => void;
}

export class MapScreen {
  readonly el: HTMLElement;
  private readonly options: MapScreenOptions;
  private readonly mapHost: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly markerHost: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly tabsHost: HTMLElement;
  private readonly layersHost: HTMLElement;
  private readonly playersHost: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchResults: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly tabButtons = new Map<MapViewId, HTMLButtonElement>();
  private readonly layerButtons = new Map<MapScreenLayer, HTMLButtonElement>();
  private readonly layers: Record<MapScreenLayer, boolean> = {
    own: true,
    rival: true,
    effects: true,
    errand: true,
    destination: true,
    players: true,
  };
  private readonly cityByProperty = new Map<string, string>();
  private map: MapView | null = null;
  private currentState: PublicState | null = null;
  private view: MapViewId = 'world';
  private markers: MarkerSpec[] = [];
  private readonly markerEls = new Map<string, HTMLElement>();
  private raf = 0;
  private opened = false;
  private searchFocusId: string | null = null;
  private destroyed = false;

  constructor(options: MapScreenOptions) {
    this.options = options;
    for (const [propertyId, ref] of propertiesById) this.cityByProperty.set(propertyId, ref.city.id);

    this.canvas = h('canvas', {
      class: 'map-screen-canvas',
      attrs: { 'aria-label': '世界地図（読み取り専用）' },
    });
    this.markerHost = h('div', { class: 'map-screen-markers', attrs: { 'aria-hidden': 'true' } });
    this.loading = h('div', { class: 'map-screen-loading', text: '地図をひらいています…' });
    this.mapHost = h('div', { class: 'map-screen-map' }, this.canvas, this.markerHost, this.loading);

    this.tabsHost = h('div', { class: 'map-screen-tabs', attrs: { role: 'tablist', 'aria-label': '世界' } });
    for (const realm of REALMS) {
      const button = h(
        'button',
        {
          class: 'map-screen-tab',
          dataset: { realm: realm.id },
          attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
          on: { click: () => this.selectRealm(realm.id) },
        },
        h('span', { class: 'map-screen-tab-icon', text: REALM_ICON[realm.id], attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'map-screen-tab-label', text: realm.short }),
        h('span', { class: 'map-screen-tab-count', text: '0' }),
      );
      this.tabButtons.set(realm.id, button);
      this.tabsHost.append(button);
    }

    this.searchInput = h('input', {
      class: 'map-screen-search-input',
      attrs: {
        type: 'search',
        placeholder: '都市を検索（東京 / Tokyo）',
        'aria-label': '都市を検索',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    });
    this.searchInput.addEventListener('input', () => this.renderSearchResults());
    this.searchResults = h('div', { class: 'map-screen-search-results', attrs: { hidden: 'hidden' } });

    this.layersHost = h('div', { class: 'map-screen-layers', attrs: { role: 'group', 'aria-label': '表示レイヤー' } });
    for (const layer of LAYERS) {
      const button = h(
        'button',
        {
          class: 'map-screen-layer',
          dataset: { layer: layer.key },
          attrs: { type: 'button', 'aria-pressed': 'true' },
          on: { click: () => this.toggleLayer(layer.key) },
        },
        h('span', { class: 'map-screen-layer-icon', text: layer.icon, attrs: { 'aria-hidden': 'true' } }),
        h('span', { text: layer.label }),
      );
      this.layerButtons.set(layer.key, button);
      this.layersHost.append(button);
    }

    this.playersHost = h('div', { class: 'map-screen-players', attrs: { 'aria-label': 'プレイヤーの位置' } });
    this.statusEl = h('span', { class: 'map-screen-status', text: '' });
    this.closeButton = h(
      'button',
      {
        class: 'btn btn-gold map-screen-close',
        attrs: { type: 'button' },
        on: { click: () => this.options.onRequestClose() },
      },
      h('span', { text: '✕', attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: 'プレイ画面に戻る' }),
    );

    this.el = h(
      'div',
      {
        class: 'map-screen',
        attrs: {
          hidden: 'hidden',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '世界地図',
        },
      },
      h(
        'header',
        { class: 'map-screen-head' },
        h(
          'div',
          { class: 'map-screen-title' },
          h('span', { class: 'map-screen-title-icon', text: '🌍', attrs: { 'aria-hidden': 'true' } }),
          h(
            'div',
            { class: 'map-screen-title-text' },
            h('h2', { text: '世界地図' }),
            h('p', { text: '都市・物件・依頼を見る（読み取り専用）' }),
          ),
          this.statusEl,
        ),
        h(
          'div',
          { class: 'map-screen-head-actions' },
          h('span', { class: 'map-screen-input-hint', text: 'ドラッグで移動 ・ ホイール/ピンチで拡大 ・ 都市をタップで情報' }),
          h('button', {
            class: 'btn btn-ghost map-screen-fit',
            text: '⤢ 全体',
            attrs: { type: 'button' },
            on: { click: () => void this.map?.fitWorld(420) },
          }),
          this.closeButton,
        ),
      ),
      h(
        'div',
        { class: 'map-screen-body' },
        this.mapHost,
        h(
          'aside',
          { class: 'map-screen-panel', attrs: { 'aria-label': '地図の切り替えと検索' } },
          this.tabsHost,
          h(
            'div',
            { class: 'map-screen-search' },
            h('span', { class: 'map-screen-search-icon', text: '🔍', attrs: { 'aria-hidden': 'true' } }),
            this.searchInput,
            this.searchResults,
          ),
          h('div', { class: 'map-screen-section-head' }, h('span', { text: '表示レイヤー' })),
          this.layersHost,
          h('div', { class: 'map-screen-section-head' }, h('span', { text: 'プレイヤー' })),
          this.playersHost,
        ),
      ),
    );
    options.host.append(this.el);
    this.syncTabUi();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get viewId(): MapViewId {
    return this.view;
  }

  open(realm: MapViewId = 'world'): void {
    if (this.opened || this.destroyed) return;
    this.opened = true;
    this.currentState = this.options.state();
    this.view = realm;
    this.el.hidden = false;
    this.options.host.classList.add('map-screen-open');
    this.loading.hidden = false;
    this.syncStatus();
    this.updateTabCounts();
    this.syncTabUi();
    this.renderPlayers();
    this.rebuildMarkers();
    this.syncLayerButtons();
    requestAnimationFrame(() => {
      if (!this.opened) return;
      this.ensureMap();
      this.startMarkerLoop();
      this.closeButton.focus({ preventScroll: true });
    });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.stopMarkerLoop();
    this.map?.destroy();
    this.map = null;
    this.markers = [];
    this.markerEls.clear();
    this.markerHost.replaceChildren();
    this.el.hidden = true;
    this.searchResults.hidden = true;
    this.options.host.classList.remove('map-screen-open');
  }

  destroy(): void {
    this.close();
    this.destroyed = true;
    this.el.remove();
  }

  update(state: PublicState): void {
    this.currentState = state;
    if (!this.opened) return;
    this.statusEl.textContent = this.statusText(state);
    this.updateTabCounts();
    this.renderPlayers();
    this.rebuildMarkers();
    this.map?.setState(state);
    this.map && this.applyNativeLayers();
  }

  private ensureMap(): void {
    if (this.map || this.destroyed) return;
    const state = this.currentState;
    if (!state) return;
    const map = new MapView(this.canvas, this.options.data, this.options.assets);
    map.setReducedMotion(this.options.reducedMotion());
    map.setAutoViewFollow(false);
    map.onCityTap((cityId) => {
      this.searchFocusId = cityId;
      this.rebuildMarkers();
      this.options.openCitySheet(cityId);
    });
    this.map = map;
    map.resize();
    map.setState(state);
    map.setView(this.view);
    this.applyNativeLayers();
    void map.fitWorld(0);
    this.loading.hidden = true;
  }

  private startMarkerLoop(): void {
    this.stopMarkerLoop();
    const tick = (): void => {
      this.raf = requestAnimationFrame(tick);
      this.updateMarkerPositions();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopMarkerLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private updateMarkerPositions(): void {
    const map = this.map;
    if (!map || this.markers.length === 0) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    for (const spec of this.markers) {
      const el = this.markerEls.get(spec.id);
      if (!el) continue;
      const point = map.screenPositionOfNode(spec.nodeId);
      if (!point || point.x < -40 || point.x > width + 40 || point.y < -40 || point.y > height + 40) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      if (el.style.display === 'none') el.style.display = '';
      const x = Math.round(point.x + spec.offsetX);
      const y = Math.round(point.y + spec.offsetY);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }

  private selectRealm(realm: MapViewId): void {
    if (this.view === realm) return;
    this.view = realm;
    this.searchFocusId = null;
    this.syncTabUi();
    this.rebuildMarkers();
    if (!this.map) return;
    this.map.setView(realm);
    void this.map.fitWorld(420);
  }

  private toggleLayer(layer: MapScreenLayer): void {
    this.layers[layer] = !this.layers[layer];
    const button = this.layerButtons.get(layer);
    if (button) button.setAttribute('aria-pressed', String(this.layers[layer]));
    button?.classList.toggle('is-off', !this.layers[layer]);
    this.applyNativeLayers();
    this.rebuildMarkers();
  }

  private syncLayerButtons(): void {
    for (const [key, button] of this.layerButtons) {
      button.setAttribute('aria-pressed', String(this.layers[key]));
      button.classList.toggle('is-off', !this.layers[key]);
    }
  }

  private applyNativeLayers(): void {
    this.map?.setHiddenLayers({
      destination: !this.layers.destination,
      errand: !this.layers.errand,
      cityMods: !this.layers.effects,
      players: !this.layers.players,
    });
  }

  private syncTabUi(): void {
    for (const [id, button] of this.tabButtons) {
      const active = id === this.view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }
  }

  private updateTabCounts(): void {
    const state = this.currentState;
    const counts = new Map<MapViewId, number>();
    if (state) {
      for (const player of state.players) {
        const realm = (nodesById.get(player.nodeId)?.realm ?? 'world') as MapViewId;
        counts.set(realm, (counts.get(realm) ?? 0) + 1);
      }
    }
    for (const [id, button] of this.tabButtons) {
      const badge = button.querySelector('.map-screen-tab-count');
      if (badge) badge.textContent = String(counts.get(id) ?? 0);
    }
  }

  private syncStatus(): void {
    const state = this.currentState;
    this.statusEl.textContent = state ? this.statusText(state) : '';
  }

  private statusText(state: PublicState): string {
    const actor = state.current;
    const player = state.players[actor];
    const name = player ? (player.isCpu ? charsById.get(player.characterId)?.nameJa ?? player.name : player.name) : '';
    return `${state.year}年目 ${state.month}月 ・ 手番: ${name}`;
  }

  private renderPlayers(): void {
    const state = this.currentState;
    this.playersHost.replaceChildren();
    if (!state) return;
    const my = new Set(this.options.myPlayerIds());
    for (const player of state.players) {
      const character = charsById.get(player.characterId);
      const node = nodesById.get(player.nodeId);
      const realm = node?.realm ?? 'world';
      const isMine = my.has(player.id);
      const isActor = player.id === state.current;
      const row = h(
        'button',
        {
          class: `map-screen-player ${isMine ? 'is-mine' : ''} ${isActor ? 'is-current' : ''}`.trim(),
          attrs: {
            type: 'button',
            style: `--seat-color:${seatColor(player.id)}`,
            'aria-label': `${displayPlayerName(player)} のコマへ移動。${realmLabel(realm)}`,
          },
          on: { click: () => this.jumpToPlayer(player.id) },
        },
        h('span', { class: 'map-screen-player-face' }, h('img', {
          attrs: { src: characterSprite(character), alt: '', draggable: 'false' },
        })),
        h(
          'span',
          { class: 'map-screen-player-main' },
          h('strong', { text: displayPlayerName(player) }),
          h('span', { class: 'map-screen-player-pos', text: `${REALM_ICON[realm]} ${realmLabel(realm)}${isActor ? ' ・ 手番' : ''}` }),
        ),
        h('span', { class: 'map-screen-player-go', text: '見る ›' }),
      );
      this.playersHost.append(row);
    }
  }

  private jumpToPlayer(playerId: number): void {
    const state = this.currentState;
    const player = state?.players[playerId];
    const node = player ? nodesById.get(player.nodeId) : undefined;
    if (!node) return;
    const realm = (node.realm ?? 'world') as MapViewId;
    this.view = realm;
    this.searchFocusId = null;
    this.syncTabUi();
    this.rebuildMarkers();
    this.map?.setView(realm);
    void this.map?.focusNode(node.id, { zoom: realm === 'world' ? 1.15 : 1, ms: 480 });
  }

  private jumpToCity(city: City): void {
    const nodeId = cityNodeId(city.id);
    const node = nodesById.get(nodeId);
    if (!node) return;
    const realm = (node.realm ?? 'world') as MapViewId;
    this.view = realm;
    this.searchFocusId = city.id;
    this.syncTabUi();
    this.rebuildMarkers();
    this.map?.setView(realm);
    void this.map?.focusNode(nodeId, { zoom: 1.35, ms: 480 });
  }

  private renderSearchResults(): void {
    const query = this.searchInput.value;
    const results = filterCities(this.options.data.cities, query, 8);
    this.searchResults.replaceChildren();
    if (results.length === 0) {
      this.searchResults.hidden = true;
      return;
    }
    for (const city of results) {
      this.searchResults.append(
        h(
          'button',
          {
            class: 'map-screen-search-result',
            attrs: { type: 'button' },
            on: {
              click: () => {
                this.searchResults.hidden = true;
                this.jumpToCity(city);
              },
            },
          },
          h('span', { class: 'map-screen-search-name', text: city.nameJa }),
          h('span', { class: 'map-screen-search-sub', text: `${city.countryJa} ・ ${city.nameEn}` }),
        ),
      );
    }
    this.searchResults.hidden = false;
  }

  private rebuildMarkers(): void {
    const state = this.currentState;
    this.markers = [];
    this.markerEls.clear();
    this.markerHost.replaceChildren();
    if (!state) return;
    const specs: MarkerSpec[] = [];
    const my = new Set(this.options.myPlayerIds());
    const groups = groupCityOwners(state.owner, this.cityByProperty);
    for (const group of groups) {
      const mine = group.owners.filter((owner) => my.has(owner.playerId));
      const rivals = group.owners.filter((owner) => !my.has(owner.playerId));
      const city = citiesById.get(group.cityId);
      const name = city?.nameJa ?? group.cityId;
      const nodeId = cityNodeId(group.cityId);
      if (this.layers.own && mine.length > 0) {
        const count = mine.reduce((sum, owner) => sum + owner.count, 0);
        specs.push({
          id: `own:${group.cityId}`,
          nodeId,
          icon: '🏠',
          count,
          tone: 'mine',
          color: '#ffd23f',
          offsetX: -22,
          offsetY: -20,
          label: `自分の物件: ${name} ${count}件`,
        });
      }
      if (this.layers.rival && rivals.length > 0) {
        const count = rivals.reduce((sum, owner) => sum + owner.count, 0);
        const top = rivals[0];
        specs.push({
          id: `rival:${group.cityId}`,
          nodeId,
          icon: '🏢',
          count,
          tone: 'rival',
          color: seatColor(top.playerId),
          offsetX: 22,
          offsetY: -20,
          label: `ライバルの物件: ${name} ${count}件（${rivals
            .map((owner) => this.playerName(owner.playerId))
            .join('・')}）`,
        });
      }
    }
    if (this.searchFocusId) {
      const node = nodesById.get(cityNodeId(this.searchFocusId));
      if (node) {
        specs.push({
          id: `focus:${this.searchFocusId}`,
          nodeId: node.id,
          icon: '📍',
          count: null,
          tone: 'focus',
          color: '#7ff0d4',
          offsetX: 0,
          offsetY: -52,
          label: citiesById.get(this.searchFocusId)?.nameJa ?? this.searchFocusId,
        });
      }
    }
    for (const spec of specs) {
      const marker = h(
        'div',
        { class: `map-screen-marker is-${spec.tone}`, attrs: { title: spec.label } },
        h(
          'span',
          { class: 'map-screen-marker-pill', attrs: { style: `--marker-color:${spec.color}` } },
          h('span', { class: 'map-screen-marker-icon', text: spec.icon }),
          spec.count !== null ? h('span', { class: 'map-screen-marker-count', text: String(spec.count) }) : null,
        ),
      );
      marker.style.display = 'none';
      marker.style.transform = 'translate(-100px, -100px)';
      this.markerHost.append(marker);
      this.markerEls.set(spec.id, marker);
      this.markers.push(spec);
    }
    this.updateMarkerPositions();
  }

  private playerName(playerId: number): string {
    const player = this.currentState?.players[playerId];
    if (!player) return `プレイヤー${playerId + 1}`;
    return displayPlayerName(player);
  }
}