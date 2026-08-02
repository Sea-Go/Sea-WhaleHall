import { describe, expect, test } from 'bun:test';
import { modelLocalToCanvas } from '../src/views/pet/CanvasPetRenderer';
import type { PetFrame, PetModel, PetTone } from '../src/views/pet/core/types';
import { WHALE_THEME } from '../src/views/pet/models/whale';
import { CAT_MODEL, getPetModel, PET_MODELS, WHALE_MODEL } from '../src/views/pet/models/registry';
import { paletteForTone } from '../src/views/pet/models/shared';
import { canvasPointToLocal } from '../src/views/pet/pet-math';

const PET_TONES: readonly PetTone[] = [
  'neutral',
  'happy',
  'busy',
  'error',
  'angry',
  'sleepy',
  'love',
  'shy',
  'proud',
  'confused',
  'afraid',
  'focused',
  'sick',
  'celebration',
];

function frame(overrides: Partial<PetFrame['pose']> = {}): PetFrame {
  return {
    action: {
      id: 'idle',
      elapsedSeconds: 0,
      progress: 0,
      phase: 0,
      visualCues: ['pose'],
    },
    root: {
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      facingX: 1,
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
      ...overrides,
    },
    expression: {
      eyes: 'open',
      eyeOpen: 1,
      look: { x: 0, y: 0 },
      mouth: 'smile',
      blush: 0,
    },
    tone: 'neutral',
    effects: [],
    props: [],
    shadow: { opacity: 1, scaleX: 1, scaleY: 1, offsetY: 0 },
  };
}

function fakeCanvasContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(object, property) {
      if (property === 'createLinearGradient' || property === 'createRadialGradient') {
        return () => gradient;
      }
      const existing = object[String(property)];
      if (existing !== undefined) return existing;
      return () => undefined;
    },
    set(object, property, value) {
      object[String(property)] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function expectModelContract(model: PetModel): void {
  const pose = frame();
  const snapshot = structuredClone(pose);
  model.draw(fakeCanvasContext(), pose);
  for (const anchor of model.skeleton.anchors) {
    const point = model.resolveAnchor(anchor, pose);
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  }
  expect(pose).toEqual(snapshot);
}

describe('replaceable desktop-pet models', () => {
  test('registers a default whale and a distinct cat topology', () => {
    expect(PET_MODELS.map(({ id }) => id)).toEqual(['whale', 'cat']);
    expect(WHALE_MODEL.skeleton.visualBounds).not.toEqual(CAT_MODEL.skeleton.visualBounds);
    expect(getPetModel('cat')).toBe(CAT_MODEL);
    expect(getPetModel('missing-model')).toBe(WHALE_MODEL);
  });

  test('both models consume the same semantic frame without mutating it', () => {
    expectModelContract(WHALE_MODEL);
    expectModelContract(CAT_MODEL);
  });

  test('whale uses the sleeping body palette for every semantic tone', () => {
    const sleepingPalette = paletteForTone(WHALE_THEME, 'sleepy');
    expect(sleepingPalette).toEqual({
      primary: '#b3d8ec',
      secondary: '#6a9bd1',
      dark: '#3d6fa3',
      light: '#edf7ff',
      outline: '#063347',
      accent: '#ff8fab',
    });
    for (const tone of PET_TONES) {
      expect(paletteForTone(WHALE_THEME, tone)).toEqual(sleepingPalette);
    }
  });

  test('whale exposes face, head, body, tail and limb hit zones', () => {
    const pose = frame();
    expect(WHALE_MODEL.hitTest({ x: 65, y: -12 }, pose)).toBe('face');
    expect(WHALE_MODEL.hitTest({ x: 22, y: -46 }, pose)).toBe('head');
    expect(WHALE_MODEL.hitTest({ x: -30, y: 20 }, pose)).toBe('body');
    expect(WHALE_MODEL.hitTest({ x: -127, y: -28 }, pose)).toBe('tail');
    expect(WHALE_MODEL.hitTest({ x: 54, y: 61 }, pose)).toBe('limb');
    expect(WHALE_MODEL.hitTest({ x: 160, y: -90 }, pose)).toBeNull();
  });

  test('cat exposes independently shaped face, head, body, tail and limb zones', () => {
    const pose = frame();
    expect(CAT_MODEL.hitTest({ x: 45, y: -49 }, pose)).toBe('face');
    expect(CAT_MODEL.hitTest({ x: 18, y: -76 }, pose)).toBe('head');
    expect(CAT_MODEL.hitTest({ x: -24, y: 5 }, pose)).toBe('body');
    expect(CAT_MODEL.hitTest({ x: -87, y: -30 }, pose)).toBe('tail');
    expect(CAT_MODEL.hitTest({ x: 29, y: 57 }, pose)).toBe('limb');
    expect(CAT_MODEL.hitTest({ x: 125, y: -90 }, pose)).toBeNull();
  });

  test('hit testing and anchors follow model-local sit and lie poses', () => {
    for (const model of PET_MODELS) {
      const standing = frame();
      const sitting = frame({ sit: 1, crouch: 0.3 });
      const standingGround = model.resolveAnchor('ground', standing);
      const sittingGround = model.resolveAnchor('ground', sitting);
      expect(sittingGround.y).toBeGreaterThan(standingGround.y);
      expect(model.hitTest(model.resolveAnchor('face', sitting), sitting)).toBe('face');
    }
  });

  test('release padding expands hit zones without accepting far transparent space', () => {
    const pose = frame();
    expect(WHALE_MODEL.hitTest({ x: 49, y: -67 }, pose)).toBeNull();
    expect(WHALE_MODEL.hitTest({ x: 49, y: -67 }, pose, 8)).toBe('head');
    expect(CAT_MODEL.hitTest({ x: 45, y: -101 }, pose, 8)).toBe('head');
    expect(CAT_MODEL.hitTest({ x: 150, y: -100 }, pose, 20)).toBeNull();
  });

  test('the shared scene transform round-trips mirrored, rotated model points', () => {
    const pose = frame();
    pose.root.x = 17;
    pose.root.y = -12;
    pose.root.rotation = Math.PI / 7;
    pose.root.scaleX = 1.25;
    pose.root.scaleY = 0.82;
    pose.root.facingX = -1;
    const origin = { x: 180, y: 150 };
    const local = { x: 43, y: -27 };
    const canvas = modelLocalToCanvas(local, origin, pose);
    const roundTrip = canvasPointToLocal(canvas, {
      x: origin.x + pose.root.x,
      y: origin.y + pose.root.y,
      rotation: pose.root.rotation,
      scaleX: pose.root.scaleX * pose.root.facingX,
      scaleY: pose.root.scaleY,
    });
    expect(roundTrip.x).toBeCloseTo(local.x, 8);
    expect(roundTrip.y).toBeCloseTo(local.y, 8);
  });
});
