import {
  PET_ACTION_CATALOG,
  getPetAction,
  type PetActionDefinition,
  type PetActionId,
  type PetMotionTemplate,
  type PetVisualCue,
} from '../../shared/pet-actions';
import type { PetAnimationId, PetMood } from '../../shared/contracts';
import type { Point } from './pet-math';
import type {
  PetEffect,
  PetEyeExpression,
  PetFacing,
  PetFrame,
  PetMouthExpression,
  PetProp,
  PetPropKind,
  PetTone,
} from './core/types';

export type {
  PetAnchorId,
  PetEffect,
  PetEyeExpression,
  PetFacing,
  PetFrame,
  PetHitZone,
  PetModel,
  PetModelSkeleton,
  PetModelTheme,
  PetMouthExpression,
  PetProp,
  PetPropKind,
  PetRect,
  PetTone,
  PetVector2,
} from './core/types';

export interface AnimationContext {
	width: number;
	height: number;
	/** Optional model-aware root translation limits supplied by the scene. */
	travelBounds?: { minX: number; maxX: number };
	time: number;
  deltaSeconds: number;
  reducedMotion: boolean;
	pointerLocal: Point;
	/** Model-normalized gaze target, in the range -1..1. */
	aim?: Point;
  hoverAmount: number;
  pressAmount: number;
  /** Optional normalized/px-per-frame inputs supplied by richer controllers. */
  pointerVelocity?: Point;
  dragDelta?: Point;
  windowPush?: Point;
  message?: string;
}

export interface PetAnimationConfig {
  loop: boolean;
  duration: number;
  next?: PetAnimationId;
}

const EXPLICIT_NEXT: Partial<Record<PetActionId, PetActionId>> = {
  blink: 'idle',
  lookAround: 'idle',
  stretch: 'idle',
  yawn: 'idle',
  stopWalking: 'idle',
  turnLeft: 'idle',
  turnRight: 'idle',
  drop: 'idle',
  clickFeedback: 'idle',
  sleepIn: 'sleepLoop',
  wake: 'idle',
  enter: 'enterToIdle',
  jump: 'idle',
  takeOff: 'takeOffToAirborne',
  land: 'idle',
  fallDown: 'recoverFromFall',
  recoverFromFall: 'idle',
  sitDown: 'sittingLoop',
  standUp: 'idle',
  lieDown: 'lyingLoop',
  riseFromLie: 'idle',
  dragToDrop: 'drop',
  takeOffToAirborne: 'airborneLoop',
  airborneToLand: 'land',
  enterToIdle: 'idle',
  idleToWalk: 'idle',
  walkToIdle: 'idle',
  walkToTurn: 'idle',
  turnToWalk: 'idle',
  idleToSit: 'sitDown',
  sitToIdle: 'idle',
  idleToSleep: 'sleepIn',
  sleepToWake: 'wake',
  idleToExit: 'exit',
};

export const PET_ANIMATION_CONFIG = Object.fromEntries(
  PET_ACTION_CATALOG.map((definition) => {
    const next = EXPLICIT_NEXT[definition.id] ??
      (!definition.loop && definition.category !== 'transition' && definition.id !== 'exit'
        ? 'idle'
        : undefined);
    return [
      definition.id,
      {
        // Exit deliberately remains the terminal invisible pose until enter/play.
        loop: definition.id === 'exit' ? true : definition.loop,
        duration: definition.durationMs / 1000,
        ...(next ? { next } : {}),
      },
    ];
  }),
) as Record<PetActionId, PetAnimationConfig>;

const MOOD_ANIMATION: Record<PetMood, PetActionId> = {
  idle: 'idle',
  happy: 'happy',
  busy: 'loading',
  error: 'operationFailed',
};

const WALK_ACTIONS = new Set<PetActionId>([
  'walkLeft',
  'walkRight',
  'runLeft',
  'runRight',
]);
const SLEEP_ACTIONS = new Set<PetActionId>([
  'sleepy',
  'sleepIn',
  'sleepLoop',
  'idleToSleep',
  'eveningSleepy',
]);
const DRAG_ACTIONS = new Set<PetActionId>([
  'dragged',
  'dragStruggle',
  'heldLoop',
]);

const PROP_BY_ACTION: Partial<Record<PetActionId, PetPropKind>> = {
  eat: 'food',
  lunchTime: 'food',
  receiveFood: 'food',
  refuseFood: 'food',
  hungry: 'food',
  drink: 'drink',
  bathe: 'towel',
  dryOff: 'towel',
  groom: 'brush',
  playToy: 'toy',
  idleSelfEntertainment: 'toy',
  readBook: 'book',
  usePhone: 'phone',
  listenMusic: 'headphones',
  takeMedicine: 'medicine',
  receiveGift: 'gift',
  unwrapGift: 'gift',
  birthdayCelebrate: 'gift',
  changeOutfit: 'outfit',
  holdSign: 'sign',
  pointNotification: 'notification',
  searching: 'magnifier',
  recordTodo: 'notebook',
  startPomodoro: 'timer',
  focus: 'timer',
  overworkRestReminder: 'timer',
  alarm: 'alarm',
  rainUmbrella: 'umbrella',
  summerFan: 'fan',
  holidayAction: 'holiday',
  hiddenEasterEgg: 'mystery',
};

const STRUCTURAL_CUES = new Set<PetVisualCue>([
  'pose',
  'blink',
  'gaze',
  'squashStretch',
  'prop',
  'fade',
  'shadow',
  'outfit',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function easeInOut(value: number): number {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function easeOut(value: number): number {
  const t = clamp(value, 0, 1);
  return 1 - (1 - t) ** 3;
}

function easeIn(value: number): number {
  const t = clamp(value, 0, 1);
  return t ** 3;
}

function randomBetween(min: number, max: number, random: () => number): number {
  const sampled = random();
  const bounded = Number.isFinite(sampled)
    ? Math.min(0.999_999, Math.max(0, sampled))
    : 0;
  return min + bounded * (max - min);
}

function intensityValue(definition: PetActionDefinition<PetActionId>): number {
  if (definition.motion.intensity === 'strong') return 1;
  if (definition.motion.intensity === 'medium') return 0.68;
  return 0.38;
}

function toneFor(id: PetActionId): PetTone {
  switch (id) {
    case 'happy':
    case 'laugh':
    case 'clickFeedback':
    case 'doubleClick':
    case 'full':
    case 'recoverEnergy':
    case 'welcomeUserBack':
      return 'happy';
    case 'taskComplete':
    case 'updateComplete':
    case 'levelUp':
    case 'birthdayCelebrate':
    case 'holidayAction':
    case 'hiddenEasterEgg':
      return 'celebration';
    case 'angry':
    case 'impatient':
    case 'rapidClickAnnoyed':
      return 'angry';
    case 'loveReaction':
    case 'petHead':
      return 'love';
    case 'shy':
      return 'shy';
    case 'proud':
      return 'proud';
    case 'confused':
    case 'bored':
    case 'think':
      return 'confused';
    case 'afraid':
    case 'wronged':
      return 'afraid';
    case 'searching':
    case 'focus':
      return 'focused';
    case 'loading':
      return 'busy';
    case 'operationFailed':
    case 'networkDisconnected':
      return 'error';
    case 'sick':
      return 'sick';
    case 'sleepy':
    case 'sleepIn':
    case 'sleepLoop':
    case 'eveningSleepy':
    case 'lateNightRestReminder':
      return 'sleepy';
    default:
      return 'neutral';
  }
}

function createFrame(
  definition: PetActionDefinition<PetActionId>,
  elapsedSeconds: number,
  facingX: PetFacing,
): PetFrame {
  const duration = Math.max(definition.durationMs / 1000, 0.001);
  const cycle = elapsedSeconds / duration;
  const progress = definition.loop
    ? cycle - Math.floor(cycle)
    : clamp(cycle, 0, 1);
  return {
    action: {
      id: definition.id,
      elapsedSeconds: Math.max(0, elapsedSeconds),
      progress,
      phase: cycle - Math.floor(cycle),
      visualCues: definition.visualCues,
    },
    root: {
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      facingX,
      opacity: 1,
    },
    pose: {
      breath: 0,
      stretch: 0,
      crouch: 0,
      sit: 0,
      lie: 0,
      headTilt: 0,
      tailSwing: 0,
      primaryLimb: 0,
      secondaryLimb: 0,
      gaitPhase: 0,
      gaitWeight: 0,
      airborne: 0,
      squash: 0,
      lean: 0,
    },
    expression: {
      eyes: 'open',
      eyeOpen: 1,
      look: { x: 0, y: 0 },
      mouth: 'smile',
      blush: 0,
    },
    tone: toneFor(definition.id),
    effects: [],
    props: [],
    shadow: {
      opacity: 0.35,
      scaleX: 1,
      scaleY: 1,
      offsetY: 0,
    },
  };
}

function cueAnchor(cue: PetVisualCue): PetEffect['anchor'] {
  switch (cue) {
    case 'dust':
    case 'impact':
    case 'shadow':
      return 'ground';
    case 'food':
    case 'water':
    case 'medicine':
    case 'soundWave':
    case 'bubble':
      return 'mouth';
    case 'heart':
    case 'angerMark':
    case 'tear':
    case 'sweat':
    case 'questionMark':
    case 'exclamationMark':
    case 'zzz':
      return 'headTop';
    case 'notification':
    case 'offlineBadge':
    case 'errorMark':
    case 'spinner':
    case 'timer':
    case 'sign':
      return 'message';
    default:
      return 'bodyCenter';
  }
}

function buildEffects(
  definition: PetActionDefinition<PetActionId>,
  progress: number,
  phase: number,
): PetEffect[] {
  const baseIntensity = intensityValue(definition);
  return definition.visualCues
    .filter((cue) => !STRUCTURAL_CUES.has(cue))
    .map((cue, index) => ({
      kind: cue,
      anchor: cueAnchor(cue),
      progress,
      intensity: baseIntensity,
      opacity: definition.loop
        ? 0.62 + Math.sin((phase + index * 0.19) * Math.PI * 2) * 0.28
        : Math.sin(clamp(progress, 0, 1) * Math.PI),
      offset: {
        x: Math.sin(index * 2.4 + phase * Math.PI * 2) * (8 + index * 2),
        y: -index * 4,
      },
    }));
}

function buildProps(
  definition: PetActionDefinition<PetActionId>,
  progress: number,
  context: AnimationContext,
): PetProp[] {
  if (!definition.channels.includes('prop')) return [];
  const kind = PROP_BY_ACTION[definition.id] ?? 'mystery';
  const baseScale = kind === 'book'
    ? 1.08
    : kind === 'phone' || kind === 'headphones'
      ? 1.03
      : kind === 'toy'
        ? 1
        : 0.92;
  return [{
    kind,
    anchor: kind === 'outfit' ? 'back' : kind === 'sign' ? 'primaryGrip' : 'secondaryGrip',
    ...(kind === 'sign' && context.message ? { text: context.message } : {}),
    progress,
    opacity: 1,
    scale: baseScale + Math.sin(progress * Math.PI) * 0.08,
    rotation: Math.sin(progress * Math.PI * 2) * 0.05,
    offset: { x: 0, y: 0 },
  }];
}

function setExpression(
  frame: PetFrame,
  eyes: PetEyeExpression,
  mouth: PetMouthExpression,
  blush = 0,
): void {
  frame.expression.eyes = eyes;
  frame.expression.mouth = mouth;
  frame.expression.blush = blush;
  if (eyes === 'closed') frame.expression.eyeOpen = 0;
  if (eyes === 'sleepy') frame.expression.eyeOpen = 0.42;
}

function applyActionExpression(frame: PetFrame, id: PetActionId, time: number): void {
  switch (id) {
    case 'clickFeedback':
    case 'doubleClick':
    case 'happy':
    case 'full':
    case 'recoverEnergy':
    case 'welcomeUserBack':
      setExpression(frame, 'happy', 'open', 0.45);
      break;
    case 'laugh':
    case 'taskComplete':
    case 'updateComplete':
    case 'birthdayCelebrate':
    case 'hiddenEasterEgg':
      setExpression(frame, 'laugh', 'laugh', 0.5);
      break;
    case 'shy':
      setExpression(frame, 'shy', 'small', 0.85);
      frame.expression.look.x = -0.45;
      break;
    case 'angry':
    case 'impatient':
    case 'rapidClickAnnoyed':
      setExpression(frame, 'angry', 'pout', 0.25);
      break;
    case 'wronged':
      setExpression(frame, 'wronged', 'pout', 0.18);
      frame.expression.look.y = 0.35;
      break;
    case 'sad':
    case 'cry':
      setExpression(frame, 'wronged', 'frown', 0.12);
      frame.expression.look.y = 0.45;
      break;
    case 'surprised':
    case 'pokeFace':
    case 'pokeBody':
    case 'pushedByWindow':
      setExpression(frame, 'surprised', 'o', 0.25);
      break;
    case 'afraid':
    case 'chasedByPointer':
    case 'dragStruggle':
      setExpression(frame, 'afraid', 'wavy');
      break;
    case 'confused':
    case 'think':
      setExpression(frame, 'confused', 'flat');
      frame.expression.look = { x: 0.35, y: -0.3 };
      break;
    case 'bored':
      setExpression(frame, 'sleepy', 'flat');
      break;
    case 'sleepy':
    case 'sleepIn':
    case 'eveningSleepy':
      setExpression(frame, 'sleepy', 'yawn');
      break;
    case 'sleepLoop':
      setExpression(frame, 'closed', 'small');
      break;
    case 'proud':
      setExpression(frame, 'proud', 'smile', 0.15);
      break;
    case 'expectant':
      setExpression(frame, 'open', 'smile', 0.35);
      frame.expression.look.y = -0.35;
      break;
    case 'loveReaction':
    case 'petHead':
      setExpression(frame, 'love', 'smile', 0.7);
      break;
    case 'sick':
    case 'operationFailed':
    case 'networkDisconnected':
      setExpression(frame, 'dizzy', 'wavy');
      break;
    case 'refuseFood':
      setExpression(frame, 'angry', 'flat');
      break;
    case 'hungry':
      setExpression(frame, 'wronged', 'small');
      break;
    case 'answerQuestion':
      setExpression(frame, 'open', Math.sin(time * 12) > 0 ? 'open' : 'smile');
      break;
    case 'dragged':
    case 'heldLoop':
    case 'fallFromHeight':
      setExpression(frame, 'surprised', 'open');
      break;
    default:
      break;
  }
}

function applyMotionTemplate(
  frame: PetFrame,
  definition: PetActionDefinition<PetActionId>,
  elapsed: number,
  context: AnimationContext,
): void {
  const p = frame.action.progress;
  const phase = frame.action.phase * Math.PI * 2;
  const time = Number.isFinite(context.time) ? context.time : elapsed;
  const strength = intensityValue(definition);
  const wave = Math.sin(phase);
	const pointerX = clamp(context.aim?.x ?? context.pointerLocal.x / 90, -1, 1);
	const pointerY = clamp(context.aim?.y ?? context.pointerLocal.y / 70, -1, 1);
  const direction = definition.motion.direction === 'left'
    ? -1
    : definition.motion.direction === 'right'
      ? 1
      : frame.root.facingX;

  switch (definition.motion.template as PetMotionTemplate) {
    case 'holdPose':
      frame.pose.breath = Math.sin(time * 1.8) * 0.18;
      if (definition.id === 'sittingLoop') frame.pose.sit = 1;
      if (definition.id === 'lyingLoop') frame.pose.lie = 1;
      if (definition.id === 'airborneLoop') {
        frame.pose.airborne = 1;
        frame.root.y = -36 + wave * 2;
      }
      break;
    case 'idleBreath':
      frame.pose.breath = wave * 0.32;
      frame.root.y = wave * 2;
      break;
    case 'blink':
      frame.expression.eyeOpen = Math.abs(Math.cos(p * Math.PI));
      if (frame.expression.eyeOpen < 0.15) frame.expression.eyes = 'closed';
      break;
    case 'look':
      frame.expression.look.x = Math.sin(p * Math.PI * 2) * 0.9;
      frame.expression.look.y = Math.sin(p * Math.PI * 4) * 0.18;
      frame.pose.headTilt = frame.expression.look.x * 0.18;
      break;
    case 'stretch': {
      const stretch = Math.sin(p * Math.PI);
      frame.pose.stretch = stretch;
      frame.root.y = -stretch * 10;
      frame.root.scaleX = 1 - stretch * 0.08;
      frame.root.scaleY = 1 + stretch * 0.14;
      frame.pose.primaryLimb = stretch * 0.8;
      frame.pose.secondaryLimb = stretch * 0.65;
      break;
    }
    case 'yawn':
      frame.expression.eyes = 'sleepy';
      frame.expression.eyeOpen = 0.3 + Math.abs(p - 0.5) * 0.8;
      frame.expression.mouth = 'yawn';
      frame.pose.stretch = Math.sin(p * Math.PI) * 0.35;
      frame.pose.headTilt = -0.12;
      break;
    case 'walkCycle':
    case 'runCycle': {
      const running = definition.motion.template === 'runCycle';
      frame.pose.gaitPhase = frame.action.phase;
      frame.pose.gaitWeight = running ? 1 : 0.62;
      frame.root.y = Math.sin(phase * (running ? 2 : 1)) * (running ? 5 : 3);
      frame.pose.tailSwing = Math.sin(phase) * (running ? 0.8 : 0.45);
      frame.pose.primaryLimb = Math.sin(phase) * (running ? 0.85 : 0.52);
      frame.pose.secondaryLimb = -frame.pose.primaryLimb;
      frame.pose.lean = direction * (running ? 0.2 : 0.08);
      break;
    }
    case 'decelerate':
      frame.pose.gaitPhase = p;
      frame.pose.gaitWeight = 1 - easeOut(p);
      frame.pose.squash = Math.sin(p * Math.PI) * 0.25;
      break;
    case 'turn':
      frame.root.scaleX = Math.max(0.2, Math.abs(Math.cos(p * Math.PI)));
      frame.pose.headTilt = Math.sin(p * Math.PI) * direction * 0.22;
      frame.root.rotation = Math.sin(p * Math.PI) * direction * 0.05;
      break;
    case 'suspended':
      frame.root.x = clamp(context.pointerLocal.x * 0.28, -48, 48);
      frame.root.y = clamp(context.pointerLocal.y * 0.28 - 15, -55, 20);
      frame.root.rotation = clamp(context.pointerLocal.x / 360, -0.22, 0.22);
      frame.pose.airborne = 1;
      frame.pose.tailSwing = Math.sin(time * 7) * 0.4;
      frame.pose.primaryLimb = -0.55;
      break;
    case 'dropBounce': {
      const landAt = 0.62;
      if (p < landAt) {
        const t = p / landAt;
        frame.root.y = 52 * (1 - easeIn(t));
        frame.pose.airborne = 1 - t;
      } else {
        const bounce = Math.sin(((p - landAt) / (1 - landAt)) * Math.PI);
        frame.root.y = -bounce * 8;
        frame.pose.squash = bounce;
        frame.root.scaleX = 1 + bounce * 0.1;
        frame.root.scaleY = 1 - bounce * 0.12;
      }
      break;
    }
    case 'reaction': {
      const bounceCount = definition.id === 'doubleClick' ? 2 : 1;
      const bounce = Math.abs(Math.sin(p * Math.PI * bounceCount));
      frame.root.y = -bounce * (10 + 10 * strength);
      frame.root.rotation = Math.sin(p * Math.PI * bounceCount * 2) * 0.06 * strength;
      frame.pose.squash = bounce * 0.45;
      break;
    }
    case 'sleepTransition':
      frame.pose.lie = easeInOut(p) * 0.45;
      frame.expression.eyeOpen = 1 - easeInOut(p);
      frame.root.y = easeInOut(p) * 8;
      break;
    case 'sleepCycle':
      frame.pose.breath = wave * 0.3;
      frame.pose.lie = 0.48;
      frame.root.y = wave * 1.5;
      break;
    case 'wakeStretch':
      frame.expression.eyeOpen = easeOut(p);
      frame.pose.stretch = Math.sin(p * Math.PI);
      frame.root.y = -Math.sin(p * Math.PI) * 7;
      break;
    case 'fadeSlide':
      if (definition.id === 'exit') {
        const amount = easeIn(Math.min(1, elapsed / Math.max(0.001, definition.durationMs / 1000)));
        frame.root.opacity = 1 - amount;
        frame.root.y = -amount * 14;
        frame.root.scaleX = 1 - amount * 0.12;
        frame.root.scaleY = 1 - amount * 0.12;
      } else {
        const amount = easeOut(p);
        frame.root.opacity = amount;
        frame.root.y = (1 - amount) * 32;
        frame.root.scaleX = 0.72 + amount * 0.28;
        frame.root.scaleY = 0.72 + amount * 0.28;
      }
      break;
    case 'jumpArc': {
      const arc = Math.sin(p * Math.PI);
      frame.root.y = -arc * 68;
      frame.pose.airborne = arc;
      frame.pose.crouch = p < 0.12 ? 1 - p / 0.12 : 0;
      frame.pose.squash = Math.sin(Math.min(1, p * 4) * Math.PI) * 0.4;
      frame.shadow.scaleX = 1 - arc * 0.42;
      frame.shadow.opacity = 0.35 - arc * 0.18;
      break;
    }
    case 'takeOff':
      frame.pose.crouch = 1 - easeOut(p);
      frame.root.y = -easeIn(p) * 30;
      frame.pose.airborne = easeIn(p);
      frame.pose.squash = Math.sin(p * Math.PI) * 0.55;
      break;
    case 'landSquash': {
      const impact = Math.sin(p * Math.PI);
      frame.pose.squash = impact;
      frame.root.scaleX = 1 + impact * 0.16;
      frame.root.scaleY = 1 - impact * 0.2;
      frame.root.y = -impact * 5;
      break;
    }
    case 'tumble':
      frame.root.rotation = easeInOut(p) * Math.PI * direction;
      frame.root.y = -Math.sin(p * Math.PI) * 22;
      frame.pose.airborne = Math.sin(p * Math.PI);
      frame.pose.lie = easeInOut(p);
      break;
    case 'recover':
      frame.pose.lie = 1 - easeInOut(p);
      frame.pose.crouch = Math.sin(p * Math.PI) * 0.55;
      frame.root.rotation = (1 - easeOut(p)) * 0.35 * direction;
      break;
    case 'sit':
      frame.pose.sit = easeInOut(p);
      frame.pose.crouch = Math.sin(p * Math.PI) * 0.35;
      frame.root.y = easeInOut(p) * 14;
      break;
    case 'stand': {
      const standing = easeInOut(p);
      frame.pose.sit = 1 - standing;
      frame.pose.lie = definition.id === 'riseFromLie' ? 1 - standing : 0;
      frame.root.y = (1 - standing) * 14;
      break;
    }
    case 'lie':
      frame.pose.lie = easeInOut(p);
      frame.root.y = easeInOut(p) * 18;
      frame.root.rotation = easeInOut(p) * 0.18 * direction;
      break;
    case 'slide':
      frame.root.x = direction * easeOut(p) * 80;
      frame.pose.lean = direction * Math.sin(p * Math.PI) * 0.35;
      frame.root.rotation = direction * Math.sin(p * Math.PI) * 0.12;
      break;
    case 'edgeClimb':
      frame.root.y = -frame.action.phase * 46;
      frame.pose.primaryLimb = Math.sin(phase) * 0.9;
      frame.pose.secondaryLimb = -frame.pose.primaryLimb;
      frame.pose.lean = direction * 0.25;
      break;
    case 'edgeHold':
      frame.pose.primaryLimb = 1;
      frame.pose.secondaryLimb = 0.85;
      frame.pose.lean = direction * 0.3;
      frame.root.y = Math.sin(time * 4) * 2;
      break;
    case 'peek':
      frame.root.x = direction * (38 - Math.sin(phase) * 7);
      frame.expression.look.x = -direction * 0.9;
      frame.pose.headTilt = -direction * 0.22;
      break;
    case 'falling':
      frame.root.y = 8 + frame.action.phase * 48;
      frame.root.rotation = Math.sin(phase) * 0.14;
      frame.pose.airborne = 1;
      break;
    case 'collisionPush': {
      const pushX = context.windowPush?.x ?? direction * 28;
      const pushY = context.windowPush?.y ?? 0;
      frame.root.x = pushX * Math.sin(p * Math.PI);
      frame.root.y = pushY * Math.sin(p * Math.PI);
      frame.pose.squash = Math.sin(p * Math.PI) * strength;
      break;
    }
    case 'pointerTracking':
      frame.expression.look = { x: pointerX, y: pointerY };
      frame.pose.headTilt = pointerX * 0.18;
      break;
    case 'shake':
      frame.root.x = Math.sin(time * 28) * 4 * strength;
      frame.root.rotation = Math.sin(time * 22) * 0.06 * strength;
      frame.pose.tailSwing = Math.sin(time * 25) * strength;
      break;
    case 'petting':
      frame.pose.headTilt = Math.sin(time * 3) * 0.08;
      frame.expression.eyeOpen = 0.25;
      frame.pose.breath = Math.sin(time * 2) * 0.2;
      break;
    case 'poke': {
      const indent = Math.sin(p * Math.PI);
      frame.root.x = pointerX * indent * 8;
      frame.root.scaleX = 1 - indent * 0.1;
      frame.root.scaleY = 1 - indent * 0.06;
      frame.pose.squash = indent;
      break;
    }
    case 'chase':
      frame.root.x = pointerX * 34;
      frame.root.y = pointerY * 12;
      frame.pose.gaitPhase = frame.action.phase;
      frame.pose.gaitWeight = 1;
      frame.pose.lean = pointerX * 0.3;
      frame.expression.look = { x: pointerX, y: pointerY };
      break;
    case 'reach':
      frame.expression.look = { x: pointerX, y: pointerY };
      frame.pose.primaryLimb = easeOut(p) * (pointerX < 0 ? -1 : 1);
      frame.root.x = pointerX * Math.sin(p * Math.PI) * 18;
      break;
    case 'perch':
      frame.root.x = clamp(context.pointerLocal.x * 0.22, -42, 42);
      frame.root.y = clamp(context.pointerLocal.y * 0.18 - 8, -35, 22);
      frame.pose.sit = 1;
      frame.expression.look = { x: pointerX, y: pointerY };
      break;
    case 'push':
      frame.expression.look = { x: pointerX, y: pointerY };
      frame.pose.primaryLimb = Math.sin(p * Math.PI) * (pointerX < 0 ? -1 : 1);
      frame.root.x = -pointerX * Math.sin(p * Math.PI) * 12;
      frame.pose.lean = pointerX * 0.4;
      break;
    case 'emote':
      frame.root.y = -Math.abs(wave) * 6 * strength;
      frame.pose.headTilt = Math.sin(time * 2.2) * 0.15 * strength;
      frame.pose.tailSwing = Math.sin(time * 5) * 0.65 * strength;
      break;
    case 'consume':
      frame.pose.headTilt = 0.12 + Math.sin(time * 8) * 0.08;
      frame.expression.mouth = Math.sin(time * 9) > 0 ? 'open' : 'small';
      frame.pose.primaryLimb = 0.55;
      break;
    case 'handoff':
      frame.pose.primaryLimb = easeOut(p);
      frame.pose.secondaryLimb = easeOut(p) * 0.7;
      frame.expression.look = { x: 0.5 * direction, y: 0.2 };
      break;
    case 'refusal':
      frame.pose.headTilt = Math.sin(p * Math.PI * 5) * 0.25;
      frame.root.x = Math.sin(p * Math.PI * 5) * 4;
      break;
    case 'bathe':
      frame.root.y = wave * 2;
      frame.pose.primaryLimb = Math.sin(phase * 2) * 0.7;
      frame.pose.secondaryLimb = -frame.pose.primaryLimb;
      break;
    case 'groom':
      frame.pose.primaryLimb = Math.sin(p * Math.PI * 6) * 0.8;
      frame.pose.headTilt = -0.12;
      break;
    case 'propUse':
      frame.pose.primaryLimb = 0.55 + wave * 0.12;
      frame.pose.secondaryLimb = 0.38 - wave * 0.1;
      frame.expression.look = { x: 0.18 * direction, y: 0.35 };
      frame.pose.headTilt = wave * 0.08;
      if (definition.id === 'playToy') {
        frame.pose.crouch = 0.22 + Math.abs(wave) * 0.2;
        frame.root.x = wave * 5;
        frame.expression.look = { x: wave * 0.45, y: 0.45 };
        frame.pose.tailSwing = Math.sin(time * 7) * 0.8;
      } else if (definition.id === 'readBook') {
        frame.pose.sit = 1;
        frame.root.y = 14;
        frame.pose.primaryLimb = 0.46 + wave * 0.04;
        frame.pose.secondaryLimb = 0.46 - wave * 0.04;
        frame.expression.look = { x: 0.08 * direction, y: 0.62 };
        frame.expression.eyeOpen = 0.78;
        frame.pose.headTilt = 0.1;
      } else if (definition.id === 'usePhone') {
        frame.pose.sit = 0.78;
        frame.root.y = 11;
        frame.expression.look = { x: 0.14 * direction, y: 0.55 };
        frame.expression.eyeOpen = 0.68 + wave * 0.08;
        frame.pose.headTilt = 0.14;
      } else if (definition.id === 'listenMusic') {
        frame.pose.sit = 0.38;
        frame.root.y = -Math.abs(Math.sin(time * 4)) * 4;
        frame.pose.headTilt = Math.sin(time * 3) * 0.18;
        frame.pose.tailSwing = Math.sin(time * 6) * 0.9;
        frame.expression.eyes = 'happy';
        frame.expression.eyeOpen = 0.72;
      } else if (definition.id === 'holdSign') {
        frame.pose.primaryLimb = 0.92;
        frame.pose.secondaryLimb = 0.82;
        frame.expression.look = { x: 0, y: -0.18 };
      } else if (definition.id === 'unwrapGift') {
        frame.pose.crouch = Math.sin(p * Math.PI) * 0.38;
        frame.root.y = -Math.abs(Math.sin(p * Math.PI * 3)) * 5;
      }
      break;
    case 'exercise':
      frame.root.y = -Math.abs(wave) * 11;
      frame.pose.primaryLimb = wave;
      frame.pose.secondaryLimb = -wave;
      frame.pose.squash = Math.abs(wave) * 0.45;
      break;
    case 'illness':
      frame.root.x = Math.sin(time * 9) * 1.5;
      frame.pose.headTilt = 0.16;
      frame.pose.breath = wave * 0.12;
      frame.root.scaleX = 0.97;
      frame.root.scaleY = 0.97;
      break;
    case 'transform': {
      const pulse = Math.sin(p * Math.PI * 4) * (1 - p) * strength;
      frame.root.scaleX = 1 + pulse * 0.12;
      frame.root.scaleY = 1 + pulse * 0.12;
      frame.root.rotation = Math.sin(p * Math.PI * 2) * 0.08;
      break;
    }
    case 'attention':
      frame.root.y = -Math.abs(Math.sin(p * Math.PI * 3)) * 8 * strength;
      frame.pose.primaryLimb = Math.sin(p * Math.PI) * 0.9;
      frame.pose.lean = direction * 0.2;
      break;
    case 'thinking':
      frame.pose.headTilt = 0.16 + wave * 0.03;
      frame.expression.look = { x: 0.35, y: -0.4 };
      break;
    case 'searching':
      frame.expression.look.x = wave;
      frame.pose.headTilt = wave * 0.14;
      frame.pose.primaryLimb = 0.35;
      break;
    case 'loading':
      frame.pose.breath = wave * 0.22;
      frame.expression.eyeOpen = 0.7 + wave * 0.12;
      break;
    case 'speaking':
      frame.expression.mouth = Math.sin(time * 12) > 0 ? 'open' : 'smile';
      frame.pose.headTilt = Math.sin(time * 3) * 0.08;
      break;
    case 'writing':
      frame.pose.primaryLimb = Math.sin(p * Math.PI * 8) * 0.45;
      frame.expression.look = { x: 0.2, y: 0.5 };
      frame.pose.headTilt = 0.1;
      break;
    case 'timer':
      frame.pose.primaryLimb = Math.sin(p * Math.PI) * 0.7;
      frame.root.y = -Math.sin(p * Math.PI) * 5;
      break;
    case 'focus':
      frame.expression.look = { x: 0.1, y: 0.25 };
      frame.expression.eyeOpen = 0.78;
      frame.pose.breath = wave * 0.1;
      frame.pose.headTilt = 0.04;
      break;
    case 'alarm':
      frame.root.x = Math.sin(time * 28) * 5;
      frame.root.y = -Math.abs(wave) * 7;
      frame.pose.primaryLimb = wave;
      break;
    case 'celebrate':
      frame.root.y = -Math.abs(Math.sin(p * Math.PI * 4)) * 16;
      frame.root.rotation = Math.sin(p * Math.PI * 4) * 0.1;
      frame.pose.primaryLimb = Math.sin(p * Math.PI * 6) * 0.9;
      frame.pose.secondaryLimb = -frame.pose.primaryLimb;
      frame.pose.tailSwing = Math.sin(time * 12);
      break;
    case 'error':
      frame.root.rotation = Math.sin(p * Math.PI * 4) * 0.12 * (1 - p);
      frame.pose.headTilt = 0.2;
      frame.pose.lie = p > 0.72 ? (p - 0.72) / 0.28 * 0.4 : 0;
      break;
    case 'disconnect':
      frame.root.x = Math.sin(time * 8) * 2;
      frame.root.rotation = Math.sin(time * 6) * 0.04;
      frame.pose.headTilt = 0.18;
      frame.pose.breath = wave * 0.08;
      break;
    case 'weather':
      frame.pose.primaryLimb = 0.82;
      frame.pose.secondaryLimb = 0.35;
      frame.root.x = Math.sin(time * 3) * 2;
      frame.pose.headTilt = -0.08;
      break;
    case 'idlePlay':
      frame.root.y = -Math.abs(Math.sin(phase * 1.5)) * 8;
      frame.root.rotation = Math.sin(phase) * 0.12;
      frame.pose.primaryLimb = Math.sin(phase * 2) * 0.8;
      frame.pose.secondaryLimb = Math.cos(phase * 2) * 0.65;
      frame.pose.tailSwing = Math.sin(phase * 2.5) * 0.8;
      break;
    case 'transition':
      frame.pose.squash = Math.sin(p * Math.PI) * 0.28;
      frame.root.y = -Math.sin(p * Math.PI) * 3;
      if (definition.id === 'idleToSit') frame.pose.sit = easeInOut(p);
      if (definition.id === 'sitToIdle') frame.pose.sit = 1 - easeInOut(p);
      if (definition.id === 'takeOffToAirborne') frame.pose.airborne = easeInOut(p);
      if (definition.id === 'airborneToLand') frame.pose.airborne = 1 - easeInOut(p);
      if (definition.id === 'idleToExit') frame.root.opacity = 1 - p * 0.15;
      break;
    case 'hidden':
      frame.root.opacity = 0;
      frame.shadow.opacity = 0;
      break;
  }
}

function applyReducedMotion(frame: PetFrame, context: AnimationContext): void {
  if (!context.reducedMotion) return;
  const followsPointer = DRAG_ACTIONS.has(frame.action.id);
  frame.root.x = followsPointer ? frame.root.x : 0;
  frame.root.y = followsPointer ? frame.root.y : 0;
  frame.root.rotation = 0;
  frame.root.scaleX = 1;
  frame.root.scaleY = 1;
  frame.pose.breath = 0;
  frame.pose.stretch = 0;
  frame.pose.crouch = 0;
  frame.pose.headTilt = 0;
  frame.pose.tailSwing = 0;
  frame.pose.primaryLimb = 0;
  frame.pose.secondaryLimb = 0;
  frame.pose.gaitPhase = 0;
  frame.pose.gaitWeight = 0;
  frame.pose.squash = 0;
  frame.pose.lean = 0;
  for (const effect of frame.effects) {
    effect.intensity = Math.min(effect.intensity, 0.25);
    effect.offset = { x: 0, y: 0 };
  }
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function sanitizeFrame(frame: PetFrame): PetFrame {
  frame.action.elapsedSeconds = Math.max(0, finite(frame.action.elapsedSeconds));
  frame.action.progress = clamp(frame.action.progress, 0, 1);
  frame.action.phase = clamp(frame.action.phase, 0, 1);
  frame.root.x = finite(frame.root.x);
  frame.root.y = finite(frame.root.y);
  frame.root.rotation = finite(frame.root.rotation);
  frame.root.scaleX = clamp(frame.root.scaleX, 0.01, 4);
  frame.root.scaleY = clamp(frame.root.scaleY, 0.01, 4);
  frame.root.opacity = clamp(frame.root.opacity, 0, 1);
  for (const key of Object.keys(frame.pose) as (keyof PetFrame['pose'])[]) {
    frame.pose[key] = clamp(frame.pose[key], -2, 2);
  }
  frame.expression.eyeOpen = clamp(frame.expression.eyeOpen, 0, 1);
  frame.expression.look.x = clamp(frame.expression.look.x, -1, 1);
  frame.expression.look.y = clamp(frame.expression.look.y, -1, 1);
  frame.expression.blush = clamp(frame.expression.blush, 0, 1);
  frame.shadow.opacity = clamp(frame.shadow.opacity, 0, 1);
  frame.shadow.scaleX = clamp(frame.shadow.scaleX, 0.05, 3);
  frame.shadow.scaleY = clamp(frame.shadow.scaleY, 0.05, 3);
  frame.shadow.offsetY = finite(frame.shadow.offsetY);
  for (const effect of frame.effects) {
    effect.progress = clamp(effect.progress, 0, 1);
    effect.intensity = clamp(effect.intensity, 0, 1);
    effect.opacity = clamp(effect.opacity, 0, 1);
    effect.offset.x = finite(effect.offset.x);
    effect.offset.y = finite(effect.offset.y);
  }
  for (const prop of frame.props) {
    prop.progress = clamp(prop.progress, 0, 1);
    prop.opacity = clamp(prop.opacity, 0, 1);
    prop.scale = clamp(prop.scale, 0.05, 4);
    prop.rotation = finite(prop.rotation);
    prop.offset.x = finite(prop.offset.x);
    prop.offset.y = finite(prop.offset.y);
  }
  return frame;
}

function routeFor(from: PetActionId, target: PetActionId): PetActionId[] | null {
  if (from === 'idle') {
    if (target === 'walkLeft' || target === 'walkRight' || target === 'runLeft' || target === 'runRight') {
      return ['idleToWalk', target];
    }
    if (target === 'sitDown') return ['idleToSit', 'sitDown'];
    if (target === 'sleepIn') return ['idleToSleep', 'sleepIn'];
    if (target === 'exit') return ['idleToExit', 'exit'];
  }
  if (WALK_ACTIONS.has(from)) {
    if (target === 'idle' || target === 'stopWalking') return ['walkToIdle', 'idle'];
    if (WALK_ACTIONS.has(target) && from !== target) {
      const turn: PetActionId = target.endsWith('Left') ? 'turnLeft' : 'turnRight';
      return ['walkToTurn', turn, 'turnToWalk', target];
    }
  }
  if (from === 'sittingLoop' && (target === 'standUp' || target === 'idle')) {
    return ['sitToIdle', target === 'standUp' ? 'standUp' : 'idle'];
  }
  if (from === 'lyingLoop' && (target === 'riseFromLie' || target === 'idle')) {
    return target === 'riseFromLie' ? ['riseFromLie'] : ['riseFromLie', 'idle'];
  }
  if (SLEEP_ACTIONS.has(from) && (target === 'wake' || target === 'idle')) {
    return ['sleepToWake', target === 'wake' ? 'wake' : 'idle'];
  }
  if (DRAG_ACTIONS.has(from) && target === 'drop') return ['dragToDrop', 'drop'];
  if (from === 'airborneLoop' && target === 'land') return ['airborneToLand', 'land'];
  return null;
}

export class PetAnimator {
  private actionId: PetActionId = 'enter';
  private queue: PetActionId[] = [];
  private startedAt = 0;
  private petX = 0;
  private facing: PetFacing = 1;
  private autoBlinkAt = 0;
  private autoVariationAt = 0;
  private variationIndex = 0;

  constructor(
    private readonly reducedMotion = false,
    private readonly random: () => number = Math.random,
  ) {}

  start(now: number): void {
    const safeNow = finite(now);
    this.actionId = 'enter';
    this.queue = [];
    this.startedAt = safeNow;
    this.petX = 0;
    this.facing = 1;
    this.autoBlinkAt = safeNow + randomBetween(2_000, 5_000, this.random);
    this.autoVariationAt = safeNow + randomBetween(8_000, 15_000, this.random);
  }

  play(id: PetAnimationId, now: number): void {
    if (id === this.actionId && this.queue.length === 0) return;
    const route = PET_ANIMATION_CONFIG[this.actionId].loop
      ? routeFor(this.actionId, id)
      : null;
    if (route && route.length > 0) {
      this.startSequence(route, now);
      return;
    }
    this.queue = [];
    this.setAction(id, now);
  }

  setMoodOrAnimation(
    mood: PetMood,
    animation: PetAnimationId | undefined,
    now: number,
  ): void {
    const target = animation ?? MOOD_ANIMATION[mood];
    if (animation) {
      this.play(target, now);
      return;
    }
    if (target === this.actionId) return;
    const config = PET_ANIMATION_CONFIG[this.actionId];
    if (config.loop || this.actionId === 'exit') this.play(target, now);
  }

  notifyInteraction(now: number): void {
    if (SLEEP_ACTIONS.has(this.actionId)) this.play('wake', now);
  }

  getCurrentAction(): PetAnimationId {
    return this.actionId;
  }

  getFacing(): PetFacing {
    return this.facing;
  }

  private startSequence(route: readonly PetActionId[], now: number): void {
    const [first, ...rest] = route;
    if (!first) return;
    this.queue = rest;
    this.setAction(first, now, false);
  }

  private setAction(id: PetActionId, now: number, clearQueue = true): void {
    if (clearQueue) this.queue = [];
    if (id === 'turnLeft' || id === 'walkLeft' || id === 'runLeft') this.facing = -1;
    if (id === 'turnRight' || id === 'walkRight' || id === 'runRight') this.facing = 1;
    this.actionId = id;
    this.startedAt = finite(now);
    if (id === 'enter') {
      this.petX = 0;
      this.facing = 1;
    }
  }

  private advanceCompletedActions(now: number): void {
    for (let guard = 0; guard < 32; guard += 1) {
      const config = PET_ANIMATION_CONFIG[this.actionId];
      if (config.loop) return;
      const durationMs = Math.max(1, config.duration * 1000);
      if (now - this.startedAt < durationMs) return;
      const completedAt = this.startedAt + durationMs;
      const queued = this.queue.shift();
      const next = queued ?? config.next ?? 'idle';
      this.setAction(next, completedAt, false);
    }
  }

  private scheduleIdle(now: number): void {
    if (this.actionId === 'idle' && now >= this.autoBlinkAt) {
      this.setAction('blink', now);
      this.autoBlinkAt = now + randomBetween(2_000, 5_000, this.random);
      return;
    }
    if (this.actionId === 'idle' && now >= this.autoVariationAt) {
      const variations: readonly PetActionId[] = ['lookAround', 'stretch', 'yawn'];
      const selected = variations[this.variationIndex % variations.length] ?? 'lookAround';
      this.variationIndex += 1;
      this.setAction(selected, now);
      this.autoVariationAt = now + randomBetween(8_000, 15_000, this.random);
      return;
    }
  }

  private updatePersistentPosition(context: AnimationContext, now: number): void {
    const delta = clamp(context.deltaSeconds, 0, 0.1);
    if (WALK_ACTIONS.has(this.actionId)) {
      const isRun = this.actionId === 'runLeft' || this.actionId === 'runRight';
      const direction = this.actionId.endsWith('Left') ? -1 : 1;
      const speed = context.reducedMotion ? 0 : (isRun ? 160 : 60);
      this.petX += direction * speed * delta;
		const width = Math.max(120, finite(context.width, 400));
		const fallbackLimit = width * 0.35;
		const requestedMin = finite(
			context.travelBounds ? context.travelBounds.minX : -fallbackLimit,
			-fallbackLimit,
		);
		const requestedMax = finite(
			context.travelBounds ? context.travelBounds.maxX : fallbackLimit,
			fallbackLimit,
		);
		const minimumX = Math.min(requestedMin, requestedMax);
		const maximumX = Math.max(requestedMin, requestedMax);
		if (this.petX >= maximumX && direction > 0) {
			this.petX = maximumX;
			const target: PetActionId = isRun ? 'runLeft' : 'walkLeft';
			this.startSequence(['walkToTurn', 'turnLeft', 'turnToWalk', target], now);
		} else if (this.petX <= minimumX && direction < 0) {
			this.petX = minimumX;
        const target: PetActionId = isRun ? 'runRight' : 'walkRight';
        this.startSequence(['walkToTurn', 'turnRight', 'turnToWalk', target], now);
      }
      return;
    }
    if (!DRAG_ACTIONS.has(this.actionId) && this.actionId !== 'enter' && this.actionId !== 'exit') {
      this.petX *= Math.max(0, 1 - delta * 2);
      if (Math.abs(this.petX) < 0.01) this.petX = 0;
    }
  }

  update(context: AnimationContext, now: number): PetFrame {
    const safeNow = finite(now, this.startedAt);
    this.advanceCompletedActions(safeNow);
    this.scheduleIdle(safeNow);
    this.advanceCompletedActions(safeNow);
    this.updatePersistentPosition(context, safeNow);

    const elapsed = Math.max(0, (safeNow - this.startedAt) / 1000);
    const definition = getPetAction(this.actionId);
    const frame = createFrame(definition, elapsed, this.facing);
    frame.effects = buildEffects(definition, frame.action.progress, frame.action.phase);
    frame.props = buildProps(definition, frame.action.progress, context);
    applyActionExpression(frame, definition.id, finite(context.time, elapsed));
    // Template motion refines the semantic baseline (for example sleep eye-close).
    applyMotionTemplate(frame, definition, elapsed, context);

    if (!DRAG_ACTIONS.has(this.actionId) && this.actionId !== 'enter') {
      frame.root.x += this.petX;
    }
    applyReducedMotion(frame, {
      ...context,
      reducedMotion: this.reducedMotion || context.reducedMotion,
    });
    sanitizeFrame(frame);
    return frame;
  }
}
