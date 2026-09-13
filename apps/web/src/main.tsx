import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { apiClient } from './api/client';
import { createSpacesApi } from './api/spacesApi';
import { createGraphApi } from './api/graphApi';
import { createCurrentSpaceStorage } from './space/currentSpace';
import { createSpaceLoader } from './space/spaceLoader';

const loader = createSpaceLoader(
  createSpacesApi(apiClient),
  createGraphApi(apiClient),
  createCurrentSpaceStorage(() => window.localStorage),
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App loader={loader} />
  </StrictMode>,
);
