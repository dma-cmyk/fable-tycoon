/** ふりがな付きの名前表示。地名は <ruby>名<rt>かな</rt></ruby> で組む。 */
import { h } from './dom';

/** 漢字（々 と CJK 統合漢字）。読みがあってもカタカナ名には付けない保険。 */
const KANJI = /[\u3005\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 名前とひらがな読みから表示要素を作る。読みが無い・名前と同一・漢字を含まない
 * 場合は ruby にせず素の span を返す（呼び出し側は常に要素として扱える）。
 */
export function rubyName(name: string, kana?: string): HTMLElement {
  const reading = kana?.trim();
  if (!reading || reading === name || !KANJI.test(name)) {
    return h('span', { class: 'ruby-name is-plain', text: name });
  }
  return h('ruby', { class: 'ruby-name' }, name, h('rt', { text: reading }));
}