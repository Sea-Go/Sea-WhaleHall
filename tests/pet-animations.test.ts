import { describe, expect, test } from 'bun:test';
import {
  PET_ACTION_CATALOG,
  PET_ACTION_IDS,
} from '../src/shared/pet-actions';
import {
  PET_ANIMATION_CONFIG,
  PetAnimator,
  type AnimationContext,
  type PetFrame,
} from '../src/views/pet/animations';

function buildContext(overrides: Partial<AnimationContext> = {}): AnimationContext {
  return {
    width: 400,
    height: 300,
    time: 0,
    deltaSeconds: 1 / 60,
    reducedMotion: false,
    pointerLocal: { x: 0, y: 0 },
    hoverAmount: 0,
    pressAmount: 0,
    ...overrides,
  };
}

function expectFiniteTree(value: unknown, path = 'frame'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} should be finite`).toBe(true);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expectFiniteTree(child, `${path}.${key}`);
  }
}

function readyAnimator(at = 1_100): PetAnimator {
  const animator = new PetAnimator();
  animator.start(0);
  animator.update(buildContext({ time: at / 1000 }), at);
  expect(animator.getCurrentAction()).toBe('idle');
  return animator;
}

describe('canonical semantic animation contract', () => {
  test('has timing configuration for every canonical action and no extras', () => {
    expect(new Set(Object.keys(PET_ANIMATION_CONFIG))).toEqual(new Set(PET_ACTION_IDS));
    for (const definition of PET_ACTION_CATALOG) {
      const config = PET_ANIMATION_CONFIG[definition.id];
      expect(config.duration).toBe(definition.durationMs / 1000);
      expect(config.duration).toBeGreaterThan(0);
      expect(typeof config.loop).toBe('boolean');
    }
  });

  test('every action starts and produces a finite model-independent frame', () => {
    for (const definition of PET_ACTION_CATALOG) {
      const animator = new PetAnimator();
      animator.start(0);
      if (definition.id !== 'enter') animator.play(definition.id, 1);
      const now = definition.id === 'enter'
        ? Math.max(1, definition.durationMs / 2)
        : 1 + Math.max(1, definition.durationMs / 2);
      const frame = animator.update(buildContext({
        time: now / 1000,
        pointerLocal: { x: 42, y: -23 },
        pointerVelocity: { x: 4, y: -2 },
        dragDelta: { x: 8, y: 5 },
        windowPush: { x: -15, y: 3 },
        message: '喝水时间',
      }), now);

      expect(frame.action.id, definition.id).toBe(definition.id);
      expect(frame.action.visualCues).toEqual(definition.visualCues);
      expect(frame.root.facingX === -1 || frame.root.facingX === 1).toBe(true);
      expect(frame.root.opacity).toBeGreaterThanOrEqual(0);
      expect(frame.root.opacity).toBeLessThanOrEqual(1);
      expect(frame.expression.eyeOpen).toBeGreaterThanOrEqual(0);
      expect(frame.expression.eyeOpen).toBeLessThanOrEqual(1);
      expect(frame.expression.look.x).toBeGreaterThanOrEqual(-1);
      expect(frame.expression.look.x).toBeLessThanOrEqual(1);
      expect(frame.expression.look.y).toBeGreaterThanOrEqual(-1);
      expect(frame.expression.look.y).toBeLessThanOrEqual(1);
      expectFiniteTree(frame, `frame(${definition.id})`);
      if (definition.channels.includes('prop')) {
        expect(frame.props.length, `${definition.id} should expose a semantic prop`).toBeGreaterThan(0);
      }
    }
  });

  test('sanitizes hostile/non-finite controller inputs', () => {
    const animator = new PetAnimator();
    animator.start(0);
    animator.play('dragged', 1);
    const frame = animator.update(buildContext({
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
      time: Number.NaN,
      deltaSeconds: Number.NEGATIVE_INFINITY,
      pointerLocal: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      windowPush: { x: Number.NaN, y: Number.NEGATIVE_INFINITY },
    }), Number.NaN);
    expectFiniteTree(frame);
  });

  test('semantic channels contain no species-specific anatomy', () => {
    const frame = readyAnimator().update(buildContext({ time: 1.2 }), 1_200);
    expect(Object.keys(frame)).toEqual([
      'action', 'root', 'pose', 'expression', 'tone', 'effects', 'props', 'shadow',
    ]);
    expect(Object.keys(frame.pose)).toEqual([
      'breath', 'stretch', 'crouch', 'sit', 'lie', 'headTilt', 'tailSwing',
      'primaryLimb', 'secondaryLimb', 'gaitPhase', 'gaitWeight', 'airborne',
      'squash', 'lean',
    ]);
  });
});

describe('PetAnimator lifecycle and transitions', () => {
  test('starts with enter, bridges through enterToIdle, then idles', () => {
    const animator = new PetAnimator();
    animator.start(0);
    expect(animator.getCurrentAction()).toBe('enter');
    animator.update(buildContext({ time: 0.73 }), 730);
    expect(animator.getCurrentAction()).toBe('enterToIdle');
    const frame = animator.update(buildContext({ time: 1.05 }), 1_050);
    expect(animator.getCurrentAction()).toBe('idle');
    expect(frame.root.opacity).toBe(1);
  });

  test('routes idle -> walk and walk -> idle through transition actions', () => {
    const animator = readyAnimator();
    animator.play('walkLeft', 1_100);
    expect(animator.getCurrentAction()).toBe('idleToWalk');
    animator.update(buildContext({ time: 1.43 }), 1_430);
    expect(animator.getCurrentAction()).toBe('walkLeft');
    expect(animator.getFacing()).toBe(-1);

    animator.play('idle', 1_500);
    expect(animator.getCurrentAction()).toBe('walkToIdle');
    animator.update(buildContext({ time: 1.93 }), 1_930);
    expect(animator.getCurrentAction()).toBe('idle');
  });

  test('routes sit and sleep through their stable semantic poses', () => {
    const sitting = readyAnimator();
    sitting.play('sitDown', 1_100);
    expect(sitting.getCurrentAction()).toBe('idleToSit');
    sitting.update(buildContext({ time: 1.63 }), 1_630);
    expect(sitting.getCurrentAction()).toBe('sitDown');
    const sitFrame = sitting.update(buildContext({ time: 2.29 }), 2_290);
    expect(sitting.getCurrentAction()).toBe('sittingLoop');
    expect(sitFrame.pose.sit).toBe(1);

    const sleeping = readyAnimator();
    sleeping.play('sleepIn', 1_100);
    expect(sleeping.getCurrentAction()).toBe('idleToSleep');
    sleeping.update(buildContext({ time: 2.16 }), 2_160);
    expect(sleeping.getCurrentAction()).toBe('sleepIn');
    const sleepFrame = sleeping.update(buildContext({ time: 3.37 }), 3_370);
    expect(sleeping.getCurrentAction()).toBe('sleepLoop');
    expect(sleepFrame.expression.eyes).toBe('closed');
  });

  test('drop and airborne transitions preserve requested sequence', () => {
    const drag = new PetAnimator();
    drag.start(0);
    drag.play('dragged', 1);
    drag.play('drop', 20);
    expect(drag.getCurrentAction()).toBe('dragToDrop');
    drag.update(buildContext({ time: 0.33 }), 330);
    expect(drag.getCurrentAction()).toBe('drop');
    drag.update(buildContext({ time: 1 }), 1_000);
    expect(drag.getCurrentAction()).toBe('idle');

    const jump = new PetAnimator();
    jump.start(0);
    jump.play('takeOff', 1);
    jump.update(buildContext({ time: 0.27 }), 270);
    expect(jump.getCurrentAction()).toBe('takeOffToAirborne');
    jump.update(buildContext({ time: 0.46 }), 460);
    expect(jump.getCurrentAction()).toBe('airborneLoop');
    expect(jump.update(buildContext({ time: 0.5 }), 500).pose.airborne).toBe(1);
  });

  test('non-looping actions accept immediate user overrides', () => {
    const animator = readyAnimator();
    animator.play('blink', 2_000);
    animator.play('walkRight', 2_010);
    expect(animator.getCurrentAction()).toBe('walkRight');
  });
});

describe('movement, visibility, pointer and accessibility invariants', () => {
	test('walk/run motion remains bounded and reverses at both edges', () => {
    const animator = new PetAnimator();
    animator.start(0);
    animator.play('runRight', 1);
    let now = 1;
    let minimumX = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let sawLeft = false;
    let sawRight = false;

    for (let index = 0; index < 3_000; index += 1) {
      now += 16;
      const frame = animator.update(buildContext({
        time: now / 1000,
        deltaSeconds: 0.016,
      }), now);
      minimumX = Math.min(minimumX, frame.root.x);
      maximumX = Math.max(maximumX, frame.root.x);
      sawLeft ||= animator.getFacing() === -1;
      sawRight ||= animator.getFacing() === 1;
    }

    expect(minimumX).toBeGreaterThanOrEqual(-140.001);
    expect(maximumX).toBeLessThanOrEqual(140.001);
    expect(sawLeft).toBe(true);
		expect(sawRight).toBe(true);
	});

	test('honors model-aware visual travel bounds from the scene', () => {
		const animator = new PetAnimator();
		animator.start(0);
		animator.play('runRight', 1);
		let now = 1;
		let minimumX = Number.POSITIVE_INFINITY;
		let maximumX = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < 2_000; index += 1) {
			now += 16;
			const frame = animator.update(buildContext({
				time: now / 1_000,
				deltaSeconds: 0.016,
				travelBounds: { minX: -34, maxX: 59 },
			}), now);
			minimumX = Math.min(minimumX, frame.root.x);
			maximumX = Math.max(maximumX, frame.root.x);
		}
		expect(minimumX).toBeGreaterThanOrEqual(-34.001);
		expect(maximumX).toBeLessThanOrEqual(59.001);
	});

  test('exit is terminal and stays invisible after its fade completes', () => {
    const animator = new PetAnimator();
    animator.start(0);
    animator.play('exit', 1);
    const settled = animator.update(buildContext({ time: 1 }), 1_000);
    const later = animator.update(buildContext({ time: 10 }), 10_000);
    expect(animator.getCurrentAction()).toBe('exit');
    expect(settled.root.opacity).toBe(0);
    expect(later.root.opacity).toBe(0);
  });

  test('pointer tracking is normalized and model-independent', () => {
    const animator = new PetAnimator();
    animator.start(0);
    animator.play('trackPointerGaze', 1);
    const frame = animator.update(buildContext({
      pointerLocal: { x: 900, y: -700 },
      time: 0.1,
    }), 100);
    expect(frame.expression.look).toEqual({ x: 1, y: -1 });
  });

  test('reduced motion removes continuous movement but keeps drag position and visibility', () => {
    const animator = new PetAnimator(true);
    animator.start(0);
    animator.play('runRight', 1);
    const first = animator.update(buildContext({
      reducedMotion: true,
      time: 1,
      deltaSeconds: 0.1,
    }), 1_000);
    const second = animator.update(buildContext({
      reducedMotion: true,
      time: 2,
      deltaSeconds: 0.1,
    }), 2_000);
    expect(first.root.x).toBe(0);
    expect(second.root.x).toBe(0);
    expect(second.root.rotation).toBe(0);
    expect(second.root.scaleX).toBe(1);
    expect(second.pose.tailSwing).toBe(0);

    animator.play('dragged', 2_010);
    const dragged = animator.update(buildContext({
      reducedMotion: true,
      pointerLocal: { x: 80, y: -30 },
    }), 2_020);
    expect(Math.abs(dragged.root.x) + Math.abs(dragged.root.y)).toBeGreaterThan(0);
    expect(dragged.root.rotation).toBe(0);
  });
});
