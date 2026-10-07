const router = require('express').Router();
const c = require('../controllers/noteController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

router.patch('/:id', validate(s.notePatch), c.patch);
router.delete('/:id', c.remove);

module.exports = router;
