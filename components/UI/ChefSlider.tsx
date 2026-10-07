import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface ChefSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

interface ChefSliderFieldProps extends ChefSliderProps {
  label: string;
  suffix?: string;
  decimals?: number;
  fixedDecimals?: boolean;
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
  onChange,
  onChangeEnd,
  ariaLabel,
  disabled = false,
  className,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const dragGeometryRef = useRef<{ left: number; width: number } | null>(null);
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
    const ratio = clamp((clientX - geometry.left) / geometry.width, 0, 1);
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
    dragGeometryRef.current = { left: rect.left, width: rect.width };
    lastEmittedValueRef.current = null;
    setIsDragging(true);
    pointerIdRef.current = event.pointerId;
    updateFromClientX(event.clientX);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = safeValue - safeStep;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = safeValue + safeStep;
    } else if (event.key === 'PageDown') {
      next = safeValue - safeStep * 10;
    } else if (event.key === 'PageUp') {
      next = safeValue + safeStep * 10;
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
  onChange,
  onChangeEnd,
  ariaLabel,
  disabled = false,
  className,
}) => {
  useI18n();
  const format = (next: number) => {
    const fixed = next.toFixed(decimals);
    return fixedDecimals ? fixed : fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  };
  const [draft, setDraft] = useState(() => format(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(format(value));
  }, [value, decimals, fixedDecimals]);

  const commit = () => {
    editing.current = false;
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : value;
    setDraft(format(next));
    onChange(next);
    onChangeEnd?.(next);
  };

  return (
    <div className="space-y-0.5">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">{label}</span>
        <label className="chef-slider-value chef-hit-y flex h-8 items-center rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-[var(--surface-canvas)] px-2 text-[var(--text-secondary)] focus-within:border-[var(--accent-rest)] focus-within:ring-1 focus-within:ring-[var(--focus-ring)]">
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
            onFocus={(event) => {
              editing.current = true;
              event.currentTarget.select();
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraft(format(value));
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
        value={value}
        onChange={onChange}
        onChangeEnd={onChangeEnd}
        ariaLabel={ariaLabel}
        disabled={disabled}
        className={`is-compact chef-hit-y ${className ?? ''}`.trim()}
      />
    </div>
  );
};
