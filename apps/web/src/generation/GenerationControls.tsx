import { useState } from 'react';
import type { GenerationRequest } from '@canvas/contracts';
import { apiClient } from '../api/client';
import type { CanvasNode } from '../graph/graphModel';
import { generationErrorMessage, type GenerationView } from './generationModel';
import { useGeneration, useGenerationOverview, useGenerationReady } from './GenerationProvider';

function GenerationProblem({
  view,
  retry,
}: {
  view: Extract<GenerationView, { status: 'error' }>;
  retry: () => void;
}) {
  return (
    <div className="generation-error" role="alert">
      <p>{generationErrorMessage(view.error)}</p>
      {view.recovery === 'replay' && (
        <p>Исход POST неизвестен. Повтор использует прежние body и ключ.</p>
      )}
      {['replay', 'poll', 'refresh'].includes(view.recovery) && (
        <button type="button" onClick={retry}>
          {view.recovery === 'replay' ? 'Восстановить запуск' : 'Повторить загрузку статуса'}
        </button>
      )}
    </div>
  );
}

export function GenerationStatus({ nodes }: { nodes: CanvasNode[] }) {
  const { controller, overview } = useGenerationOverview();
  if (overview.status === 'loading') return <p role="status">Восстанавливаем генерации…</p>;
  if (overview.status === 'error')
    return (
      <div className="generation-error" role="alert">
        <p>{overview.error?.message}</p>
        <button type="button" onClick={() => void controller?.restore()}>
          Повторить загрузку генераций
        </button>
      </div>
    );
  return (
    <>
      {overview.problems.map(({ nodeId, view }) =>
        nodes.some((node) => node.id === nodeId) ? null : (
          <div key={nodeId} className="generation-error">
            <p>Восстановление запуска удалённой ноды {nodeId}</p>
            <GenerationProblem view={view} retry={() => void controller?.retry(nodeId)} />
          </div>
        ),
      )}
    </>
  );
}

export function GeneratorControls({ nodeId }: { nodeId: string }) {
  const [scenario, setScenario] = useState<GenerationRequest['scenario']>('success');
  const { controller, view } = useGeneration(nodeId, 'generator');
  const ready = useGenerationReady();
  const busy =
    view.status === 'flushing' || view.status === 'creating' || view.status === 'processing';
  const blocked = view.status === 'error' && view.recovery !== 'new';
  return (
    <div className="generation-controls nodrag nopan nowheel">
      <label htmlFor={`scenario-${nodeId}`}>Тестовый сценарий</label>
      <select
        id={`scenario-${nodeId}`}
        value={scenario}
        disabled={busy || blocked || !ready}
        onChange={(event) => setScenario(event.target.value as GenerationRequest['scenario'])}
      >
        <option value="success">Успешная генерация</option>
        <option value="failure">Тестовый отказ</option>
      </select>
      <button
        type="button"
        aria-busy={busy}
        disabled={busy || blocked || !ready}
        onClick={() => void controller?.start(nodeId, scenario)}
      >
        {view.status === 'flushing'
          ? 'Сохраняем граф…'
          : view.status === 'creating'
            ? 'Запускаем…'
            : view.status === 'processing'
              ? 'Генерация выполняется…'
              : 'Сгенерировать'}
      </button>
      {view.status === 'succeeded' && (
        <p role="status">Генерация завершена. Результат привязан к ноде, выбранной при запуске.</p>
      )}
      {view.status === 'failed' && (
        <p role="status">
          Тестовый отказ: {view.generation.failureCode}. Можно запустить новую попытку.
        </p>
      )}
      {view.status === 'error' && (
        <GenerationProblem view={view} retry={() => void controller?.retry(nodeId)} />
      )}
    </div>
  );
}

export function GenerationResult({ nodeId }: { nodeId: string }) {
  const { controller, view } = useGeneration(nodeId, 'result');
  return (
    <div className="generation-result nodrag nopan nowheel">
      {view.status === 'idle' && <p>Здесь появится результат генерации.</p>}
      {view.status === 'processing' && <p role="status">Изображение создаётся…</p>}
      {view.status === 'failed' && (
        <p role="status">
          Генерация завершилась отказом: {view.generation.failureCode}. Запустите новую попытку из
          генератора.
        </p>
      )}
      {view.status === 'succeeded' && view.generation.imageUrl && (
        <>
          <p role="status">Изображение готово.</p>
          <ResultImage key={view.generation.id} url={view.generation.imageUrl} />
        </>
      )}
      {view.status === 'error' && (
        <GenerationProblem
          view={view}
          retry={() => void controller?.retryPoll(view.generation!.id)}
        />
      )}
    </div>
  );
}

function ResultImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return failed ? (
    <div role="alert">
      <p>Генерация завершена, но файл изображения не загрузился.</p>
      <button
        type="button"
        onClick={() => {
          setAttempt(attempt + 1);
          setFailed(false);
        }}
      >
        Загрузить изображение повторно
      </button>
    </div>
  ) : (
    <img
      key={attempt}
      src={apiClient.resolveUrl(url)}
      alt="Тестовый результат генерации изображения"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
