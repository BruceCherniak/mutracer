const displacementCommon = /*wgsl*/ `


struct MicroTriangleIntersect {
  barycentric: vec3f,
  t: f32,
  normal: vec3f,

  // _testData: vec3f,
}

fn findVT(
  uu: f32,
  pARel: vec3f, pBRel: vec3f,
  eAC: vec3f, eBD: vec3f,
  rayDir: vec3f,
  distMin: f32,
  hitDist: ptr<function, f32>
) -> bool {
  if (uu >= 0.0 && uu <= 1.0) {
    let pAB = mix(pARel, pBRel, uu);
    let pCD = mix(eAC, eBD, uu);
    var n = cross(rayDir, pCD);
    let recDet = 1.0 / dot(n, n);
    n = cross(n, pAB);
    let tt = dot(n, pCD) * recDet;
    let vv = dot(n, rayDir) * recDet;
    if (vv >= 0.0 && vv <= 1.0 && tt > distMin && tt < *hitDist) {
      *hitDist = tt;
      return true;
    }
  }
  return false;
}

fn testRayVsBilinearPatch(
  rayOrg: vec3f, rayDir: vec3f, distMin: f32, distMax: f32,
  pA: vec3f, pB: vec3f, pC: vec3f, pD: vec3f,
  hitDist: ptr<function, f32>
) -> bool {
  let eAB = pB - pA;
  let eAC = pC - pA;
  let eBD = pD - pB;
  let eCD = pD - pC;
  let pARel = pA - rayOrg;
  let pBRel = pB - rayOrg;

  var u1: f32;
  var u2: f32;
  {
    let qN = cross(eAB, -eCD);
    let a = dot(qN, rayDir);
    var b = dot(cross(pBRel, rayDir), eBD);
    let c = dot(cross(pARel, rayDir), eAC);
    b -= a + c;

    let det = b * b - 4.0 * a * c;
    if (det < 0.0) {
      return false;
    }

    if (a == 0.0) {
      u1 = -c / b;
      u2 = -1.0;
    } else {
      let sqrtDet = sqrt(det);
      let temp = -0.5 * (b + sign(b) * sqrtDet);
      u1 = temp / a;
      u2 = c / temp;
    }
  }

  *hitDist = distMax;

  var hit = false;

  hit = findVT(u1, pARel, pBRel, eAC, eBD, rayDir, distMin, hitDist) || 
        findVT(u2, pARel, pBRel, eAC, eBD, rayDir, distMin, hitDist);
  if (!hit) {
    return false;
  }

  return true;
}

fn intersectPrism(
  rayOrg: vec3f, rayDir: vec3f, distMin: f32, distMax: f32,
  pA: vec3f, pB: vec3f, pC: vec3f,
  pD: vec3f, pE: vec3f, pF: vec3f,

  hitDistMin: ptr<function, f32>,
  hitDistMax: ptr<function, f32>
) -> bool {
  *hitDistMin = INF;
  *hitDistMax = -INF;

  let maxD = maxDimension(abs(rayDir));
  let shear = getShear(rayDir, maxD);
  var tt: f32;

  tt = intersectTriangle(
    rayOrg, rayDir,
    Triangle(pC, pB, pA), maxD, shear, INF
  ).t;
  if (tt > 0.0) {
    *hitDistMin = min(*hitDistMin, tt);
    *hitDistMax = max(*hitDistMax, tt);
  }
  tt = intersectTriangle(
    rayOrg, rayDir,
    Triangle(pD, pE, pF), maxD, shear, INF
  ).t;
  if (tt > 0.0) {
    *hitDistMin = min(*hitDistMin, tt);
    *hitDistMax = max(*hitDistMax, tt);
  }
  if (testRayVsBilinearPatch(
    rayOrg, rayDir, -INF, INF,
    pA, pB, pD, pE,
    &tt)) {
    *hitDistMin = min(*hitDistMin, tt);
    *hitDistMax = max(*hitDistMax, tt);
  }
  if (testRayVsBilinearPatch(
    rayOrg, rayDir, -INF, INF,
    pB, pC, pE, pF,
    &tt)) {
    *hitDistMin = min(*hitDistMin, tt);
    *hitDistMax = max(*hitDistMax, tt);
  }
  if (testRayVsBilinearPatch(
    rayOrg, rayDir, -INF, INF,
    pC, pA, pF, pD,
    &tt)) {
    *hitDistMin = min(*hitDistMin, tt);
    *hitDistMax = max(*hitDistMax, tt);
  }

  *hitDistMin = max(*hitDistMin, distMin);
  *hitDistMax = min(*hitDistMax, distMax);

  return *hitDistMin <= *hitDistMax && *hitDistMax > 0.0;
}
`;

export default /* wgsl */ `

${displacementCommon}

fn triangleBarycentric(p: vec3f, p0: vec3f, p1: vec3f, p2: vec3f) -> vec3f {
  let v0 = p1 - p0;
  let v1 = p2 - p0;
  let v2 = p - p0;

  let d00 = dot(v0, v0);
  let d01 = dot(v0, v1);
  let d11 = dot(v1, v1);
  let d20 = dot(v2, v0);
  let d21 = dot(v2, v1);

  let invDenom = 1.0 / (d00 * d11 - d01 * d01);
  let v = clamp((d11 * d20 - d01 * d21) * invDenom, 0.0, 1.0);
  let w = clamp((d00 * d21 - d01 * d20) * invDenom, 0.0, 1.0);
  let u = 1.0 - v - w;

  return vec3f(u, v, w);
}

fn wrapUv(uv: vec2f) -> vec2f {
  return (uv % 1.0 + 1.0) % 1.0;
}


fn intersectDisplacement(
  _rayOrigin: vec3f, _rayDir: vec3f, _tMax: f32,
  _pA: vec3f, _pB: vec3f, _pC: vec3f,
  _nA: vec3f, _nB: vec3f, _nC: vec3f,
  _tcA: vec2f, _tcB: vec2f, _tcC: vec2f,

  heightMapIndex: i32,
  heightMapSize: vec2f,

  _minH: f32, _maxH: f32,
  hScale: f32,
  stepSize: f32,
  uvProjection: i32,
  uvScale: vec2f,
  isShadowHit: bool,
  isRefraction: bool
) -> MicroTriangleIntersect {

  let DT = stepSize;
  // TODO precision in object space?
  let dt = DT / length(_rayDir);
  let dbx = 0.001;
  let dby = 0.001;

  var result: MicroTriangleIntersect;
  result.t = INF;

  var hitDistMin = INF;
  var hitDistMax = -INF;

  let hSign = sign(hScale);
  let hScaleAbs = abs(hScale);
  // Face normal.
  let faceN = hSign * normalize(cross(_pB - _pA, _pC - _pA));

  // dA, dB, dC are negative if hScale is negative
  let dA = dot(_nA, faceN);
  let dB = dot(_nB, faceN);
  let dC = dot(_nC, faceN);

  var minH = _minH * hScale * min(min(dA, dB), dC);
  var maxH = _maxH * hScale * max(max(dA, dB), dC);

  // Add gap
  // 1. Avoid too small height cause ray marching miss.
  // 2. Make sure the ray start beyond the displaced surface when surface height is same with prism height.
  let prismHeight = abs(maxH) - abs(minH);
  minH = sign(minH) * max(abs(minH) - dt * 2.0, 0.0);
  if (prismHeight < dt * 2.0) {
    maxH = sign(maxH) * min(abs(maxH) + dt * 2.0, abs(hScale));
  }

  let pA = _pA + _nA * minH / dA;
  let pB = _pB + _nB * minH / dB;
  let pC = _pC + _nC * minH / dC;

  let pD = _pA + _nA * maxH / dA;
  let pE = _pB + _nB * maxH / dB;
  let pF = _pC + _nC * maxH / dC;

  if (!intersectPrism(
    _rayOrigin, _rayDir, 0.0, INF,
    pA, pB, pC,
    pD, pE, pF,
    
    &hitDistMin, &hitDistMax
  )) {
    return result;
  }

  var testFlag = false;
  // Ray is inside the prism
  if (hitDistMax == hitDistMin) {
    hitDistMin = 0.0;
  }

  // TODO dt bias?
  var t = hitDistMin + dt * randomSample();
  var s = _rayOrigin + _rayDir * t;
  var hRay = dot(s - _pA, faceN);
  var hSurf = select(0.0, INF, hSign < 0.0);
  // initial scanning triangle
  var c0 = _pA + _nA * hRay / dA;
  var c1 = _pB + _nB * hRay / dB;
  var c2 = _pC + _nC * hRay / dC;

  // var step = 0;
  var projPos: vec3f;

  hRay = abs(hRay);

  var hDiff = hRay - hSurf;
  var hDiffPrev = hDiff;
  var step = 0;

  while (true) {
    // TODO Avoid too long loop
    // if (step > 1000) {
    //   break;
    // }

    // Barycentric coordinates
    let b = triangleBarycentric(s, c0, c1, c2);
    // Projected point on base triangle
    projPos = _pA * b.x + _pB * b.y + _pC * b.z;
    // Height at projected point
    hRay = distance(projPos, s);
    // Update scanning point
    var uv: vec2f;
    if (uvProjection > 0) {
      let n = normalize(_nA * b.x + _nB * b.y + _nC * b.z);
      uv = wrapUv(projectUV(uvProjection, projPos, n) * uvScale);
    }
    else {
      uv = wrapUv(_tcA * b.x + _tcB * b.y + _tcC * b.z);
    }
    let h = sampleMap(heightMapIndex, uv).x;
    // height < dt will be ignored in ray marching
    hSurf = max(hScaleAbs * h, dt);

    // Advance scanning triangle
    let dh = dot(faceN, s - c0);
    c0 = c0 + _nA * dh / dA;
    c1 = c1 + _nB * dh / dB;
    c2 = c2 + _nC * dh / dC;

    hDiffPrev = hDiff;
    hDiff = hRay - hSurf;

    if (!(select(hDiff * hSign, hDiff * hDiffPrev, isRefraction) > 0.0
      && t < hitDistMax + dt) 
      // Ignore first step
      && step > 0) {
      break;
    }

    step++;
    t = t + dt;
    s = s + _rayDir * dt;
  }

  if (select(hDiff * hSign, hDiff * hDiffPrev, isRefraction) <= 0.0) {
    let dtt = dt * (abs(hDiff) / (abs(hDiffPrev) + abs(hDiff) + EPS));
    t = t - dtt;
    // t = interpolateCrossing(_rayOrigin, _rayDir, projPos, t, dt, hSurf);
    let pHit = _rayOrigin + _rayDir * t;
    let b = triangleBarycentric(pHit, c0, c1, c2);

    let N = normalize(_nA * b.x + _nB * b.y + _nC * b.z);

    let p_a = _pA * b.x + _pB * b.y + _pC * b.z;
    let p_b = _pA * (b.x + dbx) + _pB * b.y + _pC * (b.z - dbx);
    let p_c = _pA * b.x + _pB * (b.y + dby) + _pC * (b.z - dby);

    var uv_a: vec2f;
    var uv_b: vec2f;
    var uv_c: vec2f;

    if (uvProjection > 0) {
      let NA = normalize(_nA * b.x + _nB * b.y + _nC * b.z);
      let NB = normalize(_nA * (b.x + dbx) + _nB * b.y + _nC * (b.z - dbx));
      let NC = normalize(_nA * b.x + _nB * (b.y + dby) + _nC * (b.z - dby));  
      uv_a = projectUV(uvProjection, p_a, NA) * uvScale;
      uv_b = projectUV(uvProjection, p_b, NB) * uvScale;
      uv_c = projectUV(uvProjection, p_c, NC) * uvScale;
    }
    else {
      uv_a = _tcA * b.x + _tcB * b.y + _tcC * b.z;
      uv_b = _tcA * (b.x + dbx) + _tcB * b.y + _tcC * (b.z - dbx);
      uv_c = _tcA * b.x + _tcB * (b.y + dby) + _tcC * (b.z - dby);
    }

    let s_a = p_a + hSign * N * sampleMap(heightMapIndex, wrapUv(uv_a)).x * hScale;
    let s_b = p_b + hSign * N * sampleMap(heightMapIndex, wrapUv(uv_b)).x * hScale;
    let s_c = p_c + hSign * N * sampleMap(heightMapIndex, wrapUv(uv_c)).x * hScale;

    // TODO why it's inversed
    let N_s = -hSign * normalize(cross(s_c - s_a, s_b - s_a));

    result.t = t;
    result.barycentric = b;
    result.normal = normalize(N_s - faceN + hSign * N);
  }

  return result;

}
`;

export { displacementCommon };
