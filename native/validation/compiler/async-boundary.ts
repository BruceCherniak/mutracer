// Isolate scriptc's async library restriction from all GPU/type diagnostics.
let completed = false;
async function initialize(): Promise<void> {
  await Promise.resolve();
  completed = true;
}
export function begin(): void { void initialize(); }
export function ready(): boolean { return completed; }
