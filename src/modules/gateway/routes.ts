import { Router } from 'express';
import { gatewayController } from './controller.js';
import { authenticateInternal } from '../../middleware/auth.js';

const router = Router();

// Webhook endpoints (public, but should be secured with webhook secrets in production)
router.post('/webhook/telegram', gatewayController.telegramWebhook);
router.post('/webhook/whatsapp', gatewayController.whatsappWebhook);
router.get('/webhook/whatsapp', gatewayController.whatsappWebhookVerification);
router.post('/webhook/webchat', gatewayController.webChatWebhook);

// Internal API routes
router.post('/send-message', authenticateInternal, gatewayController.sendMessage);

// Web chat specific endpoints
router.get('/webchat/:chatId/messages', gatewayController.getWebChatMessages);
router.post('/webchat/:chatId/send', gatewayController.sendWebChatMessage);
// Admin routes
router.get('/webhook-logs', gatewayController.getWebhookLogs);

export default router;