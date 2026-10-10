import {
  HANDOFF_HASH, isHDRFile, isModelFile, readDroppedItems, stashFiles, toPathedFiles, type PathedFile
} from '../../viewer/src/engine/droppedFiles';
import { MODEL_PRESETS } from '../../viewer/src/engine/presets';
import './style.css';

const drop = document.getElementById('drop')!;
const veil = document.getElementById('veil')!;
const error = document.getElementById('drop-error')!;

function showError(message: string) {
  error.textContent = message;
  error.hidden = false;
}

async function open(files: PathedFile[]) {
  if (!files.some((f) => isModelFile(f.path) || isHDRFile(f.path))) {
    showError('No .glb, .gltf or .hdr file found.');
    return;
  }
  drop.dataset.busy = '';
  try {
    await stashFiles(files);
    location.href = `./viewer/#${HANDOFF_HASH}`;
  } catch (e) {
    delete drop.dataset.busy;
    showError(`Could not hand the files to the viewer: ${(e as Error).message}. Open the viewer and drop them there.`);
  }
}

// The whole window accepts drops; the veil keeps dragleave from firing on child elements.
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  veil.hidden = false;
  drop.dataset.dragging = '';
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
veil.addEventListener('dragleave', () => {
  veil.hidden = true;
  delete drop.dataset.dragging;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  veil.hidden = true;
  delete drop.dataset.dragging;
  error.hidden = true;
  // Read the items before awaiting: the DataTransfer is cleared after the event.
  await open(await readDroppedItems(e.dataTransfer!.items));
});

for (const id of ['pick-files', 'pick-folder']) {
  const input = document.getElementById(id) as HTMLInputElement;
  input.addEventListener('change', () => {
    error.hidden = true;
    if (input.files?.length) void open(toPathedFiles(input.files));
    input.value = '';
  });
}

const cards = document.getElementById('cards')!;
for (const preset of MODEL_PRESETS) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `./viewer/#model=${encodeURIComponent(preset.id)}`;
  const thumb = document.createElement('div');
  thumb.className = 'card__thumb';
  if (preset.thumbnail) {
    const img = document.createElement('img');
    img.src = preset.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  }
  const name = document.createElement('strong');
  name.textContent = preset.name;
  const meta = document.createElement('small');
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = preset.tag;
  const license = document.createElement('span');
  license.textContent = preset.url ? `${preset.license}${preset.sizeMB ? ` · ${preset.sizeMB} MB` : ''}` : 'Procedural';
  meta.append(tag, license);
  a.append(thumb, name, meta);
  li.append(a);
  cards.append(li);
}
