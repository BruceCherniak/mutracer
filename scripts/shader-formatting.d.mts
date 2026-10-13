import type ts from 'typescript';
import type { Plugin } from 'vite';

export function stripShaderFormatting(source: string, trimFirstLine?: boolean): string;
export function createShaderFormattingTransformer(): ts.TransformerFactory<ts.SourceFile>;
export function shaderFormattingPlugin(): Plugin;
