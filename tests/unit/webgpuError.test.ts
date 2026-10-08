import { describe, expect, it } from 'vitest';
import {
  getWebGPUErrorMessage,
  isWebGPUPipelineSpecializationFailure
} from '../../src/renderer/WGPURayTracePass';

describe('WebGPU error reporting', () => {
  it('reads messages from Web IDL GPU errors that do not extend Error', () => {
    const validationError = Object.create(null) as { message: string };
    validationError.message = 'Compute library failed creation';

    expect(getWebGPUErrorMessage(validationError)).toBe(
      'Compute library failed creation'
    );
    expect(isWebGPUPipelineSpecializationFailure(validationError)).toBe(true);
  });

  it('keeps normal Error and string messages', () => {
    expect(getWebGPUErrorMessage(new Error('pipeline failed'))).toBe(
      'pipeline failed'
    );
    expect(getWebGPUErrorMessage('validation failed')).toBe(
      'validation failed'
    );
    expect(isWebGPUPipelineSpecializationFailure('validation failed')).toBe(
      false
    );
  });
});
