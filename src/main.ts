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
import { App } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app が見つかりません');

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