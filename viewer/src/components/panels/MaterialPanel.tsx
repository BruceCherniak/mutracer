import { useState } from 'react';
import { MousePointerClick, RotateCcw } from 'lucide-react';
import { useViewer } from '../../store';
import { getEngine } from '../../engine/ViewerEngine';
import { thumbnailUrl } from '../../engine/presets';
import {
  MATERIAL_GROUPS, MATERIAL_PRESETS, hexToLinear, linearToHex,
  type MaterialGroup, type MaterialParam, type MaterialValues
} from '../../engine/materialParams';
import { ColorField, Hint, Scrub, Section, Switch } from '../ui/controls';

export function MaterialPanel() {
  const material = useViewer((s) => s.material);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  if (!material) {
    return (
      <div className="empty-panel">
        <MousePointerClick size={22} />
        <strong>No material selected</strong>
        <span>Click an object in the viewport or pick a material in the scene tree.</span>
      </div>
    );
  }

  const set = (values: MaterialValues) => getEngine()?.setMaterialValues(material.id, values);
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
          <button key={preset.id} className="preset" title={`Apply ${preset.label}`} onClick={() => set(preset.values)}>
            <img src={thumbnailUrl(`material-${preset.id}`)} alt="" />{preset.label}
          </button>
        ))}
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
              <ParamControl key={param.key} param={param} values={material.values} textures={textures} onChange={set} />
            ))}
          </Section>
        );
      })}
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

const formatWeight = (w: number) => (w === 0 ? '0' : w.toFixed(2));
