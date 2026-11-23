/**
 * 立体サイコロの幾何計算。DOM に触れないので単体テストできる。
 *
 * 立方体の各面は「面の値 → 面の姿勢（rotateX/rotateY + translateZ）」で貼り、
 * 着地時はキューブ全体を逆回転させて出目が手前（+Z）を向くようにする。
 * 向かい合う面は必ず 7 になる。
 */

export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

export interface DieFaceGeom {
  value: DieValue;
  /** 面を立方体に貼るための回転（度）。translateZ は CSS 側で足す。 */
  rx: number;
  ry: number;
}

export const DICE_FACES: readonly DieFaceGeom[] = [
  { value: 1, rx: 0, ry: 0 }, // 手前
  { value: 2, rx: 90, ry: 0 }, // 上
  { value: 3, rx: 0, ry: 90 }, // 右
  { value: 4, rx: 0, ry: -90 }, // 左
  { value: 5, rx: -90, ry: 0 }, // 下
  { value: 6, rx: 0, ry: 180 }, // 奥
];

export interface DieRotation {
  x: number;
  y: number;
}

/** その目を手前へ向けるキューブ回転（度）。 */
const LANDING_ROTATIONS: Record<DieValue, DieRotation> = {
  1: { x: 0, y: 0 },
  2: { x: -90, y: 0 }, // 上の面を手前へ
  3: { x: 0, y: -90 }, // 右の面を手前へ
  4: { x: 0, y: 90 }, // 左の面を手前へ
  5: { x: 90, y: 0 }, // 下の面を手前へ
  6: { x: 0, y: 180 }, // 奥の面を手前へ
};

export function asDieValue(value: number): DieValue {
  const n = Math.round(value);
  return (n >= 1 && n <= 6 ? n : 1) as DieValue;
}

export function landingRotation(value: number): DieRotation {
  return LANDING_ROTATIONS[asDieValue(value)];
}

export function landingTransform(value: number): string {
  const { x, y } = landingRotation(value);
  return `rotateX(${x}deg) rotateY(${y}deg)`;
}

export function faceTransform(face: DieFaceGeom): string {
  return `transform: rotateX(${face.rx}deg) rotateY(${face.ry}deg) translateZ(var(--die-half))`;
}

/**
 * 投げて転がる回転キーフレーム。複数軸にスピンし、最後は必ず landingTransform と
 * 同じ姿勢（+360° の整数倍だけ余分）で終わる。
 */
export function tumbleKeyframes(value: number, spinsX: number, spinsY: number): Keyframe[] {
  const { x, y } = landingRotation(value);
  const endX = x + 360 * Math.max(1, Math.round(Math.abs(spinsX)));
  const endY = y + 360 * Math.max(1, Math.round(Math.abs(spinsY)));
  const frame = (px: number, py: number, z: number, offset: number): Keyframe => ({
    offset,
    transform: `rotateX(${Math.round(endX * px)}deg) rotateY(${Math.round(endY * py)}deg) rotateZ(${z}deg)`,
  });
  return [
    frame(0, 0, 0, 0),
    frame(0.26, 0.2, -16, 0.28),
    frame(0.56, 0.52, 12, 0.58),
    frame(0.82, 0.78, -7, 0.82),
    frame(1, 1, 0, 1),
  ];
}

/** 3×3 グリッド上のピップ位置（列, 行）。1 だけ中央の大きな赤ピップ。 */
const PIP_POSITIONS: Record<DieValue, readonly (readonly [number, number])[]> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

export function pipPositions(value: number): readonly (readonly [number, number])[] {
  return PIP_POSITIONS[asDieValue(value)];
}