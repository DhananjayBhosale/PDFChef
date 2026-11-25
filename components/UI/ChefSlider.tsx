import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isConfirmEnter } from './keys';
import { finalNumberValue } from './numberDraft.ts';
import { useCloseEditor, useEditorTitle } from '../Tool/Popover';
import { TapChoices } from '../Tool/parts';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
// Arabic and other right-to-left layouts mirror the slider: the minimum sits on the right.
const isRtl = (element: Element) => getComputedStyle(element).direction === 'rtl';

interface ChefSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /**
   * What one arrow key moves, and PageUp/PageDown (default ten arrows). A fine drag step
   * (0.1%, 0.5°) made a keyboard user press 90 times for 45° (round 6, desktop-06).
   */
  keyStep?: number;
  pageStep?: number;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

interface ChefSliderFieldProps extends ChefSliderProps {
  label: string;
  /** One row: the label, the slider and the value box side by side (a phone card with two sliders). */
  row?: boolean;
  suffix?: string;
  decimals?: number;
  fixedDecimals?: boolean;
  /** Common values offered as taps under the slider while it sits in a slot's editor (phones). */
  presets?: readonly number[];
  /** The visible text of a preset, formatted like the slot's value. */
  presetText?: (value: number) => string;
}

const getPrecision = (step: number) => {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
};

export const ChefSlider: React.FC<ChefSliderProps> = ({
  value,
  min,
  max,
  step = 1,
  keyStep,
  pageStep,
  onChange,
  onChangeEnd,
  ariaLabel,
  disabled = false,
  className,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const dragGeometryRef = useRef<{ left: number; width: number; rtl: boolean } | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingValueRef = useRef<number | null>(null);
  const latestDragValueRef = useRef<number | null>(null);
  const lastEmittedValueRef = useRef<number | null>(null);
  const safeValueRef = useRef(0);
  const getValueFromClientXRef = useRef<(clientX: number) => number>(() => 0);
  const updateFromClientXRef = useRef<(clientX: number) => number>(() => 0);
  const finishDragRef = useRef<(finalValue?: number) => void>(() => undefined);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 1;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const precision = useMemo(() => Math.min(4, Math.max(getPrecision(safeStep) + 1, 2)), [safeStep]);

  const normalize = (raw: number) => {
    const clamped = clamp(raw, safeMin, safeMax);
    return Number(clamped.toFixed(precision));
  };

  const safeValue = normalize(Number.isFinite(value) ? value : safeMin);
  safeValueRef.current = safeValue;
  const visualValue = dragValue ?? safeValue;
  const percent = ((visualValue - safeMin) / (safeMax - safeMin)) * 100;

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const cancelPendingChange = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingValueRef.current = null;
  };

  const scheduleChange = (next: number) => {
    latestDragValueRef.current = next;
    pendingValueRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingValueRef.current;
      pendingValueRef.current = null;
      if (pending !== null) {
        setDragValue(pending);
        lastEmittedValueRef.current = pending;
        onChange(pending);
      }
    });
  };

  const getValueFromClientX = (clientX: number) => {
    const geometry = dragGeometryRef.current;
    if (!geometry || geometry.width <= 0) return safeValueRef.current;
    const fromLeft = clamp((clientX - geometry.left) / geometry.width, 0, 1);
    const ratio = geometry.rtl ? 1 - fromLeft : fromLeft;
    return normalize(safeMin + ratio * (safeMax - safeMin));
  };
  getValueFromClientXRef.current = getValueFromClientX;

  const updateFromClientX = (clientX: number) => {
    const next = getValueFromClientX(clientX);
    scheduleChange(next);
    return next;
  };
  updateFromClientXRef.current = updateFromClientX;

  const finishDrag = (finalValue?: number) => {
    if (pointerIdRef.current === null) return;
    const next = normalize(finalValue ?? latestDragValueRef.current ?? safeValueRef.current);
    pointerIdRef.current = null;
    dragGeometryRef.current = null;
    cancelPendingChange();
    latestDragValueRef.current = null;
    setDragValue(null);
    setIsDragging(false);
    if (lastEmittedValueRef.current !== next) {
      lastEmittedValueRef.current = next;
      onChange(next);
    }
    if (onChangeEnd) {
      onChangeEnd(next);
    }
  };
  finishDragRef.current = finishDrag;

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      updateFromClientXRef.current(event.clientX);
    };

    const handleStop = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      finishDragRef.current(getValueFromClientXRef.current(event.clientX));
    };

    const handleCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      finishDragRef.current();
    };

    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('pointerup', handleStop, { passive: true });
    window.addEventListener('pointercancel', handleCancel, { passive: true });

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleStop);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    event.preventDefault();
    dragGeometryRef.current = { left: rect.left, width: rect.width, rtl: isRtl(event.currentTarget) };
    lastEmittedValueRef.current = null;
    setIsDragging(true);
    pointerIdRef.current = event.pointerId;
    updateFromClientX(event.clientX);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    const rtl = isRtl(event.currentTarget);
    const arrow = keyStep && keyStep > 0 ? keyStep : safeStep;
    const page = pageStep && pageStep > 0 ? pageStep : arrow * 10;
    let next: number | null = null;
    if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || event.key === 'ArrowDown') {
      next = safeValue - arrow;
    } else if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || event.key === 'ArrowUp') {
      next = safeValue + arrow;
    } else if (event.key === 'PageDown') {
      next = safeValue - page;
    } else if (event.key === 'PageUp') {
      next = safeValue + page;
    } else if (event.key === 'Home') {
      next = safeMin;
    } else if (event.key === 'End') {
      next = safeMax;
    }

    if (next === null) return;

    event.preventDefault();
    const normalized = normalize(next);
    onChange(normalized);
    if (onChangeEnd) {
      onChangeEnd(normalized);
    }
  };

  return (
    <div
      ref={rootRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={safeMin}
      aria-valuemax={safeMax}
      aria-valuenow={Math.round(visualValue * 100) / 100}
      aria-disabled={disabled}
      className={`chef-slider ${disabled ? 'is-disabled' : ''} ${isDragging ? 'is-dragging' : ''} ${className ?? ''}`.trim()}
      style={{ '--chef-slider-pct': `${percent}%` } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      <div className="chef-slider__track" />
      <div className="chef-slider__fill" />
      <div className="chef-slider__thumb" />
    </div>
  );
};

export const ChefSliderField: React.FC<ChefSliderFieldProps> = ({
  label,
  suffix = '',
  decimals = 0,
  fixedDecimals = false,
  value,
  min,
  max,
  step = 1,
  keyStep,
  pageStep,
  onChange,
  onChangeEnd,
  ariaLabel,
  disabled = false,
  className,
  presets,
  presetText,
  row = false,
}) => {
  useI18n();
  const format = (next: number) => {
    const fixed = next.toFixed(decimals);
    return fixedDecimals ? fixed : fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  };
  const closeEditor = useCloseEditor();
  // In a card titled with the same word ("Size" over "Size"), the title is the label: the slider
  // and its value share one row (pass 3). The value box keeps its own name.
  const titled = useEditorTitle() === label;
  const [draft, setDraft] = useState(() => format(value));
  // The box holds the person's own text only from their first keystroke until it is applied.
  // Focus alone does not make it theirs: a slot editor focuses the box on open, and a slider
  // dragged after that must not be undone by the box's old text when the editor closes
  // (round 5, mobile-01). Moving the slider drops any typed text, so the last change wins.
  const typed = useRef(false);

  useEffect(() => {
    if (!typed.current) setDraft(format(value));
  }, [value, decimals, fixedDecimals]);

  const commit = () => {
    if (!typed.current) {
      setDraft(format(value));
      return;
    }
    typed.current = false;
    // Kept at the precision the box shows: a typed 12.34 read "12.3" but saved 12.34 (round 6, desktop-10).
    const typedValue = finalNumberValue(draft, min, max);
    const next = typedValue === null ? value : Math.min(max, Math.max(min, Number(typedValue.toFixed(decimals))));
    setDraft(format(next));
    onChange(next);
    onChangeEnd?.(next);
  };

  const slide = (next: number) => {
    typed.current = false;
    onChange(next);
  };

  return (
    <div className={titled ? 'chef-slider-row' : row ? 'chef-slider-row' : 'space-y-0.5'} data-titled={titled ? '' : undefined}>
      <div className={row || titled ? 'contents' : 'flex min-h-8 items-center justify-between gap-3'}>
        {!titled && <span className="text-[0.8125rem] font-semibold text-[var(--text-secondary)]">{label}</span>}
        {/* Drawn as a field (border-strong, primary text) so it reads as one you can type in (round 5, h2-03). */}
        <label className="chef-slider-value chef-hit-y flex h-8 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-[var(--text-primary)] focus-within:border-[var(--accent-rest)] focus-within:ring-1 focus-within:ring-[var(--focus-ring)]">
          <span className="sr-only">{label}</span>
          <input
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={draft}
            disabled={disabled}
            aria-label={t("chef-slider.value.71f9e8", { v0: ariaLabel })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              typed.current = true;
              setDraft(event.target.value);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (isConfirmEnter(event)) {
                event.currentTarget.blur();
                // In a slot editor, Enter applies the value and closes it, as every editor field does
                // (M-02). Prevented, so the same Enter does not press the slot that takes focus back.
                if (closeEditor) {
                  event.preventDefault();
                  closeEditor();
                }
              }
              if (event.key === 'Escape') {
                typed.current = false;
                event.currentTarget.blur();
              }
            }}
            className="tabular w-14 appearance-none bg-transparent text-end text-xs outline-none disabled:opacity-55"
          />
          {suffix ? <span aria-hidden className="ms-0.5 text-xs">{suffix}</span> : null}
        </label>
      </div>
      <ChefSlider
        min={min}
        max={max}
        step={step}
        keyStep={keyStep}
        pageStep={pageStep}
        value={value}
        onChange={slide}
        onChangeEnd={onChangeEnd}
        ariaLabel={ariaLabel}
        disabled={disabled}
        className={`is-compact chef-hit-y ${className ?? ''}`.trim()}
      />
      {closeEditor && presets?.length ? (
        <TapChoices
          label={label}
          values={presets}
          current={value}
          text={presetText ?? ((next) => `${format(next)}${suffix}`)}
          onPick={(next) => {
            typed.current = false;
            setDraft(format(next));
            onChange(next);
            onChangeEnd?.(next);
          }}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
};
