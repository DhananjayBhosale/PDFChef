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
  className?: string;
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
  zoom, onZoomIn, onZoomOut, onReset, min = 0.5, max = 2.0, className = ''
}) => {
  useI18n();
  return (
    <div
      className={`inline-flex w-fit max-w-full items-center rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-0.5 ${className}`}
    >
      <button
        type="button"
        onClick={onZoomOut}
        disabled={zoom <= min}
        className={controlClass}
        aria-label={t("zoom-controls.zoom.out.bc7b63")}
      >
        <Minus aria-hidden size={18} />
      </button>

      <span className="tabular w-11 text-center text-xs font-semibold text-[var(--text-primary)] select-none">
        {formatPercent(Math.round(zoom * 100))}
      </span>

      <button
        type="button"
        onClick={onZoomIn}
        disabled={zoom >= max}
        className={controlClass}
        aria-label={t("zoom-controls.zoom.in.0e47f0")}
      >
        <Plus aria-hidden size={18} />
      </button>

      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border-hairline)]" />

      <button
        type="button"
        onClick={onReset}
        disabled={zoom === 1}
        className={controlClass}
        aria-label={t("zoom-controls.reset.zoom.to.100.39cdc8")}
      >
        <RotateCcw aria-hidden size={16} />
      </button>
    </div>
  );
};
