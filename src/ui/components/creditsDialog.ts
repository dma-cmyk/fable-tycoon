import { h, type ModalHost } from '../dom';
import {
  CREDITS_NOTE,
  MUSIC_CREDITS,
  SFX_CREDIT,
  VOICE_CREDITS,
} from '../credits';

export function openCreditsDialog(modal: ModalHost): void {
  const speakers = h('ul', { class: 'credits-list' });
  for (const speaker of VOICE_CREDITS.speakers) speakers.append(h('li', { text: speaker }));

  const music = h('ul', { class: 'credits-music' });
  for (const track of MUSIC_CREDITS) {
    music.append(
      h(
        'li',
        {},
        h('span', { class: 'credits-track', text: `「${track.title}」` }),
        h('span', { class: 'credits-artist', text: track.artist }),
        h(
          'span',
          { class: 'credits-license' },
          ' / ',
          h('a', {
            text: track.license,
            attrs: { href: track.licenseUrl, target: '_blank', rel: 'noopener noreferrer' },
          }),
          ' / ',
          h('a', {
            text: '出典',
            attrs: { href: track.sourceUrl, target: '_blank', rel: 'noopener noreferrer' },
          }),
        ),
      ),
    );
  }

  const body = h(
    'div',
    { class: 'modal-copy credits-copy' },
    h('h3', { text: '音声' }),
    h(
      'p',
      {},
      '音声合成: ',
      h('a', {
        text: 'VOICEVOX',
        attrs: { href: VOICE_CREDITS.engineUrl, target: '_blank', rel: 'noopener noreferrer' },
      }),
      '（本作で使用している話者）',
    ),
    speakers,
    h('p', { class: 'credits-note', text: VOICE_CREDITS.note }),
    h('h3', { text: '効果音' }),
    h('p', { text: SFX_CREDIT.text }),
    h('h3', { text: 'BGM' }),
    h('p', {
      text: 'BGM は Kevin MacLeod (incompetech.com) の楽曲を Creative Commons: By Attribution 4.0 License で使用しています。',
    }),
    music,
    h('p', { class: 'credits-note', text: CREDITS_NOTE }),
    h('h3', { text: '制作' }),
    h('p', { text: 'グローバル寓話大富豪 〜世界童話経済すごろく〜' }),
    h('p', { text: '本作はフィクションです。実在の人物・団体・国家への批判や推奨を目的とするものではありません。' }),
  );

  modal.open(body, { title: 'クレジット', subtitle: '音声・音楽・素材の出典', className: 'modal-wide credits-modal' });
}