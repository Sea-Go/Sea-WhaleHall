import { describe, expect, test } from 'bun:test';
import {
  PET_ACTION_CATALOG,
  PET_ACTION_CATEGORIES,
  PET_ACTION_IDS,
  PET_ACTION_TRIGGER_KINDS,
  PET_FIRST_RELEASE_CHECKLIST,
  PET_MODEL_CHANNELS,
  PET_MOTION_TEMPLATES,
  PET_REQUIREMENT_CHECKLIST,
  PET_VISUAL_CUES,
  getPetAction,
  getPetActionsByCategory,
} from '../src/shared/pet-actions';

const EXPECTED_USER_REQUIREMENTS = [
  'basic.idle', 'basic.idleVariation', 'basic.walk', 'basic.stop', 'basic.turn',
  'basic.dragged', 'basic.drop', 'basic.clickFeedback', 'basic.sleep', 'basic.visibility',
  'movement.run', 'movement.jump', 'movement.takeOffAndLand', 'movement.fallAndRecover',
  'movement.sitAndStand', 'movement.lieAndRise', 'movement.slide',
  'movement.climbScreenEdge', 'movement.holdWindowEdge', 'movement.peekFromEdge',
  'movement.fallFromHeight', 'movement.pushedByWindow',
  'pointer.singleClick', 'pointer.doubleClick', 'pointer.rapidClick', 'pointer.hoverLook',
  'pointer.trackGaze', 'pointer.dragReaction', 'pointer.petHead', 'pointer.poke',
  'pointer.chased', 'pointer.catch', 'pointer.sitOn', 'pointer.pushAway',
  'emotion.happy', 'emotion.laugh', 'emotion.shy', 'emotion.angry', 'emotion.wronged',
  'emotion.sad', 'emotion.cry', 'emotion.surprised', 'emotion.afraid', 'emotion.confused',
  'emotion.bored', 'emotion.sleepy', 'emotion.proud', 'emotion.impatient',
  'emotion.expectant', 'emotion.love',
  'life.eat', 'life.drink', 'life.receiveFood', 'life.refuseFood', 'life.full',
  'life.hungry', 'life.bathe', 'life.dryOff', 'life.groom', 'life.playToy',
  'life.readBook', 'life.usePhone', 'life.listenMusic', 'life.exercise', 'life.sick',
  'life.takeMedicine', 'life.recoverEnergy', 'life.levelUp', 'life.receiveGift',
  'life.unwrapGift', 'life.changeOutfit',
  'function.remindUser', 'function.holdSign', 'function.knockScreen',
  'function.pointNotification', 'function.think', 'function.searching', 'function.loading',
  'function.answerQuestion', 'function.recordTodo', 'function.startPomodoro',
  'function.focus', 'function.breakReminder', 'function.alarm', 'function.taskComplete',
  'function.operationFailed', 'function.networkDisconnected', 'function.updateComplete',
  'special.morningWakeUp', 'special.lunchTime', 'special.eveningSleepy',
  'special.lateNightRest', 'special.birthday', 'special.holiday', 'special.rain',
  'special.winter', 'special.summer', 'special.idlePlay', 'special.welcomeBack',
  'special.overworkRest', 'special.easterEgg',
] as const;

describe('model-independent pet action catalogue', () => {
  test('all ids are stable camelCase and unique', () => {
    expect(PET_ACTION_IDS.length).toBe(PET_ACTION_CATALOG.length);
    expect(new Set(PET_ACTION_IDS).size).toBe(PET_ACTION_IDS.length);

    for (const id of PET_ACTION_IDS) {
      expect(id).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(getPetAction(id).id).toBe(id);
    }
  });

  test('every definition has legal timing and portable rendering metadata', () => {
    const categories = new Set(PET_ACTION_CATEGORIES);
    const triggers = new Set(PET_ACTION_TRIGGER_KINDS);
    const templates = new Set(PET_MOTION_TEMPLATES);
    const cues = new Set(PET_VISUAL_CUES);
    const channels = new Set(PET_MODEL_CHANNELS);

    for (const definition of PET_ACTION_CATALOG) {
      expect(definition.label.trim().length).toBeGreaterThan(0);
      expect(categories.has(definition.category)).toBe(true);
      expect(typeof definition.loop).toBe('boolean');
      expect(Number.isFinite(definition.durationMs)).toBe(true);
      expect(definition.durationMs).toBeGreaterThan(0);
      expect(definition.durationMs).toBeLessThanOrEqual(10_000);
      expect(triggers.has(definition.trigger.kind)).toBe(true);
      expect(templates.has(definition.motion.template)).toBe(true);
      expect(['subtle', 'medium', 'strong']).toContain(definition.motion.intensity);
      expect(definition.visualCues.length).toBeGreaterThan(0);
      expect(definition.channels.length).toBeGreaterThan(0);
      expect(definition.visualCues.every((cue) => cues.has(cue))).toBe(true);
      expect(definition.channels.every((channel) => channels.has(channel))).toBe(true);
      expect(new Set(definition.channels).size).toBe(definition.channels.length);
    }
  });

  test('category queries partition the complete catalogue', () => {
    const queriedIds = PET_ACTION_CATEGORIES.flatMap((category) => {
      const definitions = getPetActionsByCategory(category);
      expect(definitions.length).toBeGreaterThan(0);
      expect(definitions.every((definition) => definition.category === category)).toBe(true);
      return definitions.map(({ id }) => id);
    });

    expect(new Set(queriedIds)).toEqual(new Set(PET_ACTION_IDS));
  });
});

describe('requested action coverage', () => {
  test('maps every explicit user requirement, one by one', () => {
    const userRows = PET_REQUIREMENT_CHECKLIST.filter(({ source }) => source === 'user');
    const actualRequirementIds = userRows.map(({ requirementId }) => requirementId);

    expect(new Set(actualRequirementIds)).toEqual(new Set(EXPECTED_USER_REQUIREMENTS));
    expect(actualRequirementIds.length).toBe(EXPECTED_USER_REQUIREMENTS.length);

    const knownActions = new Set(PET_ACTION_IDS);
    for (const requirementId of EXPECTED_USER_REQUIREMENTS) {
      const row = userRows.find((candidate) => candidate.requirementId === requirementId);
      expect(row, `missing mapping for ${requirementId}`).toBeDefined();
      expect(row?.actionIds.length).toBeGreaterThan(0);
      expect(row?.actionIds.every((id) => knownActions.has(id))).toBe(true);
    }
  });

  test('also maps every transition and internal action needed for smooth replacement', () => {
    const mappedActionIds = new Set(
      PET_REQUIREMENT_CHECKLIST.flatMap(({ actionIds }) => actionIds),
    );

    expect(mappedActionIds).toEqual(new Set(PET_ACTION_IDS));
    expect(
      PET_REQUIREMENT_CHECKLIST.some(
        ({ source, category }) => source === 'architecture' && category === 'transition',
      ),
    ).toBe(true);
    expect(
      PET_REQUIREMENT_CHECKLIST.some(
        ({ source, category }) => source === 'architecture' && category === 'internal',
      ),
    ).toBe(true);
  });

  test('contains all 18 first-release checklist items in order', () => {
    expect(PET_FIRST_RELEASE_CHECKLIST).toHaveLength(18);
    expect(
      PET_FIRST_RELEASE_CHECKLIST.every(({ ordinal }, index) => ordinal === index + 1),
    ).toBe(true);
    expect(PET_FIRST_RELEASE_CHECKLIST.map(({ label }) => label)).toEqual([
      '待机循环', '眨眼', '特殊待机', '左走', '右走', '转身', '坐下', '起身',
      '被拖拽', '放下', '点击反馈', '开心', '生气', '困倦', '入睡', '睡眠循环',
      '醒来', '出场和退场',
    ]);

    const knownActions = new Set(PET_ACTION_IDS);
    for (const item of PET_FIRST_RELEASE_CHECKLIST) {
      expect(item.actionIds.length).toBeGreaterThan(0);
      expect(item.actionIds.every((id) => knownActions.has(id))).toBe(true);
    }
  });
});
