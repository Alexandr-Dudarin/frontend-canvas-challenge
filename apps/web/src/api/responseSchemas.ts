import { ErrorResponse, Graph, Id, Space, type GraphData, type SpaceData } from '@canvas/contracts';
import type { Static } from '@sinclair/typebox';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Компилируем официальные схемы один раз, без изменения полученных данных.
const ajv = new Ajv();
addFormats(ajv);

export const isGraph = ajv.compile<GraphData>(Graph);
export const isSpace = ajv.compile<SpaceData>(Space);
export const isId = ajv.compile<string>(Id);
export const isErrorResponse = ajv.compile<Static<typeof ErrorResponse>>(ErrorResponse);
