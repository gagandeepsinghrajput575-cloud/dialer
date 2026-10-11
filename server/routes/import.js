const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const ACCEPTED = /\.(csv|tsv|txt|xlsx|xls|xlsm)$/i;
const TEXT_FORMAT = /\.(csv|tsv|txt)$/i;

// Danish lists arrive in two flavours: UTF-8 from web exports and cp1252 from Excel on a Danish
// Windows. SheetJS reads a BOM-less file as cp1252, so "Mødt på messe" was imported as
// "MÃ¸dt pÃ¥ messe" — mojibake that is then in the database for good. There is no way to guess
// the right answer from the ASCII part, but the bytes themselves tell you: a payload that is
// valid UTF-8 *and* contains multi-byte characters is UTF-8. Anything else keeps the cp1252
// default, which is what a genuine Danish Excel export needs.
function csvCodepage(buf) {
  if (!buf || !buf.length) return null;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return null; // BOM: SheetJS handles it
  try {
    return /[\u0080-\uFFFF]/.test(new TextDecoder('utf-8', { fatal: true }).decode(buf)) ? 65001 : null;
  } catch {
    return null; // not valid UTF-8, so it is a legacy single-byte encoding
  }
}

router.post('/parse', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  if (!ACCEPTED.test(req.file.originalname || '')) {
    throw ApiError.badRequest('Use a .csv, .tsv or .xlsx file');
  }
  try {
    const codepage = TEXT_FORMAT.test(req.file.originalname || '') ? csvCodepage(req.file.buffer) : null;
    const wb = XLSX.read(req.file.buffer, {
      type: 'buffer', raw: false, cellDates: false, ...(codepage ? { codepage } : {}),
    });
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
