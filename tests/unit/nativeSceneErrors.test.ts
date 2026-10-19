import {describe, expect, it} from 'vitest';
import {sceneErrorPacket, SCENE_ERROR_MAGIC} from '../../native/scene-errors';

describe('native scene exception packets', () => {
  it('retains operation codes and UTF-8 messages, including non-Error throws', () => {
    for (const value of [new Error('IES 输入无效'), 'texture rejected', 17]) {
      const bytes = sceneErrorPacket(109, value);
      const [version, code, length, magic] = new Uint32Array(bytes.buffer, 0, 4);
      expect([version, code, magic]).toEqual([2, 109, SCENE_ERROR_MAGIC]);
      expect(new TextDecoder().decode(bytes.subarray(16, 16 + length))).toBe(value instanceof Error ? value.message : String(value));
    }
  });
  it('bounds messages while retaining a valid Unicode payload', () => {
    const bytes = sceneErrorPacket(110, new Error('无效🙂'.repeat(4096)));
    const length = new Uint32Array(bytes.buffer)[2];
    const message = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(16,16+length));
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toContain('无效');
  });
});
