import { Router } from 'express';
import { z } from 'zod';
import { speedyChat, speedyDiagnose, speedyStatus } from '../services/speedy.js';

/**
 * Speedy AI endpoints — public on purpose: the website's Ask Speedy chat
 * serves signed-out customers. Guardrails: the global rate limit, strict
 * input caps, no account data is ever returned, and the OpenAI key stays
 * on the server. When OPENAI_API_KEY is not configured the endpoints say
 * so honestly (503) instead of faking an answer.
 */
const router = Router();

const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});

const chatSchema = z.object({
  message: z.string().trim().min(1, 'Message is required').max(2000),
  history: z.array(historyTurn).max(10).optional(),
});

const diagnoseSchema = z.object({
  imageDataUrl: z
    .string()
    .regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, 'imageDataUrl must be a base64 image data URL')
    .max(4_500_000)
    .optional(),
  imageUrl: z.string().url().max(2000).optional(),
  note: z.string().trim().max(500).optional(),
}).refine((data) => data.imageDataUrl || data.imageUrl, {
  message: 'Provide imageDataUrl or imageUrl',
});

function notConfigured(res) {
  return res.status(503).json({
    error: 'Speedy is not configured yet',
    hint: 'Set OPENAI_API_KEY on the API server to enable the AI assistant.',
  });
}

router.get('/speedy/status', (req, res) => {
  return res.json({ data: speedyStatus() });
});

router.post('/speedy/chat', async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid chat message', details: parsed.error.flatten() });
  }
  try {
    const result = await speedyChat(parsed.data);
    return res.json({ data: result });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy had a hiccup — try again, or call (954) 931-7997', detail: String(error?.message || error) });
  }
});

router.post('/speedy/diagnose', async (req, res) => {
  if (!speedyStatus().configured) return notConfigured(res);
  const parsed = diagnoseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid diagnosis request', details: parsed.error.flatten() });
  }
  try {
    const result = await speedyDiagnose({
      imageUrl: parsed.data.imageDataUrl || parsed.data.imageUrl,
      note: parsed.data.note || '',
    });
    return res.json({ data: result });
  } catch (error) {
    return res.status(502).json({ error: 'Speedy could not read that photo — try again, or call (954) 931-7997', detail: String(error?.message || error) });
  }
});

export default router;
