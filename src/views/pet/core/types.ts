import type {
  PetActionId,
  PetVisualCue,
} from '../../../shared/pet-actions';

/** A normalized or canvas-space two dimensional vector, depending on the field. */
export interface PetVector2 {
  x: number;
  y: number;
}

export type PetFacing = -1 | 1;

/**
 * Expression names are semantic. A model may approximate an unsupported shape,
 * but animation code never needs to know how many eyes or mouths the model has.
 */
export type PetEyeExpression =
  | 'open'
  | 'closed'
  | 'happy'
  | 'angry'
  | 'sleepy'
  | 'surprised'
  | 'laugh'
  | 'shy'
  | 'wronged'
  | 'afraid'
  | 'confused'
  | 'proud'
  | 'love'
  | 'dizzy'
  | 'wink';

export type PetMouthExpression =
  | 'smile'
  | 'flat'
  | 'frown'
  | 'open'
  | 'small'
  | 'yawn'
  | 'grin'
  | 'pout'
  | 'o'
  | 'wavy'
  | 'laugh';

/** A renderer-selected colour treatment, independent of any concrete palette. */
export type PetTone =
  | 'neutral'
  | 'happy'
  | 'busy'
  | 'error'
  | 'angry'
  | 'sleepy'
  | 'love'
  | 'shy'
  | 'proud'
  | 'confused'
  | 'afraid'
  | 'focused'
  | 'sick'
  | 'celebration';

export type PetAnchorId =
  | 'headTop'
  | 'face'
  | 'mouth'
  | 'bodyCenter'
  | 'primaryGrip'
  | 'secondaryGrip'
  | 'back'
  | 'ground'
  | 'message';

export type PetHitZone = 'head' | 'face' | 'body' | 'tail' | 'limb';

export interface PetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetModelSkeleton {
  /** Model-local bounds used by window sizing and conservative hit testing. */
  visualBounds: PetRect;
  /** Model-local point which should meet the scene ground line. */
  groundAnchor: PetVector2;
  anchors: readonly PetAnchorId[];
  hitZones: readonly PetHitZone[];
}

export interface PetModelTheme {
  /** Renderer-specific colour tokens; animation code never reads these. */
  readonly colors: Readonly<Record<string, string>>;
}

/**
 * Props describe purpose, not artwork. A renderer can use vectors, sprites,
 * emoji, Live2D attachments, or ignore an optional prop it cannot represent.
 */
export type PetPropKind =
  | 'food'
  | 'drink'
  | 'towel'
  | 'brush'
  | 'toy'
  | 'book'
  | 'phone'
  | 'headphones'
  | 'medicine'
  | 'gift'
  | 'outfit'
  | 'sign'
  | 'notification'
  | 'magnifier'
  | 'notebook'
  | 'timer'
  | 'alarm'
  | 'umbrella'
  | 'fan'
  | 'holiday'
  | 'mystery';

export interface PetProp {
  kind: PetPropKind;
  anchor: PetAnchorId;
  /** Optional text supplied by a controller, for example a reminder sign. */
  text?: string;
  /** Normalized per-action progress, useful for opening or handing off props. */
  progress: number;
  opacity: number;
  scale: number;
  rotation: number;
  offset: PetVector2;
}

export interface PetEffect {
  kind: PetVisualCue;
  anchor: PetAnchorId;
  progress: number;
  intensity: number;
  opacity: number;
  offset: PetVector2;
}

/**
 * The single model-independent output of the animation engine. All values are
 * finite; pose/expression weights are normally in [-1, 1] or [0, 1].
 */
export interface PetFrame {
  action: {
    id: PetActionId;
    elapsedSeconds: number;
    /** 0..1 within the current cycle. */
    progress: number;
    /** 0..1 repeating phase, including for non-looping actions. */
    phase: number;
    visualCues: readonly PetVisualCue[];
  };
  root: {
    /** Canvas-space offset owned by the animation, not by the model. */
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    facingX: PetFacing;
    opacity: number;
  };
  pose: {
    breath: number;
    stretch: number;
    crouch: number;
    sit: number;
    lie: number;
    headTilt: number;
    tailSwing: number;
    primaryLimb: number;
    secondaryLimb: number;
    gaitPhase: number;
    gaitWeight: number;
    airborne: number;
    squash: number;
    lean: number;
  };
  expression: {
    eyes: PetEyeExpression;
    eyeOpen: number;
    /** Normalized gaze vector in the range -1..1. */
    look: PetVector2;
    mouth: PetMouthExpression;
    blush: number;
  };
  tone: PetTone;
  effects: PetEffect[];
  props: PetProp[];
  shadow: {
    opacity: number;
    scaleX: number;
    scaleY: number;
    offsetY: number;
  };
}

/** Replaceable drawing/hit-testing adapter consumed by the shared scene. */
export interface PetModel {
  readonly id: string;
  readonly label: string;
  readonly skeleton: PetModelSkeleton;
  readonly theme: PetModelTheme;
  preload?(): Promise<void>;
  draw(context: CanvasRenderingContext2D, frame: PetFrame): void;
  hitTest(localPoint: PetVector2, frame: PetFrame, padding?: number): PetHitZone | null;
  resolveAnchor(anchor: PetAnchorId, frame: PetFrame): PetVector2;
}
