export interface ScreenHandle {
  readonly el: HTMLElement;
  destroy(): void;
}

export type SetupMode = 'solo' | 'hotseat';