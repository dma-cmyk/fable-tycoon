import type { Session } from '../../net/session-types';
import type { Report } from '../../net/protocol';
import { avatar, h, type ModalHost, type ToastHost } from '../dom';
import { characterSprite, charsById } from '../format';
import type { MuteFlags } from '../settings';

export interface PlayerMenuOptions {
  modal: ModalHost;
  toasts: ToastHost;
  session: Session;
  seat: number;
  name: string;
  characterId: string | null;
  color: string;
  canReport: boolean;
  flagged?: boolean;
  flags: MuteFlags;
  onMute: (flags: MuteFlags) => void;
}

const REPORT_REASONS: { reason: Report['reason']; label: string; desc: string }[] = [
  { reason: 'spam', label: 'スパム', desc: '連投・宣伝・意味のない繰り返し' },
  { reason: 'abuse', label: '不快な言動', desc: '暴言・嫌がらせ・差別的な表現' },
  { reason: 'cheat', label: '不正', desc: '外部ツール・妨害行為' },
  { reason: 'other', label: 'その他', desc: '上記に当てはまらない問題' },
];

export function openPlayerMenu(options: PlayerMenuOptions): void {
  const flags: MuteFlags = { ...options.flags };
  let reportMode = false;

  const statusNote = h('p', { class: 'player-menu-note' });
  const updateNote = (): void => {
    const muted = [flags.chat ? 'チャット' : '', flags.emote ? 'エモート' : '', flags.voice ? 'ボイス' : '']
      .filter(Boolean)
      .join('・');
    statusNote.textContent = muted ? `${muted} をミュート中。設定はこの端末に保存されます。` : 'ミュートはこの端末だけに適用されます。';
  };
  updateNote();

  const muteRows = h('div', { class: 'player-menu-mutes' });
  if (options.flagged) {
    muteRows.append(
      h('p', { class: 'player-menu-flagged', text: '🚩 複数の通報により、この席は自動ミュートされています（再接続後も維持）。' }),
    );
  }
  const muteDefs: { key: keyof MuteFlags; icon: string; label: string; desc: string }[] = [
    { key: 'chat', icon: '💬', label: 'チャット', desc: '吹き出しとログを表示しない' },
    { key: 'emote', icon: '😆', label: 'エモート', desc: 'アニメと台詞を表示しない' },
    { key: 'voice', icon: '🗣️', label: 'ボイス', desc: 'この席の声を再生しない' },
  ];
  for (const def of muteDefs) {
    const toggle = h('button', {
      class: 'toggle',
      attrs: {
        type: 'button',
        role: 'switch',
        'aria-pressed': String(options.flagged ? true : flags[def.key]),
        'aria-label': `${def.label}をミュート`,
        ...(options.flagged ? { disabled: 'disabled' } : {}),
      },
      on: {
        click: () => {
          flags[def.key] = !flags[def.key];
          toggle.setAttribute('aria-pressed', String(flags[def.key]));
          options.onMute({ ...flags });
          updateNote();
        },
      },
    });
    muteRows.append(
      h(
        'div',
        { class: 'player-menu-row' },
        h('span', { class: 'player-menu-icon', text: def.icon, attrs: { 'aria-hidden': 'true' } }),
        h(
          'span',
          { class: 'player-menu-text' },
          h('span', { class: 'player-menu-label', text: def.label }),
          h('span', { class: 'player-menu-desc', text: def.desc }),
        ),
        toggle,
      ),
    );
  }

  const reportHost = h('div', { class: 'player-report-host' });
  const reportButton = options.canReport
    ? h('button', {
        class: 'btn btn-red player-report-btn',
        text: '🚩 通報する',
        attrs: { type: 'button' },
        on: {
          click: () => {
            reportMode = true;
            renderReportReasons();
          },
        },
      })
    : null;

  const renderReportReasons = (): void => {
    reportHost.replaceChildren();
    if (!reportMode) return;
    reportHost.append(
      h('h3', { class: 'player-menu-subhead', text: '通報の理由' }),
      h('p', {
        class: 'player-menu-note',
        text: '通報内容には、この席の直近のチャット 10 件と時刻がサーバーに保存されます。',
      }),
    );
    for (const reason of REPORT_REASONS) {
      reportHost.append(
        h(
          'button',
          {
            class: 'player-report-reason',
            attrs: { type: 'button' },
            on: {
              click: () => {
                options.session.send({ t: 'report', seat: options.seat, reason: reason.reason });
                options.toasts.show(`${options.name} を通報しました`, 'warn', 3200);
                handle.close();
              },
            },
          },
          h('span', { class: 'player-report-reason-label', text: reason.label }),
          h('span', { class: 'player-report-reason-desc', text: reason.desc }),
        ),
      );
    }
    reportHost.append(
      h('button', {
        class: 'btn btn-ghost btn-small',
        text: 'やめる',
        attrs: { type: 'button' },
        on: {
          click: () => {
            reportMode = false;
            reportHost.replaceChildren();
          },
        },
      }),
    );
  };

  const body = h(
    'div',
    { class: 'player-menu' },
    h(
      'div',
      { class: 'player-menu-head' },
      avatar(characterSprite(options.characterId ? charsById.get(options.characterId) : undefined), options.color, 56),
      h(
        'div',
        { class: 'player-menu-head-text' },
        h('strong', { text: options.name }),
        h('span', {
          class: 'muted',
          text: options.characterId ? charsById.get(options.characterId)?.nameJa ?? '' : 'キャラクター未選択',
        }),
      ),
    ),
    h('h3', { class: 'player-menu-subhead', text: 'ミュート' }),
    muteRows,
    statusNote,
    reportButton ? h('div', { class: 'divider' }) : null,
    reportButton,
    reportHost,
  );

  const handle = options.modal.open(body, {
    title: `${options.name} のメニュー`,
    subtitle: 'ミュートと通報',
    className: 'player-menu-modal',
  });
}

export interface PlayerView {
  seat: number;
  name: string;
  characterId: string | null;
  color: string;
  cash: number;
  income: number;
  net: number;
  rank: number;
  isCurrent: boolean;
  isCpu: boolean;
  flagged?: boolean;
  connected: boolean | null;
  autoplay: boolean;
  piperLevel: number | null;
  cashText: string;
  incomeText: string;
  netText: string;
  negativeCash: boolean;
}

export interface PlayerRosterOptions {
  modal: ModalHost;
  title: string;
  rows: PlayerView[];
  onMenu: (seat: number) => void;
  onClose?: () => void;
}

export function openPlayerRoster(options: PlayerRosterOptions): void {
  const list = h('div', { class: 'roster-list' });
  for (const row of options.rows) {
    list.append(
      h(
        'div',
        { class: `roster-row ${row.isCurrent ? 'is-current' : ''}`.trim() },
        h('span', { class: `roster-rank rank-${row.rank}` }, h('span', { text: `${row.rank}` })),
        avatar(characterSprite(row.characterId ? charsById.get(row.characterId) : undefined), row.color, 46),
        h(
          'div',
          { class: 'roster-main' },
          h(
            'div',
            { class: 'roster-name-line' },
            h('strong', { class: 'roster-name', text: row.name }),
            row.isCpu ? h('span', { class: 'badge', text: 'CPU' }) : null,
            row.isCurrent ? h('span', { class: 'badge badge-gold', text: '手番' }) : null,
            row.piperLevel ? h('span', { class: 'badge badge-red', text: `🎺 Lv${row.piperLevel}` }) : null,
            row.connected === false ? h('span', { class: 'badge', text: '切断' }) : null,
            row.autoplay ? h('span', { class: 'badge', text: 'CPU代行' }) : null,
            row.flagged ? h('span', { class: 'badge badge-red', text: '🚩 自動ミュート' }) : null,
          ),
          h(
            'div',
            { class: 'roster-stats' },
            h('span', { class: 'roster-stat' }, h('span', { class: 'muted', text: '所持金 ' }), h('strong', { class: row.negativeCash ? 'money-negative' : '', text: row.cashText })),
            h('span', { class: 'roster-stat' }, h('span', { class: 'muted', text: '収益 ' }), h('strong', { text: row.incomeText })),
            h('span', { class: 'roster-stat' }, h('span', { class: 'muted', text: '総資産 ' }), h('strong', { text: row.netText })),
          ),
        ),
        h('button', {
          class: 'roster-menu-btn',
          text: '…',
          attrs: { type: 'button', 'aria-label': `${row.name} のメニュー` },
          on: {
            click: () => {
              handle.close();
              options.onMenu(row.seat);
            },
          },
        }),
      ),
    );
  }

  const handle = options.modal.open(list, {
    title: options.title,
    subtitle: 'タップで詳細、右の「…」でミュート・通報',
    className: 'roster-modal',
    onClose: options.onClose,
  });
}