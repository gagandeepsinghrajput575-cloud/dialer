const router = require('express').Router();
const c = require('../controllers/settingsController');
const s = require('../validation/schemas');
const { validate } = require('../middleware/validate');

router.get('/', c.get);
router.put('/', validate(s.settingsUpdate), c.put);
router.post('/test-softphone', validate(s.softphoneTest), c.testSoftphone);
router.get('/backups', c.listBackups);
router.post('/backups', validate(s.backupCreate), c.createBackup);
router.get('/backups/:file', c.downloadBackup);

module.exports = router;
