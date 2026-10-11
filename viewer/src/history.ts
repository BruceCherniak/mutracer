// One undo history for material, lighting and render edits. No React or
// engine imports: the store records settings edits and the material editor
// records material edits.

export interface HistoryItem {
  label: string;
  /** Lets a model change discard only the edits that belong to the model. */
  scope: 'settings' | 'material';
  /** Consecutive edits with the same key (a slider drag) collapse into one step. */
  mergeKey?: string;
  undo(): void;
  redo(): void;
  /** Absorbs the next edit; returns false when the combined edit changes nothing. */
  merge?(next: HistoryItem): boolean;
}

const MERGE_MS = 1000;
const LIMIT = 100;

let undoStack: { item: HistoryItem; time: number }[] = [];
let redoStack: HistoryItem[] = [];
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Records an edit that has already been applied. */
export function pushHistory(item: HistoryItem) {
  const last = undoStack[undoStack.length - 1];
  const now = performance.now();
  redoStack = [];
  if (item.mergeKey && last?.item.mergeKey === item.mergeKey && last.item.merge && now - last.time < MERGE_MS) {
    if (last.item.merge(item)) last.time = now;
    else undoStack.pop();
  } else {
    undoStack.push({ item, time: now });
    if (undoStack.length > LIMIT) undoStack.shift();
  }
  changed();
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  redoStack.push(entry.item);
  entry.item.undo();
  changed();
}

export function redo() {
  const item = redoStack.pop();
  if (!item) return;
  undoStack.push({ item, time: -Infinity });
  item.redo();
  changed();
}

/** Drops the edits of one scope; edits of different scopes are independent. */
export function discardHistory(scope: HistoryItem['scope']) {
  const before = undoStack.length + redoStack.length;
  undoStack = undoStack.filter(({ item }) => item.scope !== scope);
  redoStack = redoStack.filter((item) => item.scope !== scope);
  if (undoStack.length + redoStack.length !== before) changed();
}

/** Labels of the edits that undo and redo would apply. */
export function historyLabels() {
  return {
    undo: undoStack[undoStack.length - 1]?.item.label ?? null,
    redo: redoStack[redoStack.length - 1]?.label ?? null
  };
}

export function onHistoryChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
