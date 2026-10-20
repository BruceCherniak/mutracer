export interface StorageSpecializationSummary {
  calls: number;
  functions: number;
  passes: number;
  variants: {file:string; name:string; types:Record<string,string>}[];
  prunedTemplates: {file:string; name:string}[];
}
export function specializeStorageLoops(stage:string,entry:string):StorageSpecializationSummary;
