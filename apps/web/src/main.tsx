import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './routes.js';
import './styles/tokens.css';
import './styles/app.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing from index.html');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The edge proxy already caches with per-op TTLs; the client layer only
      // needs to avoid refetch storms, not to be the cache of record.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
