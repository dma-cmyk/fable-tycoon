import '@fontsource/m-plus-rounded-1c/400.css';
import '@fontsource/m-plus-rounded-1c/700.css';
import '@fontsource/m-plus-rounded-1c/800.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/components.css';
import './styles/game.css';
import './styles/effects.css';
import './styles/layout-fixes.css';
import './styles/dice.css';
import './styles/messageWindow.css';
import './styles/piper.css';
import './styles/cityMods.css';
import './styles/eventVideo.css';
import './styles/eventArt.css';
import { App } from './ui/app';
import { continueAssetWarmup, loadingLine, startCriticalAssets, type PreloadProgress } from './ui/assetPreload';
import { installImageResilience } from './ui/imageFallback';
import { registerServiceWorker } from './ui/serviceWorker';

const root = document.getElementById('app');
if (!root) throw new Error('#app が見つかりません');

installImageResilience();

// ---------------------------------------------------------------- boot loader
//
// The title only needs the UI icons, logo and key art. Everything else keeps streaming in
// behind the title (see continueAssetWarmup), so the map is ready by the time a local game
// is started and the picker's 48 portraits are decoded before the picker opens.

const bootScreen = document.getElementById('boot-screen');
const bootFill = document.getElementById('boot-fill');
const bootText = document.getElementById('boot-text');
const bootJoke = document.getElementById('boot-joke');
const bootBar = document.getElementById('boot-bar');

const renderBootProgress = (progress: PreloadProgress): void => {
  const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
  if (bootFill) bootFill.style.width = `${Math.max(4, Math.round(ratio * 100))}%`;
  if (bootBar) bootBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (bootText) bootText.textContent = loadingLine(ratio, progress.tier);
  if (bootJoke) bootJoke.textContent = ratio >= 0.999 ? 'まもなく開演です' : '';
};

const removeBootScreen = (): void => {
  bootScreen?.remove();
};

const startTitle = (): void => {
  removeBootScreen();
  const app = new App(root);
  try {
    app.boot();
  } catch (error) {
    root.replaceChildren();
    const message = document.createElement('div');
    message.className = 'boot-screen boot-error';
    message.textContent = `起動できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    root.append(message);
    throw error;
  }
  continueAssetWarmup();
  registerServiceWorker();
};

// Give the boot layer one frame to paint its 4% bar before the first image starts, so slow
// connections see movement instead of a frozen globe.
requestAnimationFrame(() => {
  const started = startCriticalAssets(renderBootProgress);
  // Never block the title longer than the tier actually needs; a hard 2.5 s cap keeps a
  // flaky asset from turning the loader into the product.
  const cap = Promise.withResolvers<void>();
  const timer = window.setTimeout(cap.resolve, 2000);
  void Promise.race([started, cap.promise]).finally(() => {
    window.clearTimeout(timer);
    startTitle();
  });
});