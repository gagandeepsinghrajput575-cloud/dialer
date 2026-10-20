const router = require('express').Router();
const c = require('../controllers/callController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

// GET /api/calls & /api/calls/history — list call history
router.get('/', c.list);
router.get('/history', c.list);

// Declared before the /:id routes so "inbound" and "direct" are never read as a call id.
router.post('/inbound', validate(s.callInbound), c.inbound);
router.post('/direct', validate(s.directDial), c.directDial);
router.post('/:id/missed', validate(s.callMissed), c.missed);
router.post('/:id/miss', validate(s.callMissed), c.missed);
router.patch('/:id', validate(s.callPatch), c.patch);
router.post('/:id/discard', c.discard);
router.post('/:id/voicemail-drop', validate(s.voicemailDrop), c.voicemailDrop);
router.post('/:id/summary', c.summarize);
router.delete('/:id', c.discard);

module.exports = router;
