import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type AriaLabelConfig,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import type { NodeData } from '@canvas/contracts';
import type { LoadedSpace } from '../space/spaceLoader';
import { useGraphAutosave } from '../save/useGraphAutosave';
import { GraphSaveStatus } from '../save/GraphSaveStatus';
import { GenerationProvider } from '../generation/GenerationProvider';
import { GenerationStatus } from '../generation/GenerationControls';
import { canConnect } from './connectionRules';
import { GraphActionsContext } from './GraphActions';
import { canvasNodeTypes } from './CanvasNodes';
import { editorReducer, initialEditorState } from './graphState';
import { MAX_NODES, MAX_ZOOM, MIN_ZOOM, NODE_EXTENT, type CanvasNode } from './graphModel';

const ariaLabelConfig: Partial<AriaLabelConfig> = {
  'controls.zoomIn.ariaLabel': 'Увеличить масштаб',
  'controls.zoomOut.ariaLabel': 'Уменьшить масштаб',
  'controls.fitView.ariaLabel': 'Показать весь граф',
  'node.a11yDescription.default':
    'Enter или пробел — выбрать ноду. Стрелки — переместить. Delete — удалить. Escape — отменить выбор.',
  'edge.a11yDescription.default':
    'Enter или пробел — выбрать связь. Delete — удалить. Escape — отменить выбор.',
};

export function GraphEditor({ loaded }: { loaded: LoadedSpace }) {
  const [state, dispatch] = useReducer(editorReducer, loaded.graph.data, initialEditorState);
  const { save, flush, retry, reloadServer, reportConflict } = useGraphAutosave(
    loaded.space.id,
    loaded.graph.meta.etag,
    state,
    dispatch,
  );
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);
  const getGraph = useCallback(() => latest.current, []);
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    dispatch({ type: 'nodesChanged', changes });
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    dispatch({ type: 'edgesChanged', changes });
  }, []);
  const onConnect = useCallback((connection: Connection) => {
    dispatch({ type: 'connect', connection, id: crypto.randomUUID() });
  }, []);
  const onViewportChange = useCallback((viewport: Viewport) => {
    dispatch({ type: 'viewportChanged', viewport });
  }, []);
  const isValidConnection = useCallback(
    (connection: Edge | Connection) => canConnect(connection, state.nodes, state.edges),
    [state.nodes, state.edges],
  );
  const actions = useMemo(
    () => ({
      editPrompt: (id: string, text: string) => dispatch({ type: 'editPrompt', id, text }),
      deleteNode: (id: string) => dispatch({ type: 'deleteNodes', ids: new Set([id]) }),
    }),
    [],
  );
  const addNode = (nodeType: NodeData['type']) => {
    dispatch({ type: 'addNode', nodeType, id: crypto.randomUUID() });
  };
  const atLimit = state.nodes.length >= MAX_NODES;

  return (
    <GenerationProvider
      spaceId={loaded.space.id}
      getGraph={getGraph}
      flush={flush}
      onGraphChanged={reportConflict}
    >
      <GraphActionsContext.Provider value={actions}>
        <div className="editor">
          <div className="editor-toolbar" role="group" aria-label="Добавить ноду">
            <button type="button" disabled={atLimit} onClick={() => addNode('prompt')}>
              + Текст
            </button>
            <button type="button" disabled={atLimit} onClick={() => addNode('generator')}>
              + Генератор
            </button>
            <button type="button" disabled={atLimit} onClick={() => addNode('result')}>
              + Результат
            </button>
            <span className="node-count">
              Ноды: {state.nodes.length} / {MAX_NODES}
            </span>
          </div>
          <div className="editor-help">
            <p id="canvas-help">
              Текст → генератор → результат. Соединяйте точки портов перетаскиванием. У входа одна
              связь, у генератора один результат.
            </p>
            <p>
              Перемещайте ноду за заголовок или выберите её клавишей Tab и используйте стрелки.
              Delete удаляет выбранные ноды и связи.
            </p>
          </div>
          <GraphSaveStatus save={save} retry={retry} reloadServer={reloadServer} />
          <GenerationStatus nodes={state.nodes} />
          {atLimit && (
            <p role="status">Достигнут лимит нод. Удалите ненужную, чтобы добавить новую.</p>
          )}
          <div className="canvas" aria-label="Рабочее поле графа" aria-describedby="canvas-help">
            <ReactFlow<CanvasNode, Edge>
              nodes={state.nodes}
              edges={state.edges}
              nodeTypes={canvasNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              viewport={state.viewport}
              onViewportChange={onViewportChange}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              nodeExtent={NODE_EXTENT}
              edgesReconnectable={false}
              deleteKeyCode={['Backspace', 'Delete']}
              ariaLabelConfig={ariaLabelConfig}
            >
              <Background gap={24} size={1} />
              <Controls showInteractive={false} />
              {state.nodes.length === 0 && (
                <div className="empty-canvas">Добавьте первую ноду кнопкой «+ Текст».</div>
              )}
            </ReactFlow>
          </div>
        </div>
      </GraphActionsContext.Provider>
    </GenerationProvider>
  );
}
