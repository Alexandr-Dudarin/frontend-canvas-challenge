import {
  ErrorResponse,
  Config,
  Generation,
  GenerationInput,
  IdempotencyHeaders,
  Graph,
  Id,
  Space,
  type GraphData,
  type GenerationData,
  type GenerationRequest,
  type SpaceData,
} from '@canvas/contracts';
import { Type, type Static } from '@sinclair/typebox';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Компилируем официальные схемы один раз, без изменения полученных данных.
const ajv = new Ajv();
addFormats(ajv);

export const isGraph = ajv.compile<GraphData>(Graph);
// В contracts формат версии графа задан в поле graphETag; используем ту же схему.
export const isGraphETag = ajv.compile<string>(GenerationInput.properties.graphETag);
export const isSpace = ajv.compile<SpaceData>(Space);
export const isId = ajv.compile<string>(Id);
export const isErrorResponse = ajv.compile<Static<typeof ErrorResponse>>(ErrorResponse);
export const isGeneration = ajv.compile<GenerationData>(Generation);
export const isGenerations = ajv.compile<GenerationData[]>(Type.Array(Generation));
export const isGenerationInput = ajv.compile<GenerationRequest>(GenerationInput);
export const isIdempotencyKey = ajv.compile<string>(
  IdempotencyHeaders.properties['idempotency-key'],
);
export const isConfig = ajv.compile<Static<typeof Config>>(Config);
