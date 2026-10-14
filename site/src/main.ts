import {
  HANDOFF_HASH, isHDRFile, isModelFile, readDroppedItems, stashFiles, toPathedFiles, type PathedFile
} from '../../viewer/src/engine/droppedFiles';
import { MODEL_PRESETS } from '../../viewer/src/engine/presets';
import './style.css';

const copyInstall = document.getElementById('copy-install') as HTMLButtonElement;
const installCommand = document.getElementById('install-command')!;
const copyStatus = document.getElementById('copy-install-status')!;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
copyInstall.addEventListener('click', async () => {
  clearTimeout(copyFeedbackTimer);
  copyInstall.disabled = true;
  delete copyInstall.dataset.copied;
  copyStatus.textContent = '';
  try {
    await navigator.clipboard.writeText(installCommand.textContent!.trim());
    copyInstall.dataset.copied = '';
    copyStatus.textContent = 'Copied!';
  } catch {
    copyStatus.textContent = 'Could not copy. Select the command to copy it manually.';
  } finally {
    copyInstall.disabled = false;
    copyFeedbackTimer = setTimeout(() => {
      delete copyInstall.dataset.copied;
      copyStatus.textContent = '';
    }, 3000);
  }
});

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
  if (preset.id === 'spheres') continue;
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
  if (preset.licenseUrl) {
    const credits = document.createElement('div');
    credits.className = 'card-credits';
    const author = document.createElement('a');
    author.href = preset.sourceUrl;
    author.textContent = preset.credit;
    const terms = document.createElement('a');
    terms.href = preset.licenseUrl;
    terms.textContent = preset.license;
    for (const link of [author, terms]) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    credits.append(author, terms);
    if (preset.attributionUrl) {
      const details = document.createElement('a');
      details.href = preset.attributionUrl;
      details.textContent = 'Credits & changes';
      details.target = '_blank';
      details.rel = 'noopener noreferrer';
      credits.append(details);
    }
    li.append(credits);
  }
  cards.append(li);
}

// Tilt the hovered card toward the pointer; CSS applies it only for hover-capable,
// motion-tolerant users.
const tiltQuery = matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)');
const MAX_TILT_DEG = 8;
cards.addEventListener('pointermove', (event) => {
  const card = (event.target as Element).closest<HTMLElement>('.card');
  if (!card || !tiltQuery.matches || event.pointerType !== 'mouse') return;
  const rect = card.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  card.classList.add('is-tilting');
  card.style.setProperty('--rx', `${((0.5 - y) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
  card.style.setProperty('--ry', `${((x - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
  // Pan the thumbnail against the tilt so the image reads as sitting behind the card.
  card.style.setProperty('--px', ((x - 0.5) * 2).toFixed(3));
  card.style.setProperty('--py', ((y - 0.5) * 2).toFixed(3));
});
cards.addEventListener('pointerout', (event) => {
  const card = (event.target as Element).closest<HTMLElement>('.card');
  if (!card || card.contains(event.relatedTarget as Node | null)) return;
  card.classList.remove('is-tilting');
  for (const name of ['--rx', '--ry', '--px', '--py']) card.style.removeProperty(name);
});
