export function compareFiles(reference: string, current: string): {
 file: string; identical: boolean; missing?: string; referenceBytes?: number;
 currentBytes?: number; firstDifferentOffset?: number | null; maxDifference?: number | string;
}[];
