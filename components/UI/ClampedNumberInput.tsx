import React, { useState } from 'react';
import { finalNumberValue, liveNumberValue } from './numberDraft.ts';

interface ClampedNumberInputProps {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  className?: string;
}

/** A number box that lets the user type a full value before it is clamped into range. */
export const ClampedNumberInput: React.FC<ClampedNumberInputProps> = ({ value, min, max, onCommit, className }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = () => {
    if (draft === null) return;
    const next = finalNumberValue(draft, min, max);
    if (next !== null && next !== value) onCommit(next);
    setDraft(null);
  };
  return (
    <input
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
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      className={className}
    />
  );
};
