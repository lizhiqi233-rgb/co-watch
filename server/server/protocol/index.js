const { handleRoomMessage } = require('./room.js');
const { handleNavigationMessage } = require('./navigation.js');
const { handlePlaylistMessage } = require('./playlist.js');
const { handleVideoMessage } = require('./video.js');
const { sendJson } = require('./context.js');

function dispatchMessage(ctx, message) {
  if (!message || typeof message !== 'object') return;
  if (handleRoomMessage(ctx, message)) return;
  if (handleNavigationMessage(ctx, message)) return;
  if (handlePlaylistMessage(ctx, message)) return;
  if (handleVideoMessage(ctx, message)) return;
  if (message.type === 'ping') {
    sendJson(ctx, { type: 'pong', t: message.t });
  }
}

module.exports = { dispatchMessage };
