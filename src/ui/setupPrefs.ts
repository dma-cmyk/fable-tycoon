/** Remembered local-setup choices (currently the CPU randomizer). */

export interface SetupPrefs {
  /** Re-roll every CPU character right before a local game starts. */
  randomCpusOnStart: boolean;
}

const SETUP_PREFS_KEY = 'fable.setup.prefs';

const DEFAULT_PREFS: SetupPrefs = {
  randomCpusOnStart: false,
};

export function readSetupPrefs(): SetupPrefs {
  try {
    const raw = localStorage.getItem(SETUP_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };
    const record = parsed as Record<string, unknown>;
    return {
      randomCpusOnStart: record.randomCpusOnStart === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveSetupPrefs(patch: Partial<SetupPrefs>): SetupPrefs {
  const next = { ...readSetupPrefs(), ...patch };
  try {
    localStorage.setItem(SETUP_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled */
  }
  return next;
}