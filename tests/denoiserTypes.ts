// Compiled by typecheck:examples; these assertions validate the public option union.
import type {DenoiserOptions} from '../src/main.js';
// @ts-expect-error Required selector cannot be omitted.
const missingType: DenoiserOptions = {strength: 1};
// @ts-expect-error JNLM options do not belong to OIDN.
const foreignField: DenoiserOptions = {type: 'oidn', strength: 1};
void missingType; void foreignField;
// @ts-expect-error Explicit weights and packaged models are mutually exclusive.
const mixedSource: DenoiserOptions = {type: 'oidn', weightsUrl: '/network.tza', model: 'small'};
// @ts-expect-error Custom metadata requires an explicit URL.
const missingURL: DenoiserOptions = {type: 'oidn', hdr: false};
void mixedSource; void missingURL;
