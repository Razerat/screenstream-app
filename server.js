const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const db = require('./database.js');

const JWT_SECRET = process.env.JWT_SECRET || 'screenstream_super_secret_key_2026';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.json({
    status: "ok",
    message: "Servidor Backend ScreenStream está 100% Online e Ativo!",
    timestamp: new Date().toISOString()
  });
});

// Middleware de Autenticação JWT para API
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

// ============================================================================
// API DE AUTENTICAÇÃO & SISTEMA DE AMIGOS
// ============================================================================
app.post('/api/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
    }

    const user = db.registerUser({ name, email, password });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ message: 'Usuário cadastrado com sucesso!', user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const user = db.authenticateUser({ email, password });
    if (!user) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ message: 'Login realizado com sucesso!', user, token });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
  res.json({ user });
});

// Endpoints da Lista de Amigos
app.get('/api/friends', authMiddleware, (req, res) => {
  try {
    const friends = db.getFriendsList(req.user.id);
    res.json({ friends });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/friends/request', authMiddleware, (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail do amigo é obrigatório.' });

    const result = db.sendFriendRequest(req.user.id, email);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/friends/accept', authMiddleware, (req, res) => {
  try {
    const { friendId } = req.body;
    if (!friendId) return res.status(400).json({ error: 'ID do amigo é obrigatório.' });

    const result = db.acceptFriendRequest(req.user.id, friendId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// SOCKET.IO REALTIME SIGNALING, CHAT, AMIGOS & ONLINE TRACKER
// ============================================================================
const rooms = new Map();
// Key: userId -> { socketId, userId, name, isBroadcasting, roomId }
const activeUserSockets = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function broadcastRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const participants = [];

  if (room.presenterId) {
    participants.push({
      id: room.presenterId,
      name: room.presenterName,
      isPresenter: true,
      isBroadcasting: room.isBroadcasting
    });
  }

  for (const [viewerId, viewerName] of room.viewers.entries()) {
    participants.push({
      id: viewerId,
      name: viewerName,
      isPresenter: false,
      isBroadcasting: false
    });
  }

  io.to(roomId).emit('room-users-update', {
    roomId,
    presenterName: room.presenterName,
    isBroadcasting: room.isBroadcasting,
    totalOnline: participants.length,
    participants
  });
}

function notifyFriendsPresence(userId) {
  const friends = db.getFriendsList(userId);
  if (!friends || friends.length === 0) return;

  friends.forEach(f => {
    const friendSocketInfo = activeUserSockets.get(f.id);
    if (friendSocketInfo) {
      // Enviar lista atualizada de amigos ao amigo conectado
      const friendUserFriends = db.getFriendsList(f.id).map(myFriend => {
        const socketInfo = activeUserSockets.get(myFriend.id);
        return {
          ...myFriend,
          isOnline: !!socketInfo,
          isBroadcasting: socketInfo ? socketInfo.isBroadcasting : false,
          roomId: socketInfo ? socketInfo.roomId : null
        };
      });

      io.to(friendSocketInfo.socketId).emit('friends-presence-update', {
        friends: friendUserFriends
      });
    }
  });
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
    } catch (err) {
      console.warn('[Socket Auth Warning] Token inválido.');
    }
  }
  next();
});

io.on('connection', (socket) => {
  const userName = socket.user ? socket.user.name : `Visitante_${socket.id.substring(0, 4)}`;
  const userId = socket.user ? socket.user.id : socket.id;
  socket.userName = userName;
  socket.userId = userId;

  if (socket.user) {
    activeUserSockets.set(userId, {
      socketId: socket.id,
      userId,
      name: userName,
      isBroadcasting: false,
      roomId: null
    });
    notifyFriendsPresence(userId);
  }

  console.log(`[Socket Connected] ID: ${socket.id} | Usuário: ${userName} (${userId})`);

  // Obter presença atualizada de amigos
  socket.on('get-friends-presence', () => {
    if (!socket.user) return;
    const friends = db.getFriendsList(socket.user.id).map(myFriend => {
      const socketInfo = activeUserSockets.get(myFriend.id);
      return {
        ...myFriend,
        isOnline: !!socketInfo,
        isBroadcasting: socketInfo ? socketInfo.isBroadcasting : false,
        roomId: socketInfo ? socketInfo.roomId : null
      };
    });
    socket.emit('friends-presence-update', { friends });
  });

  // Entrar na transmissão de um amigo diretamente pelo ID do amigo (SEM CÓDIGO DE SALA!)
  socket.on('join-friend-stream', ({ friendId }) => {
    let targetRoomId = null;
    let targetPresenterId = null;

    // Procurar sala criada pelo amigo
    for (const [rId, room] of rooms.entries()) {
      if (room.presenterUserId === friendId || room.presenterId === friendId) {
        targetRoomId = rId;
        targetPresenterId = room.presenterId;
        break;
      }
    }

    if (!targetRoomId) {
      // Procurar se o amigo está transmitindo via activeUserSockets
      const socketInfo = activeUserSockets.get(friendId);
      if (socketInfo && socketInfo.roomId) {
        targetRoomId = socketInfo.roomId;
        targetPresenterId = socketInfo.socketId;
      }
    }

    if (!targetRoomId) {
      return socket.emit('room-error', { message: 'Este amigo não está transmitindo nenhuma tela no momento.' });
    }

    const room = rooms.get(targetRoomId);
    if (!room) {
      return socket.emit('room-error', { message: 'Transmissão não encontrada.' });
    }

    room.viewers.set(socket.id, userName);
    socket.join(targetRoomId);
    socket.roomId = targetRoomId;
    socket.isPresenter = false;

    console.log(`[Assistindo Amigo] ${userName} entrou na transmissão de ${room.presenterName} (Sala ${targetRoomId})`);

    socket.emit('room-joined', { 
      roomId: targetRoomId,
      presenterId: room.presenterId,
      presenterName: room.presenterName,
      isBroadcasting: room.isBroadcasting
    });

    io.to(room.presenterId).emit('viewer-joined', { 
      viewerId: socket.id,
      viewerName: userName,
      totalViewers: room.viewers.size
    });

    io.to(targetRoomId).emit('chat-system-message', {
      text: `${userName} entrou na sala.`
    });

    broadcastRoomUsers(targetRoomId);
  });

  // Apresentador cria sala
  socket.on('create-room', () => {
    for (const [id, room] of rooms.entries()) {
      if (room.presenterId === socket.id) {
        io.to(id).emit('presenter-left');
        rooms.delete(id);
      }
    }

    let roomId = generateRoomId();
    while (rooms.has(roomId)) {
      roomId = generateRoomId();
    }

    rooms.set(roomId, {
      presenterId: socket.id,
      presenterUserId: userId,
      presenterName: userName,
      viewers: new Map(),
      isBroadcasting: true,
      createdAt: new Date()
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.isPresenter = true;

    if (socket.user) {
      const info = activeUserSockets.get(userId);
      if (info) {
        info.isBroadcasting = true;
        info.roomId = roomId;
      }
      notifyFriendsPresence(userId);
    }

    console.log(`[Sala Criada] Code: ${roomId} | Presenter: ${userName}`);
    socket.emit('room-created', { roomId, presenterName: userName });
    broadcastRoomUsers(roomId);
  });

  // Espectador entra via código de sala
  socket.on('join-room', ({ roomId }) => {
    const cleanRoomId = roomId ? roomId.trim().toUpperCase() : '';
    const room = rooms.get(cleanRoomId);

    if (!room) {
      return socket.emit('room-error', { message: 'Sala não encontrada. Verifique o código digitado.' });
    }

    room.viewers.set(socket.id, userName);
    socket.join(cleanRoomId);
    socket.roomId = cleanRoomId;
    socket.isPresenter = false;

    console.log(`[Espectador Entrou] Room: ${cleanRoomId} | Viewer: ${userName}`);

    socket.emit('room-joined', { 
      roomId: cleanRoomId,
      presenterId: room.presenterId,
      presenterName: room.presenterName,
      isBroadcasting: room.isBroadcasting
    });

    io.to(room.presenterId).emit('viewer-joined', { 
      viewerId: socket.id,
      viewerName: userName,
      totalViewers: room.viewers.size
    });

    io.to(cleanRoomId).emit('chat-system-message', {
      text: `${userName} entrou na sala.`
    });

    broadcastRoomUsers(cleanRoomId);
  });

  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { senderId: socket.id, offer });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { senderId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) {
      io.to(targetId).emit('ice-candidate', { senderId: socket.id, candidate });
    }
  });

  socket.on('send-chat-message', ({ messageText }) => {
    if (!socket.roomId) return;
    const text = messageText ? messageText.trim() : '';
    if (!text) return;

    const chatData = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      senderId: socket.id,
      senderName: userName,
      isPresenter: socket.isPresenter || false,
      text,
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    io.to(socket.roomId).emit('chat-message', chatData);
  });

  socket.on('stop-sharing', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.presenterId === socket.id) {
        room.isBroadcasting = false;
        socket.to(socket.roomId).emit('presenter-left');
        broadcastRoomUsers(socket.roomId);
        rooms.delete(socket.roomId);

        if (socket.user) {
          const info = activeUserSockets.get(userId);
          if (info) {
            info.isBroadcasting = false;
            info.roomId = null;
          }
          notifyFriendsPresence(userId);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.user) {
      activeUserSockets.delete(userId);
      notifyFriendsPresence(userId);
    }

    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);

      if (socket.isPresenter || room.presenterId === socket.id) {
        socket.to(socket.roomId).emit('presenter-left');
        rooms.delete(socket.roomId);
      } else {
        room.viewers.delete(socket.id);
        io.to(room.presenterId).emit('viewer-left', {
          viewerId: socket.id,
          totalViewers: room.viewers.size
        });
        io.to(socket.roomId).emit('chat-system-message', {
          text: `${userName} saiu da sala.`
        });
        broadcastRoomUsers(socket.roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Servidor ScreenStream (Amigos + Stream 1-Click) ON!`);
  console.log(` Acesse localmente em: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
