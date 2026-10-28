export const steps: Set<string>;
export function ciOptions(args: string[]): {
 only?: Set<string>; skip?: Set<string>; filter?: string; gpuFilter?: RegExp;
 batch: boolean; subset: boolean; enabled(name: string): boolean;
};
