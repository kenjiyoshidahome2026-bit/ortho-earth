// Cesium の積雲（CloudCollection の CumulusCloud・2026-10-28 順 5）を sprites オーバーレイで描くシェーダ。
// CesiumJS 1.146（Apache-2.0）の CloudCollectionFS.glsl／CloudNoiseVS.glsl／CloudNoiseFS.glsl をそのまま写した物（czm_ の定数だけ置き換え）。
//   雲＝画面に向いた四角（目の空間で scale m）。四角の中で小さな楕円体へ光線を飛ばし、Gardner の雲の式と Worley ノイズの 3 層で縁を削る。
//   ノイズ＝128³ のボクセルを 4096×512 の 2D に並べた絵（noiseDetail・noiseOffset ごとに一度だけ作る）。

/** 雲の四角（instanced）：中心・半幅・半高（device px）・clip w・色・楕円体の大きさ（maximumSize）・slice・明るさ */
export const CLOUD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;   // -1..1
layout(location = 1) in vec4 a_c;        // x, y, hw, hh（device px）
layout(location = 2) in vec4 a_col;
layout(location = 3) in vec4 a_ms;       // maximumSize xyz・slice
layout(location = 4) in vec2 a_wb;       // clip w・brightness
uniform vec2 u_vp;
out vec2 v_offset; out vec3 v_maximumSize; out vec4 v_color; out float v_slice; out float v_brightness; out float v_w;
void main() {
	vec2 p = a_c.xy + vec2(a_corner.x * a_c.z, -a_corner.y * a_c.w);   // 画面は y 下向き（Cesium の目の空間の +y＝上）
	v_offset = a_corner * 0.5;
	v_maximumSize = a_ms.xyz; v_slice = a_ms.w; v_color = a_col; v_brightness = a_wb.y; v_w = a_wb.x;
	gl_Position = vec4(p.x / u_vp.x * 2.0 - 1.0, 1.0 - p.y / u_vp.y * 2.0, 0.0, 1.0);
}`;

export const CLOUD_FS = (depthGLSL: string) => `#version 300 es
precision highp float;
uniform sampler2D u_noiseTexture;
uniform vec3 u_noiseTextureDimensions;
uniform float u_noiseDetail;
uniform vec2 u_vp;
in vec2 v_offset; in vec3 v_maximumSize; in vec4 v_color; in float v_slice; in float v_brightness; in float v_w;
${depthGLSL}
out vec4 o;
const float CZM_PI = 3.141592653589793;
const float CZM_EPSILON2 = 0.01;
float wrap(float value, float rangeLength) {
	if (value < 0.0) { float absValue = abs(value); float modValue = mod(absValue, rangeLength); return mod(rangeLength - modValue, rangeLength); }
	return mod(value, rangeLength);
}
vec3 wrapVec(vec3 value, float rangeLength) { return vec3(wrap(value.x, rangeLength), wrap(value.y, rangeLength), wrap(value.z, rangeLength)); }
vec2 voxelToUV(vec3 voxelIndex) {
	float textureSliceWidth = u_noiseTextureDimensions.x;
	float noiseTextureRows = u_noiseTextureDimensions.y;
	float inverseNoiseTextureRows = u_noiseTextureDimensions.z;
	float textureSliceWidthSquared = textureSliceWidth * textureSliceWidth;
	vec2 inverseNoiseTextureDimensions = vec2(noiseTextureRows / textureSliceWidthSquared, inverseNoiseTextureRows / textureSliceWidth);
	vec3 wrappedIndex = wrapVec(voxelIndex, textureSliceWidth);
	float column = mod(wrappedIndex.z, textureSliceWidth * inverseNoiseTextureRows);
	float row = floor(wrappedIndex.z / textureSliceWidth * noiseTextureRows);
	float xPixelCoord = wrappedIndex.x + column * textureSliceWidth;
	float yPixelCoord = wrappedIndex.y + row * textureSliceWidth;
	return vec2(xPixelCoord, yPixelCoord) * inverseNoiseTextureDimensions;
}
vec4 lerpSamplesX(vec3 voxelIndex, float x) {
	vec4 sample0 = texture(u_noiseTexture, voxelToUV(voxelIndex));
	vec4 sample1 = texture(u_noiseTexture, voxelToUV(voxelIndex + vec3(1.0, 0.0, 0.0)));
	return mix(sample0, sample1, x);
}
vec4 sampleNoiseTexture(vec3 position) {
	float textureSliceWidth = u_noiseTextureDimensions.x;
	vec3 recenteredPos = position + vec3(textureSliceWidth / 2.0);
	vec3 lerpValue = fract(recenteredPos);
	vec3 voxelIndex = floor(recenteredPos);
	vec4 xLerp00 = lerpSamplesX(voxelIndex, lerpValue.x);
	vec4 xLerp01 = lerpSamplesX(voxelIndex + vec3(0.0, 0.0, 1.0), lerpValue.x);
	vec4 xLerp10 = lerpSamplesX(voxelIndex + vec3(0.0, 1.0, 0.0), lerpValue.x);
	vec4 xLerp11 = lerpSamplesX(voxelIndex + vec3(0.0, 1.0, 1.0), lerpValue.x);
	vec4 yLerp0 = mix(xLerp00, xLerp10, lerpValue.y);
	vec4 yLerp1 = mix(xLerp01, xLerp11, lerpValue.y);
	return mix(yLerp0, yLerp1, lerpValue.z);
}
bool intersectSphere(vec3 origin, vec3 dir, float slice, out vec3 point, out vec3 normal) {
	float A = dot(dir, dir);
	float B = dot(origin, dir);
	float C = dot(origin, origin) - 0.25;
	float discriminant = (B * B) - (A * C);
	if (discriminant < 0.0) return false;
	float root = sqrt(discriminant);
	float t = (-B - root) / A;
	if (t < 0.0) t = (-B + root) / A;
	point = origin + t * dir;
	if (slice >= 0.0) { point.z = (slice / 2.0) - 0.5; if (length(point) > 0.5) return false; }
	normal = normalize(point);
	point -= CZM_EPSILON2 * normal;
	return true;
}
bool intersectEllipsoid(vec3 origin, vec3 dir, vec3 center, vec3 scale, float slice, out vec3 point, out vec3 normal) {
	if (scale.x <= 0.01 || scale.y < 0.01 || scale.z < 0.01) return false;
	vec3 oo = (origin - center) / scale;
	vec3 d = dir / scale;
	vec3 p, n;
	bool intersected = intersectSphere(oo, d, slice, p, n);
	if (intersected) { point = (p * scale) + center; normal = n; }
	return intersected;
}
vec2 phaseShift2D(vec2 p, vec2 freq) { return (CZM_PI / 2.0) * sin(freq.yx * p.yx); }
vec2 phaseShift3D(vec3 p, vec2 freq) { return phaseShift2D(p.xy, freq) + CZM_PI * vec2(sin(freq.x * p.z)); }
const float T0 = 0.6; const float k = 0.1; const float C0 = 0.8; const float FX0 = 0.6; const float FY0 = 0.6; const int octaves = 5;
float T(vec3 point) {
	vec2 sum = vec2(0.0); float Ci = C0; vec2 FXY = vec2(FX0, FY0); vec2 PXY = vec2(0.0);
	for (int i = 1; i <= octaves; i++) { PXY = phaseShift3D(point, FXY); Ci *= 0.707; FXY *= 2.0; vec2 sinTerm = sin(FXY * point.xy + PXY); sum += Ci * sinTerm + vec2(T0); }
	return k * sum.x * sum.y;
}
const float a = 0.5; const float t = 0.4; const float s = 0.25;
float I(float Id, float Is, float It) { return (1.0 - a) * ((1.0 - t) * ((1.0 - s) * Id + s * Is) + t * It) + a; }
const vec3 lightDir = normalize(vec3(0.2, -1.0, 0.7));
vec4 drawCloud(vec3 rayOrigin, vec3 rayDir, vec3 cloudCenter, vec3 cloudScale, float cloudSlice, float brightness) {
	vec3 cloudPoint, cloudNormal;
	if (!intersectEllipsoid(rayOrigin, rayDir, cloudCenter, cloudScale, cloudSlice, cloudPoint, cloudNormal)) return vec4(0.0);
	float Id = clamp(dot(cloudNormal, -lightDir), 0.0, 1.0);
	float Is = max(pow(dot(-lightDir, -rayDir), 2.0), 0.0);
	float It = T(cloudPoint);
	float intensity = I(Id, Is, It);
	vec3 color = vec3(intensity * clamp(brightness, 0.1, 1.0));
	vec4 noise = sampleNoiseTexture(u_noiseDetail * cloudPoint);
	float W = noise.x; float W2 = noise.y; float W3 = noise.z;
	float ndDot = clamp(dot(cloudNormal, -rayDir), 0.0, 1.0);
	float TR = pow(ndDot, 3.0) - W;
	TR *= 1.3;
	float minusDot = 0.5 - ndDot;
	TR -= min(minusDot * W2, 0.0);
	TR -= 0.8 * (minusDot + 0.25) * W3;
	float shading = mix(1.0 - 0.8 * W * W, 1.0, Id * TR);
	shading = clamp(shading + 0.2, 0.3, 1.0);
	vec3 finalColor = mix(vec3(0.5), shading * color, 1.15);
	return vec4(finalColor, clamp(TR, 0.0, 1.0)) * v_color;
}
void main() {
	vec2 coordinate = v_maximumSize.xy * v_offset;
	vec3 ellipsoidScale = 0.82 * v_maximumSize;
	vec3 ellipsoidCenter = vec3(0.0);
	float zOffset = max(ellipsoidScale.z - 10.0, 0.0);
	vec3 eye = vec3(0, 0, -10.0 - zOffset);
	vec3 rayDir = normalize(vec3(coordinate, 1.0) - eye);
	vec4 cloud = drawCloud(eye, rayDir, ellipsoidCenter, ellipsoidScale, v_slice, v_brightness);
	if (cloud.w < 0.01) discard;
	if (sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;
	o = vec4(cloud.rgb * cloud.a, cloud.a);   // Cesium は ALPHA_BLEND（非前乗算）＝この canvas は前乗算
}`;

/** ノイズの絵を作る全画面の三角 2 枚 */
export const NOISE_VS = `#version 300 es
precision highp float;
uniform vec3 u_noiseTextureDimensions;
layout(location = 0) in vec2 position;
out vec2 v_position;
void main() {
	gl_Position = vec4(position, 0.1, 1.0);
	float textureSliceWidth = u_noiseTextureDimensions.x;
	float noiseTextureRows = u_noiseTextureDimensions.y;
	float inverseNoiseTextureRows = u_noiseTextureDimensions.z;
	vec2 transformedPos = (position * 0.5) + vec2(0.5);
	transformedPos *= textureSliceWidth;
	transformedPos.x *= textureSliceWidth * inverseNoiseTextureRows;
	transformedPos.y *= noiseTextureRows;
	v_position = transformedPos;
}`;

export const NOISE_FS = `#version 300 es
precision highp float;
uniform vec3 u_noiseTextureDimensions;
uniform float u_noiseDetail;
uniform vec3 u_noiseOffset;
in vec2 v_position;
out vec4 o;
float wrap(float value, float rangeLength) {
	if (value < 0.0) { float absValue = abs(value); float modValue = mod(absValue, rangeLength); return mod(rangeLength - modValue, rangeLength); }
	return mod(value, rangeLength);
}
vec3 wrapVec(vec3 value, float rangeLength) { return vec3(wrap(value.x, rangeLength), wrap(value.y, rangeLength), wrap(value.z, rangeLength)); }
vec3 random3(vec3 p) {
	float dot1 = dot(p, vec3(127.1, 311.7, 932.8));
	float dot2 = dot(p, vec3(269.5, 183.3, 421.4));
	return fract(vec3(sin(dot1 - dot2), cos(dot1 * dot2), dot1 * dot2));
}
vec3 getWorleyCellPoint(vec3 centerCell, vec3 offset, float freq) {
	float textureSliceWidth = u_noiseTextureDimensions.x;
	vec3 cell = centerCell + offset;
	cell = wrapVec(cell, textureSliceWidth / u_noiseDetail);
	cell += floor(u_noiseOffset / u_noiseDetail);
	return offset + random3(cell);
}
float worleyNoise(vec3 p, float freq) {
	vec3 centerCell = floor(p * freq);
	vec3 pointInCell = fract(p * freq);
	float shortestDistance = 1000.0;
	for (float z = -1.0; z <= 1.0; z++) for (float y = -1.0; y <= 1.0; y++) for (float x = -1.0; x <= 1.0; x++) {
		vec3 point = getWorleyCellPoint(centerCell, vec3(x, y, z), freq);
		float distance = length(pointInCell - point);
		if (distance < shortestDistance) shortestDistance = distance;
	}
	return shortestDistance;
}
const float MAX_FBM_ITERATIONS = 10.0;
float worleyFBMNoise(vec3 p, float octaves, float scale) {
	float noise = 0.0; float freq = 1.0; float persistence = 0.625;
	for (float i = 0.0; i < MAX_FBM_ITERATIONS; i++) {
		if (i >= octaves) break;
		noise += worleyNoise(p * scale, freq * scale) * persistence;
		persistence *= 0.5; freq *= 2.0;
	}
	return noise;
}
void main() {
	float textureSliceWidth = u_noiseTextureDimensions.x;
	float inverseNoiseTextureRows = u_noiseTextureDimensions.z;
	float x = mod(v_position.x, textureSliceWidth);
	float y = mod(v_position.y, textureSliceWidth);
	float sliceRow = floor(v_position.y / textureSliceWidth);
	float z = floor(v_position.x / textureSliceWidth) + sliceRow * inverseNoiseTextureRows * textureSliceWidth;
	vec3 position = vec3(x, y, z) / u_noiseDetail;
	float worley0 = clamp(worleyFBMNoise(position, 3.0, 1.0), 0.0, 1.0);
	float worley1 = clamp(worleyFBMNoise(position, 3.0, 2.0), 0.0, 1.0);
	float worley2 = clamp(worleyFBMNoise(position, 3.0, 3.0), 0.0, 1.0);
	o = vec4(worley0, worley1, worley2, 1.0);
}`;

/** Cesium の既定（CloudCollection._textureSliceWidth・_noiseTextureRows） */
export const NOISE_SLICE = 128, NOISE_ROWS = 4;
