/**
 * Canonical desktop-pet animation verification.
 *
 * Drives every catalogue action through the real PetAnimator, validates the
 * semantic frame contract, then exercises transitions, boundaries, terminal
 * visibility and reduced-motion behaviour.
 *
 * Run: bun run scripts/verify-pet-animations.ts
 */
import {
  PET_ACTION_CATALOG,
  PET_ACTION_IDS,
  type PetActionId,
} from '../src/shared/pet-actions';
import {
  PET_ANIMATION_CONFIG,
  PetAnimator,
  type AnimationContext,
  type PetFrame,
} from '../src/views/pet/animations';

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

function context(overrides: Partial<AnimationContext> = {}): AnimationContext {
  return {
    width: 400,
    height: 300,
    time: 0,
    deltaSeconds: 1 / 60,
    reducedMotion: false,
    pointerLocal: { x: 38, y: -16 },
    hoverAmount: 0.7,
    pressAmount: 0,
    pointerVelocity: { x: 2, y: -1 },
    dragDelta: { x: 5, y: 3 },
    windowPush: { x: -12, y: 2 },
    message: '桌宠验证',
    ...overrides,
  };
}

function allNumbersFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return true;
  return Object.values(value).every(allNumbersFinite);
}

function sampleAction(id: PetActionId): PetFrame {
  const definition = PET_ACTION_CATALOG.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing catalogue action ${id}`);
  const animator = new PetAnimator();
  animator.start(0);
  if (id !== 'enter') animator.play(id, 1);
  const now = (id === 'enter' ? 0 : 1) + Math.max(1, definition.durationMs / 2);
  return animator.update(context({ time: now / 1000 }), now);
}

function verifyCatalogue(): void {
  const configuredIds = Object.keys(PET_ANIMATION_CONFIG);
  check(
    new Set(configuredIds).size === PET_ACTION_IDS.length,
    `config size ${configuredIds.length} does not match catalogue ${PET_ACTION_IDS.length}`,
  );

  for (const definition of PET_ACTION_CATALOG) {
    const config = PET_ANIMATION_CONFIG[definition.id];
    check(Boolean(config), `${definition.id}: missing timing config`);
    check(config.duration === definition.durationMs / 1000, `${definition.id}: duration drift`);
    const frame = sampleAction(definition.id);
    check(frame.action.id === definition.id, `${definition.id}: started as ${frame.action.id}`);
    check(allNumbersFinite(frame), `${definition.id}: emitted NaN/Infinity`);
    check(frame.root.opacity >= 0 && frame.root.opacity <= 1, `${definition.id}: opacity out of range`);
    check(frame.expression.eyeOpen >= 0 && frame.expression.eyeOpen <= 1, `${definition.id}: eyeOpen out of range`);
    check(
      frame.expression.look.x >= -1 && frame.expression.look.x <= 1 &&
      frame.expression.look.y >= -1 && frame.expression.look.y <= 1,
      `${definition.id}: gaze out of range`,
    );
    check(frame.root.scaleX > 0 && frame.root.scaleY > 0, `${definition.id}: invalid semantic scale`);
    check(
      frame.action.visualCues.join('|') === definition.visualCues.join('|'),
      `${definition.id}: visual-cue metadata drift`,
    );
    if (definition.channels.includes('prop')) {
      check(frame.props.length > 0, `${definition.id}: prop channel has no semantic prop`);
    }
  }
}

function readyAnimator(): PetAnimator {
  const animator = new PetAnimator();
  animator.start(0);
  animator.update(context({ time: 1.05 }), 1_050);
  return animator;
}

function verifyTransitions(): void {
  const walking = readyAnimator();
  check(walking.getCurrentAction() === 'idle', 'enter did not resolve to idle');
  walking.play('walkLeft', 1_100);
  check(walking.getCurrentAction() === 'idleToWalk', 'idle -> walk skipped idleToWalk');
  walking.update(context({ time: 1.43 }), 1_430);
  check(walking.getCurrentAction() === 'walkLeft', 'idleToWalk did not resolve to walkLeft');
  walking.play('idle', 1_500);
  check(walking.getCurrentAction() === 'walkToIdle', 'walk -> idle skipped walkToIdle');
  walking.update(context({ time: 1.93 }), 1_930);
  check(walking.getCurrentAction() === 'idle', 'walkToIdle did not resolve to idle');

  const sitting = readyAnimator();
  sitting.play('sitDown', 1_100);
  check(sitting.getCurrentAction() === 'idleToSit', 'idle -> sit skipped idleToSit');
  sitting.update(context({ time: 1.63 }), 1_630);
  sitting.update(context({ time: 2.29 }), 2_290);
  check(sitting.getCurrentAction() === 'sittingLoop', 'sitDown did not resolve to sittingLoop');

  const sleeping = readyAnimator();
  sleeping.play('sleepIn', 1_100);
  check(sleeping.getCurrentAction() === 'idleToSleep', 'idle -> sleep skipped idleToSleep');
  sleeping.update(context({ time: 2.16 }), 2_160);
  sleeping.update(context({ time: 3.37 }), 3_370);
  check(sleeping.getCurrentAction() === 'sleepLoop', 'sleepIn did not resolve to sleepLoop');
}

function verifyBoundaries(): void {
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
    const frame = animator.update(context({
      time: now / 1000,
      deltaSeconds: 0.016,
    }), now);
    minimumX = Math.min(minimumX, frame.root.x);
    maximumX = Math.max(maximumX, frame.root.x);
    sawLeft ||= animator.getFacing() === -1;
    sawRight ||= animator.getFacing() === 1;
  }
  check(minimumX >= -140.001, `movement crossed left boundary (${minimumX})`);
  check(maximumX <= 140.001, `movement crossed right boundary (${maximumX})`);
  check(sawLeft && sawRight, 'edge collision did not reverse facing');
}

function verifyTerminalAndReducedMotion(): void {
  const exiting = new PetAnimator();
  exiting.start(0);
  exiting.play('exit', 1);
  const exited = exiting.update(context({ time: 8 }), 8_000);
  check(exiting.getCurrentAction() === 'exit', 'exit restarted or left its terminal state');
  check(exited.root.opacity === 0, `terminal exit opacity is ${exited.root.opacity}`);

  const reduced = new PetAnimator(true);
  reduced.start(0);
  reduced.play('runRight', 1);
  const still = reduced.update(context({
    time: 2,
    deltaSeconds: 0.1,
    reducedMotion: true,
  }), 2_000);
  check(still.root.x === 0 && still.root.y === 0, 'reduced motion translated a running pet');
  check(still.root.rotation === 0, 'reduced motion rotated the pet');
  check(still.root.scaleX === 1 && still.root.scaleY === 1, 'reduced motion scaled the pet');
  check(still.pose.tailSwing === 0 && still.pose.gaitWeight === 0, 'reduced motion kept continuous pose motion');

  reduced.play('dragged', 2_010);
  const dragged = reduced.update(context({
    pointerLocal: { x: 80, y: -40 },
    reducedMotion: true,
  }), 2_020);
  check(
    Math.abs(dragged.root.x) + Math.abs(dragged.root.y) > 0,
    'reduced motion prevented the required dragged pointer position',
  );
}

verifyCatalogue();
verifyTransitions();
verifyBoundaries();
verifyTerminalAndReducedMotion();

if (failures.length > 0) {
  console.error(`\nPet animation verification failed (${failures.length}/${checks} checks):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Pet animation verification passed: ${PET_ACTION_IDS.length} actions, ${checks} checks, semantic frames finite.`,
  );
}
