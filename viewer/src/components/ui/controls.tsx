import { useRef, useState, type ReactNode, type KeyboardEvent, type PointerEvent } from 'react';
import {
  Button, ListBox, ListBoxItem, Popover, Select as AriaSelect, SelectValue,
  Switch as AriaSwitch, ToggleButton, ToggleButtonGroup, type Key
} from 'react-aria-components';
import { ChevronDown } from 'lucide-react';

// ------------------------------------------------------------------ Section

export function Section({
  title, icon, value, open, onOpenChange, actions, children
}: {
  title: string;
  icon?: ReactNode;
  /** Right-aligned summary, e.g. a weight. */
  value?: ReactNode;
  /** Omit for a non-collapsible section. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const collapsible = open !== undefined;
  const collapsed = collapsible && !open;
  return (
    <section className="section" data-collapsed={collapsed || undefined}>
      <div className="section__head">
        {collapsible ? (
          <button className="section__trigger" aria-expanded={open} onClick={() => onOpenChange?.(!open)}>
            {icon && <span className="ico">{icon}</span>}
            <strong>{title}</strong>
            {value !== undefined && <span className="val">{value}</span>}
            <span className="toggle-chev"><ChevronDown size={13} /></span>
          </button>
        ) : (
          <>
            {icon && <span className="ico">{icon}</span>}
            <strong>{title}</strong>
            {value !== undefined && <span className="val">{value}</span>}
          </>
        )}
        {actions}
      </div>
      {!collapsed && children && <div className="section__body">{children}</div>}
    </section>
  );
}

// -------------------------------------------------------------------- Scrub

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function Scrub({
  label, value, min, max, step, onChange, unit, disabled, log, format, title
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  unit?: string;
  disabled?: boolean;
  /** Logarithmic mapping, for sample counts. */
  log?: boolean;
  format?: (value: number) => string;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const range = max - min;
  const effectiveStep = step ?? (range >= 50 ? 1 : range >= 5 ? 0.1 : 0.01);
  const decimals = effectiveStep >= 1 ? 0 : effectiveStep >= 0.1 ? 1 : effectiveStep >= 0.01 ? 2 : 3;
  const toT = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / range);
  const fromT = (t: number) => (log ? min * Math.pow(max / min, t) : min + t * range);
  const quantize = (v: number) => Number((Math.round(v / effectiveStep) * effectiveStep).toFixed(decimals));
  const text = format ? format(value) : value.toFixed(decimals);

  const setFromPointer = (event: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const t = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const next = quantize(fromT(t));
    if (next !== value) onChange(log ? Math.round(next) : next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') return setEditing(true);
    const dir = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    event.preventDefault();
    if (log) {
      onChange(clamp(Math.round(value * Math.pow(2, dir * (event.shiftKey ? 2 : 1))), min, max));
    } else {
      onChange(clamp(quantize(value + dir * effectiveStep * (event.shiftKey ? 10 : 1)), min, max));
    }
  };

  if (editing) {
    return (
      <div className="scrub" data-editing>
        <span className="scrub__label">{label}</span>
        <input
          className="scrub__input mono"
          autoFocus
          defaultValue={value.toFixed(decimals)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const parsed = Number(e.currentTarget.value);
            if (Number.isFinite(parsed)) onChange(parsed);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="scrub"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      title={title}
      aria-label={typeof label === 'string' ? label : undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${text}${unit ?? ''}`}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      data-dragging={dragging || undefined}
      style={{ '--p': `${clamp(toT(value), 0, 1) * 100}%` } as React.CSSProperties}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        setFromPointer(e);
      }}
      onPointerMove={(e) => dragging && setFromPointer(e)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => !disabled && setEditing(true)}
      onKeyDown={disabled ? undefined : onKeyDown}
    >
      <div className="scrub__fill" />
      <span className="scrub__label">{label}</span>
      <span className="scrub__value">{text}{unit && <small>{unit}</small>}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Segmented

export function Segmented<T extends string>({
  value, options, onChange, label, disabled
}: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <ToggleButtonGroup
      className="seg"
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      isDisabled={disabled}
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const next = [...keys][0] as T | undefined;
        if (next !== undefined) onChange(next);
      }}
    >
      {options.map((o) => (
        <ToggleButton key={o.value} id={o.value} isDisabled={o.disabled}>{o.label}</ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

// ------------------------------------------------------------------- Switch

export function Switch({
  checked, onChange, label, disabled, children
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <AriaSwitch className="switch-field" isSelected={checked} onChange={onChange} isDisabled={disabled} aria-label={children ? undefined : label}>
      {children}
      <span className="switch"><i /></span>
    </AriaSwitch>
  );
}

// ------------------------------------------------------------------- Select

export function Select<T extends string>({
  value, options, onChange, label, prefix, disabled
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; hint?: string }[];
  onChange: (value: T) => void;
  label: string;
  /** Inline muted label inside the trigger. */
  prefix?: string;
  disabled?: boolean;
}) {
  return (
    <AriaSelect
      className="select-field"
      aria-label={label}
      selectedKey={value}
      isDisabled={disabled}
      onSelectionChange={(key: Key | null) => key !== null && onChange(key as T)}
    >
      <Button className="select">
        <span>{prefix && <span className="muted">{prefix}&nbsp;&nbsp;</span>}<SelectValue>{({ selectedText }) => selectedText}</SelectValue></span>
        <ChevronDown size={13} />
      </Button>
      <Popover className="popover menu" offset={6}>
        <ListBox className="listbox">
          {options.map((o) => (
            <ListBoxItem key={o.value} id={o.value} className="menu-item" textValue={o.label} isDisabled={o.disabled}>
              <span>{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

// -------------------------------------------------------------- ColorField

export function ColorField({
  label, value, onChange, badge
}: {
  label: ReactNode;
  value: string;
  onChange: (hex: string) => void;
  badge?: ReactNode;
}) {
  return (
    <label className="color">
      <i className="sw" style={{ background: value }} />
      <span>{label}{badge}</span>
      <code>{value.toUpperCase()}</code>
      <input type="color" value={value} onChange={(e) => onChange(e.currentTarget.value)} />
    </label>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

export function Hint({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <div className={warn ? 'hint hint--warn' : 'hint'}>{children}</div>;
}
