const router = require('express').Router();
const multer = require('multer');
const c = require('../controllers/recordingController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get('/', validate(s.recordingsQuery, 'query'), c.list);
router.get('/:callId/audio', c.audio);
router.post('/demo', c.demo);
router.post('/:callId', upload.single('audio'), c.upload);
router.delete('/:callId', c.remove);

module.exports = router;
