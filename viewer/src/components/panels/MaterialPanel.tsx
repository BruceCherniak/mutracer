import { useRef, useState } from 'react';
import { ImagePlus, MousePointerClick, RotateCcw, X } from 'lucide-react';
import { setUi, showToast, useViewer, type SelectedMaterial } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import { thumbnailUrl } from '../../engine/presets';
import {
  MATERIAL_GROUPS, MATERIAL_PRESETS, TEXTURE_SLOTS, hexToLinear, linearToHex,
  type MaterialGroup, type MaterialParam, type MaterialValues, type TextureKey
} from '../../engine/materialParams';
import { ColorField, Hint, Scrub, Section, Switch } from '../ui/controls';
import { PolyHavenLogo } from '../PolyHavenLogo';

export function MaterialPanel() {
  const material = useViewer((s) => s.material);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const browsing = useViewer((s) => s.ui.textureBrowser);

  if (!material) {
    return (
      <div className="empty-panel">
        <MousePointerClick size={22} />
        <strong>No material selected</strong>
        <span>Click an object in the viewport or pick a material in the scene tree.</span>
      </div>
    );
  }

  const set = (values: MaterialValues, label: string, mergeKey?: string) =>
    getEngine()?.setMaterialValues(material.id, values, label, mergeKey);
  const textures = new Set(material.textures);
  const base = material.values.baseColor as [number, number, number];
  const isOpen = (group: MaterialGroup) => {
    if (openGroups[group.id] !== undefined) return openGroups[group.id];
    if (!group.weight) return group.id !== 'advanced';
    return Number(material.values[group.weight]) > 0;
  };

  return (
    <>
      <div className="mat-card">
        <i className="mat-ball" style={{ '--c': linearToHex(base) } as React.CSSProperties} />
        <div>
          <strong>{material.name}</strong>
          <small>{material.meshName || 'Mesh'}{material.users > 1 ? ` · shared by ${material.users} meshes` : ''}</small>
        </div>
        <button className="icon-btn sm" title="Reset to loaded values" aria-label="Reset material" onClick={() => getEngine()?.resetMaterial(material.id)}>
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="preset-grid" aria-label="Material presets">
        {MATERIAL_PRESETS.map((preset) => (
          <button key={preset.id} className="preset" title={`Apply ${preset.label}`} onClick={() => set(preset.values, `${preset.label} preset`)}>
            <img src={thumbnailUrl(`material-${preset.id}`)} alt="" /><span>{preset.label}</span>
          </button>
        ))}
      </div>
      <div className="tex-browse hide-m">
        <button className="btn btn--wide" aria-pressed={browsing} data-on={browsing || undefined}
          onClick={() => setUi({ textureBrowser: !browsing })}>
          <PolyHavenLogo />{browsing ? 'Hide Poly Haven textures' : 'Browse Poly Haven textures'}
        </button>
      </div>
      {MATERIAL_GROUPS.map((group) => {
        const weight = group.weight ? Number(material.values[group.weight]) : undefined;
        return (
          <Section
            key={group.id}
            title={group.label}
            value={weight !== undefined ? formatWeight(weight) : undefined}
            open={isOpen(group)}
            onOpenChange={(open) => setOpenGroups((g) => ({ ...g, [group.id]: open }))}
          >
            {group.params.map((param) => (
              <ParamControl key={param.key} param={param} values={material.values} textures={textures}
                onChange={(values) => set(values, paramLabel(group, param), `${material.id}:${param.key}`)} />
            ))}
          </Section>
        );
      })}
      <Section
        title="Textures"
        value={String(Object.keys(material.maps).length)}
        open={openGroups.textures ?? Object.keys(material.maps).length > 0}
        onOpenChange={(open) => setOpenGroups((g) => ({ ...g, textures: open }))}
      >
        <TextureSlots material={material} />
      </Section>
      {material.textures.length > 0 && <Hint>Values marked with a texture swatch multiply the texture.</Hint>}
    </>
  );
}

function ParamControl({
  param, values, textures, onChange
}: {
  param: MaterialParam;
  values: MaterialValues;
  textures: Set<string>;
  onChange: (values: MaterialValues) => void;
}) {
  const badge = 'texture' in param && param.texture && textures.has(param.texture)
    ? <i className="tex" title="Multiplied by a texture" /> : null;
  if (param.kind === 'color') {
    const value = values[param.key] as [number, number, number];
    return <ColorField label={param.label} badge={badge} value={linearToHex(value)} onChange={(hex) => onChange({ [param.key]: hexToLinear(hex) })} />;
  }
  if (param.kind === 'boolean') {
    return (
      <Switch label={param.label} checked={Boolean(values[param.key])} onChange={(v) => onChange({ [param.key]: v })}>
        <span className="field-label">{param.label}</span>
      </Switch>
    );
  }
  return (
    <Scrub
      label={<>{param.label}{badge}</>}
      title={param.label}
      value={Number(values[param.key])}
      min={param.min}
      max={param.max}
      step={param.step}
      unit={param.unit}
      onChange={(v) => onChange({ [param.key]: v })}
    />
  );
}

function TextureSlots({ material }: { material: SelectedMaterial }) {
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<TextureKey | null>(null);
  const [dropTarget, setDropTarget] = useState<TextureKey | null>(null);
  const label = (slot: TextureKey) => TEXTURE_SLOTS.find((s) => s.key === slot)!.label;
  const upload = (slot: TextureKey, file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return showToast(`${file.name} is not an image`, 'error');
    void getEngine()?.setMaterialTexture(material.id, slot, file, `${label(slot)} texture`);
  };
  return (
    <div className="tex-slots">
      {TEXTURE_SLOTS.map(({ key, label, hint }) => {
        const thumb = material.maps[key];
        const has = thumb !== undefined;
        return (
          <div
            key={key}
            className="tex-slot"
            data-on={has || undefined}
            data-drop={dropTarget === key || undefined}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(key);
            }}
            onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(null);
              upload(key, e.dataTransfer.files[0]);
            }}
          >
            <button className="tex-slot__thumb" title={has ? `Replace ${label.toLowerCase()} texture` : `Upload ${label.toLowerCase()} texture`}
              aria-label={has ? `Replace ${label} texture` : `Upload ${label} texture`}
              onClick={() => { target.current = key; input.current?.click(); }}>
              {thumb ? <img src={thumb} alt="" /> : has ? <i className="tex" /> : <ImagePlus size={14} />}
            </button>
            <span className="tex-slot__label"><b>{label}</b><small>{hint}</small></span>
            {has && (
              <button className="icon-btn icon-btn--bare xs" title={`Remove ${label.toLowerCase()} texture`} aria-label={`Remove ${label} texture`}
                onClick={() => void getEngine()?.setMaterialTexture(material.id, key, null, `Remove ${label.toLowerCase()} texture`)}>
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/avif"
        onChange={(e) => {
          if (target.current) upload(target.current, e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }} />
      <Hint>Drop an image on a slot to replace its texture. Edits are kept for this model until another model is opened.</Hint>
    </div>
  );
}

const paramLabel = (group: MaterialGroup, param: MaterialParam) =>
  group.id === 'base' || group.id === 'advanced' ? param.label : `${group.label} ${param.label.toLowerCase()}`;

const formatWeight = (w: number) => (w === 0 ? '0' : w.toFixed(2));
