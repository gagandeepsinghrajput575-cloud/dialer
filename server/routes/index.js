const router = require('express').Router();
const prospectController = require('../controllers/prospectController');
const statsController = require('../controllers/statsController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

router.use('/prospects', require('./prospects'));
router.use('/calls', require('./calls'));
router.use('/notes', require('./notes'));
router.use('/settings', require('./settings'));
router.use('/telephony', require('./telephony'));
router.use('/import', require('./import'));
router.use('/email', require('./email'));
router.use('/recordings', require('./recordings'));
router.use('/', require('./system'));

router.get('/stats', statsController.stats);
router.get('/queue', validate(s.queueQuery, 'query'), prospectController.queue);
router.post('/demo', prospectController.demo);

module.exports = router;
