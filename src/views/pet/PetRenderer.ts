/**
 * Compatibility entry point.
 *
 * New code should import CanvasPetRenderer directly and inject a PetModel
 * (e.g. PetPackModelBridge from renderers/pet-model-bridge). Model selection
 * arrives via PetState.pack from the Bun package manager.
 */
export {
  CanvasPetRenderer,
  type CanvasPetRendererOptions,
  type PetInteractionEvent,
  type PetInteractionKind,
  type PetRenderer,
  type PetRenderSnapshot,
} from './CanvasPetRenderer';

export type PetInteractionState = 'idle' | 'hover' | 'press' | 'drag' | 'celebrate';

export type { ClickMotion, Point } from './pet-math';
export {
  CLICK_REACTION_DURATION_SECONDS,
  getClickMotion,
  isPointInsideWhale,
} from './pet-math';
