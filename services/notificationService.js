const { getIO } = require('../sockets/socketManager');
const { isUserOnline } = require('../sockets/handlers/onConnection');

async function dispatchToUser(
  userId,
  message,
  type,
  url = '/',
  pushPayload = null,
  socketPayload = {}
) {
  const uid = String(userId);

  if (!uid || uid === "undefined") {
    console.warn("[rewardNotify] Invalid userId");
    return null;
  }

  // 1 — DB (source of truth)
  let notif = null;
  try {
    notif = await Notification.create({
      user: userId,
      message,
      type,
      url,
    });
  } catch (err) {
    console.error(`[rewardNotify] DB write failed for ${uid}:`, err.message);
  }

  let socketDelivered = false;

  // 2 — Socket (only if online)
  try {
    if (isUserOnline(uid)) {
      const io = getIO();

      io.to(uid).emit('notification', {
        _id: notif?._id,
        type,
        message,
        url,
        ...(socketPayload || {}),
        createdAt: notif?.createdAt || new Date(),
      });

      socketDelivered = true;
    }
  } catch (err) {
    console.debug(`[rewardNotify] Socket skipped for ${uid}: ${err.message}`);
  }

  // 3 — Push (fallback only)
  try {
    if (!socketDelivered) {
      await sendPushToUser(uid, pushPayload ?? {
        title: 'SoShoLife Rewards',
        message,
        url,
      });
    }
  } catch (err) {
    console.debug(`[rewardNotify] Push skipped for ${uid}: ${err.message}`);
  }

  return notif;
}