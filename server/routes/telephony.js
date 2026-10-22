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
// Hands the SIP secret to the local desktop supervisor, so it is token-gated too. `?secret=0`
// returns the same account with the secret withheld, for diagnostics.
router.get('/carrier-credentials', requireToken, c.carrierCredentials);
// The supervisor's liveness beat; also the opt-in that switches the in-app phone to native.
router.post('/native-heartbeat', requireToken, c.nativeHeartbeat);
router.get('/caller-ids', c.callerIds);
router.get('/voicemail-greeting', c.greetingMeta);
router.post('/voicemail-greeting', upload.single('file'), c.uploadGreeting);
router.get('/voicemail-greeting/file', c.greetingFile);

// Follow-up scheduler + 1-click email (per prospect)
router.post('/prospects/:id/follow-up', validate(s.followUpSchedule), c.scheduleFollowUp);
router.post('/prospects/:id/follow-up-email', validate(s.emailRender), c.followUpEmail);

// FlyNumber Copenhagen Inbound DID & Verification Bridge
router.get('/flynumber', c.flynumber);
router.post('/flynumber', c.updateFlynumber);

module.exports = router;
