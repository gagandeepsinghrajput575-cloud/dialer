const notes = require('../repositories/noteRepo');
const prospects = require('../repositories/prospectRepo');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const create = asyncHandler(async (req, res) => {
  const prospect = prospects.raw(req.params.id);
  if (!prospect) throw ApiError.notFound('Prospect not found');
  const note = notes.insert(req.params.id, req.body.body);
  prospects.touch(req.params.id);
  res.json(note);
});

const patch = asyncHandler(async (req, res) => {
  if (!notes.get(req.params.id)) throw ApiError.notFound('Note not found');
  res.json(notes.update(req.params.id, String(req.body.body ?? '')));
});

const remove = asyncHandler(async (req, res) => {
  if (!notes.get(req.params.id)) throw ApiError.notFound('Note not found');
  notes.remove(req.params.id);
  res.json({ ok: true });
});

module.exports = { create, patch, remove };
