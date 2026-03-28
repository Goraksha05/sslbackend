const express = require('express');
const router = express.Router();

const fetchUser = require('../middleware/fetchuser');
const isAdmin = require('../middleware/isAdmin');

const service = require('../services/kycService');

router.get('/', fetchUser, isAdmin, async (req, res) => {
  res.json(await service.getList(req.query));
});

router.patch('/:id/approve', fetchUser, isAdmin, async (req, res) => {
  res.json(await service.approve(req.params.id, req.user.id));
});

router.patch('/:id/reject', fetchUser, isAdmin, async (req, res) => {
  res.json(await service.reject(req.params.id, req.user.id, req.body.reason));
});

router.patch('/bulk/approve', fetchUser, isAdmin, async (req, res) => {
  await service.bulkApprove(req.body.ids, req.user.id);
  res.json({ message: 'Bulk approved' });
});

router.patch('/bulk/reject', fetchUser, isAdmin, async (req, res) => {
  await service.bulkReject(req.body.ids, req.user.id, req.body.reason);
  res.json({ message: 'Bulk rejected' });
});

module.exports = router;