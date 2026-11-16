'use strict';

const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const elements = {
  statusText: document.querySelector('#status-text'),
  statusDot: document.querySelector('#status-dot'),
  callState: document.querySelector('#call-state'),
  stageHeading: document.querySelector('#stage-heading'),
  stageCopy: document.querySelector('#stage-copy'),
  remoteVideo: document.querySelector('#remote-video'),
  remotePlaceholder: document.querySelector('#remote-placeholder'),
  remoteCaption: document.querySelector('#remote-caption'),
  localTile: document.querySelector('#local-tile'),
  localVideo: document.querySelector('#local-video'),
  localPlaceholder: document.querySelector('#local-placeholder'),
  connectButton: document.querySelector('#connect-button'),
  callButton: document.querySelector('#call-button'),
  hangupButton: document.querySelector('#hangup-button'),
  micButton: document.querySelector('#mic-button'),
  micLabel: document.querySelector('#mic-label'),
  micIndicator: document.querySelector('#mic-indicator'),
  cameraButton: document.querySelector('#camera-button'),
  cameraLabel: document.querySelector('#camera-label'),
  chatStatus: document.querySelector('#chat-status'),
  messageList: document.querySelector('#message-list'),
  chatCount: document.querySelector('#chat-count'),
  chatForm: document.querySelector('#chat-form'),
  chatInput: document.querySelector('#chat-input'),
  sendButton: document.querySelector('#send-button'),
  callDuration: document.querySelector('#call-duration'),
  toast: document.querySelector('#toast'),
  connectionInfo: document.querySelector('#connection-info')
};

const clientId = createClientId();
let socket = null;
let localStream = null;
let peerConnection = null;
let peerId = null;
let peerAvailable = false;
let callStarted = false;
let makingOffer = false;
let ignoreOffer = false;
let polite = false;
let pendingCandidates = [];
let toastTimeout = null;
let callStartedAt = 0;
let durationInterval = null;
let messageCount = 0;

function createClientId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(message, state = 'idle') {
  elements.statusText.textContent = message;
  elements.statusDot.classList.toggle('is-connected', state === 'connected');
  elements.statusDot.classList.toggle('is-alert', state === 'alert');
}

function showToast(message) {
  window.clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 4200);
}

function setStageWaiting(message = 'Подключитесь, чтобы проверить камеру и микрофон, затем пригласите собеседника.') {
  elements.stageHeading.innerHTML = 'Встреча начинается<br>с разговора';
  elements.stageCopy.textContent = message;
  elements.callState.textContent = peerAvailable ? 'СОБЕСЕДНИК НА СВЯЗИ' : 'КОМНАТА ОЖИДАЕТ';
  elements.remotePlaceholder.hidden = false;
  elements.remoteCaption.hidden = true;
  elements.callDuration.hidden = true;
  elements.callDuration.textContent = '00:00';
  elements.callState.classList.remove('is-live');
}

function updateControls() {
  const socketOpen = socket && socket.readyState === WebSocket.OPEN;
  const socketConnecting = socket && socket.readyState === WebSocket.CONNECTING;
  elements.connectButton.disabled = Boolean(socketOpen || socketConnecting);
  elements.connectButton.querySelector('span').textContent = socketOpen ? 'Подключено' : socketConnecting ? 'Подключение...' : 'Подключиться';
  elements.callButton.disabled = !socketOpen || !peerAvailable || !localStream || callStarted;
  elements.hangupButton.disabled = !callStarted;
  elements.micButton.disabled = !localStream;
  elements.cameraButton.disabled = !localStream;
  elements.chatInput.disabled = !socketOpen || !peerAvailable;
  elements.sendButton.disabled = !socketOpen || !peerAvailable || !elements.chatInput.value.trim();
  elements.chatStatus.hidden = Boolean(socketOpen && peerAvailable);
  if (socketOpen && peerAvailable) {
    elements.chatStatus.querySelector('span:last-child').textContent = 'Можно отправлять сообщения и ссылки';
  } else if (socketOpen) {
    elements.chatStatus.querySelector('span:last-child').textContent = 'Ожидание собеседника для чата';
  } else {
    elements.chatStatus.querySelector('span:last-child').textContent = 'Сообщения доступны после подключения';
  }
}

async function getLocalMedia() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('Браузер не поддерживает доступ к камере. Откройте страницу через HTTPS или localhost.');
  }

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  elements.localVideo.srcObject = localStream;
  elements.localTile.hidden = false;
  elements.localPlaceholder.hidden = localStream.getVideoTracks().some((track) => track.enabled);
  elements.micButton.disabled = false;
  elements.cameraButton.disabled = false;
  return localStream;
}

async function connectToSession() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  try {
    setStatus('Запрос доступа к устройствам...');
    await getLocalMedia();
  } catch (error) {
    const message = error.name === 'NotAllowedError'
      ? 'Нет доступа к камере или микрофону. Разрешите доступ в настройках браузера.'
      : error.name === 'NotFoundError'
        ? 'Камера или микрофон не найдены. Проверьте подключение устройств.'
        : error.message || 'Не удалось получить доступ к устройствам.';
    setStatus('Нет доступа к устройствам', 'alert');
    showToast(message);
    updateControls();
    return;
  }

  setStatus('Подключение к серверу...');
  try {
    socket = new WebSocket(SIGNALING_URL);
  } catch (error) {
    socket = null;
    setStatus('Не удалось подключиться к серверу', 'alert');
    showToast('Не удалось открыть WebSocket-соединение. Попробуйте подключиться еще раз.');
    updateControls();
    return;
  }

  socket.addEventListener('open', () => {
    setStatus('Ожидание собеседника...');
    sendSignal({ type: 'ready', from: clientId });
    updateControls();
  });

  socket.addEventListener('message', (event) => {
    void handleSignalMessage(event.data);
  });

  socket.addEventListener('error', () => {
    setStatus('Ошибка signaling-сервера', 'alert');
    showToast('Не удалось связаться с сервером сигнализации. Проверьте сеть и попробуйте снова.');
  });

  socket.addEventListener('close', () => {
    socket = null;
    peerAvailable = false;
    peerId = null;
    closePeerConnection();
    setStatus('Соединение с сервером потеряно', 'alert');
    setStageWaiting('Связь с сервером прервана. Нажмите «Подключиться», чтобы попробовать снова.');
    updateControls();
  });

  updateControls();
}

function sendSignal(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    showToast('Сообщение не отправлено. Проверьте соединение с сервером.');
    return false;
  }
}

function setPeer(from) {
  if (typeof from !== 'string' || from === clientId) return;
  peerId = from;
  polite = clientId.localeCompare(peerId) > 0;
  peerAvailable = true;
  if (!callStarted) {
    setStatus('Собеседник подключен', 'connected');
    elements.callState.textContent = 'СОБЕСЕДНИК НА СВЯЗИ';
    elements.stageCopy.textContent = 'Собеседник в комнате. Можно начинать разговор.';
  }
  updateControls();
}

function createPeerConnection() {
  if (peerConnection) return peerConnection;

  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  for (const track of localStream.getTracks()) {
    peerConnection.addTrack(track, localStream);
  }

  peerConnection.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      sendSignal({ type: 'ice-candidate', from: clientId, candidate: event.candidate.toJSON() });
    }
  });

  peerConnection.addEventListener('track', (event) => {
    const [stream] = event.streams;
    if (stream) elements.remoteVideo.srcObject = stream;
    elements.remotePlaceholder.hidden = true;
    elements.remoteCaption.hidden = false;
    void elements.remoteVideo.play().catch(() => {});
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === 'connected') {
      callStarted = true;
      setStatus('Идет звонок', 'connected');
      elements.callState.textContent = 'ИДЕТ ЗВОНОК';
      elements.callState.classList.add('is-live');
      elements.remotePlaceholder.hidden = true;
      elements.remoteCaption.hidden = false;
      startCallDuration();
      updateControls();
    } else if (peerConnection.connectionState === 'failed') {
      setStatus('Не удалось установить видеосвязь', 'alert');
      showToast('WebRTC-соединение не установлено. Проверьте сеть или попробуйте начать звонок снова.');
    } else if (peerConnection.connectionState === 'disconnected') {
      setStatus('Связь прервана, переподключение...', 'alert');
    }
  });

  peerConnection.addEventListener('iceconnectionstatechange', () => {
    if (peerConnection && peerConnection.iceConnectionState === 'failed') {
      showToast('ICE-соединение не удалось. Возможно, сеть ограничивает прямую видеосвязь.');
    }
  });

  return peerConnection;
}

async function startCall() {
  if (!peerAvailable || !localStream || !socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    callStarted = true;
    updateControls();
    setStatus('Вызов собеседника...', 'connected');
    elements.callState.textContent = 'ВЫЗОВ СОБЕСЕДНИКА';
    const connection = createPeerConnection();
    makingOffer = true;
    await connection.setLocalDescription(await connection.createOffer());
    sendSignal({
      type: 'description',
      from: clientId,
      description: { type: connection.localDescription.type, sdp: connection.localDescription.sdp }
    });
  } catch (error) {
    callStarted = false;
    setStatus('Не удалось начать звонок', 'alert');
    showToast('Не удалось создать видеозвонок. Попробуйте еще раз.');
    closePeerConnection();
    updateControls();
  } finally {
    makingOffer = false;
  }
}

async function handleSignalMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    showToast('Сервер прислал сообщение в неизвестном формате.');
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'peer-left') {
    handlePeerLeft();
    return;
  }

  if (message.from) setPeer(message.from);

  try {
    switch (message.type) {
      case 'ready':
        break;
      case 'description':
        await handleDescription(message.description);
        break;
      case 'ice-candidate':
        await handleIceCandidate(message.candidate);
        break;
      case 'chat':
        if (typeof message.text === 'string') appendMessage(message.text, false, message.sentAt);
        break;
      case 'hangup':
        resetCall('Собеседник завершил звонок. Можно начать новый.');
        showToast('Собеседник завершил звонок.');
        break;
      default:
        break;
    }
  } catch (error) {
    if (message.type === 'description') {
      setStatus('Не удалось установить видеосвязь', 'alert');
      showToast('Ошибка при согласовании WebRTC-соединения. Попробуйте начать звонок снова.');
    }
  }
}

async function handleDescription(description) {
  if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string') return;
  if (!localStream) {
    sendSignal({ type: 'hangup', from: clientId });
    showToast('Собеседник звонит, но у вас не подключены камера и микрофон. Нажмите «Подключиться».');
    return;
  }

  const connection = createPeerConnection();
  const offerCollision = description.type === 'offer' && (makingOffer || connection.signalingState !== 'stable');
  ignoreOffer = !polite && offerCollision;
  if (ignoreOffer) return;

  await Promise.all([
    connection.setRemoteDescription(description),
    offerCollision ? connection.setLocalDescription({ type: 'rollback' }) : Promise.resolve()
  ]);
  await drainPendingCandidates();

  if (description.type === 'offer') {
    await connection.setLocalDescription(await connection.createAnswer());
    sendSignal({
      type: 'description',
      from: clientId,
      description: { type: connection.localDescription.type, sdp: connection.localDescription.sdp }
    });
    callStarted = true;
    setStatus('Установка видеосвязи...', 'connected');
    elements.callState.textContent = 'ПОДКЛЮЧЕНИЕ';
    updateControls();
  }
}

async function handleIceCandidate(candidate) {
  if (!candidate) return;
  const connection = localStream ? createPeerConnection() : null;
  if (!connection || !connection.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await connection.addIceCandidate(candidate);
  } catch (error) {
    if (!ignoreOffer) throw error;
  }
}

async function drainPendingCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  const candidates = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      if (!ignoreOffer) throw error;
    }
  }
}

function handlePeerLeft() {
  peerAvailable = false;
  peerId = null;
  resetCall('Собеседник покинул звонок. Ожидание нового подключения.');
  setStatus('Собеседник отключился', 'alert');
  showToast('Собеседник покинул звонок');
  updateControls();
}

function resetCall(copy) {
  closePeerConnection();
  callStarted = false;
  setStageWaiting(copy);
  if (peerAvailable) setStatus('Собеседник подключен', 'connected');
  updateControls();
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.close();
    peerConnection = null;
  }
  callStarted = false;
  pendingCandidates = [];
  makingOffer = false;
  ignoreOffer = false;
  elements.remoteVideo.srcObject = null;
  elements.remotePlaceholder.hidden = false;
  elements.remoteCaption.hidden = true;
  stopCallDuration();
}

function startCallDuration() {
  if (durationInterval) return;
  callStartedAt = Date.now();
  elements.callDuration.hidden = false;
  durationInterval = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - callStartedAt) / 1000);
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const remainder = (seconds % 60).toString().padStart(2, '0');
    elements.callDuration.textContent = `${minutes}:${remainder}`;
  }, 1000);
}

function stopCallDuration() {
  window.clearInterval(durationInterval);
  durationInterval = null;
  callStartedAt = 0;
  elements.callDuration.hidden = true;
  elements.callDuration.textContent = '00:00';
}

function endCall() {
  sendSignal({ type: 'hangup', from: clientId });
  resetCall(peerAvailable ? 'Звонок завершен. Можно начать новый.' : 'Собеседник не подключен. Ожидание нового подключения.');
  setStatus(peerAvailable ? 'Собеседник подключен' : 'Ожидание собеседника... ', peerAvailable ? 'connected' : 'idle');
}

function toggleMicrophone() {
  const track = localStream && localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const isMuted = !track.enabled;
  elements.micButton.setAttribute('aria-pressed', String(isMuted));
  elements.micLabel.textContent = isMuted ? 'Включить звук' : 'Микрофон';
  elements.micIndicator.classList.toggle('is-muted', isMuted);
  elements.micIndicator.setAttribute('aria-label', isMuted ? 'Микрофон выключен' : 'Микрофон включен');
  elements.micIndicator.innerHTML = isMuted
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0m-7 7v3m-4 0h8M3 3l18 18"></path></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0m-7 7v3m-4 0h8"></path></svg>';
}

function toggleCamera() {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const isOff = !track.enabled;
  elements.cameraButton.setAttribute('aria-pressed', String(isOff));
  elements.cameraLabel.textContent = isOff ? 'Включить камеру' : 'Камера';
  elements.localPlaceholder.hidden = !isOff;
}

function appendMessage(text, isOwn, timestamp = Date.now()) {
  const emptyMessage = elements.messageList.querySelector('.empty-chat');
  if (emptyMessage) emptyMessage.remove();
  const message = document.createElement('article');
  message.className = `message${isOwn ? ' is-own' : ''}`;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = isOwn ? 'Вы' : 'Собеседник';
  const time = document.createElement('time');
  const date = new Date(Number(timestamp));
  time.dateTime = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  time.textContent = (Number.isNaN(date.getTime()) ? new Date() : date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  meta.append(author, time);
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  message.append(meta, bubble);
  elements.messageList.append(message);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
  messageCount += 1;
  elements.chatCount.textContent = String(messageCount);
}

function sendChatMessage(event) {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || text.length > 1000 || !peerAvailable) return;
  const sentAt = Date.now();
  if (!sendSignal({ type: 'chat', from: clientId, text, sentAt })) {
    showToast('Сообщение не отправлено: нет соединения с сервером.');
    updateControls();
    return;
  }
  appendMessage(text, true, sentAt);
  elements.chatInput.value = '';
  elements.chatInput.style.height = 'auto';
  updateControls();
}

function showConnectionInfo() {
  showToast(`Signaling: ${SIGNALING_URL} · STUN: Google public STUN`);
}

elements.connectButton.addEventListener('click', () => void connectToSession());
elements.callButton.addEventListener('click', () => void startCall());
elements.hangupButton.addEventListener('click', endCall);
elements.micButton.addEventListener('click', toggleMicrophone);
elements.cameraButton.addEventListener('click', toggleCamera);
elements.chatForm.addEventListener('submit', sendChatMessage);
elements.chatInput.addEventListener('input', () => {
  elements.chatInput.style.height = 'auto';
  elements.chatInput.style.height = `${Math.min(elements.chatInput.scrollHeight, 100)}px`;
  updateControls();
});
elements.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!elements.sendButton.disabled) elements.chatForm.requestSubmit();
  }
});
elements.connectionInfo.addEventListener('click', showConnectionInfo);

elements.messageList.innerHTML = '<p class="empty-chat">Здесь появятся сообщения и ссылки, которыми вы обменяетесь во время встречи.</p>';
updateControls();
setStageWaiting();

window.addEventListener('beforeunload', () => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
});
