const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const ACCEPTED = /\.(csv|tsv|txt|xlsx|xls|xlsm)$/i;

router.post('/parse', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  if (!ACCEPTED.test(req.file.originalname || '')) {
    throw ApiError.badRequest('Use a .csv, .tsv or .xlsx file');
  }
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: false, cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!sheet || !rows.length) {
      return res.json({ headers: [], rows: [], filename: req.file.originalname, warning: 'That file has no readable rows.' });
    }
    res.json({ headers: Object.keys(rows[0]), rows, filename: req.file.originalname });
  } catch (e) {
    throw ApiError.badRequest(`Could not read that file: ${e.message}`);
  }
}));

module.exports = router;
