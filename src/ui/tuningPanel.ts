/**
 * In-app 内测面板 (internal test panel).
 *
 * Hidden behind a passphrase so ordinary players never trip over it, but it
 * edits every number in `tuning.ts` live: fire rate, heat, damage, hull speed,
 * respawn timers and pickup cooldowns. Non-default values are labelled in the
 * HUD and travel with the room config, so LAN matches stay fair.
 *
 * The panel is plain DOM: it lives inside the menu card and repaints itself,
 * never the whole screen.
 */

import {
  TUNING_DEFAULTS,
  TUNING_GROUPS,
  TUNING_SPEC,
  exportTuning,
  importTuning,
  isTuningUnlocked,
  lockTuning,
  resetTuning,
  setTuningValue,
  tuning,
  tuningDiff,
  tuningIsCustom,
  unlockTuning,
  type Tuning,
  type TuningGroup,
} from '../game/tuning';
import { heatCfg, shotsToOverheat } from '../game/heat';

/** One-line summary used by the badge: what a full burst looks like now. */
function balanceSummary(): string {
  const cfg = heatCfg();
  const t = tuning();
  const shots = shotsToOverheat(cfg);
  const burst = (shots - 1) * t.fireCooldown;
  return `连打 ${shots} 发锁炮 · 约 ${burst.toFixed(1)} 秒 · 每秒 ${(1 / t.fireCooldown).toFixed(1)} 发`;
}

function valueLabel(key: keyof Tuning, value: number): string {
  const spec = TUNING_SPEC.find((entry) => entry.key === key);
  const digits = spec && spec.step < 1 ? (spec.step < 0.1 ? 2 : 1) : 0;
  return `${value.toFixed(digits)}${spec?.unit ?? ''}`;
}

function rowHtml(group: TuningGroup): string {
  const values = tuning();
  return TUNING_SPEC.filter((spec) => spec.group === group)
    .map((spec) => {
      const value = values[spec.key];
      const changed = Math.abs(value - TUNING_DEFAULTS[spec.key]) > 1e-9;
      return `
        <label class="tune-row${changed ? ' is-changed' : ''}" data-key="${spec.key}">
          <span class="tune-name">${spec.label}${spec.hint ? `<i>${spec.hint}</i>` : ''}</span>
          <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${value}"
                 data-tune="${spec.key}" aria-label="${spec.label}" />
          <span class="tune-value" data-tune-value="${spec.key}">${valueLabel(spec.key, value)}</span>
        </label>`;
    })
    .join('');
}

function controlsHtml(): string {
  return TUNING_GROUPS.map(
    (group) => `
      <div class="tune-group">
        <div class="tune-group-title">${group}</div>
        ${rowHtml(group)}
      </div>`
  ).join('');
}

/** The whole panel. `readOnly` is used for LAN guests (the host owns balance). */
export function tuningPanelHtml(readOnly = false): string {
  const unlocked = isTuningUnlocked();
  const custom = tuningIsCustom();
  return `
    <div class="tuning-panel${unlocked ? ' unlocked' : ''}" id="tuning-panel">
      <div class="tuning-head">
        <span class="tuning-title">内测参数</span>
        <span class="tuning-badge ${custom ? 'on' : ''}" id="tuning-badge">
          ${custom ? `已改动 ${tuningDiff().length} 项` : '官方数值'}
        </span>
        <button type="button" class="chip ghost" id="tuning-toggle">${unlocked ? '收起' : '展开'}</button>
      </div>
      <div class="tuning-body" id="tuning-body" ${unlocked ? '' : 'hidden'}>
        <p class="tune-summary" id="tune-summary">${balanceSummary()}</p>
        ${
          readOnly
            ? `<p class="tune-hint">联机时数值由房主决定，你这边只读。</p>`
            : `<div class="tune-lock" id="tune-lock">
                 <input type="password" id="tune-pass" placeholder="内测密码" autocomplete="off" />
                 <button type="button" class="chip" id="tune-unlock">解锁</button>
                 <span class="tune-error" id="tune-error"></span>
               </div>`
        }
        <div class="tune-controls" id="tune-controls" ${readOnly ? 'data-readonly="1"' : ''}>
          ${controlsHtml()}
        </div>
        <div class="tune-actions">
          <button type="button" class="chip" id="tune-reset">恢复默认</button>
          <button type="button" class="chip" id="tune-export">导出参数</button>
          <button type="button" class="chip" id="tune-import">导入参数</button>
          <button type="button" class="chip ghost" id="tune-lock-again">重新锁定</button>
        </div>
        <p class="tune-hint">
          改动立刻生效（下一局开始套用）。非官方数值会显示在 HUD 上，联机时会随房间同步给所有人。
        </p>
      </div>
    </div>`;
}

/** Wires the panel up. `onChange` runs once per committed value (not per pixel). */
export function bindTuningPanel(root: HTMLElement, onChange: () => void = () => {}): void {
  const panel = root.querySelector<HTMLElement>('#tuning-panel');
  if (!panel) return;

  const body = root.querySelector<HTMLElement>('#tuning-body');
  const toggle = root.querySelector<HTMLButtonElement>('#tuning-toggle');
  const badge = root.querySelector<HTMLElement>('#tuning-badge');
  const summary = root.querySelector<HTMLElement>('#tune-summary');
  const controls = root.querySelector<HTMLElement>('#tune-controls');
  const readOnly = controls?.dataset.readonly === '1';

  const refreshMeta = (): void => {
    const custom = tuningIsCustom();
    if (badge) {
      badge.textContent = custom ? `已改动 ${tuningDiff().length} 项` : '官方数值';
      badge.classList.toggle('on', custom);
    }
    if (summary) summary.textContent = balanceSummary();
  };

  // Opening the panel: locked panels show the passphrase box, unlocked show knobs.
  const open = (): void => {
    if (!body) return;
    body.hidden = false;
    if (toggle) toggle.textContent = '收起';
    if (!body.querySelector('#tune-pass')) panel.classList.add('unlocked');
  };

  toggle?.addEventListener('click', () => {
    if (!body) return;
    if (body.hidden) open();
    else {
      body.hidden = true;
      if (toggle) toggle.textContent = '展开';
    }
  });

  // If it arrives already unlocked (remembered on this machine) show it open.
  if (body && !body.hidden) open();

  const applyValue = (key: keyof Tuning, value: number): void => {
    setTuningValue(key, value);
    const out = root.querySelector<HTMLElement>(`[data-tune-value="${key}"]`);
    if (out) out.textContent = valueLabel(key, tuning()[key]);
    const row = root.querySelector<HTMLElement>(`[data-key="${key}"]`);
    row?.classList.toggle('is-changed', Math.abs(tuning()[key] - TUNING_DEFAULTS[key]) > 1e-9);
    refreshMeta();
  };

  controls?.querySelectorAll<HTMLInputElement>('input[data-tune]').forEach((input) => {
    const key = input.dataset.tune as keyof Tuning;
    if (readOnly) {
      input.disabled = true;
      return;
    }
    // Live readout while dragging, commit on release.
    input.addEventListener('input', () => {
      const out = root.querySelector<HTMLElement>(`[data-tune-value="${key}"]`);
      if (out) out.textContent = valueLabel(key, Number(input.value));
      if (summary) summary.textContent = balanceSummary();
    });
    input.addEventListener('change', () => {
      applyValue(key, Number(input.value));
      onChange();
    });
  });

  root.querySelector<HTMLButtonElement>('#tune-unlock')?.addEventListener('click', () => {
    const pass = root.querySelector<HTMLInputElement>('#tune-pass');
    const error = root.querySelector<HTMLElement>('#tune-error');
    const ok = unlockTuning(pass?.value ?? '');
    if (!ok) {
      if (error) error.textContent = '密码不对';
      return;
    }
    if (error) error.textContent = '';
    open();
  });

  root.querySelector<HTMLInputElement>('#tune-pass')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      root.querySelector<HTMLButtonElement>('#tune-unlock')?.click();
    }
  });

  root.querySelector<HTMLButtonElement>('#tune-reset')?.addEventListener('click', () => {
    resetTuning();
    // Repaint the panel in place with the defaults.
    if (controls) controls.innerHTML = controlsHtml();
    bindTuningPanel(root, onChange);
    refreshMeta();
    onChange();
  });

  root.querySelector<HTMLButtonElement>('#tune-lock-again')?.addEventListener('click', () => {
    lockTuning();
    if (body) body.hidden = true;
    if (toggle) toggle.textContent = '展开';
    onChange();
  });

  root.querySelector<HTMLButtonElement>('#tune-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(exportTuning(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tankgame-tuning.json';
    link.click();
    URL.revokeObjectURL(url);
  });

  root.querySelector<HTMLButtonElement>('#tune-import')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        if (importTuning(text)) {
          if (controls) controls.innerHTML = controlsHtml();
          bindTuningPanel(root, onChange);
          refreshMeta();
          onChange();
        }
      });
    });
    input.click();
  });
}
