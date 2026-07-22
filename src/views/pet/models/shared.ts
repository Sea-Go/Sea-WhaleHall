import type {
  PetFrame,
  PetModelTheme,
  PetTone,
  PetVector2,
} from '../core/types';

export interface ModelPalette {
  primary: string;
  secondary: string;
  dark: string;
  light: string;
  outline: string;
  accent: string;
}
export interface LocalPoseTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export function paletteForTone(
  theme: PetModelTheme,
  tone: PetTone,
): ModelPalette {
  const colors = theme.colors;
  const prefix = colors[`${tone}.primary`] ? tone : 'neutral';
  return {
    primary: colors[`${prefix}.primary`] ?? '#59e1df',
    secondary: colors[`${prefix}.secondary`] ?? '#1685a5',
    dark: colors[`${prefix}.dark`] ?? '#0c607e',
    light: colors[`${prefix}.light`] ?? '#e5fffd',
    outline: colors.outline ?? '#063347',
    accent: colors[`${prefix}.accent`] ?? colors.accent ?? '#ff8fab',
  };
}

export function applyPoseTransform(
  context: CanvasRenderingContext2D,
  transform: LocalPoseTransform,
): void {
  context.translate(transform.x, transform.y);
  context.rotate(transform.rotation);
  context.scale(transform.scaleX, transform.scaleY);
}

export function transformPoint(
  point: PetVector2,
  transform: LocalPoseTransform,
): PetVector2 {
  const scaledX = point.x * transform.scaleX;
  const scaledY = point.y * transform.scaleY;
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    x: transform.x + scaledX * cosine - scaledY * sine,
    y: transform.y + scaledX * sine + scaledY * cosine,
  };
}

export function inverseTransformPoint(
  point: PetVector2,
  transform: LocalPoseTransform,
): PetVector2 {
  const dx = point.x - transform.x;
  const dy = point.y - transform.y;
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  const scaleX = Math.abs(transform.scaleX) < 0.001 ? 0.001 : transform.scaleX;
  const scaleY = Math.abs(transform.scaleY) < 0.001 ? 0.001 : transform.scaleY;
  return {
    x: (dx * cosine + dy * sine) / scaleX,
    y: (-dx * sine + dy * cosine) / scaleY,
  };
}

export function inEllipse(
  point: PetVector2,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  padding = 0,
): boolean {
  const rx = Math.max(1, radiusX + padding);
  const ry = Math.max(1, radiusY + padding);
  const dx = (point.x - centerX) / rx;
  const dy = (point.y - centerY) / ry;
  return dx * dx + dy * dy <= 1;
}

export function inRotatedEllipse(
  point: PetVector2,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
  padding = 0,
): boolean {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return inEllipse(
    { x: dx * cosine + dy * sine, y: -dx * sine + dy * cosine },
    0,
    0,
    radiusX,
    radiusY,
    padding,
  );
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function postureWeight(frame: PetFrame): number {
  return Math.max(frame.pose.crouch, frame.pose.sit, frame.pose.lie);
}
