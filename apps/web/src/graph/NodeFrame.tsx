import { Handle, Position } from '@xyflow/react';
import type { ReactNode } from 'react';
import type { NodeData } from '@canvas/contracts';
import { useGraphActions } from './GraphActions';

type Props = {
  id: string;
  type: NodeData['type'];
  title: string;
  isConnectable: boolean;
  children: ReactNode;
};

export function NodeFrame({ id, type, title, isConnectable, children }: Props) {
  const { deleteNode } = useGraphActions();
  return (
    <section className={`canvas-node canvas-node--${type}`} aria-labelledby={`title-${id}`}>
      <header className="node-heading">
        <h2 id={`title-${id}`}>{title}</h2>
        <button
          className="node-delete nodrag nopan"
          type="button"
          aria-label={`Удалить ноду «${title}»`}
          onClick={() => deleteNode(id)}
        >
          Удалить
        </button>
      </header>
      <div className="node-content">{children}</div>
      <div className="node-ports">
        {type !== 'prompt' && (
          <span className="port-label port-label--input">
            {type === 'generator' ? 'Текст · вход' : 'Генератор · вход'}
            <Handle
              type="target"
              position={Position.Left}
              isConnectable={isConnectable}
              aria-label="Вход"
            />
          </span>
        )}
        {type !== 'result' && (
          <span className="port-label port-label--output">
            {type === 'prompt' ? 'Текст · выход' : 'Результат · выход'}
            <Handle
              type="source"
              position={Position.Right}
              isConnectable={isConnectable}
              aria-label="Выход"
            />
          </span>
        )}
      </div>
    </section>
  );
}
