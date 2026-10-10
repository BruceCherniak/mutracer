import { displacementCommon } from './pdm_displacement.wgsl';

/* ----------------------------------------------------- */

export default /* wgsl */ `

fn invertM3x3(m: mat3x3f) -> mat3x3f {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2];

  let b01 = a22 * a11 - a12 * a21;
  let b11 = -a22 * a10 + a12 * a20;
  let b21 = a21 * a10 - a11 * a20;

  let det = a00 * b01 + a01 * b11 + a02 * b21;
  let invDet = 1.0 / det;

  return mat3x3f(
    vec3f(b01, (-a22 * a01 + a02 * a21), (a12 * a01 - a02 * a11)) * invDet,
    vec3f(b11, (a22 * a00 - a02 * a20), (-a12 * a00 + a02 * a10)) * invDet,
    vec3f(b21, (-a21 * a00 + a01 * a20), (a11 * a00 - a01 * a10)) * invDet
  );
}

fn makeCoordinateSystem(dir: vec3f, e0: ptr<function, vec3f>, e1: ptr<function, vec3f>) {
  *e0 = select(vec3f(0.0, -dir.z, dir.y), vec3f(-dir.z, 0.0, dir.x), abs(dir.x) > abs(dir.y));
  *e1 = cross(dir, *e0);
  *e0 = normalize(*e0);
  *e1 = normalize(*e1);
}

fn makeTangToObj(pA: vec3f, pB: vec3f, pC: vec3f, tcA: vec2f, tcB: vec2f, tcC: vec2f) -> mat3x3f {
  let dp01 = pB - pA;
  let dp02 = pC - pA;
  let dt01 = tcB - tcA;
  let dt02 = tcC - tcA;
  let faceNormal = normalize(cross(dp01, dp02));

  let tmp = dt01.x * dt02.y - dt01.y * dt02.x;
  var tc0Dir: vec3f;
  var tc1Dir: vec3f;
  if (tmp == 0.0) {
    makeCoordinateSystem(faceNormal, &tc0Dir, &tc1Dir);
  }
  else {
    let recDet = 1.0 / tmp;
    tc0Dir = recDet * (dt02.y * dp01 - dt01.y * dp02);
    tc1Dir = recDet * (-dt02.x * dp01 + dt01.x * dp02);
  }
  if (dot(tc0Dir, tc0Dir) == 0.0) {
    tc0Dir = cross(tc1Dir, faceNormal);
  }
  if (dot(tc1Dir, tc1Dir) == 0.0) {
    tc1Dir = cross(faceNormal, tc0Dir);
  }

  return mat3x3f(tc0Dir, tc1Dir, faceNormal);
}

fn prevPowOf2Exponent(x: i32) -> i32 {
  if (x == 0) {
    return 0;
  }
  return i32(31 - countLeadingZeros(x));
}

fn findRoots(
  triAabbMinP: vec2<f32>, triAabbMaxP: vec2<f32>, maxDepth: i32, targetMipLevel: i32, 
  signX: i32, signY: i32,
  roots: ptr<function, array<vec3i, 24>>,
  rootCount: ptr<function, i32>
) {
  let d = triAabbMaxP - triAabbMinP;
  let size = max(d.x, d.y);

  var startMipLevel = maxDepth - prevPowOf2Exponent(i32(1.0 / size)) - 1;
  startMipLevel = min(max(startMipLevel, 0), maxDepth);
  
  loop {
    let res = pow(2.0, f32(maxDepth - startMipLevel));
    let minTexelX = i32(res * triAabbMinP.x);
    let minTexelY = i32(res * triAabbMinP.y);
    let maxTexelX = i32(res * triAabbMaxP.x);
    let maxTexelY = i32(res * triAabbMaxP.y);

    if (((maxTexelX - minTexelX) < 2 && (maxTexelY - minTexelY) < 2 &&
        startMipLevel >= targetMipLevel) ||
        startMipLevel >= maxDepth) {
      *rootCount = 0;

      for (var y = minTexelY; y <= maxTexelY; y++) {
        for (var x = minTexelX; x <= maxTexelX; x++) {
          (*roots)[*rootCount] = vec3i(x, y, startMipLevel);
          *rootCount = *rootCount + 1;
        }
      }
      break;
    }
    startMipLevel = startMipLevel + 1;
  }
}

${displacementCommon}


fn upVoxel(voxel: ptr<function, vec3i>) {
  (*voxel).x /= 2;
  (*voxel).y /= 2;
  (*voxel).z += 1;
}

fn downVoxel(voxel: ptr<function, vec3i>, signX: i32, signY: i32) {
  (*voxel).x *= 2;
  (*voxel).y *= 2;
  (*voxel).z -= 1;

  if (signX < 0) {
    (*voxel).x += 1;
  }
  if (signY < 0) {
    (*voxel).y += 1;
  }
}

fn nextVoxel(voxel: ptr<function, vec3i>, signX: i32, signY: i32, maxLod: i32) {
  loop {
    if (((*voxel).x + select(0, 1, signX < 0)) % 2 == 0) {
      (*voxel).x += signX;
      break;
    }
    else if (((*voxel).y + select(0, 1, signY < 0)) % 2 == 0) {
      (*voxel).y += signY;
      (*voxel).x -= signX;
      break;
    }
    else {
      upVoxel(voxel);
      if ((*voxel).z > maxLod) {
        break;
      }
    }
  }
}

fn wrapTc(p: vec2i, size: vec2i) -> vec2i {
  return (p % size + size) % size;
}

fn boxIntersectBox(minA: vec2f, maxA: vec2f, minB: vec2f, maxB: vec2f) -> bool {
  return all(minA <= maxB) && all(maxA >= minB);
}

fn intersectDisplacement(
  _rayOrigin: vec3f, _rayDir: vec3f, _tMax: f32,
  _pA: vec3f, _pB: vec3f, _pC: vec3f,
  _nA: vec3f, _nB: vec3f, _nC: vec3f,
  _tcA: vec2f, _tcB: vec2f, _tcC: vec2f,

  heightMapIndex: i32,
  heightMapSize: vec2f,
  minmaxMapIndex: i32,
  minmaxMapSize: i32,

  hScale: f32,
  targetMipLevel: i32,

  isShadowHit: bool
) -> MicroTriangleIntersect {
  var tMax = _tMax;
  var tcA = _tcA;
  var tcB = _tcB;
  var tcC = _tcC;

  // Wrap texcoord to positive.
  // Negative texcoord have problems.
  if (tcA.x < 0.0 || tcB.x < 0.0 || tcC.x < 0.0) {
    let maxX = ceil(max(abs(tcA.x), max(abs(tcB.x), abs(tcC.x))));
    tcA.x += maxX;
    tcB.x += maxX;
    tcC.x += maxX;
  }
  if (tcA.y < 0.0 || tcB.y < 0.0 || tcC.y < 0.0) {
    let maxY = ceil(max(abs(tcA.y), max(abs(tcB.y), abs(tcC.y))));
    tcA.y += maxY;
    tcB.y += maxY;
    tcC.y += maxY;
  }

  let triAreaInTc = cross2D(tcB - tcA, tcC - tcA);
  let recTriAreaInTc = 1.0 / triAreaInTc;

  let texTriAabbMinP = min(tcA, min(tcB, tcC));
  let texTriAabbMaxP = max(tcA, max(tcB, tcC));
  let maxDepth = prevPowOf2Exponent(minmaxMapSize);

  let matTcToBc = invertM3x3(mat3x3f(vec3f(tcA, 1.0), vec3f(tcB, 1.0), vec3f(tcC, 1.0)));
  let matTcToNInObj = mat3x3f(_nA, _nB, _nC) * matTcToBc;
  let matTangToObj = makeTangToObj(_pA, _pB, _pC, tcA, tcB, tcC);
  let matObjToTcTang = invertM3x3(matTangToObj);
  let rayDir = matObjToTcTang * _rayDir;
  let rayOrigin = matObjToTcTang * (_rayOrigin - _pA) + vec3f(tcA, 0.0);
  let invRayDir = 1.0 / rayDir;
  
  let signX = i32(sign(rayDir.x));
  let signY = i32(sign(rayDir.y));

  let maxD = maxDimension(abs(rayDir));
  let shear = getShear(rayDir, maxD);

  var hitBary: vec3f;
  var hitNormal: vec3f;



  // TODO: configurable root count. for large triangles.
  var roots: array<vec3i, 24>;
  var rootCount: i32;
  findRoots(texTriAabbMinP, texTriAabbMaxP, maxDepth, targetMipLevel, signX, signY, &roots, &rootCount);
  var iter = 0;
  var rootIdx = 0;
  for (; rootIdx < rootCount; rootIdx++) {
    var voxel = roots[rootIdx];
    let initialLod = voxel.z;
    var endVoxel = voxel;
    nextVoxel(&endVoxel, signX, signY, initialLod);

    // Use for loop to avoid long shader compilation time.
    while (true) {
      iter += 1;
      if (iter > 200) {
        break;
      }
      let lod = voxel.z;
      let texelScale = pow(2.0, f32(lod - maxDepth));
      let mipSize = vec2i(i32(1.0 / texelScale));

      if (all(voxel == endVoxel) || lod > initialLod) {
        break;
      }

      let texel = vec2f(voxel.xy) * texelScale;

      if (!boxIntersectBox(texTriAabbMinP, texTriAabbMaxP, texel, texel + texelScale)) {
        nextVoxel(&voxel, signX, signY, initialLod);
        continue;
      }

      let tl = texel;
      let tr = texel + vec2f(texelScale, 0.0);
      let bl = texel + vec2f(0.0, texelScale);
      let br = texel + texelScale;

      //Normalize normal vectors in the object space.
      let nTL = matObjToTcTang * (normalize(matTcToNInObj * vec3f(tl, 1.0)));
      let nTR = matObjToTcTang * (normalize(matTcToNInObj * vec3f(tr, 1.0)));
      let nBL = matObjToTcTang * (normalize(matTcToNInObj * vec3f(bl, 1.0)));
      let nBR = matObjToTcTang * (normalize(matTcToNInObj * vec3f(br, 1.0)));

      if (lod > targetMipLevel) {
        let minmax = textureLoad(minmaxMap, wrapTc(voxel.xy, mipSize), minmaxMapIndex, lod);

        let minH = vec3f(hScale * minmax.x);
        let maxH = vec3f(hScale * minmax.y);

        let p0 = fma(nTL, minH, vec3f(tl, 0.0));
        let p1 = fma(nTR, minH, vec3f(tr, 0.0));
        let p2 = fma(nBL, minH, vec3f(bl, 0.0));
        let p3 = fma(nBR, minH, vec3f(br, 0.0));

        let p4 = fma(nTL, maxH, vec3f(tl, 0.0));
        let p5 = fma(nTR, maxH, vec3f(tr, 0.0));
        let p6 = fma(nBL, maxH, vec3f(bl, 0.0));
        let p7 = fma(nBR, maxH, vec3f(br, 0.0));

        let minP = min(p0, min(p1, min(p2, min(p3, min(p4, min(p5, min(p6, p7)))))));
        let maxP = max(p0, max(p1, max(p2, max(p3, max(p4, max(p5, max(p6, p7)))))));

        let d = intersectBox(rayOrigin, minP, maxP, invRayDir, tMax);
        if (d >= 0.0) {
          downVoxel(&voxel, signX, signY);
        }
        else {
          nextVoxel(&voxel, signX, signY, initialLod);
        }
        continue;
      }

      // Size will minus 1. See MergedMaterialData#65
      let hSize = vec2f(textureDimensions(map)) * heightMapSize + 1.0;
      let hSizei = vec2i(hSize);
      // TODO height map size should be put in a single texture object.
      let hX = i32(texel.x * hSize.x);
      let hY = i32(texel.y * hSize.y);

      let hTL = loadMapTexel(heightMapIndex, wrapTc(vec2i(hX, hY), hSizei)).r * hScale;
      let hTR = loadMapTexel(heightMapIndex, wrapTc(vec2i(hX + 1, hY), hSizei)).r * hScale;
      let hBL = loadMapTexel(heightMapIndex, wrapTc(vec2i(hX, hY + 1), hSizei)).r * hScale;
      let hBR = loadMapTexel(heightMapIndex, wrapTc(vec2i(hX + 1, hY + 1), hSizei)).r * hScale;
      let mpTL = vec3f(tl, 0.0) + nTL * hTL;
      let mpTR = vec3f(tr, 0.0) + nTR * hTR;
      let mpBL = vec3f(bl, 0.0) + nBL * hBL;
      let mpBR = vec3f(br, 0.0) + nBR * hBR;

      let microTri1 = Triangle(mpTL, mpBR, mpBL);
      let microTri2 = Triangle(mpTL, mpTR, mpBR);
      let hit0 = intersectTriangle(rayOrigin, rayDir, microTri1, maxD, shear, tMax);
      var isHit = false;
      var hitMicroTri: Triangle;
      // var hitMicroBary: vec3f;
      // var microTcA: vec2i; var microTcB: vec2i; var microTcC: vec2i;
      if (hit0.t > 0.0) {
        // NOTE: hp on the base plane. Not displaced plane.
        let hp = hit0.barycentric.x * tl + hit0.barycentric.y * br + hit0.barycentric.z * bl;
        let bcB = cross2D(tcC - hp, tcA - hp) * recTriAreaInTc;
        let bcC = cross2D(tcA - hp, tcB - hp) * recTriAreaInTc;

        if (bcB >= 0.0 && bcC >= 0.0 && bcB + bcC <= 1.0) {
          tMax = hit0.t;
          hitMicroTri = microTri1;
          hitBary = vec3f(1.0 - bcB - bcC, bcB, bcC);
          // microTcA = vec2i(hX, hY); microTcB = vec2i(hX, hY + 1); microTcC = vec2i(hX + 1, hY + 1);
          isHit = true;
        }
      }
      
      let hit1 = intersectTriangle(rayOrigin, rayDir, microTri2, maxD, shear, tMax);  
      if (hit1.t > 0.0) {
        let hp = hit1.barycentric.x * tl + hit1.barycentric.y * tr + hit1.barycentric.z * br;
        let bcB = cross2D(tcC - hp, tcA - hp) * recTriAreaInTc;
        let bcC = cross2D(tcA - hp, tcB - hp) * recTriAreaInTc;

        if (bcB >= 0.0 && bcC >= 0.0 && bcB + bcC <= 1.0) {
          tMax = hit1.t;
          hitMicroTri = microTri2;
          hitBary = vec3f(1.0 - bcB - bcC, bcB, bcC);
          // microTcA = vec2i(hX, hY); microTcB = vec2i(hX, hY + 1); microTcC = vec2i(hX + 1, hY + 1);
          isHit = true;
        }
      }
      if (isHit) {
        // No need to calculate normal for shadow ray.
        if (!isShadowHit) {
          hitNormal = cross(hitMicroTri.p1 - hitMicroTri.p0, hitMicroTri.p2 - hitMicroTri.p0);

          hitNormal = normalize(transpose(matObjToTcTang) * hitNormal);
          let smoothNormal = _nA * hitBary.x + _nB * hitBary.y + _nC * hitBary.z;
          let faceNormal = cross(_pB - _pA, _pC - _pA);

          // Calculate rotation from face normal to smooth normal
          let normalDiff = normalize(smoothNormal) - normalize(faceNormal);
          hitNormal = normalize(hitNormal + normalDiff);
          break;
        }
        else {
          return MicroTriangleIntersect(
            hitBary, tMax, hitNormal
            // , vec3f(0.0)
          );
        }
      }
      nextVoxel(&voxel, signX, signY, initialLod);
    }
  }

  return MicroTriangleIntersect(
    hitBary, tMax, hitNormal
    // , vec3f(0.0)
  );
}
`;

export { displacementCommon };
