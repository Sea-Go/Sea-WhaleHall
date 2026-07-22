/**
 * Compatibility entry point.
 *
 * New code should import CanvasPetRenderer and a model from CanvasPetRenderer
 * or models/registry. The historical CanvasWhaleRenderer name remains available
 * for the production React view while model selection is wired through RPC.
 */
export {
  CanvasPetRenderer,
  CanvasWhaleRenderer,
  CAT_MODEL,
  WHALE_MODEL,
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
