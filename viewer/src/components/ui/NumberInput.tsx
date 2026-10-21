import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { decimalPlacesForStep, numberFromDrag } from './numberPrecision';

type NumberInputProps = {
  label: ReactNode;
  value: number;
  step: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  log?: boolean;
  format?: (value: number) => string;
  title?: string;
  inputRef?: RefObject<HTMLInputElement>;
};

export function NumberInput({
  label, value, step, onChange, min, max, unit, disabled, log, format, title, inputRef
}: NumberInputProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const cancelEdit = useRef(false);
  const suppressClick = useRef(false);
  const gesture = useRef<{ pointerId: number; x: number; value: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const decimals = decimalPlacesForStep(step);
  const text = format ? format(value) : value.toFixed(decimals);

  return (
    <span
      className="scrub__number"
      data-dragging={dragging || undefined}
      data-editing={draft !== null || undefined}
      data-disabled={disabled || undefined}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0 || document.activeElement === ref.current) return;
        // Defer focus until release so dragging never selects text or starts an edit.
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        suppressClick.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
        gesture.current = { pointerId: e.pointerId, x: e.clientX, value, moved: false };
      }}
      onPointerMove={(e) => {
        const current = gesture.current;
        if (!current || current.pointerId !== e.pointerId) return;
        const deltaX = e.clientX - current.x;
        if (!current.moved && Math.abs(deltaX) < 4) return;
        current.moved = true;
        setDragging(true);
        const next = numberFromDrag(current.value, deltaX, step, { min, max, log });
        if (next !== value) onChange(next);
      }}
      onPointerUp={(e) => {
        const current = gesture.current;
        if (!current || current.pointerId !== e.pointerId) return;
        gesture.current = null;
        suppressClick.current = current.moved;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (!current.moved) ref.current?.focus();
      }}
      onPointerCancel={() => { gesture.current = null; setDragging(false); }}
      onLostPointerCapture={() => { gesture.current = null; setDragging(false); }}
      onClick={(e) => {
        // A completed drag must not activate the surrounding field label and focus the input.
        if (suppressClick.current) {
          e.preventDefault();
          suppressClick.current = false;
        }
      }}
    >
      <input
        ref={ref}
        className="scrub__input mono"
        aria-label={typeof label === 'string' ? label : undefined}
        title={title}
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? text}
        onFocus={(e) => {
          const input = e.currentTarget;
          cancelEdit.current = false;
          // Update formatted text before selecting so typing replaces the entire raw value.
          flushSync(() => setDraft(format ? String(value) : value.toFixed(decimals)));
          input.select();
        }}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => {
          const raw = e.currentTarget.value.trim();
          const parsed = Number(raw);
          if (!cancelEdit.current && raw !== '' && Number.isFinite(parsed) && parsed !== value) onChange(parsed);
          cancelEdit.current = false;
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.stopPropagation();
            cancelEdit.current = e.key === 'Escape';
            e.currentTarget.blur();
          }
        }}
      />
      {unit && <small className="scrub__unit">{unit}</small>}
    </span>
  );
}

export function NumberField(props: NumberInputProps) {
  return (
    <label className="number-field" data-disabled={props.disabled || undefined}>
      <span className="field-label">{props.label}</span>
      <NumberInput {...props} />
    </label>
  );
}
