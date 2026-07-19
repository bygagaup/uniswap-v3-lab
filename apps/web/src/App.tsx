import { useQuery } from '@tanstack/react-query';

interface Health {
  ok: boolean;
  service: string;
  graphKeyConfigured: boolean;
}

async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
  return res.json() as Promise<Health>;
}

export function App() {
  const { data, error, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });

  return (
    <main>
      <h1>PoolLab</h1>
      {isPending && <p>Checking API…</p>}
      {error && <p role="alert">API unreachable: {error.message}</p>}
      {data && (
        <p>
          API up: {data.service} · Graph key {data.graphKeyConfigured ? 'configured' : 'missing'}
        </p>
      )}
    </main>
  );
}
