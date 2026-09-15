import type { SaveState } from './graphSaveCoordinator';

export function GraphSaveStatus({
  save,
  retry,
  reloadServer,
}: {
  save: SaveState;
  retry: () => void;
  reloadServer: () => void;
}) {
  let message: string;
  switch (save.status) {
    case 'saved':
      message = 'Все изменения сохранены.';
      break;
    case 'dirty':
      message = 'Есть несохранённые изменения. Сохраним после паузы.';
      break;
    case 'saving':
      message =
        save.operation === 'reload'
          ? 'Загружаем версию с сервера…'
          : save.operation === 'reconcile'
            ? 'Проверяем, сохранился ли отправленный граф…'
            : 'Сохраняем изменения… Можно продолжать редактирование.';
      break;
    case 'conflict':
      message = `Конфликт версий. ${save.error.message}`;
      break;
    case 'error':
      message =
        save.recovery === 'reconcile'
          ? `Результат сохранения пока неизвестен. ${save.error.message}`
          : `Не удалось ${save.recovery === 'reload' ? 'загрузить граф' : 'сохранить изменения'}. ${save.error.message}`;
  }
  const blocked = save.status === 'error' || save.status === 'conflict';
  return (
    <section className={`save-status save-status--${save.status}`} aria-label="Сохранение графа">
      <p role={blocked ? 'alert' : 'status'}>{message}</p>
      {blocked && (
        <>
          <p>Локальные правки остаются в редакторе. Автосохранение остановлено.</p>
          {save.error.meta?.requestId && (
            <p className="muted">Код запроса: {save.error.meta.requestId}</p>
          )}
          <div className="save-actions">
            {save.status === 'error' && (
              <button type="button" onClick={retry}>
                {save.recovery === 'reconcile'
                  ? 'Повторить проверку на сервере'
                  : save.recovery === 'reload'
                    ? 'Повторить загрузку'
                    : 'Повторить сохранение'}
              </button>
            )}
            <button type="button" onClick={reloadServer} aria-describedby="reload-warning">
              Загрузить версию с сервера
            </button>
          </div>
          <p id="reload-warning" className="muted">
            Загрузка серверной версии заменит локальные правки.
          </p>
        </>
      )}
    </section>
  );
}
