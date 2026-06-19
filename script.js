const peers = {}; // key: peerId, value: { pc, dataChannel, name, iceCandidatesQueue }
let socket;
let currentRoomCode = "";
const peerId = Math.random().toString(36).substring(2, 9);
// Use public Google STUN servers to resolve P2P firewall NAT traversal automatically
const config = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

// Username configs
let localName = "You";

// Incoming file transfer chunks cache
const fileIncomingBuffers = {};

// Discover local private IP on load
function discoverLocalIP() {
    const localIpPreview = document.getElementById('local-ip-preview');
    const localIpVal = document.getElementById('local-ip-val');
    const localPortVal = document.getElementById('local-port-val');
    
    const portStr = window.location.port ? ':' + window.location.port : '';

    function showIpBadge(ip) {
        if (localIpPreview && localIpVal && localPortVal) {
            localIpVal.innerText = ip;
            localPortVal.innerText = portStr;
            localIpPreview.style.display = 'flex';
        }
    }

    const hostname = window.location.hostname;
    if (isPrivateIPv4(hostname)) {
        showIpBadge(hostname);
        return;
    }

    try {
        const dummyPc = new RTCPeerConnection({ iceServers: [] });
        dummyPc.createDataChannel("ip_discover");
        
        let found = false;
        
        dummyPc.onicecandidate = (event) => {
            if (event.candidate) {
                const parts = event.candidate.candidate.split(' ');
                if (parts.length > 4) {
                    const ip = parts[4];
                    if (isPrivateIPv4(ip)) {
                        found = true;
                        showIpBadge(ip);
                        dummyPc.close();
                    }
                }
            }
        };
        
        dummyPc.createOffer()
            .then(offer => dummyPc.setLocalDescription(offer))
            .catch(() => {});
            
        setTimeout(() => {
            if (!found) {
                dummyPc.close();
            }
        }, 1500);
    } catch (e) {}
}

function isPrivateIPv4(ip) {
    if (!ip) return false;
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    
    if (first === 192 && second === 168) return true;
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    
    return false;
}

// Automatically initiate discovery on load
document.addEventListener('DOMContentLoaded', () => {
    discoverLocalIP();
});

// --- AUTOMATED SIGNALING PIPELINE VIA NTFY.SH ---
function initiateSignaling(roomCode) {
    if (!roomCode) return showNotification("Please enter or generate a room code first.", "warning");
    
    currentRoomCode = roomCode;
    showNotification(`Connecting to room signaling tunnel: ${roomCode}...`, "info");
    
    const wsServer = `wss://ntfy.sh/workspace-${roomCode}/ws`;
    
    try {
        socket = new WebSocket(wsServer);
        
        socket.onopen = () => {
            showNotification(`Signaling tunnel open. Room Code: ${roomCode}`, "success");
            updateStatusDisplay();
            
            // Announce presence to all existing peers in the room
            sendSignal({ type: 'hello' });
        };
        
        socket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.event !== "message") return; // Ignore "open", "keepalive", etc.
            
            let msg;
            try {
                msg = JSON.parse(data.message);
            } catch (e) {
                return; // Not a valid JSON signal
            }
            
            if (msg.senderId === peerId) return; // Ignore our own echo reflections
            if (msg.targetId && msg.targetId !== peerId) return; // Ignore messages targeted to other peers
            
            if (msg.type === 'hello') {
                // A new peer has joined
                if (peerId < msg.senderId) {
                    // Introduce ourselves to the new peer so they know our ID
                    sendSignal({ type: 'welcome', targetId: msg.senderId });
                } else {
                    // Initiate WebRTC connection to them
                    showNotification("New peer joined room. Negotiating link...", "info");
                    setupPeer(msg.senderId, true);
                }
            } else if (msg.type === 'welcome') {
                // An existing peer welcomed us
                showNotification("Connecting to peer...", "info");
                setupPeer(msg.senderId, true);
            } else if (msg.type === 'offer') {
                // We received a connection offer
                showNotification("Applying remote configuration offer...", "info");
                await setupPeer(msg.senderId, false);
                const peer = peers[msg.senderId];
                if (peer) {
                    await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    await processQueuedCandidates(msg.senderId);
                    const answer = await peer.pc.createAnswer();
                    await peer.pc.setLocalDescription(answer);
                    sendSignal({ type: 'answer', sdp: answer, targetId: msg.senderId });
                }
            } else if (msg.type === 'answer') {
                // We received a connection answer
                const peer = peers[msg.senderId];
                if (peer && peer.pc) {
                    await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    await processQueuedCandidates(msg.senderId);
                    showNotification("Remote answer applied. Finalizing connection...", "info");
                }
            } else if (msg.type === 'candidate') {
                // Exchange candidate
                const peer = peers[msg.senderId];
                if (peer && peer.pc && peer.pc.remoteDescription && msg.candidate) {
                    await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
                } else if (peer && msg.candidate) {
                    peer.iceCandidatesQueue.push(msg.candidate);
                } else if (!peer && msg.candidate) {
                    // Buffer candidate by initializing peer structure early
                    await setupPeer(msg.senderId, false);
                    peers[msg.senderId].iceCandidatesQueue.push(msg.candidate);
                }
            }
        };
        
        socket.onerror = () => {
            showNotification("Signaling connection error.", "error");
        };
        
        socket.onclose = () => {
            // Reconnect or notify
        };
        
    } catch(err) {
        showNotification("Failed to open signaling socket.", "error");
    }
}

function sendSignal(payload) {
    if (!currentRoomCode) return;
    payload.senderId = peerId;
    fetch(`https://ntfy.sh/workspace-${currentRoomCode}`, {
        method: "POST",
        body: JSON.stringify(payload)
    }).catch(err => {
        console.error("Failed to transmit signaling package:", err);
    });
}

async function processQueuedCandidates(targetPeerId) {
    const peer = peers[targetPeerId];
    if (peer && peer.pc && peer.pc.remoteDescription) {
        while (peer.iceCandidatesQueue.length > 0) {
            const candidate = peer.iceCandidatesQueue.shift();
            await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
    }
}

async function setupPeer(targetPeerId, isInitiator) {
    if (peers[targetPeerId]) return; // Already exists
    
    const pc = new RTCPeerConnection(config);
    const peer = {
        pc: pc,
        dataChannel: null,
        name: 'Peer',
        iceCandidatesQueue: []
    };
    peers[targetPeerId] = peer;
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal({ type: 'candidate', candidate: event.candidate, targetId: targetPeerId });
        }
    };
    
    if (isInitiator) {
        const channel = pc.createDataChannel("workspace_sync");
        peer.dataChannel = channel;
        setupDataChannelEvents(targetPeerId, channel);
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ type: 'offer', sdp: offer, targetId: targetPeerId });
    } else {
        pc.ondatachannel = (event) => {
            peer.dataChannel = event.channel;
            setupDataChannelEvents(targetPeerId, event.channel);
        };
    }
}

function closePeer(targetPeerId) {
    const peer = peers[targetPeerId];
    if (peer) {
        if (peer.pc) {
            peer.pc.close();
        }
        delete peers[targetPeerId];
    }
    toggleUIInputs();
    updateStatusDisplay();
}

// Host action
function hostRoom() {
    // Generate a random 5-digit room code
    const roomCode = Math.floor(10000 + Math.random() * 90000).toString();
    const codeInput = document.getElementById('roomCodeInput');
    if (codeInput) {
        codeInput.value = roomCode;
    }
    initiateSignaling(roomCode, true);
}

// Joiner action
function joinRoom() {
    const codeInput = document.getElementById('roomCodeInput');
    const roomCode = codeInput ? codeInput.value.trim() : "";
    if (!roomCode) {
        return showNotification("Please enter a 5-digit room code to join.", "warning");
    }
    initiateSignaling(roomCode, false);
}

// --- DATA CHANNEL UTILITIES ---
// --- DATA CHANNEL UTILITIES ---
function setupDataChannelEvents(targetPeerId, channel) {
    channel.onopen = () => {
        showNotification("P2P connection to peer established successfully!", "success");
        // Instantly synchronize name metadata to this peer
        channel.send(JSON.stringify({ type: 'name', content: localName }));
        toggleUIInputs();
        updateStatusDisplay();
    };

    channel.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const peer = peers[targetPeerId];
            const senderName = peer ? peer.name : "Peer";
            
            if (data.type === 'chat') {
                appendMessage(data.content, 'remote', senderName);
            } else if (data.type === 'name') {
                if (peer) {
                    peer.name = data.content;
                }
                updateStatusDisplay();
            } else if (data.type === 'notepad') {
                const notepadArea = document.getElementById('notepad-area');
                if (notepadArea) {
                    notepadArea.value = data.content;
                    if (typeof updateWordCount === 'function') updateWordCount();
                    updateNotepadTimestamp();
                }
            } else if (data.type === 'clipboard') {
                const clipboardBox = document.getElementById('clipboard-sandbox');
                if (clipboardBox) {
                    clipboardBox.value = data.content;
                }
                addToClipboardLog(data.content, 'received', senderName);
                showNotification(`Clipboard text synced from ${senderName}`, "info");
            } else if (data.type === 'file-start') {
                fileIncomingBuffers[data.content.id] = {
                    name: data.content.name,
                    mime: data.content.mime,
                    size: data.content.size,
                    sender: senderName,
                    chunks: new Array(data.content.totalChunks),
                    chunksReceived: 0,
                    totalChunks: data.content.totalChunks
                };
                showNotification(`Incoming file: ${data.content.name} (from ${senderName})`, "info");
            } else if (data.type === 'file-chunk') {
                const fileTransfer = fileIncomingBuffers[data.content.id];
                if (fileTransfer) {
                    fileTransfer.chunks[data.content.index] = data.content.chunk;
                    fileTransfer.chunksReceived++;
                    
                    if (fileTransfer.chunksReceived === fileTransfer.totalChunks) {
                        const fullBase64 = fileTransfer.chunks.join('');
                        const fileData = {
                            name: fileTransfer.name,
                            mime: fileTransfer.mime,
                            size: fileTransfer.size,
                            sender: fileTransfer.sender,
                            data: fullBase64
                        };
                        receiveFile(fileData);
                        delete fileIncomingBuffers[data.content.id];
                    }
                }
            }
        } catch (e) {
            const peer = peers[targetPeerId];
            appendMessage(event.data, 'remote', peer ? peer.name : 'Peer');
        }
    };

    channel.onclose = () => {
        closePeer(targetPeerId);
    };
}

function sendData(type, content) {
    sendDataToAll(type, content);
}

function sendDataToAll(type, content) {
    const payload = JSON.stringify({ type, content });
    for (const id in peers) {
        const peer = peers[id];
        if (peer.dataChannel && peer.dataChannel.readyState === "open") {
            peer.dataChannel.send(payload);
        }
    }
}

// Send chat message
function sendMessage() {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    if (text) {
        sendData('chat', text);
        appendMessage(text, 'local', localName);
        input.value = "";
    }
}

function appendMessage(text, side, senderName) {
    const chatBox = document.getElementById('chatBox');
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('msg', side);
    
    const nameLabel = side === 'local' ? localName : (senderName || 'Peer');
    msgDiv.innerText = `${nameLabel}: ${text}`;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// --- REALTIME SYNC HANDLERS ---
function updateLocalName() {
    const input = document.getElementById('usernameInput');
    if (input) {
        localName = input.value.trim() || "You";
        sendData('name', localName);
    }
}

function syncNotepadText() {
    const notepadArea = document.getElementById('notepad-area');
    if (notepadArea) {
        sendData('notepad', notepadArea.value);
        updateNotepadTimestamp();
    }
}

function syncClipboardText() {
    const clipboardSandbox = document.getElementById('clipboard-sandbox');
    if (clipboardSandbox) {
        sendData('clipboard', clipboardSandbox.value);
        addToClipboardLog(clipboardSandbox.value, 'sent', localName);
        showNotification("Clipboard text pushed to remote peer!", "success");
    }
}

// File sharing staging and transfer helpers (with WebRTC chunking and throttling)
function sendFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64Data = e.target.result;
        const fileId = Math.random().toString(36).substring(2, 9);
        const chunkSize = 16384; // 16KB safe chunk size
        const totalChunks = Math.ceil(base64Data.length / chunkSize);
        
        sendData('file-start', {
            id: fileId,
            name: file.name,
            mime: file.type,
            size: file.size,
            sender: localName,
            totalChunks: totalChunks
        });
        
        addToFileLog(file, 'sent', localName);
        showNotification(`Uploading: ${file.name}...`, "info");

        let chunkIndex = 0;
        function sendNextChunk() {
            if (chunkIndex < totalChunks) {
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize, base64Data.length);
                const chunk = base64Data.substring(start, end);
                
                sendData('file-chunk', {
                    id: fileId,
                    index: chunkIndex,
                    chunk: chunk
                });
                
                chunkIndex++;
                setTimeout(sendNextChunk, 2); 
            } else {
                showNotification(`Sent file successfully: ${file.name}`, "success");
            }
        }
        sendNextChunk();
    };
    reader.readAsDataURL(file);
}

function receiveFile(fileData) {
    const log = document.getElementById('transfer-log');
    if (log) {
        const empty = log.querySelector('.transfer-empty');
        if (empty) empty.remove();

        const sender = fileData.sender || "Peer";
        const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const fileItem = document.createElement('div');
        fileItem.className = 'file-transfer-item';
        fileItem.innerHTML = `
            <span class="file-icon">📁</span>
            <div class="file-details">
                <span class="file-name">${fileData.name}</span>
                <span class="file-size">${(fileData.size / 1024).toFixed(1)} KB (from ${sender})</span>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                <a href="${fileData.data}" download="${fileData.name}" class="btn btn-secondary btn-sm file-download-btn" style="text-decoration:none;">
                    Download
                </a>
                <span style="font-size: 10px; color: var(--text-muted);">${timeString}</span>
            </div>
        `;
        log.appendChild(fileItem);
        showNotification(`File received from ${sender}`, "info");
    }
}

function addToFileLog(file, direction, senderName) {
    const log = document.getElementById('transfer-log');
    if (log) {
        const empty = log.querySelector('.transfer-empty');
        if (empty) empty.remove();

        const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const fileItem = document.createElement('div');
        fileItem.className = 'file-transfer-item';
        
        const nameLabel = direction === 'sent' ? `by you` : `from ${senderName}`;
        
        fileItem.innerHTML = `
            <span class="file-icon">📁</span>
            <div class="file-details">
                <span class="file-name">${file.name}</span>
                <span class="file-size">${(file.size / 1024).toFixed(1)} KB (${nameLabel})</span>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                <span class="file-status ${direction}">${direction === 'sent' ? 'Sent' : 'Received'}</span>
                <span style="font-size: 10px; color: var(--text-muted);">${timeString}</span>
            </div>
        `;
        log.appendChild(fileItem);
    }
}

// Custom side-toast notification system
function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    else if (type === 'warning') icon = '⚠️';
    else if (type === 'error') icon = '❌';

    toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message">${message}</span>`;
    container.appendChild(toast);

    // Slide in
    setTimeout(() => {
        toast.classList.add('visible');
    }, 10);

    // Slide out and remove
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3500);
}

// Helpers
function getFormattedTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function updateNotepadTimestamp() {
    const timeLabel = document.getElementById('notepad-sync-time');
    if (timeLabel) {
        timeLabel.innerText = "Last updated: " + getFormattedTime();
    }
}

function addToClipboardLog(text, direction, nameLabel) {
    const list = document.getElementById('clipboard-log-list');
    if (list) {
        const empty = list.querySelector('.history-empty');
        if (empty) empty.remove();

        const timeString = getFormattedTime();
        const item = document.createElement('div');
        item.className = 'clipboard-history-item';
        
        // Truncate text preview for clean layout
        const preview = text.length > 30 ? text.substring(0, 30) + "..." : text;
        const directionText = direction === 'sent' ? `You synced` : `${nameLabel} synced`;
        
        item.innerHTML = `
            <span class="full-text" style="display:none;"></span>
            <span class="history-item-text"><strong>${directionText}</strong>: "${preview}"</span>
            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                <span class="history-item-time" style="font-size: 10px; color: var(--text-muted);">${timeString}</span>
                <button class="textarea-action-btn" onclick="copyClipboardHistoryItem(this)" title="Copy item text" style="position:static; width:22px; height:22px; display:inline-flex;">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
            </div>
        `;
        item.querySelector('.full-text').textContent = text;
        
        list.insertBefore(item, list.firstChild);
    }
}

// Copy full text from clipboard history items
function copyClipboardHistoryItem(btnElement) {
    const parent = btnElement.closest('.clipboard-history-item');
    const fullTextSpan = parent ? parent.querySelector('.full-text') : null;
    if (fullTextSpan) {
        navigator.clipboard.writeText(fullTextSpan.textContent)
            .then(() => showNotification("History text copied to clipboard!", "success"))
            .catch(() => showNotification("Failed to copy. Please copy manually.", "warning"));
    }
}

// Helper to disable inputs when offline (no open peer data channels)
function toggleUIInputs() {
    const hasPeers = Object.values(peers).some(p => p.dataChannel && p.dataChannel.readyState === "open");
    const disabled = !hasPeers;
    
    const msgInput = document.getElementById('msgInput');
    const sendBtn = document.getElementById('sendBtn');
    const clipboardSyncBtn = document.getElementById('clipboard-sync-btn');

    if (msgInput) msgInput.disabled = disabled;
    if (sendBtn) sendBtn.disabled = disabled;
    if (clipboardSyncBtn) clipboardSyncBtn.disabled = disabled;
}

// Update the dynamic status indicator with the number of connected peers
function updateStatusDisplay() {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status');
    const peerCount = Object.keys(peers).length;
    
    if (peerCount > 0) {
        if (statusDot) {
            statusDot.className = "status-indicator-dot connected";
        }
        if (statusText) {
            statusText.innerText = `Connected (${peerCount} peer${peerCount > 1 ? 's' : ''}) 🎉`;
            statusText.className = "status-value connected";
        }
    } else {
        if (statusDot) {
            statusDot.className = "status-indicator-dot disconnected";
        }
        if (statusText) {
            statusText.innerText = socket ? "Waiting for peers..." : "Disconnected";
            statusText.className = "status-value disconnected";
        }
    }
}