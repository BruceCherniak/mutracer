//! Optical records preserve renderer data without claiming an SDK mapping.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GlassKind {
    Thin,
    Solid,
    Curved,
    Absorption,
    Nested,
    Rough,
    Dispersion,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GlassMotion {
    Static,
    Camera,
    Interface,
    Terminal,
    Combined,
}

#[derive(Clone, Debug)]
pub(crate) struct GlassCapability {
    pub kind: GlassKind,
    pub motion: GlassMotion,
    pub data_ready: Support,
    pub temporal_correspondence: Support,
    pub rr_validated: Support,
}
#[derive(Clone, Debug, Default)]
pub(crate) struct GlassCapabilities(pub Vec<GlassCapability>);
impl GlassCapabilities {
    /// Missing categories are unverified, never implicitly rejected or supported.
    pub fn get(&self, kind: GlassKind, motion: GlassMotion) -> GlassCapability {
        self.0
            .iter()
            .find(|c| c.kind == kind && c.motion == motion)
            .cloned()
            .unwrap_or(GlassCapability {
                kind,
                motion,
                data_ready: Support::Unverified,
                temporal_correspondence: Support::Unverified,
                rr_validated: Support::Unverified,
            })
    }
    pub fn validate(&self) -> crate::Result<()> {
        for (i, c) in self.0.iter().enumerate() {
            if self.0[..i]
                .iter()
                .any(|p| p.kind == c.kind && p.motion == c.motion)
            {
                return Err("Duplicate glass capability category".into());
            }
            if (c.temporal_correspondence == Support::Ready || c.rr_validated == Support::Ready)
                && c.data_ready != Support::Ready
            {
                return Err("Glass correspondence/RR validation requires verified data".into());
            }
        }
        Ok(())
    }
}

// These values are internal GPU record tags, not public ABI or SDK constants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum BranchSampling {
    Unsampled = 0,
    RadianceSample = 1,
    GeometryOnly = 2,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum OpticalFailure {
    None = 0,
    NoCorrespondence = 1,
    TotalInternalReflection = 2,
    InterfaceMismatch = 3,
    TerminalMismatch = 4,
    Occluded = 5,
    PathBudget = 6,
    RecordOverflow = 7,
    UnsupportedMedium = 8,
    StochasticDirection = 9,
    SpectralMismatch = 10,
    InvalidProjection = 11,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub(crate) enum OpticalEventKind {
    Reflection = 1,
    Transmission = 2,
    MediumExit = 3,
    Environment = 4,
}

/// WGSL-compatible 16-byte lanes; integer identity never passes through float.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GlassSurfaceRecord {
    pub world_position: [f32; 4],
    pub geometric_normal: [f32; 4],
    pub shading_normal: [f32; 4],
    /// stable instance ID (lo/hi), stable primitive ID (lo/hi).
    pub identity: [u32; 4],
    /// barycentric u/v, front face (0/1), reserved.
    pub barycentrics_face: [f32; 4],
}
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GlassMaterialRecord {
    /// RGB transmission tint, resolved transmission weight.
    pub transmission: [f32; 4],
    /// reflection r, transmission r, actual incident IOR, actual outgoing IOR.
    pub roughness_ior: [f32; 4],
    /// RGB pure-absorption extinction per scene unit, reserved.
    pub absorption: [f32; 4],
    /// thin-walled, medium before, medium after, flags.
    pub medium: [u32; 4],
}
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TerminalGuideRecord {
    /// xyz world position, geometric path length (never primary view-Z).
    pub position_length: [f32; 4],
    pub normal_roughness: [f32; 4],
    pub diffuse_albedo: [f32; 4],
    pub specular_albedo: [f32; 4],
    pub identity: [u32; 4],
    /// Environment direction; w=1 for environment, 0 for a surface.
    pub environment: [f32; 4],
    pub barycentrics: [f32; 4],
}
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct OpticalEventRecord {
    /// event kind, medium before, medium after, hit/miss/overflow flags.
    pub event: [u32; 4],
    pub identity: [u32; 4],
    /// Directions are actual sampled directions, including spectral refraction.
    pub incident_segment_length: [f32; 4],
    pub outgoing: [f32; 4],
    pub position: [f32; 4],
}
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GlassBranchRecord {
    /// Pre-clamp RGB contribution, already weighted by the production path.
    pub radiance: [f32; 4],
    /// RGB throughput after the event; w=event PDF.
    pub throughput_pdf: [f32; 4],
    /// RGB Fresnel/transmission coefficient; w=branch selection probability.
    pub coefficient_probability: [f32; 4],
    pub absorption: [f32; 4],
    /// sampling status, optical failure, event offset, event count.
    pub state: [u32; 4],
    /// Image motion prev-current in input pixels, residual in pixels, confidence.
    /// Surface motion is kept separately in the primary motion texture.
    pub image_motion: [f32; 4],
    /// motion valid, event overflow, weights included in radiance, spectral mode.
    pub flags: [u32; 4],
    /// wavelength, selection probability, reconstruction weight R/G (B below).
    pub spectral: [f32; 4],
    pub spectral_weight: [f32; 4],
    pub terminal: TerminalGuideRecord,
}

/// Fixed diagnostic record: distinct branches and residual reconstruct the
/// pre-clamp frame contribution. Geometry-only samples never supply radiance.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct GlassPixelRecord {
    pub surface: GlassSurfaceRecord,
    pub material: GlassMaterialRecord,
    pub reflection: GlassBranchRecord,
    pub transmission: GlassBranchRecord,
    pub residual: [f32; 4],
}
impl GlassPixelRecord {
    pub fn recomposed_radiance(&self) -> crate::Result<[f32; 3]> {
        let mut result = [0.0; 3];
        for (i, value) in result.iter_mut().enumerate() {
            *value = self.residual[i];
            for branch in [&self.reflection, &self.transmission] {
                if branch.state[0] > BranchSampling::GeometryOnly as u32 {
                    return Err("Unknown glass branch sampling state".into());
                }
                if branch.state[0] == BranchSampling::RadianceSample as u32 {
                    if branch.flags[2] != 1 {
                        return Err("Glass radiance must include path weights exactly once".into());
                    }
                    *value += branch.radiance[i];
                } else if branch.radiance[i] != 0.0 {
                    return Err("Unsampled/geometry-only glass branch carries radiance".into());
                }
            }
            if !value.is_finite() {
                return Err("Non-finite glass branch contribution".into());
            }
        }
        Ok(result)
    }
}
