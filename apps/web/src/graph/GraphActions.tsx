import { createContext, useContext } from 'react';

export type GraphActions = {
  editPrompt: (id: string, text: string) => void;
  deleteNode: (id: string) => void;
};

// В context только стабильные действия. Весь граф сюда не попадает.
export const GraphActionsContext = createContext<GraphActions | null>(null);

export function useGraphActions(): GraphActions {
  const actions = useContext(GraphActionsContext);
  if (!actions) throw new Error('GraphActionsContext is required');
  return actions;
}
