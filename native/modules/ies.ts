import {parseIESProfile} from '../../src/scene/IESProfile.js';

export function iesParameters(bytes: Uint8Array): Uint8Array {
  try {
    const profile = parseIESProfile(new TextDecoder().decode(bytes), 'native fixture');
    const output = new Float32Array(profile.data.length + 5);
    output[0] = profile.peakCandela;
    output[1] = profile.evaluateAngles(25, 45);
    output[2] = profile.sampleBaked(.3, -.7, .2);
    output[3] = profile.verticalAngles.length; output[4] = profile.horizontalAngles.length;
    output.set(profile.data, 5);
    return new Uint8Array(output.buffer);
  } catch {
    return new Uint8Array(new Float32Array([-1]).buffer);
  }
}
