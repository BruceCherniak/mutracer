export interface ShaderSourceFile { filename: string; source: string; }
export function renameShaderIdentifiers(source: string, identifiers: ReadonlyMap<string, string>): string;
export function readShaderSourceFiles(root?: string): ShaderSourceFile[];
export function createShaderIdentifierMap(files: readonly ShaderSourceFile[]): Map<string, string>;
export function loadShaderIdentifierMap(): Map<string, string>;
