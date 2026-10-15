import {
  DEFAULT_OIDN_WEIGHTS_BASE_URL,
  DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL,
  OIDN_AUXILIARY_MODEL_FILENAMES,
  OIDN_MODEL_FILENAMES,
  OIDN_WEIGHTS_PACKAGE,
  OIDN_WEIGHTS_PACKAGE_VERSION,
  resolveOIDNAuxiliaryModelUrls,
  resolveOIDNModelUrl,
  type OIDNAuxiliaryModelUrls
} from '../src/oidn.js';

function auxiliaryStrings(value: OIDNAuxiliaryModelUrls) {
  const { albedo, normal } = value;
  return {
    albedo: typeof albedo === 'string' ? albedo : String(albedo),
    normal: typeof normal === 'string' ? normal : String(normal)
  };
}

export function modelUrl(model: string, base: string, asUrl: boolean): string {
  if (model !== 'standard' && model !== 'small' && model !== 'cleanAuxLarge') {
    throw new Error('Unknown OIDN model.');
  }
  return asUrl
    ? resolveOIDNModelUrl(model, new URL(base))
    : resolveOIDNModelUrl(model, base);
}

export function auxiliaryUrls(base: string, asUrl: boolean): string {
  const value = asUrl
    ? resolveOIDNAuxiliaryModelUrls(new URL(base))
    : resolveOIDNAuxiliaryModelUrls(base);
  return JSON.stringify(auxiliaryStrings(value));
}

export function defaults(): string {
  return JSON.stringify({
    package: OIDN_WEIGHTS_PACKAGE,
    version: OIDN_WEIGHTS_PACKAGE_VERSION,
    base: DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL,
    fallbackBase: DEFAULT_OIDN_WEIGHTS_BASE_URL,
    models: OIDN_MODEL_FILENAMES,
    auxiliaryModels: OIDN_AUXILIARY_MODEL_FILENAMES,
    standard: resolveOIDNModelUrl('standard'),
    small: resolveOIDNModelUrl('small'),
    cleanAuxLarge: resolveOIDNModelUrl('cleanAuxLarge'),
    auxiliary: auxiliaryStrings(resolveOIDNAuxiliaryModelUrls())
  });
}
