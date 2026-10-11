const router = require('express').Router();
const multer = require('multer');
const c = require('../controllers/telephonyController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');
const { requireToken } = require('../middleware/guard');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get('/business-hours', c.businessHours);
// Returns live SIP credentials in opt-in mode, so it demands the session token even though
// it is a GET — see requireToken in middleware/guard.
router.get('/webrtc-session', requireToken, c.webrtcSession);
router.get('/caller-ids', c.callerIds);
router.get('/voicemail-greeting', c.greetingMeta);
router.post('/voicemail-greeting', upload.single('file'), c.uploadGreeting);
router.get('/voicemail-greeting/file', c.greetingFile);

// Follow-up scheduler + 1-click email (per prospect)
router.post('/prospects/:id/follow-up', validate(s.followUpSchedule), c.scheduleFollowUp);
router.post('/prospects/:id/follow-up-email', validate(s.emailRender), c.followUpEmail);

module.exports = router;
