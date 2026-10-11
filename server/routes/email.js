const router = require('express').Router();
const multer = require('multer');
const c = require('../controllers/emailController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

// Attachments stay in memory under a short-lived token — see emailController.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: c.MAX_EACH_BYTES, files: c.MAX_ATTACHMENTS } });

router.get('/status', c.status);
router.post('/verify', validate(s.emailVerify), c.verifyOne);
router.post('/verify-batch', validate(s.emailVerifyBatch), c.verifyBatch);
router.get('/attachments', c.listAttachments);
router.post('/attachments', upload.single('file'), c.stageAttachment);
router.delete('/attachments/:id', c.dropAttachment);
router.post('/prospects/:id/draft', validate(s.emailDraft), c.draftFor);
router.post('/send', validate(s.emailSend), c.send);
router.post('/test', c.testConnection);

// The local catch-all sink's ledger. Reads are same-origin; pruning is a write and is
// therefore covered by the app's standing CSRF guard like every other mutation.
router.get('/outbox', validate(s.outboxQuery, 'query'), c.outboxList);
router.get('/outbox/:id/attachments/:index', c.outboxAttachment);
router.get('/outbox/:id', c.outboxGet);
router.delete('/outbox/:id', c.outboxDelete);
router.delete('/outbox', c.outboxClear);

module.exports = router;
