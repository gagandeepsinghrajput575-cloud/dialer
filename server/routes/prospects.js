const router = require('express').Router();
const c = require('../controllers/prospectController');
const calls = require('../controllers/callController');
const notes = require('../controllers/noteController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

// Static segments must be declared before "/:id" so Express does not treat them as an id.
router.get('/', c.list);
router.get('/export', c.exportData);
router.get('/search', validate(s.searchQuery, 'query'), c.search);
router.get('/follow-ups', c.followUps);
router.post('/', validate(s.prospectCreateStrict), c.create);
router.post('/bulk', validate(s.bulkImport), c.bulk);
router.post('/clear', c.clearAll);

router.get('/:id', c.detail);
router.patch('/:id', validate(s.prospectPatch), c.patch);
router.delete('/:id', c.remove);

router.post('/:id/call', validate(s.callStart), calls.start);
router.post('/:id/notes', validate(s.noteCreate), notes.create);

module.exports = router;
