import type ts from 'typescript';
import type { Plugin } from 'vite';

export function stripShaderFormatting(source: string, trimFirstLine?: boolean): string;
export function createShaderFormattingTransformer(identifiers?: ReadonlyMap<string, string>): ts.TransformerFactory<ts.SourceFile>;
export function shaderFormattingPlugin(options?: { sourceRoot?: string }): Plugin;
