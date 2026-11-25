import { formatPercent } from '../../services/i18n/core.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  min?: number;
  max?: number;
  /** The percentage is itself the reset button, which saves a control on a phone row. */
  compact?: boolean;
  /** Leave focus where it is, so zooming while typing keeps the caret and the keyboard. */
  keepFocus?: boolean;
  className?: string;
  /** No cluster border, for a bar or pill that is already one surface (the reader). */
  bare?: boolean;
  /** 40 px-wide controls for a crowded phone bar. */
  dense?: boolean;
  /** The zoom Reset returns to, when the view starts at another zoom than 100% (Sign on a phone). */
  resetTo?: number;
  /** The reset button's name when it returns to a fitted view rather than 100% (Sign: "Fit page"). */
  resetLabel?: string;
}

/**
 * The reader's zoom cluster, at the Android reader's density.
 *
 * Each control's visual box is 36px tall, which is what makes the cluster a
 * 40px strip rather than the 58px slab a 48px visual box produced. The pressable
 * region still clears the 48px floor, and it is extended only on the vertical
 * axis: these buttons sit shoulder to shoulder, so growing their width would let
 * one steal the next one's edge. Width is held at the floor instead, so every
 * control keeps a separate 48x48 region.
 */
const controlClass =
  'chef-pressable chef-hit-y grid h-9 w-touch shrink-0 place-items-center rounded-[var(--radius-control)] '
  + 'text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-sunken)] disabled:opacity-55';

export const ZoomControls: React.FC<ZoomControlsProps> = ({
  zoom, onZoomIn, onZoomOut, onReset, min = 0.5, max = 2.0, compact = false, keepFocus = false, className = '',
  bare = false, dense = false, resetTo = 1, resetLabel,
}) => {
  const buttonClass = dense ? controlClass.replace('w-touch', 'w-10') : controlClass;
  useI18n();
  const holdFocus = keepFocus ? (event: React.PointerEvent) => event.preventDefault() : undefined;
  const percent = formatPercent(Math.round(zoom * 100));
  return (
    <div
      className={`inline-flex w-fit max-w-full items-center rounded-[var(--radius-field)] ${bare ? '' : 'border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-0.5'} ${className}`}
    >
      <button
        type="button"
        onClick={onZoomOut}
        onPointerDown={holdFocus}
        disabled={zoom <= min}
        className={buttonClass}
        aria-label={t("zoom-controls.zoom.out.bc7b63")}
      >
        <Minus aria-hidden size={18} />
      </button>

      {compact ? (
        // The visible percentage starts the button's name, so a voice command that reads it works.
        <button
          type="button"
          onClick={onReset}
          onPointerDown={holdFocus}
          className="chef-pressable chef-hit-y tabular h-9 min-w-touch shrink-0 rounded-[var(--radius-control)] px-1 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
        >
          {percent}<span className="sr-only">{`, ${resetLabel ?? t("zoom-controls.reset.zoom.to.100.39cdc8")}`}</span>
        </button>
      ) : (
        <span className={`tabular ${dense ? 'w-10' : 'w-11'} text-center text-xs font-semibold text-[var(--text-primary)] select-none`}>
          {percent}
        </span>
      )}

      <button
        type="button"
        onClick={onZoomIn}
        onPointerDown={holdFocus}
        disabled={zoom >= max}
        className={buttonClass}
        aria-label={t("zoom-controls.zoom.in.0e47f0")}
      >
        <Plus aria-hidden size={18} />
      </button>

      {!compact && (
        <>
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border-hairline)]" />

          <button
            type="button"
            onClick={onReset}
            disabled={Math.abs(zoom - resetTo) < 0.001}
            className={buttonClass}
            aria-label={resetLabel ?? t("zoom-controls.reset.zoom.to.100.39cdc8")}
          >
            <RotateCcw aria-hidden size={16} />
          </button>
        </>
      )}
    </div>
  );
};
