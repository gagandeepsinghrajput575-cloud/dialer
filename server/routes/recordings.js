const router = require('express').Router();
const multer = require('multer');
const c = require('../controllers/recordingController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get('/script', c.getScript);
router.put('/script', validate(s.recordingScriptUpdate), c.updateScript);
router.get('/', validate(s.recordingsQuery, 'query'), c.list);
router.get('/:callId/audio', c.audio);
router.get('/:callId/chats', c.listChats);
router.post('/:callId/chats', validate(s.recordingChatCreate), c.createChat);
router.get('/:callId/chats/:chatId', c.getChat);
router.delete('/:callId/chats/:chatId', c.deleteChat);
router.post('/:callId/ai-chat', validate(s.recordingAiChat), c.aiChat);
router.post('/demo', c.demo);
router.post('/:callId', upload.single('audio'), c.upload);
router.delete('/:callId', c.remove);

module.exports = router;
