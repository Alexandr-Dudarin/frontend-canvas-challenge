import { isId } from '../api/responseSchemas';

export const CURRENT_SPACE_KEY = 'canvas.current-space.v1';
const storageWarning =
  'Браузер не разрешил сохранить пространство. После перезагрузки оно может не восстановиться.';

export function createCurrentSpaceStorage(getStorage: () => Pick<Storage, 'getItem' | 'setItem'>) {
  return {
    read(): { id: string | null; warning: string | null } {
      try {
        const id = getStorage().getItem(CURRENT_SPACE_KEY);
        return { id: isId(id) ? id : null, warning: null };
      } catch {
        return { id: null, warning: storageWarning };
      }
    },
    write(id: string): string | null {
      try {
        getStorage().setItem(CURRENT_SPACE_KEY, id);
        return null;
      } catch {
        return storageWarning;
      }
    },
  };
}

export type CurrentSpaceStorage = ReturnType<typeof createCurrentSpaceStorage>;
