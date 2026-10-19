import {ERROR_PACKET as E} from './layout.js';
// Native rejection packet: version=2, operation code, UTF-8 byte length, ERR1.
// Successful packets and semantic full-commit-required rejections are unchanged.
export const SCENE_ERROR_MAGIC = E.MAGIC;
export function sceneErrorPacket(code: number, error: unknown): Uint8Array {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, E.MAX_MESSAGE_UNITS);
  const text = new TextEncoder().encode(message);
  const bytes = new Uint8Array(E.WORDS * 4 + Math.ceil(text.length / 4) * 4);
  new Uint32Array(bytes.buffer, 0, E.WORDS).set([E.REJECTED, code, text.length, SCENE_ERROR_MAGIC]);
  bytes.set(text, E.WORDS * 4);
  return bytes;
}
