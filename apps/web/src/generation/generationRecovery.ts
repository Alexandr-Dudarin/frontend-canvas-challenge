import type { GenerationRequest } from '@canvas/contracts';
import { ApiRequestError } from '../api/apiError';
import { isGenerationInput, isId, isIdempotencyKey } from '../api/responseSchemas';

export const PENDING_GENERATION_PREFIX = 'canvas.pending-generation.v1:';
export type PendingGeneration = Readonly<{
  version: 1;
  spaceId: string;
  body: Readonly<GenerationRequest>;
  key: string;
  blocked: boolean;
}>;
type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>;
const storageKey = (spaceId: string, nodeId: string) =>
  `${PENDING_GENERATION_PREFIX}${spaceId}:${nodeId}`;

function storageError(cause: unknown) {
  return new ApiRequestError(
    'Не удалось прочитать или сохранить данные восстановления. Разрешите browser storage и повторите действие; новый запуск пока заблокирован.',
    'request',
    'GENERATION_STORAGE_ERROR',
    undefined,
    cause,
  );
}

export function createGenerationRecovery(getStorage: () => BrowserStorage) {
  function access<T>(action: (storage: BrowserStorage) => T): T {
    try {
      return action(getStorage());
    } catch (error) {
      throw storageError(error);
    }
  }
  function decode(raw: string, key: string): PendingGeneration {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.version !== 1 ||
      !isId(value.spaceId) ||
      !isGenerationInput(value.body) ||
      !isIdempotencyKey(value.key) ||
      typeof value.blocked !== 'boolean' ||
      storageKey(value.spaceId, value.body.nodeId) !== key
    )
      throw new Error('Повреждена pending generation; автоматически удалять её нельзя.');
    return Object.freeze({ ...value, body: Object.freeze(value.body) });
  }
  function read(spaceId: string, nodeId: string) {
    return access((storage) => {
      const key = storageKey(spaceId, nodeId);
      const raw = storage.getItem(key);
      return raw === null ? null : decode(raw, key);
    });
  }
  return {
    read,
    list(spaceId: string) {
      return access((storage) => {
        const result: PendingGeneration[] = [];
        const prefix = `${PENDING_GENERATION_PREFIX}${spaceId}:`;
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key?.startsWith(prefix)) continue;
          const raw = storage.getItem(key);
          if (raw !== null) result.push(decode(raw, key));
        }
        return result;
      });
    },
    save(operation: PendingGeneration) {
      const previous = read(operation.spaceId, operation.body.nodeId);
      if (
        previous &&
        (previous.key !== operation.key ||
          JSON.stringify(previous.body) !== JSON.stringify(operation.body))
      )
        throw storageError(new Error('Нельзя заменить неразрешённую операцию другим body/key.'));
      access((storage) =>
        storage.setItem(
          storageKey(operation.spaceId, operation.body.nodeId),
          JSON.stringify(operation),
        ),
      );
    },
    remove(operation: PendingGeneration) {
      const previous = read(operation.spaceId, operation.body.nodeId);
      if (previous?.key === operation.key)
        access((storage) =>
          storage.removeItem(storageKey(operation.spaceId, operation.body.nodeId)),
        );
    },
  };
}

export type GenerationRecovery = ReturnType<typeof createGenerationRecovery>;
