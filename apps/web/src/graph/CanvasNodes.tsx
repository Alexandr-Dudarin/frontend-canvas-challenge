import { memo } from 'react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import { useGraphActions } from './GraphActions';
import { NodeFrame } from './NodeFrame';
import {
  MAX_PROMPT_LENGTH,
  type PromptNode,
  type GeneratorNode,
  type ResultNode,
} from './graphModel';

const Prompt = memo(function Prompt({ id, data, isConnectable }: NodeProps<PromptNode>) {
  const { editPrompt } = useGraphActions();
  return (
    <NodeFrame id={id} type="prompt" title="Текст" isConnectable={isConnectable}>
      <label htmlFor={`prompt-${id}`}>Описание изображения</label>
      <textarea
        id={`prompt-${id}`}
        className="nodrag nopan nowheel"
        value={data.text}
        maxLength={MAX_PROMPT_LENGTH}
        rows={4}
        placeholder="Например, горы на рассвете"
        aria-describedby={`prompt-hint-${id}`}
        onChange={(event) => editPrompt(id, event.target.value)}
      />
      <small id={`prompt-hint-${id}`}>До {MAX_PROMPT_LENGTH} символов.</small>
    </NodeFrame>
  );
});

const Generator = memo(function Generator({ id, data, isConnectable }: NodeProps<GeneratorNode>) {
  return (
    <NodeFrame id={id} type="generator" title={data.label} isConnectable={isConnectable}>
      <p>Соедините вход с текстом, а выход — с результатом.</p>
      <p className="muted">Запуск генерации пока недоступен.</p>
    </NodeFrame>
  );
});

const Result = memo(function Result({ id, data, isConnectable }: NodeProps<ResultNode>) {
  return (
    <NodeFrame id={id} type="result" title={data.label} isConnectable={isConnectable}>
      <p>Место для результата генератора.</p>
      <p className="muted">Изображение пока не загружается.</p>
    </NodeFrame>
  );
});

// Ссылка на nodeTypes не меняется при вводе, перемещении или изменении viewport.
export const canvasNodeTypes = {
  prompt: Prompt,
  generator: Generator,
  result: Result,
} satisfies NodeTypes;
