import React, { forwardRef, useState } from 'react';
import { finalNumberValue, liveNumberValue } from './numberDraft.ts';
import { isConfirmEnter } from './keys';

interface ClampedNumberInputProps
  extends Pick<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'step' | 'inputMode' | 'disabled'> {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  className?: string;
}

/** A number box that lets the user type a full value before it is clamped into range. */
export const ClampedNumberInput = forwardRef<HTMLInputElement, ClampedNumberInputProps>(({ value, min, max, onCommit, className, ...field }, ref) => {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = () => {
    if (draft === null) return;
    const next = finalNumberValue(draft, min, max);
    if (next !== null && next !== value) onCommit(next);
    setDraft(null);
  };
  return (
    <input
      {...field}
      ref={ref}
      type="number"
      min={min}
      max={max}
      value={draft ?? value}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = liveNumberValue(event.target.value, min, max);
        if (next !== null && next !== value) onCommit(next);
      }}
      onBlur={finish}
      onKeyDown={(event) => { if (isConfirmEnter(event)) event.currentTarget.blur(); }}
      className={className}
    />
  );
});
ClampedNumberInput.displayName = 'ClampedNumberInput';
