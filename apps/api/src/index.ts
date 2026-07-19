import { Hono } from 'hono';

export interface Env {
  /** The Graph gateway API key. Worker secret — never referenced outside apps/api. */
  GRAPH_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'poollab-api',
    // Presence only. The value must never leave the Worker.
    graphKeyConfigured: Boolean(c.env.GRAPH_API_KEY),
  }),
);

export default app;
