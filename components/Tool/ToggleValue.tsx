import React, { useId } from 'react';
import { ArrowLeftRight } from 'lucide-react';

export interface ToggleOption<T extends string> {
  value: T;
  /** The radio's accessible name (today's label, so the control inventory still finds it). */
  label: string;
  /** The words the sentence shows while this option is chosen. */
  text: string;
  /** Read after the name (today's hint line). */
  detail?: string;
}

/**
 * A two-choice setting drawn as its value in the sentence (polish 2026-11-15, item 3): tapping the
 * words switches to the other choice, as Rotate's action words act at once, so it needs no card.
 * Underneath it is today's radio group with today's names and checked state; arrow keys move
 * through it and the focus ring shows on the words.
 */
export function ToggleValue<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: T;
  options: readonly [ToggleOption<T>, ToggleOption<T>];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const current = options.find((option) => option.value === value) ?? options[0];
  const other = options.find((option) => option !== current) ?? options[1];
  return (
    <span role="radiogroup" aria-label={label} className="tk-toggle" data-disabled={disabled ? '' : undefined}>
      {options.map((option) => (
        <React.Fragment key={option.value}>
          <input
            type="radio"
            id={`${id}-${option.value}`}
            name={id}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
            disabled={disabled}
            aria-label={option.label}
            aria-describedby={option.detail ? `${id}-${option.value}-detail` : undefined}
            className="sr-only"
          />
          {option.detail && <span id={`${id}-${option.value}-detail`} className="sr-only">{option.detail}</span>}
        </React.Fragment>
      ))}
      {/* The words: a tap picks the other radio. Hidden from assistive technology, which uses the radios. */}
      <label htmlFor={`${id}-${other.value}`} aria-hidden className="tk-word tk-word-toggle chef-pressable">
        <ArrowLeftRight aria-hidden size={15} strokeWidth={2} />
        <span>{current.text}</span>
      </label>
    </span>
  );
}
