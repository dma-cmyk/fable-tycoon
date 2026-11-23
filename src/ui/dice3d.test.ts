import { describe, expect, it } from 'vitest';
import {
  DICE_FACES,
  asDieValue,
  landingRotation,
  pipPositions,
  tumbleKeyframes,
  type DieFaceGeom,
  type DieValue,
} from './dice3d';

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const RAD = Math.PI / 180;
const VALUES: DieValue[] = [1, 2, 3, 4, 5, 6];

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
    }
  }
  return out;
}

function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** CSS の rotateX（列ベクトル・+Y が下・+Z が手前）。 */
function rotateX(deg: number): Mat3 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}

/** CSS の rotateY。 */
function rotateY(deg: number): Mat3 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}

function faceNormal(face: DieFaceGeom): Vec3 {
  return apply(multiply(rotateX(face.rx), rotateY(face.ry)), [0, 0, 1]);
}

/** キューブを回したとき、カメラ（+Z）を向いている面の値。 */
function facingValue(rotation: { x: number; y: number }): DieValue | null {
  const cube = multiply(rotateX(rotation.x), rotateY(rotation.y));
  for (const face of DICE_FACES) {
    const normal = apply(cube, faceNormal(face));
    if (normal[2] > 0.999) return face.value;
  }
  return null;
}

function rotationOfTransform(transform: string): { x: number; y: number } {
  const x = /rotateX\((-?\d+)deg\)/.exec(transform);
  const y = /rotateY\((-?\d+)deg\)/.exec(transform);
  expect(x).not.toBeNull();
  expect(y).not.toBeNull();
  return { x: Number(x?.[1] ?? 0), y: Number(y?.[1] ?? 0) };
}

describe('dice 3D geometry', () => {
  it('points the rolled value at the viewer when it lands', () => {
    for (const value of VALUES) {
      expect(facingValue(landingRotation(value))).toBe(value);
    }
  });

  it('keeps an unrotated cube showing 1 and lands 6 on its back face', () => {
    expect(facingValue({ x: 0, y: 0 })).toBe(1);
    expect(landingRotation(6)).toEqual({ x: 0, y: 180 });
  });

  it('gives every value a distinct landing orientation', () => {
    const keys = VALUES.map((value) => `${landingRotation(value).x},${landingRotation(value).y}`);
    expect(new Set(keys).size).toBe(VALUES.length);
  });

  it('puts opposite faces 7 apart', () => {
    const normals = new Map(DICE_FACES.map((face) => [face.value, faceNormal(face)]));
    for (const face of DICE_FACES) {
      const opposite = normals.get((7 - face.value) as DieValue);
      expect(opposite).toBeDefined();
      if (!opposite) continue;
      const [ax, ay, az] = faceNormal(face);
      expect(opposite[0]).toBeCloseTo(-ax, 6);
      expect(opposite[1]).toBeCloseTo(-ay, 6);
      expect(opposite[2]).toBeCloseTo(-az, 6);
    }
  });

  it('finishes the tumble on the landed face (extra full spins allowed)', () => {
    for (const value of VALUES) {
      const frames = tumbleKeyframes(value, 2, 3);
      const first = rotationOfTransform(String(frames[0]?.transform));
      expect(facingValue(first)).toBe(1);
      const last = rotationOfTransform(String(frames[frames.length - 1]?.transform));
      expect(facingValue(last)).toBe(value);
      const landing = landingRotation(value);
      expect(Math.abs(last.x - landing.x) % 360).toBe(0);
      expect(Math.abs(last.y - landing.y) % 360).toBe(0);
      const mid = rotationOfTransform(String(frames[2]?.transform));
      expect(facingValue(mid)).not.toBe(value);
    }
  });

  it('lays out the pips for 1..6, with a single centre pip on 1', () => {
    expect(pipPositions(1)).toEqual([[2, 2]]);
    for (const value of VALUES) expect(pipPositions(value)).toHaveLength(value);
    expect(pipPositions(6)).toEqual([
      [1, 1],
      [3, 1],
      [1, 2],
      [3, 2],
      [1, 3],
      [3, 3],
    ]);
  });

  it('falls back to 1 for out-of-range input', () => {
    expect(asDieValue(0)).toBe(1);
    expect(asDieValue(7)).toBe(1);
    expect(asDieValue(4.4)).toBe(4);
  });
});