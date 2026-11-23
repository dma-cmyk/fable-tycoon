/** Client-only preferences: presentation speed, chat visibility, per-seat mute. */

export type FxSpeed = 1 | 2 | 4 | 8;

export interface UiSettings {
  fxSpeed: FxSpeed;
  autoAdvance: boolean;
  showChat: boolean;
  /** Prefer calmer UI motion. OS prefers-reduced-motion is honored on top of this. */
  reducedMotion: boolean;
}

export interface MuteFlags {
  chat: boolean;
  emote: boolean;
  voice: boolean;
}

const SETTINGS_KEY = 'fable.ui.settings';
const NAME_KEY = 'fable.player.name';
const MUTE_PREFIX = 'fable.mute.';

const DEFAULT_SETTINGS: UiSettings = {
  fxSpeed: 1,
  autoAdvance: true,
  showChat: true,
  reducedMotion: false,
};

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function readUiSettings(): UiSettings {
  const raw = readJson(SETTINGS_KEY);
  const out: UiSettings = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (record.fxSpeed === 2 || record.fxSpeed === 4 || record.fxSpeed === 8 || record.fxSpeed === 1) {
      out.fxSpeed = record.fxSpeed;
    }
    if (typeof record.autoAdvance === 'boolean') out.autoAdvance = record.autoAdvance;
    if (typeof record.showChat === 'boolean') out.showChat = record.showChat;
    if (typeof record.reducedMotion === 'boolean') out.reducedMotion = record.reducedMotion;
  }
  return out;
}

let cachedSettings: UiSettings | null = null;

export function uiSettings(): UiSettings {
  cachedSettings ??= readUiSettings();
  return cachedSettings;
}

export function saveUiSettings(patch: Partial<UiSettings>): UiSettings {
  const next = { ...uiSettings(), ...patch };
  cachedSettings = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled */
  }
  return next;
}

export function readSavedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function readMute(roomId: string, seat: number): MuteFlags {
  const raw = readJson(`${MUTE_PREFIX}${roomId}.${seat}`);
  const out: MuteFlags = { chat: false, emote: false, voice: false };
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (record.chat === true) out.chat = true;
    if (record.emote === true) out.emote = true;
    if (record.voice === true) out.voice = true;
  }
  return out;
}

export function writeMute(roomId: string, seat: number, flags: MuteFlags): void {
  try {
    localStorage.setItem(`${MUTE_PREFIX}${roomId}.${seat}`, JSON.stringify(flags));
  } catch {
    /* ignore */
  }
}

/** `?speed=8` is used by automated playtests; accepted values 1/2/4/8. */
export function urlFxSpeed(): FxSpeed | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('speed');
  if (!raw) return null;
  const value = Number(raw);
  return value === 1 || value === 2 || value === 4 || value === 8 ? value : null;
}

export function effectiveFxSpeed(): FxSpeed {
  return urlFxSpeed() ?? uiSettings().fxSpeed;
}

export function effectiveUiSettings(): UiSettings {
  return { ...uiSettings(), fxSpeed: effectiveFxSpeed() };
}
