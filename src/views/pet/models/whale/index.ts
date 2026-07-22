import type {
  PetAnchorId,
  PetFrame,
  PetHitZone,
  PetModel,
  PetModelTheme,
  PetVector2,
} from '../../core/types';
import {
  applyPoseTransform,
  clamp01,
  inEllipse,
  inRotatedEllipse,
  inverseTransformPoint,
  paletteForTone,
  transformPoint,
  type LocalPoseTransform,
} from '../shared';

export const WHALE_THEME: PetModelTheme = {
  colors: {
    outline: '#063347',
    accent: '#ff8fab',
    'neutral.primary': '#69ece5',
    'neutral.secondary': '#198eab',
    'neutral.dark': '#0a607e',
    'neutral.light': '#eafffb',
    'happy.primary': '#8af3dd',
    'happy.secondary': '#24a6b8',
    'happy.dark': '#13788f',
    'happy.light': '#effff8',
    'busy.primary': '#96d9ff',
    'busy.secondary': '#526fc4',
    'busy.dark': '#354c9a',
    'busy.light': '#edf7ff',
    'error.primary': '#ff9daf',
    'error.secondary': '#b84d74',
    'error.dark': '#913757',
    'error.light': '#fff0f4',
    'angry.primary': '#ff9b9b',
    'angry.secondary': '#d15c6b',
    'angry.dark': '#9c2d4b',
    'angry.light': '#fff0f0',
    'sleepy.primary': '#b3d8ec',
    'sleepy.secondary': '#6a9bd1',
    'sleepy.dark': '#3d6fa3',
    'sleepy.light': '#edf7ff',
    'love.primary': '#ffb3d1',
    'love.secondary': '#e56fa0',
    'love.dark': '#a8477a',
    'love.light': '#fff0f7',
    'shy.primary': '#ffc4b8',
    'shy.secondary': '#e3837a',
    'shy.dark': '#a85552',
    'shy.light': '#fff4ef',
    'proud.primary': '#ffe9a8',
    'proud.secondary': '#d9a94e',
    'proud.dark': '#9c6f2e',
    'proud.light': '#fff9df',
    'confused.primary': '#c8d3e8',
    'confused.secondary': '#7a8bb1',
    'confused.dark': '#4e5b82',
    'confused.light': '#f3f6ff',
    'afraid.primary': '#c3b5e8',
    'afraid.secondary': '#7e6bb1',
    'afraid.dark': '#55457e',
    'afraid.light': '#f5f0ff',
    'focused.primary': '#a8e6d1',
    'focused.secondary': '#3fae87',
    'focused.dark': '#237a5c',
    'focused.light': '#ecfff8',
    'sick.primary': '#b7d1bb',
    'sick.secondary': '#6f9b78',
    'sick.dark': '#41684c',
    'sick.light': '#eff8f0',
    'celebration.primary': '#ffe39a',
    'celebration.secondary': '#f89f6d',
    'celebration.dark': '#a75d45',
    'celebration.light': '#fff8df',
  },
};

function whalePose(frame: PetFrame): LocalPoseTransform {
  const lie = clamp01(frame.pose.lie);
  const sit = clamp01(frame.pose.sit);
  const crouch = clamp01(frame.pose.crouch);
  const squash = frame.pose.squash;
  return {
    x: 0,
    y: crouch * 10 + sit * 15 + lie * 23,
    rotation: lie * 0.22 + frame.pose.lean * 0.08,
    scaleX: 1 + frame.pose.stretch * 0.06 + squash * 0.08 + lie * 0.05,
    scaleY:
      1 + frame.pose.breath * 0.018 + frame.pose.stretch * 0.08 -
      squash * 0.1 - sit * 0.08 - lie * 0.17,
  };
}
function drawEye(
  context: CanvasRenderingContext2D,
  frame: PetFrame,
  outline: string,
): void {
  const eyeX = 58;
  const eyeY = -17;
  const eyes = frame.expression.eyes;
  const openAmount = clamp01(frame.expression.eyeOpen);
  context.lineCap = 'round';

  if (eyes === 'love') {
    context.fillStyle = '#ff6398';
    context.beginPath();
    context.moveTo(eyeX, eyeY + 6);
    context.bezierCurveTo(eyeX - 9, eyeY - 1, eyeX - 6, eyeY - 9, eyeX, eyeY - 4);
    context.bezierCurveTo(eyeX + 6, eyeY - 9, eyeX + 9, eyeY - 1, eyeX, eyeY + 6);
    context.fill();
    return;
  }

  if (eyes === 'dizzy') {
    context.strokeStyle = outline;
    context.lineWidth = 2.2;
    context.beginPath();
    context.arc(eyeX, eyeY, 7, 0, Math.PI * 2);
    context.arc(eyeX, eyeY, 3.5, 0, Math.PI * 2);
    context.stroke();
    return;
  }

  if (
    openAmount < 0.12 ||
    eyes === 'closed' ||
    eyes === 'happy' ||
    eyes === 'laugh' ||
    eyes === 'shy' ||
    eyes === 'proud' ||
    eyes === 'wink' ||
    eyes === 'angry' ||
    eyes === 'sleepy'
  ) {
    context.strokeStyle = outline;
    context.lineWidth = 3;
    context.beginPath();
    if (eyes === 'angry') {
      context.moveTo(51, eyeY - 5);
      context.lineTo(66, eyeY + 2);
    } else if (eyes === 'laugh') {
      context.moveTo(51, eyeY - 2);
      context.quadraticCurveTo(58, eyeY + 6, 66, eyeY - 1);
    } else if (eyes === 'proud') {
      context.moveTo(51, eyeY + 1);
      context.quadraticCurveTo(58, eyeY - 5, 66, eyeY - 1);
    } else if (eyes === 'happy') {
      context.arc(eyeX, eyeY + 3, 7, Math.PI * 1.12, Math.PI * 1.88);
    } else {
      context.moveTo(51, eyeY);
      context.quadraticCurveTo(58, eyeY + (1 - openAmount) * 5 + 2, 66, eyeY);
    }
    context.stroke();
    return;
  }

  const afraid = eyes === 'afraid';
  const surprised = eyes === 'surprised';
  const radiusX = surprised || afraid ? 9.5 : 8;
  const radiusY = (surprised || afraid ? 10.5 : 9) * Math.max(0.2, openAmount);
  context.fillStyle = 'rgba(248, 255, 255, 0.97)';
  context.beginPath();
  context.ellipse(eyeX, eyeY, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.fill();
  const pupilRadius = afraid ? 2.2 : 4.1;
  const pupilX = eyeX + Math.max(-1, Math.min(1, frame.expression.look.x)) * 3.4;
  const pupilY = eyeY + Math.max(-1, Math.min(1, frame.expression.look.y)) * 2.6;
  context.fillStyle = outline;
  context.beginPath();
  context.arc(pupilX, pupilY, pupilRadius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#fff';
  context.beginPath();
  context.arc(pupilX + 1.2, pupilY - 1.4, 1.25, 0, Math.PI * 2);
  context.fill();
  if (eyes === 'confused' || eyes === 'wronged') {
    context.strokeStyle = outline;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(50, eyeY - 11);
    context.quadraticCurveTo(58, eyeY - (eyes === 'wronged' ? 8 : 13), 67, eyeY - 10);
    context.stroke();
  }
}

function drawMouth(
  context: CanvasRenderingContext2D,
  frame: PetFrame,
  outline: string,
): void {
  const mouth = frame.expression.mouth;
  context.strokeStyle = outline;
  context.fillStyle = outline;
  context.lineWidth = 2.3;
  context.lineCap = 'round';
  context.beginPath();
  if (mouth === 'open' || mouth === 'o' || mouth === 'yawn') {
    const radiusX = mouth === 'yawn' ? 7 : 5;
    const radiusY = mouth === 'yawn' ? 11 : mouth === 'open' ? 8 : 5;
    context.ellipse(72, 3, radiusX, radiusY, 0, 0, Math.PI * 2);
    context.fill();
  } else if (mouth === 'laugh' || mouth === 'grin') {
    context.moveTo(62, -1);
    context.quadraticCurveTo(72, 15, 82, -1);
    context.quadraticCurveTo(72, 6, 62, -1);
    context.fill();
    context.fillStyle = '#ff8da9';
    context.beginPath();
    context.ellipse(72, 7, 5, 2.6, 0, 0, Math.PI * 2);
    context.fill();
  } else if (mouth === 'frown' || mouth === 'pout') {
    context.arc(72, 12, 13, Math.PI * 1.25, Math.PI * 1.75);
    context.stroke();
  } else if (mouth === 'flat' || mouth === 'small') {
    context.moveTo(mouth === 'small' ? 68 : 65, 5);
    context.lineTo(mouth === 'small' ? 76 : 79, 5);
    context.stroke();
  } else if (mouth === 'wavy') {
    context.moveTo(64, 5);
    context.quadraticCurveTo(68, 0, 72, 5);
    context.quadraticCurveTo(76, 10, 80, 5);
    context.stroke();
  } else {
    context.arc(70, -3, 15, 0.35, 1.5);
    context.stroke();
  }
}

function drawWhale(context: CanvasRenderingContext2D, frame: PetFrame): void {
  const palette = paletteForTone(WHALE_THEME, frame.tone);
  const pose = whalePose(frame);
  context.save();
  applyPoseTransform(context, pose);

  context.save();
  context.translate(-91, -1);
  context.rotate(frame.pose.tailSwing * 0.28);
  const tail = context.createLinearGradient(-62, -42, 3, 32);
  tail.addColorStop(0, palette.primary);
  tail.addColorStop(1, palette.dark);
  context.fillStyle = tail;
  context.beginPath();
  context.moveTo(0, 0);
  context.quadraticCurveTo(-43, -50, -59, -23);
  context.quadraticCurveTo(-49, 2, -7, 10);
  context.quadraticCurveTo(-51, 21, -58, 49);
  context.quadraticCurveTo(-22, 54, 0, 8);
  context.closePath();
  context.fill();
  context.restore();

  const body = context.createLinearGradient(-80, -56, 95, 54);
  body.addColorStop(0, palette.primary);
  body.addColorStop(0.56, palette.secondary);
  body.addColorStop(1, palette.dark);
  context.fillStyle = body;
  context.beginPath();
  context.moveTo(-97, 0);
  context.bezierCurveTo(-84, -56, 31, -68, 94, -23);
  context.bezierCurveTo(114, -7, 105, 31, 62, 49);
  context.bezierCurveTo(4, 71, -79, 45, -97, 0);
  context.closePath();
  context.fill();
  context.strokeStyle = 'rgba(4, 53, 72, 0.25)';
  context.lineWidth = 1.5;
  context.stroke();

  context.fillStyle = palette.light;
  context.globalAlpha *= 0.76;
  context.beginPath();
  context.ellipse(18, 34, 58, 22, -0.08, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha /= 0.76;

  context.save();
  context.translate(17, 38);
  context.rotate(0.48 + frame.pose.primaryLimb * 0.52);
  context.fillStyle = palette.dark;
  context.globalAlpha *= 0.68;
  context.beginPath();
  context.ellipse(16, 5, 35, 10, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.strokeStyle = palette.outline;
  context.globalAlpha *= 0.6;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(3, -51);
  context.quadraticCurveTo(8, -56 - frame.pose.breath, 14, -51);
  context.stroke();
  context.globalAlpha /= 0.6;

  drawEye(context, frame, palette.outline);
  if (frame.expression.blush > 0) {
    context.fillStyle = `rgba(255, 124, 157, ${0.16 + frame.expression.blush * 0.62})`;
    context.beginPath();
    context.ellipse(78, 3, 11, 5, -0.14, 0, Math.PI * 2);
    context.fill();
  }
  drawMouth(context, frame, palette.outline);
  context.restore();
}

const WHALE_ANCHORS: Record<PetAnchorId, PetVector2> = {
  headTop: { x: 51, y: -60 },
  face: { x: 61, y: -14 },
  mouth: { x: 72, y: 4 },
  bodyCenter: { x: 0, y: 0 },
  primaryGrip: { x: 49, y: 48 },
  secondaryGrip: { x: -4, y: 44 },
  back: { x: 3, y: -51 },
  ground: { x: 0, y: 64 },
  message: { x: 0, y: 82 },
};

export const WHALE_MODEL: PetModel = {
  id: 'whale',
  label: '泡泡鲸',
  skeleton: {
    visualBounds: { x: -153, y: -68, width: 267, height: 139 },
    groundAnchor: WHALE_ANCHORS.ground,
    anchors: Object.keys(WHALE_ANCHORS) as PetAnchorId[],
    hitZones: ['head', 'face', 'body', 'tail', 'limb'],
  },
  theme: WHALE_THEME,
  draw: drawWhale,
  hitTest(localPoint, frame, padding = 0): PetHitZone | null {
    const point = inverseTransformPoint(localPoint, whalePose(frame));
    const safePadding = Math.max(0, padding);
    if (inEllipse(point, 65, -12, 30, 31, safePadding)) return 'face';
    if (inEllipse(point, 49, -15, 55, 47, safePadding)) return 'head';
    if (inRotatedEllipse(point, 34, 46, 38, 13, 0.5, safePadding)) return 'limb';
    if (
      inEllipse(point, -119, -24, 44, 34, safePadding) ||
      inEllipse(point, -119, 25, 44, 34, safePadding)
    ) return 'tail';
    if (inEllipse(point, 3, 0, 112, 64, safePadding)) return 'body';
    return null;
  },
  resolveAnchor(anchor, frame): PetVector2 {
    return transformPoint(WHALE_ANCHORS[anchor], whalePose(frame));
  },
};

export function isPointInsideWhaleModel(
  x: number,
  y: number,
  frame: PetFrame,
  padding = 0,
): boolean {
  return WHALE_MODEL.hitTest({ x, y }, frame, padding) !== null;
}
