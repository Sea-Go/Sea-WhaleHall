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

export const CAT_THEME: PetModelTheme = {
  colors: {
    outline: '#3b2c43',
    accent: '#ff8ba7',
    'neutral.primary': '#f5bf69',
    'neutral.secondary': '#d98448',
    'neutral.dark': '#92533f',
    'neutral.light': '#fff0cf',
    'happy.primary': '#ffd27c',
    'happy.secondary': '#e8944e',
    'happy.dark': '#99553c',
    'happy.light': '#fff4d9',
    'busy.primary': '#b9cef5',
    'busy.secondary': '#748ec9',
    'busy.dark': '#4e5f91',
    'busy.light': '#f0f5ff',
    'error.primary': '#f3a0a4',
    'error.secondary': '#c95e66',
    'error.dark': '#883f53',
    'error.light': '#fff0f1',
    'angry.primary': '#ef9a72',
    'angry.secondary': '#ce5d47',
    'angry.dark': '#873a39',
    'angry.light': '#fff1e8',
    'sleepy.primary': '#c6b8cf',
    'sleepy.secondary': '#8b769f',
    'sleepy.dark': '#5a4a72',
    'sleepy.light': '#f6f0fa',
    'love.primary': '#f4b2bd',
    'love.secondary': '#d46f87',
    'love.dark': '#923f62',
    'love.light': '#fff0f4',
    'shy.primary': '#f4c19b',
    'shy.secondary': '#cf8268',
    'shy.dark': '#895149',
    'shy.light': '#fff3e8',
    'proud.primary': '#f5d36e',
    'proud.secondary': '#c99b3f',
    'proud.dark': '#80602f',
    'proud.light': '#fff8d8',
    'confused.primary': '#bbbcc9',
    'confused.secondary': '#7e8094',
    'confused.dark': '#505267',
    'confused.light': '#f4f4f9',
    'afraid.primary': '#b9acd3',
    'afraid.secondary': '#796a9f',
    'afraid.dark': '#504468',
    'afraid.light': '#f4effc',
    'focused.primary': '#aad7bb',
    'focused.secondary': '#5c9e74',
    'focused.dark': '#3b684c',
    'focused.light': '#effbf3',
    'sick.primary': '#b4c49a',
    'sick.secondary': '#78885f',
    'sick.dark': '#4d593d',
    'sick.light': '#f2f6e9',
    'celebration.primary': '#ffd979',
    'celebration.secondary': '#e99165',
    'celebration.dark': '#995342',
    'celebration.light': '#fff8dc',
  },
};
function catPose(frame: PetFrame): LocalPoseTransform {
  const lie = clamp01(frame.pose.lie);
  const sit = clamp01(frame.pose.sit);
  const crouch = clamp01(frame.pose.crouch);
  return {
    x: lie * 3,
    y: crouch * 11 + sit * 13 + lie * 25,
    rotation: frame.pose.lean * 0.06 - lie * 0.03,
    scaleX: 1 + frame.pose.stretch * 0.04 + lie * 0.14 + frame.pose.squash * 0.06,
    scaleY:
      1 + frame.pose.breath * 0.014 + frame.pose.stretch * 0.1 -
      sit * 0.1 - lie * 0.24 - frame.pose.squash * 0.09,
  };
}

function drawCatEye(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: PetFrame,
  outline: string,
): void {
  const eyes = frame.expression.eyes;
  const openAmount = clamp01(frame.expression.eyeOpen);
  if (eyes === 'love') {
    context.fillStyle = '#ff5f8f';
    context.beginPath();
    context.moveTo(x, y + 5);
    context.bezierCurveTo(x - 7, y, x - 5, y - 7, x, y - 3);
    context.bezierCurveTo(x + 5, y - 7, x + 7, y, x, y + 5);
    context.fill();
    return;
  }
  if (
    openAmount < 0.12 || eyes === 'closed' || eyes === 'happy' ||
    eyes === 'laugh' || eyes === 'shy' || eyes === 'proud' ||
    eyes === 'wink' || eyes === 'angry' || eyes === 'sleepy'
  ) {
    context.strokeStyle = outline;
    context.lineWidth = 2.7;
    context.lineCap = 'round';
    context.beginPath();
    if (eyes === 'angry') {
      context.moveTo(x - 6, y - 4);
      context.lineTo(x + 6, y + 1);
    } else if (eyes === 'happy' || eyes === 'laugh') {
      context.arc(x, y + 3, 6, Math.PI * 1.12, Math.PI * 1.88);
    } else if (eyes === 'proud') {
      context.moveTo(x - 6, y + 1);
      context.quadraticCurveTo(x, y - 4, x + 6, y);
    } else {
      context.moveTo(x - 6, y);
      context.quadraticCurveTo(x, y + 2 + (1 - openAmount) * 4, x + 6, y);
    }
    context.stroke();
    return;
  }
  if (eyes === 'dizzy') {
    context.strokeStyle = outline;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.arc(x, y, 2.8, 0, Math.PI * 2);
    context.stroke();
    return;
  }
  const surprised = eyes === 'surprised' || eyes === 'afraid';
  context.fillStyle = '#fffdf7';
  context.beginPath();
  context.ellipse(x, y, surprised ? 7.5 : 6.5, surprised ? 9 : 7.5, 0, 0, Math.PI * 2);
  context.fill();
  const lookX = Math.max(-1, Math.min(1, frame.expression.look.x)) * 2.5;
  const lookY = Math.max(-1, Math.min(1, frame.expression.look.y)) * 2;
  context.fillStyle = outline;
  context.beginPath();
  context.ellipse(x + lookX, y + lookY, eyes === 'afraid' ? 1.7 : 2.7, 4, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#fff';
  context.beginPath();
  context.arc(x + lookX + 0.8, y + lookY - 1.4, 0.9, 0, Math.PI * 2);
  context.fill();
}

function drawCatMouth(
  context: CanvasRenderingContext2D,
  frame: PetFrame,
  outline: string,
): void {
  const mouth = frame.expression.mouth;
  context.strokeStyle = outline;
  context.fillStyle = outline;
  context.lineWidth = 2;
  context.lineCap = 'round';
  context.beginPath();
  if (mouth === 'open' || mouth === 'o' || mouth === 'yawn') {
    context.ellipse(45, -27, mouth === 'yawn' ? 6 : 4, mouth === 'yawn' ? 9 : 5, 0, 0, Math.PI * 2);
    context.fill();
  } else if (mouth === 'laugh' || mouth === 'grin') {
    context.moveTo(36, -30);
    context.quadraticCurveTo(45, -17, 54, -30);
    context.closePath();
    context.fill();
    context.fillStyle = '#ff8fa3';
    context.beginPath();
    context.ellipse(45, -23, 4, 2, 0, 0, Math.PI * 2);
    context.fill();
  } else if (mouth === 'frown' || mouth === 'pout') {
    context.arc(45, -20, 9, Math.PI * 1.2, Math.PI * 1.8);
    context.stroke();
  } else if (mouth === 'flat' || mouth === 'small') {
    context.moveTo(mouth === 'small' ? 42 : 38, -25);
    context.lineTo(mouth === 'small' ? 48 : 52, -25);
    context.stroke();
  } else if (mouth === 'wavy') {
    context.moveTo(37, -25);
    context.quadraticCurveTo(41, -29, 45, -25);
    context.quadraticCurveTo(49, -21, 53, -25);
    context.stroke();
  } else {
    context.moveTo(45, -28);
    context.quadraticCurveTo(41, -23, 36, -27);
    context.moveTo(45, -28);
    context.quadraticCurveTo(49, -23, 54, -27);
    context.stroke();
  }
}

function drawCat(context: CanvasRenderingContext2D, frame: PetFrame): void {
  const palette = paletteForTone(CAT_THEME, frame.tone);
  const pose = catPose(frame);
  const gait = Math.sin(frame.pose.gaitPhase * Math.PI * 2) * frame.pose.gaitWeight;
  context.save();
  applyPoseTransform(context, pose);

  // A long curved tail makes the cat topology visibly different from the whale.
  context.save();
  context.translate(-63, 3);
  context.rotate(-0.35 + frame.pose.tailSwing * 0.42);
  context.strokeStyle = palette.dark;
  context.lineWidth = 17;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(0, 0);
  context.bezierCurveTo(-27, -14, -43, -47, -19, -65);
  context.bezierCurveTo(-7, -74, 5, -66, 1, -57);
  context.stroke();
  context.strokeStyle = palette.primary;
  context.lineWidth = 11;
  context.stroke();
  context.restore();

  // Rear legs.
  for (const [x, phase] of [[-42, gait], [-16, -gait]] as const) {
    context.save();
    context.translate(x, 31);
    context.rotate(phase * 0.2 + frame.pose.secondaryLimb * 0.18);
    context.fillStyle = palette.dark;
    context.beginPath();
    context.roundRect(-10, -5, 21, 37, 10);
    context.fill();
    context.fillStyle = palette.light;
    context.beginPath();
    context.ellipse(2, 28, 13, 7, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  const body = context.createLinearGradient(-65, -35, 63, 45);
  body.addColorStop(0, palette.primary);
  body.addColorStop(0.62, palette.secondary);
  body.addColorStop(1, palette.dark);
  context.fillStyle = body;
  context.beginPath();
  context.ellipse(-19, 3, 62, 45, 0.06, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(61, 38, 42, 0.22)';
  context.lineWidth = 1.4;
  context.stroke();
  context.fillStyle = palette.light;
  context.globalAlpha *= 0.68;
  context.beginPath();
  context.ellipse(3, 17, 37, 23, -0.05, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha /= 0.68;

  // Front legs use the same semantic primary-limb and gait channels as fins.
  for (const [x, phase] of [[18, -gait], [39, gait]] as const) {
    context.save();
    context.translate(x, 24);
    context.rotate(phase * 0.24 + frame.pose.primaryLimb * 0.28);
    context.fillStyle = palette.secondary;
    context.beginPath();
    context.roundRect(-9, -7, 19, 42, 9);
    context.fill();
    context.fillStyle = palette.light;
    context.beginPath();
    context.ellipse(1, 32, 12, 7, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  context.save();
  context.translate(0, frame.pose.headTilt * 2);
  context.rotate(frame.pose.headTilt * 0.1);
  // Ears behind the head.
  context.fillStyle = palette.dark;
  context.beginPath();
  context.moveTo(12, -65);
  context.lineTo(15, -96);
  context.lineTo(36, -70);
  context.moveTo(54, -71);
  context.lineTo(75, -96);
  context.lineTo(77, -61);
  context.fill();
  context.fillStyle = '#f3a2a7';
  context.beginPath();
  context.moveTo(18, -68);
  context.lineTo(19, -87);
  context.lineTo(31, -70);
  context.moveTo(59, -72);
  context.lineTo(71, -87);
  context.lineTo(72, -65);
  context.fill();

  const head = context.createLinearGradient(12, -78, 78, -21);
  head.addColorStop(0, palette.primary);
  head.addColorStop(1, palette.secondary);
  context.fillStyle = head;
  context.beginPath();
  context.ellipse(45, -50, 41, 35, -0.02, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(61, 38, 42, 0.22)';
  context.stroke();

  // Forehead stripes.
  context.strokeStyle = palette.dark;
  context.globalAlpha *= 0.54;
  context.lineWidth = 3;
  context.lineCap = 'round';
  for (const [x, tilt] of [[34, -0.14], [45, 0], [56, 0.14]] as const) {
    context.beginPath();
    context.moveTo(x, -78);
    context.lineTo(x + tilt * 20, -69);
    context.stroke();
  }
  context.globalAlpha /= 0.54;

  drawCatEye(context, 29, -52, frame, palette.outline);
  drawCatEye(context, 58, -52, frame, palette.outline);
  context.fillStyle = '#a95568';
  context.beginPath();
  context.moveTo(41, -37);
  context.quadraticCurveTo(45, -34, 49, -37);
  context.quadraticCurveTo(45, -31, 41, -37);
  context.fill();
  if (frame.expression.blush > 0) {
    context.fillStyle = `rgba(255, 113, 143, ${0.12 + frame.expression.blush * 0.56})`;
    context.beginPath();
    context.ellipse(18, -34, 9, 4, 0.08, 0, Math.PI * 2);
    context.ellipse(70, -34, 9, 4, -0.08, 0, Math.PI * 2);
    context.fill();
  }
  drawCatMouth(context, frame, palette.outline);
  context.restore();
  context.restore();
}

const CAT_ANCHORS: Record<PetAnchorId, PetVector2> = {
  headTop: { x: 45, y: -94 },
  face: { x: 45, y: -49 },
  mouth: { x: 45, y: -27 },
  bodyCenter: { x: -17, y: 3 },
  primaryGrip: { x: 42, y: 50 },
  secondaryGrip: { x: 17, y: 49 },
  back: { x: -24, y: -39 },
  ground: { x: 0, y: 67 },
  message: { x: 0, y: 84 },
};

export const CAT_MODEL: PetModel = {
  id: 'cat',
  label: '橘子猫',
  skeleton: {
    visualBounds: { x: -113, y: -99, width: 202, height: 167 },
    groundAnchor: CAT_ANCHORS.ground,
    anchors: Object.keys(CAT_ANCHORS) as PetAnchorId[],
    hitZones: ['head', 'face', 'body', 'tail', 'limb'],
  },
  theme: CAT_THEME,
  draw: drawCat,
  hitTest(localPoint, frame, padding = 0): PetHitZone | null {
    const point = inverseTransformPoint(localPoint, catPose(frame));
    const safePadding = Math.max(0, padding);
    if (inEllipse(point, 45, -49, 27, 25, safePadding)) return 'face';
    if (inEllipse(point, 45, -50, 44, 47, safePadding)) return 'head';
    if (
      inRotatedEllipse(point, 28, 47, 35, 13, 1.45, safePadding) ||
      inRotatedEllipse(point, -28, 47, 35, 16, 1.45, safePadding)
    ) return 'limb';
    if (
      inRotatedEllipse(point, -83, -28, 45, 17, -1.05, safePadding) ||
      inEllipse(point, -71, -2, 28, 21, safePadding)
    ) return 'tail';
    if (inEllipse(point, -18, 3, 66, 48, safePadding)) return 'body';
    return null;
  },
  resolveAnchor(anchor, frame): PetVector2 {
    const point = { ...CAT_ANCHORS[anchor] };
    if (anchor === 'headTop' || anchor === 'face' || anchor === 'mouth') {
      point.y += frame.pose.headTilt * 2;
    }
    return transformPoint(point, catPose(frame));
  },
};
