import type { PetModel } from '../core/types';
import { CAT_MODEL } from './cat';
import { WHALE_MODEL } from './whale';

export const PET_MODELS = [WHALE_MODEL, CAT_MODEL] as const satisfies readonly PetModel[];
export type PetModelId = (typeof PET_MODELS)[number]['id'];

const MODEL_BY_ID = new Map(PET_MODELS.map((model) => [model.id, model]));

export function getPetModel(id: string): PetModel {
  return MODEL_BY_ID.get(id) ?? WHALE_MODEL;
}

export { CAT_MODEL, WHALE_MODEL };
