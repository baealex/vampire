import type { FastifyInstance } from 'fastify';
import { listProviders, getProvider } from '../providers/registry.js';

export async function providerRoutes(app: FastifyInstance) {
  app.get('/api/providers', async () => {
    return { providers: listProviders() };
  });

  app.post('/api/providers/:name/test', async (req, reply) => {
    const name = (req.params as any).name;
    try {
      const provider = getProvider(name);
      const result = await provider.testConnection();
      return result;
    } catch (err: any) {
      return reply.code(400).send({ ok: false, message: err.message });
    }
  });
}
