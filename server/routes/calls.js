const router = require('express').Router();
const c = require('../controllers/callController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

router.patch('/:id', validate(s.callPatch), c.patch);
router.post('/:id/discard', c.discard);
router.post('/:id/voicemail-drop', validate(s.voicemailDrop), c.voicemailDrop);
router.post('/:id/summary', c.summarize);
router.delete('/:id', c.discard);

module.exports = router;
